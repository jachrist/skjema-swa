/**
 * Å starte en jobb som tar lengre tid enn et HTTP-svar.
 *
 * ## Hvorfor dette er en egen modul
 *
 * Fem ruter gjorde det samme på fem steder: kall jobben UTEN `await`, svar
 * 202 «startet», la hosten holde prosessen i live. Det virket i to år, og
 * sluttet å virke 27.10.2026 da prod ble en frittstående Function App.
 *
 * Microsoft sier det rett ut: «the Functions runtime does not track threads
 * or tasks your code starts … they must complete before your function code
 * returns». Returnerer handleren, fullfører verten invokasjonen — og det som
 * var i gang blir drept midt i. Invokasjonen bokføres som vellykket uansett.
 *
 * Utslaget: fire av ni jobber i prod v3 svarte 202 «startet» og gjorde
 * ingenting. Jobben rakk ikke engang sin FØRSTE statusskriving — den som står
 * før alt arbeid, nettopp for at «startet, men feilet» skal kunne skilles fra
 * «startet aldri». Derfor sto alle på «aldri kjørt», som er den ene
 * meldingen som var sann.
 *
 * ## Hvorfor det ikke bare er å `await`-e alltid
 *
 * Pilot kjører fortsatt på SWA Managed Functions, og der er fire-and-forget
 * både lovlig og nødvendig: SWA-proxyen har ~45 s response timeout, og
 * jobbene tar 30-90 s (postnumre) til 2-4 min (FS-data). Ventet vi der, ville
 * cron-jobbene i GitHub Actions fått tidsavbrudd og meldt rødt for jobber som
 * gikk fint.
 *
 * Valget er altså per plattform, og det står ETT sted: `FULLFOERER_VED_RETUR`
 * i `lib/plattform.js`. Ikke her, og ikke i de fem rutene.
 *
 * ## Tidsavbrudd når vi VENTER er ikke det samme som at jobben stoppet
 *
 * Også i prod står Function App-en bak SWA-proxyen, så en jobb på to minutter
 * gir et tidsavbrudd mot nettleseren. Men verten venter fortsatt på jobben,
 * så den kjører ferdig og bokfører seg selv. Det er den riktige byttehandelen
 * — en jobb som gjør arbeidet og et svar som går tapt, framfor et pent 202 og
 * ingenting. Men den som trykker på knappen MÅ få vite det, ellers leser de
 * tidsavbruddet som «jobben feilet». `GET /api/jobber` svarer derfor med
 * `venterPaaJobb`, og admin-panelet sier det i klartekst.
 *
 * Det gjelder HVER knapp som starter en jobb, ikke bare Jobber-fanen. Til
 * 27.10.2026 hadde de andre sin egen catch, og «Trigg full refresh» meldte
 * «Feil» på en jobb som sto `ok` i statusraden. Nå går alle gjennom
 * `startJobb` i admin.html, og `frontend/test/jobbknapper.test.js` leser
 * rutene HERFRA — de som pakker inn `startBakgrunnsjobb` — og krever det.
 */
const { maaVentePaaBakgrunnsarbeid } = require('./plattform');

/**
 * Start en jobb, og vent på den hvis plattformen krever det.
 *
 * @param {() => Promise<any>} start  Kaller jobben. Tas som en funksjon, ikke
 *   som et ferdig løfte, slik at en synkron `throw` i oppstarten (en manglende
 *   app-setting, en `require` som feiler) fanges her og ikke blir en 500 der
 *   ruta skulle svart 202.
 * @param {{ log?: Function, navn?: string }} opt
 * @returns {Promise<{ventet: boolean, feil: string|null}>}
 *   `ventet` sier hvilken vei vi tok — rutene velger statuskode av den, og
 *   testen kan se forskjellen. `feil` er alltid satt: `null` betyr «gikk
 *   bra», ikke «vet ikke». En nøkkel som kan forsvinne kan ikke feilsøkes.
 */
async function startBakgrunnsjobb(start, { log, navn } = {}) {
    const skriv = typeof log === 'function' ? log : () => {};
    const merke = navn || 'bakgrunnsjobb';

    let lofte;
    try {
        lofte = Promise.resolve(start());
    } catch (e) {
        const feil = String((e && e.message) || e);
        skriv(`${merke}: kastet før den kom i gang — ${feil}`);
        // `ventet: true` her er ikke en løgn om plattformen: vi VET utfallet,
        // og ruta skal si det i stedet for å svare 202 på noe som aldri
        // startet.
        return { ventet: true, feil };
    }

    // Fanges uansett vei. En uhåndtert rejection tar ned prosessen i Node
    // 15+, og i fire-and-forget-veien finnes det ingen andre som venter på
    // den.
    const fanget = lofte.then(() => null, (e) => String((e && e.message) || e) || 'ukjent feil');

    if (!maaVentePaaBakgrunnsarbeid()) {
        fanget.then((feil) => { if (feil) skriv(`${merke}: feilet i bakgrunnen — ${feil}`); });
        return { ventet: false, feil: null };
    }

    const feil = await fanget;
    if (feil) skriv(`${merke}: feilet — ${feil}`);
    return { ventet: true, feil };
}

/**
 * Svaret ruta skal gi, av utfallet fra `startBakgrunnsjobb`.
 *
 * Tre utfall, tre statuskoder, og formen står ett sted fordi admin-panelet
 * leser den: 202 «startet» (vi venter ikke), 200 «ferdig» (vi ventet, det
 * gikk), 500 «feil» (vi ventet, det gikk ikke).
 *
 * `status: 'ok'` på en jobb som ikke kjørte er nøyaktig feilklassen denne
 * modulen finnes for. Returneres `ferdig`, HAR jobben kjørt ferdig.
 */
function jobbSvar({ ventet, feil }, { startet, ekstra = {}, asynkronMelding, ferdigMelding }) {
    const felles = { startet, ...ekstra };
    if (!ventet) {
        return { status: 202, jsonBody: { status: 'startet', ...felles, melding: asynkronMelding } };
    }
    if (feil) {
        return { status: 500, jsonBody: { status: 'feil', ...felles, melding: `Jobben feilet — ${feil}` } };
    }
    return { status: 200, jsonBody: { status: 'ferdig', ...felles, melding: ferdigMelding } };
}

module.exports = { startBakgrunnsjobb, jobbSvar };
