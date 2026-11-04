/**
 * Kopier-lenkene bruker den offentlige adressen (SWA_URL), ikke nettleserens.
 *
 * Meldt 04.11.2026: lenker som ble delt, bar `*.azurestaticapps.net` etter at
 * domenet var flyttet. API-et bygde sine lenker av SWA_URL; kopier-knappene i
 * grensesnittet bygde dem av `location.origin` — adressen til den som
 * kopierte. To regler for samme spørsmål.
 *
 * Testen kjører den ekte ping-handleren og den ekte modulen, og krever at
 * ingen side bygger lenker av `location.origin` på egen hånd lenger.
 *
 * Kjøres med:  node frontend/test/offentlig-adresse.test.js
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { pathToFileURL } = require('url');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const rot = path.join(__dirname, '..', '..');
const frontend = path.join(rot, 'frontend');

(async () => {
    // ---------- 1. ping oppgir adressen ----------
    {
        let handler = null;
        const ekteLoad = Module._load;
        Module._load = function (forespurt, ...rest) {
            if (forespurt === '@azure/functions') return { app: { http(_n, o) { handler = o.handler; }, timer() {} } };
            return ekteLoad.call(this, forespurt, ...rest);
        };
        try { require(path.join(rot, 'api', 'src', 'functions', 'ping.js')); }
        finally { Module._load = ekteLoad; }
        sjekk('fant ping-handleren', typeof handler, 'function');

        const req = { headers: { get: () => null } };
        process.env.SWA_URL = 'https://www.fskjema.no/';
        sjekk('ping gir SWA_URL uten skråstrek', (await handler(req, {})).jsonBody.offentligAdresse, 'https://www.fskjema.no');
        delete process.env.SWA_URL;
        // Nøkkelen står alltid: null, ikke borte, når verdien mangler.
        const uten = (await handler(req, {})).jsonBody;
        sjekk('uten SWA_URL er den null, ikke borte', 'offentligAdresse' in uten && uten.offentligAdresse === null, true);
    }

    // ---------- 2. modulen, kjørt ----------
    const url = pathToFileURL(path.join(frontend, 'js', 'offentlig-adresse.js')).href;
    /** Ny modulinstans med gitt ping-svar (query-strengen gir ny instans). */
    async function med(svar, n) {
        global.window = { location: { origin: 'https://gentle-dune-00a313603.7.azurestaticapps.net' } };
        let kall = 0;
        global.fetch = async () => {
            kall++;
            if (svar instanceof Error) throw svar;
            return { ok: true, json: async () => svar };
        };
        const m = await import(`${url}?n=${n}`);
        const før = m.offentligAdresse();
        const etter = await m.lastOffentligAdresse();
        await m.lastOffentligAdresse();
        return { før, etter, nå: m.offentligAdresse(), kall: () => kall };
    }
    {
        const r = await med({ offentligAdresse: 'https://www.fskjema.no' }, 1);
        sjekk('før svaret: nettleserens', r.før, 'https://gentle-dune-00a313603.7.azurestaticapps.net');
        sjekk('etter svaret: den offentlige', [r.etter, r.nå], ['https://www.fskjema.no', 'https://www.fskjema.no']);
        sjekk('hentes én gang', r.kall(), 1);
    }
    sjekk('ping nås ikke: nettleserens', (await med(new Error('nede'), 2)).nå, 'https://gentle-dune-00a313603.7.azurestaticapps.net');
    sjekk('SWA_URL ikke satt: nettleserens', (await med({ offentligAdresse: null }, 3)).nå, 'https://gentle-dune-00a313603.7.azurestaticapps.net');
    sjekk('ikke https avvises', (await med({ offentligAdresse: 'javascript:alert(1)' }, 4)).nå, 'https://gentle-dune-00a313603.7.azurestaticapps.net');
    sjekk('med sti avvises', (await med({ offentligAdresse: 'https://a.no/x' }, 5)).nå, 'https://gentle-dune-00a313603.7.azurestaticapps.net');

    // ---------- 3. ingen side bygger lenker av location.origin selv ----------
    {
        const filer = [];
        for (const d of [frontend, path.join(frontend, 'js')]) {
            for (const f of fs.readdirSync(d)) if (/\.(html|js)$/.test(f)) filer.push(path.join(d, f));
        }
        const brukere = filer
            .filter(f => !f.endsWith('offentlig-adresse.js'))
            .filter(f => fs.readFileSync(f, 'utf8').split('\n')
                .some(l => /location\.origin/.test(l) && !/^\s*(\/\/|\*)/.test(l)))
            .map(f => path.relative(rot, f));
        sjekk('ingen bruker location.origin utenom modulen', brukere, []);

        const bruk = {
            'editor.html': /\$\{offentligAdresse\(\)\}\/index\.html\?skjematype_id=/,
            'rapporteditor.html': /\$\{offentligAdresse\(\)\}\/rapport\.html/,
            'admin.html': /\(await lastOffentligAdresse\(\)\) \+ '\/api\/logo\/'/,
            'index.html': /utkastLenke\(offentligAdresse\(\), skjematypeId, id\)/
        };
        for (const [fil, m] of Object.entries(bruk)) {
            sjekk(`${fil} bruker den offentlige adressen`, m.test(fs.readFileSync(path.join(frontend, fil), 'utf8')), true);
        }
    }

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
})().catch(e => { console.log('FEIL  testen kastet:', e.message, e.stack); process.exit(1); });
