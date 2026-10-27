/**
 * Knapper som starter en jobb skal skille «ingen svar» fra «feil».
 *
 * 27.10.2026 meldte «Trigg full refresh» i v3-prod:
 *
 *     Feil: Backend-kallet ble avbrutt av SWA (500).
 *
 * mens statusraden rett over sto på `ok`, 348 rader, 132,8 s. På en Function
 * App venter ruta på jobben (api/src/lib/bakgrunn.js), og SWA-proxyen gir opp
 * lenge før en jobb på to minutter er ferdig. Jobben gikk fint; meldingen sa
 * det motsatte. Jobber-fanen visste om dette — de andre knappene hadde hver
 * sin catch og visste det ikke.
 *
 * Tre ting holdes fast:
 *
 *   **api-klienten merker tidsavbruddet** (`e.tidsavbrudd`, alltid en
 *   boolean), slik at ingen kallested må kjenne SWA-teksten.
 *
 *   **`startJobb` gjør det om til «ingen svar»**, og kaster alt annet videre.
 *   En 500 fra en jobb som faktisk feilet er fortsatt en feil.
 *
 *   **Hver jobbrute i admin.html går gjennom `startJobb`.** Rutene leses ut
 *   av API-et — jobbregisteret og rutene som pakker inn `startBakgrunnsjobb`
 *   — ikke av en liste skrevet her.
 *
 * Kjøres med:  node frontend/test/jobbknapper.test.js
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
const les = (...p) => fs.readFileSync(path.join(rot, ...p), 'utf8');
const admin = les('frontend', 'admin.html');
const klient = les('frontend', 'js', 'api-client.js');

/** Klipp ut én funksjon på toppnivå i script-blokka (åtte mellomrom inn). */
function klipp(navn) {
    for (const innledning of [`async function ${navn}(`, `function ${navn}(`]) {
        const start = admin.indexOf(innledning);
        if (start === -1) continue;
        const slutt = admin.indexOf('\n        }', start) + '\n        }'.length;
        return admin.slice(start, slutt);
    }
    throw new Error(`Fant ikke ${navn} i admin.html`);
}

/**
 * `utfør` fra api-klienten, kjørt mot et stubbet `fetch`. Hele modulen
 * lastes som tekst med eksportene strippet — den ekte koden, ikke en kopi.
 */
function klientMed(fetchSvar) {
    const kode = klient.replace(/^export const api/m, 'const api');
    return new Function('fetch', 'window', `${kode}\nreturn { utfør, api };`)(
        async () => fetchSvar, { location: { pathname: '/', search: '' } });
}

/** Et svar slik fetch leverer det. */
function svar(status, contentType, kropp) {
    return {
        status, ok: status >= 200 && status < 300, statusText: '', redirected: false,
        headers: { get: (h) => (h.toLowerCase() === 'content-type' ? contentType : null) },
        text: async () => kropp
    };
}

async function kastet(fn) {
    try { await fn(); return null; } catch (e) { return e; }
}

(async () => {
    // ---------- 1. klienten merker tidsavbruddet ----------
    {
        // Den ekte formen: JSON-header, tekstkropp, 500.
        const { api } = klientMed(svar(500, 'application/json', 'Backend call failure'));
        const e = await kastet(() => api.post('/api/refresh-fs', {}));
        sjekk('SWA-tidsavbrudd kaster', e instanceof Error, true);
        sjekk('og er merket som tidsavbrudd', e && e.tidsavbrudd, true);
        sjekk('statuskoden følger med', e && e.status, 500);

        // En jobb som FEILET svarer 500 med JSON fra jobbSvar. Det er en feil.
        const { api: api2 } = klientMed(svar(500, 'application/json',
            JSON.stringify({ status: 'feil', melding: 'Jobben feilet — FS svarte 503' })));
        const e2 = await kastet(() => api2.post('/api/refresh-fs', {}));
        sjekk('en ekte feil er IKKE et tidsavbrudd', e2 && e2.tidsavbrudd, false);
        sjekk('og meldingen er jobbens', e2 && e2.message, 'Jobben feilet — FS svarte 503');

        // Feltet er alltid satt — en nøkkel som kan forsvinne kan ikke feilsøkes.
        const { api: api3 } = klientMed(svar(404, 'text/plain', 'Fant ikke'));
        const e3 = await kastet(() => api3.get('/api/x'));
        sjekk('tekstfeil har feltet satt til false', e3 && e3.tidsavbrudd, false);
    }

    // ---------- 2. startJobb og banneret ----------
    {
        const escHtml = require('../js/escape.js').escapeHtml;
        const lag = (post) => new Function('api', 'escHtml', `
            ${klipp('startJobb')}
            ${klipp('jobbUtfallHtml')}
            return { startJobb, jobbUtfallHtml };
        `)({ post }, escHtml);

        const tidsavbrudd = Object.assign(new Error('avbrutt'), { tidsavbrudd: true });
        const { startJobb, jobbUtfallHtml } = lag(async () => { throw tidsavbrudd; });
        const u = await startJobb('/api/refresh-fs');
        sjekk('tidsavbrudd gir «uten svar»', u, { svar: null, utenSvar: true });
        const html = jobbUtfallHtml(u, 'Trykk Oppdater.');
        sjekk('banneret er en advarsel, ikke en feil',
            /banner advarsel/.test(html) && !/banner feil/.test(html), true);
        sjekk('og sier at jobben kan ha gått', /kan ha gått ferdig/.test(html), true);

        const ekte = Object.assign(new Error('Jobben feilet — x'), { tidsavbrudd: false });
        const { startJobb: s2 } = lag(async () => { throw ekte; });
        sjekk('en ekte feil kastes videre', await kastet(() => s2('/api/x')), ekte);

        // Et gammelt Error uten feltet er en feil, ikke et tidsavbrudd.
        const { startJobb: s3 } = lag(async () => { throw new Error('nett'); });
        sjekk('uten feltet er det en feil', (await kastet(() => s3('/api/x'))).message, 'nett');

        const { startJobb: s4, jobbUtfallHtml: h4 } = lag(async (sti, body) => ({ status: 'ferdig', melding: `ok ${sti} ${JSON.stringify(body)}` }));
        const f = await s4('/api/a', { modus: 'delta' });
        sjekk('svaret og kroppen går gjennom', f, { svar: { status: 'ferdig', melding: 'ok /api/a {"modus":"delta"}' }, utenSvar: false });
        sjekk('ferdig sier ferdig', /✓ Ferdig/.test(h4(f, '')), true);
        sjekk('startet sier startet',
            /✓ Startet 12:00/.test(h4({ svar: { status: 'startet', startet: '12:00' }, utenSvar: false }, '')), true);
        sjekk('ingenting havner uescapet',
            h4({ svar: { status: 'ferdig', melding: '<img>' }, utenSvar: false }, '').includes('<img>'), false);
    }

    // ---------- 3. hver jobbrute går gjennom startJobb ----------
    {
        // Rutene fra API-et selv: jobbregisteret, og hver app.http som
        // pakker inn startBakgrunnsjobb.
        const ruter = new Set(require('../../api/src/lib/jobber.js').JOBBER.map(j => j.rute));
        const fnMappe = path.join(rot, 'api', 'src', 'functions');
        for (const fil of fs.readdirSync(fnMappe).filter(f => f.endsWith('.js'))) {
            const kilde = fs.readFileSync(path.join(fnMappe, fil), 'utf8');
            for (const blokk of kilde.split(/\bapp\.http\(/).slice(1)) {
                const rute = /route:\s*'([^']+)'/.exec(blokk);
                if (rute && /startBakgrunnsjobb\(/.test(blokk)) ruter.add(rute[1]);
            }
        }
        sjekk('fant jobbrutene', ['refresh-fs', 'backup/kjor', 'backup/kjor-eksternt',
            'backup/verifiser-lagret'].every(r => ruter.has(r)), true);

        const raa = [];
        for (const r of ruter) {
            const re = new RegExp(`api\\.post\\(\\s*['"\`]/api/${r.replace(/[/.]/g, '\\$&')}(['"\`?])`);
            if (re.test(admin)) raa.push(r);
        }
        sjekk('ingen jobbrute postes forbi startJobb', raa, []);

        // Og knappene finnes — ellers er regelen grønn fordi de er borte.
        for (const r of ['refresh-fs', 'postnumre/refresh-bring', 'backup/kjor',
            'backup/kjor-eksternt', 'backup/verifiser-lagret']) {
            sjekk(`${r} går via startJobb`,
                new RegExp(`startJobb\\(\\s*'/api/${r.replace(/[/.]/g, '\\$&')}'`).test(admin), true);
        }
        sjekk('Jobber-fanen går via startJobb', admin.includes('startJobb(`/api/${j.rute}`)'), true);
        sjekk('oppslagslistene går via startJobb', /async function oppslagKjor[\s\S]{0,200}startJobb\(url\)/.test(admin), true);
    }

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
})().catch(e => {
    console.log('FEIL  testen kastet:', e.message);
    console.log(e.stack);
    process.exit(1);
});
