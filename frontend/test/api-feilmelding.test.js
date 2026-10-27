/**
 * En feilmelding som skjuler årsaken er verre enn ingen feilmelding.
 *
 * SWA-fronten svarer «Backend call failure» i ren tekst når backend-kallet
 * ble avbrutt. Admin-panelets Diagnostikk-knapp gjorde et RÅTT `fetch` og
 * kalte `res.json()` på svaret. Brukeren fikk:
 *
 *     Unexpected token 'B', "Backend call failure" is not valid JSON
 *
 * Det er en parsefeil som peker på tegn 1 i en streng ingen får se, mens
 * årsaken — en backend som ikke svarte — ikke står noe sted. 19.10.2026 ble
 * den meldingen lest som «noe er galt med diagnosen» i flere timer.
 *
 * To regler holdes fast her:
 *
 *   **Kallene går gjennom `api`-klienten.** Den er stedet vaktene bor:
 *   utløpt sesjon, HTML i stedet for JSON, og et svar som ikke lar seg parse.
 *   Et rått `fetch` omgår dem alle.
 *
 *   **Et svar som bærer JSON-headeren uten å være JSON, kommer ut som
 *   tekst.** Headeren kan lyve, og da skal teksten fram — ikke en parsefeil.
 *
 * Kjøres med:  node frontend/test/api-feilmelding.test.js
 */
const fs = require('fs');
const path = require('path');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const rot = path.join(__dirname, '..', '..');
const les_ = (...p) => fs.readFileSync(path.join(rot, ...p), 'utf8');
const klientKilde = les_('frontend', 'js', 'api-client.js');

/**
 * `hentEksport` i test-kilde.js klipper fra `function <navn>(` og mister
 * `async` foran. En funksjon med `await` i seg blir da en syntaksfeil. Her
 * tas `async`-formen med.
 */
function hentFunksjon(kilde, navn, forspill = []) {
    // Modulnivå-erklæringer funksjonen lener seg på, hentet ut av KILDEN og
    // ikke skrevet av på nytt her. Skrives de av, prøver testen sin egen
    // kopi av regelen — og det er feilklassen dette repoet lager flest av.
    const over = forspill.map(re => {
        const m = re.exec(kilde);
        if (!m) throw new Error(`Fant ikke ${re} i api-client.js`);
        return m[0];
    }).join('\n');

    for (const innledning of [`async function ${navn}(`, `function ${navn}(`]) {
        const i = kilde.indexOf(innledning);
        if (i === -1) continue;
        const slutt = kilde.indexOf('\n}', i);
        if (slutt === -1) break;
        return new Function(`${over}\n${kilde.slice(i, slutt + 2)}\nreturn ${navn};`)();
    }
    throw new Error(`Fant ikke ${navn} i api-client.js`);
}

const les = hentFunksjon(klientKilde, 'les');
const tolkFeiltekst = hentFunksjon(klientKilde, 'tolkFeiltekst',
    [/^const SWA_BACKEND_FEIL = .*$/m, /^function erTidsavbrudd\([\s\S]*?\n\}/m]);

/** Et svar slik fetch leverer det, med headeren vi ber om å få. */
function svar(contentType, kropp) {
    return {
        headers: { get: () => contentType },
        text: async () => kropp,
        json: async () => JSON.parse(kropp)
    };
}

(async () => {
    // ---------- les(): headeren kan lyve ----------
    {
        // Dette er det ekte tilfellet: SWA setter JSON-headeren og sender
        // ren tekst. `response.json()` ville kastet her.
        const ut = await les(svar('application/json', 'Backend call failure'));
        sjekk('JSON-header med tekstkropp gir teksten, ikke et kast', ut, 'Backend call failure');

        sjekk('ekte JSON parses fortsatt',
            await les(svar('application/json; charset=utf-8', '{"status":"ok"}')), { status: 'ok' });

        sjekk('tekstsvar kommer ut som tekst',
            await les(svar('text/plain', 'bare tekst')), 'bare tekst');

        // Et tomt svar med JSON-header skal ikke bli til et kast heller.
        sjekk('tom kropp gir tom streng', await les(svar('application/json', '')), '');
    }

    // ---------- tolkFeiltekst(): årsaken skal stå i meldingen ----------
    {
        const m = tolkFeiltekst('Backend call failure', 500);
        sjekk('«Backend call failure» oversettes', m === 'Backend call failure', false);
        sjekk('og meldingen sier at kallet ble avbrutt', /avbrutt/i.test(m), true);
        sjekk('og nevner statuskoden', m.includes('500'), true);
        // Gjelder begge vertene: også en lenket Function App står bak
        // SWA-proxyen. Meldingen sa «SWA Managed Functions» til 27.10.2026, og
        // det var feil i v3-prod — der jobben dessuten gikk ferdig.
        sjekk('og sier at det gjelder begge vertene',
            /managed functions/i.test(m) && /function app/i.test(m), true);
        sjekk('og at arbeidet likevel kan ha gått', /likevel/.test(m), true);

        // Med innledende mellomrom, slik en proxy kan levere den.
        sjekk('tåler innledende mellomrom',
            /avbrutt/i.test(tolkFeiltekst('  Backend call failure\n', 502)), true);

        // Alt annet skal stå urørt — en oversetter som pynter på ekte
        // feilmeldinger er like skadelig som den som skjuler dem.
        sjekk('vanlige feilmeldinger er urørt',
            tolkFeiltekst('Fant ikke emne ING2307', 404), 'Fant ikke emne ING2307');
        sjekk('tom melding er urørt', tolkFeiltekst('', 500), '');
    }

    // ---------- kallene går gjennom api-klienten ----------
    //
    // Leses admin.html som tekst: ingen av FS-kallene skal gjøre et rått
    // `fetch` mot /api/. Det var nettopp forskjellen mellom de tre knappene
    // i samme panel — to gikk gjennom klienten, én gjorde ikke.
    {
        const admin = les_('frontend', 'admin.html');

        // Et rått `fetch` er RIKTIG i to tilfeller, og bare de to:
        //
        //   FormData-opplasting — `api.post` setter JSON-headeren og
        //   stringifyer kroppen, så en fil kan ikke gå den veien.
        //
        //   Binær nedlasting — svaret leses som blob, ikke som JSON.
        //
        // Alt annet hører hjemme i klienten. En håndholdt unntaksliste ville
        // drevet fra virkeligheten; her leses KALLSTEDET i stedet, så regelen
        // gjelder også kall som ikke finnes ennå.
        const unntatt = (vindu) => /FormData|body:\s*fd\b|\.blob\(\)|content-disposition/i.test(vindu);
        const funn = [];
        for (const m of admin.matchAll(/\bfetch\(\s*['"`]\/api\/[^'"`]*['"`]/g)) {
            const vindu = admin.slice(Math.max(0, m.index - 500), m.index + 400);
            if (!unntatt(vindu)) funn.push(m[0]);
        }
        sjekk('rå fetch mot /api/ bare for filopplasting og nedlasting', funn, []);

        // Og de lovlige finnes faktisk — ellers er regelen over grønn fordi
        // det ikke er noe igjen å måle.
        const alle = [...admin.matchAll(/\bfetch\(\s*['"`]\/api\/[^'"`]*['"`]/g)].length;
        sjekk('det finnes lovlige rå fetch å skille fra', alle > 3, true);

        // Og diagnosen skal faktisk kalles — ellers er sjekken over grønn
        // fordi knappen er borte.
        sjekk('diagnosen kalles via api.post',
            /api\.post\(\s*['"`]\/api\/refresh-fs\/diag['"`]/.test(admin), true);
    }

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
})().catch(e => {
    console.log('FEIL  testen kastet:', e.message);
    console.log(e.stack);
    process.exit(1);
});
