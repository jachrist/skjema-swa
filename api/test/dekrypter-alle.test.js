/**
 * `dekrypterAlle` — én dekrypteringsløkke for et helt sett skjemaer.
 *
 * Løkka fantes i TRE eksemplarer: `power-bi.js`, `datauttrekk.js` og
 * `rapport-kjor.js`. Samme regel, nesten samme logglinje — og nettopp derfor
 * verdt å samle: de svarer ulikt så snart den ene rettes. Det hadde alt
 * skjedd. To av dem advarte når nøkkelen manglet; `rapport-kjor.js` gjorde det
 * ikke, så en rapport kunne komme ut med «[Kryptert]» i hver celle uten at
 * loggen sa hvorfor.
 *
 * Dette er en refaktorering av kode som VIRKET, og da er den farlige feilen
 * en stille atferdsendring. To egenskaper var nær ved å forsvinne under
 * arbeidet, og begge testes her:
 *
 *   **En oppgitt nøkkel har forrang.** Datauttrekket lar brukeren sende
 *   nøkkelen i forespørselen (`body.Nokkel`). Den første versjonen av
 *   hjelperen slo alltid opp selv, og tok den veien bort i stillhet — uttrekk
 *   med manuell nøkkel ville sluttet å virke uten en feilmelding.
 *
 *   **Et skjema som ikke lar seg dekryptere blir med, urørt.** En rad som
 *   forsvinner er verre enn en rad man ser er kryptert: den første kan ikke
 *   skilles fra «skjemaet finnes ikke».
 *
 * Testen fant dessuten en feil som IKKE ble innført her: feil nøkkel kaster
 * ikke. `dekrypterFulltSvar` fanger feil per felt og lar chifferteksten stå,
 * men sletter likevel `Kryptert`-flagget — skjemaet kommer ut som dekryptert,
 * med «fa04…:d2c9…:q8Hq…» der verdien skulle vært. Dagens oppførsel er festet
 * under, og `dekrypterAlle` logger det nå, slik at «gal nøkkel» kan skilles
 * fra «dette er teksten brukeren skrev».
 *
 * Kjøres med:  node api/test/dekrypter-alle.test.js
 */
const kryptering = require('../src/lib/kryptering');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const nokkel = kryptering.genererNokkel();
const annenNokkel = kryptering.genererNokkel();

/** Et ekte kryptert skjema — formen leses ut av krypterSkjema, ikke oppdiktet. */
function kryptert(id, svar) {
    return kryptering.krypterSkjema({
        Skjema_id: id, Skjematype_id: '59',
        Seksjoner: [{ Seksjon_nummer: 2, Felter: [{ Nummer: 1, Svar: [svar] }] }]
    }, nokkel);
}
function åpent(id, svar) {
    return {
        Skjema_id: id, Skjematype_id: '59',
        Seksjoner: [{ Seksjon_nummer: 2, Felter: [{ Nummer: 1, Svar: [svar] }] }]
    };
}

const svaret = (s) => s?.Seksjoner?.[0]?.Felter?.[0]?.Svar?.[0];
const lager = (verdi) => ({ hentNokkel: async () => verdi, kall: 0 });

async function kjor() {
    // ---------- ingenting kryptert: samme liste tilbake, uten oppslag ----------
    {
        let kall = 0;
        const lagring = { hentNokkel: async () => { kall++; return nokkel; } };
        const inn = [åpent('1', 'a'), åpent('2', 'b')];
        const ut = await kryptering.dekrypterAlle(inn, '59', lagring);
        sjekk('urørt når ingenting er kryptert', ut, inn);
        // Et oppslag her ville kostet et tabellkall på hver rapportkjøring for
        // en ukryptert skjematype.
        sjekk('og ingen nøkkel slås opp', kall, 0);
    }

    // ---------- kryptert, nøkkel finnes ----------
    {
        const ut = await kryptering.dekrypterAlle([kryptert('1', 'hemmelig')], '59', lager(nokkel));
        sjekk('dekrypterer', svaret(ut[0]), 'hemmelig');
    }

    // ---------- blandet sett ----------
    {
        const ut = await kryptering.dekrypterAlle(
            [kryptert('1', 'hemmelig'), åpent('2', 'åpent')], '59', lager(nokkel));
        sjekk('begge formene i samme sett', [svaret(ut[0]), svaret(ut[1])], ['hemmelig', 'åpent']);
        sjekk('og rekkefølgen holder', ut.map(s => s.Skjema_id), ['1', '2']);
    }

    // ---------- oppgitt nøkkel har forrang ----------
    {
        let slo_opp = false;
        const lagring = { hentNokkel: async () => { slo_opp = true; return annenNokkel; } };
        const ut = await kryptering.dekrypterAlle(
            [kryptert('1', 'hemmelig')], '59', lagring, () => {}, { nokkel });
        sjekk('den oppgitte nøkkelen brukes', svaret(ut[0]), 'hemmelig');
        // Dette er egenskapen som nesten forsvant: slås det opp likevel, er
        // det lagringens nøkkel som gjelder, og manuelt uttrekk slutter å virke.
        sjekk('og lagringen spørres ikke', slo_opp, false);
    }
    {
        // Tom streng er ingen nøkkel — da skal oppslaget gjøres.
        let slo_opp = false;
        const lagring = { hentNokkel: async () => { slo_opp = true; return nokkel; } };
        const ut = await kryptering.dekrypterAlle(
            [kryptert('1', 'hemmelig')], '59', lagring, () => {}, { nokkel: '   ' });
        sjekk('tom oppgitt nøkkel faller tilbake på oppslag', slo_opp, true);
        sjekk('og dekrypteringen lykkes', svaret(ut[0]), 'hemmelig');
    }

    // ---------- nøkkel mangler ----------
    {
        const linjer = [];
        const inn = [kryptert('1', 'hemmelig')];
        const ut = await kryptering.dekrypterAlle(inn, '59', lager(null), (m) => linjer.push(m));
        sjekk('raden blir med selv uten nøkkel', ut.length, 1);
        sjekk('og er urørt', ut[0], inn[0]);
        // «Det gikk galt» må kunne skilles fra «koden er ikke deployet».
        sjekk('loggen sier at nøkkelen mangler',
            linjer.some(l => /nøkkel mangler/.test(l)), true);
        sjekk('og nevner skjematypen', linjer.some(l => l.includes('59')), true);
    }

    // ---------- feil nøkkel ----------
    {
        const linjer = [];
        const inn = [kryptert('1', 'hemmelig'), åpent('2', 'åpent')];
        const ut = await kryptering.dekrypterAlle(inn, '59', lager(annenNokkel), (m) => linjer.push(m));
        sjekk('alle radene er med', ut.length, 2);
        sjekk('den åpne er uskadd', svaret(ut[1]), 'åpent');

        // Her ligger en EKSISTERENDE feil, funnet av denne testen og ikke
        // innført av samlingen: feil nøkkel KASTER IKKE.
        // `dekrypterFulltSvar` fanger feil per felt og lar chifferteksten
        // stå, men sletter likevel `Kryptert`-flagget. Skjemaet kommer altså
        // ut som dekryptert, med «fa04…:d2c9…:q8Hq…» der verdien skulle vært
        // — i rapporter, datauttrekk, Power BI og PDF.
        //
        // Testen fester dagens oppførsel, så en framtidig retting i
        // dekrypterFulltSvar blir synlig her i stedet for å passere stille.
        // `Svar` er fortsatt STRENGEN med chiffertekst, ikke et array — så
        // feltet leses rått her. `svaret()` ville gitt første bokstav.
        const råSvar = ut[0]?.Seksjoner?.[0]?.Felter?.[0]?.Svar;
        sjekk('feil nøkkel kaster ikke (dagens oppførsel)',
            /^[0-9a-f]{24}:[0-9a-f]{32}:/.test(råSvar), true);
        sjekk('og flagget er borte, så ingenting nedstrøms ser det',
            'Kryptert' in ut[0], false);

        // Det eneste vi KAN gjøre uten å røre kryptoen: si det i loggen.
        sjekk('loggen sier at chifferteksten står igjen',
            linjer.some(l => /fortsatt chiffertekst/.test(l)), true);
        sjekk('og nevner hvor mange', linjer.some(l => /1 av 2/.test(l)), true);
        sjekk('serKryptertUt kjenner formen', kryptering.serKryptertUt(ut[0]), true);
        sjekk('og tar ikke feil av en ekte tekst', kryptering.serKryptertUt(ut[1]), false);
    }

    // ---------- tomt og rart ----------
    {
        sjekk('tom liste', await kryptering.dekrypterAlle([], '59', lager(nokkel)), []);
        sjekk('ikke-array', await kryptering.dekrypterAlle(null, '59', lager(nokkel)), []);
    }

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
}

kjor().catch(e => { console.error(e); process.exit(1); });
