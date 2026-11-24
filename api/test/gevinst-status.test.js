/**
 * Gevinstoppfølging i Skjematyper-oversikten, og slutten på purring av
 * «for-meg»-radene. Besluttet 24.11.2026.
 *
 *   1. Status per skjematype i produksjon (lib/gevinst-status.js):
 *      grønn = baseline og rapportering, gul = bare baseline, rød = ingen
 *      baseline, fritatt = admin har slått av kravet.
 *   2. Purresperren (utsending-storage.purresperre): rader laget av editoren
 *      for gevinstlenkene ble purret som utsendinger. Nye rader har
 *      `IkkePurr`; rader fra før kjennes igjen på formen.
 *   3. POST /api/gevinst/lenke — en forhåndsutfylt, personlig lenke til
 *      skjemaet som mangler, som admin sender selv. Purres ikke.
 *   4. POST /api/gevinst/fritak — kravet av eller på.
 *
 * Kjøres med:  node api/test/gevinst-status.test.js
 */
const Module = require('module');
const fs = require('fs');
const path = require('path');
const { utenKommentarer } = require('../../scripts/test-kilde.js');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const { gevinstStatus, STATUS_TEKST } = require('../src/lib/gevinst-status');

// ---------- 1. status ----------
{
    const rad = (id, fase = 'Produksjon') => ({ Skjematype_id: id, Fase: fase });
    const rader = [rad('1'), rad('2'), rad('3'), rad('4'), rad('5'), rad('6', 'Utvikling'), rad('90'), rad('91')];
    const g = { baselineTypeId: '90', rapportTypeId: '91',
        baseline: new Set(['1', '2', '4']), rapport: new Set(['1', '5']), fritatt: new Set(['4']) };
    const s = gevinstStatus(rader, g);
    const st = (id) => s.get(id)?.status ?? null;
    sjekk('begge sendt inn: grønn', st('1'), 'gronn');
    sjekk('bare baseline: gul', st('2'), 'gul');
    sjekk('ingenting: rød', st('3'), 'rod');
    sjekk('fritatt slår fargen', [st('4'), s.get('4').krav], ['fritatt', false]);
    sjekk('rapport uten baseline: rød — baseline kommer først', st('5'), 'rod');
    sjekk('ikke i produksjon: ingen status', st('6'), null);
    sjekk('gevinstskjemaene selv: ingen status', [st('90'), st('91')], [null, null]);
    sjekk('uten baseline satt opp: ingen status', gevinstStatus(rader, { ...g, baselineTypeId: null }).get('3'), null);
    sjekk('alle statuser har tekst til eksporten', ['gronn', 'gul', 'rod', 'fritatt'].every(k => !!STATUS_TEKST[k]), true);
}

// ---------- 2. purresperren ----------
(async () => {
    const lager = [];
    const ekteLoad = Module._load;
    Module._load = function (f, forelder, ...r) {
        if (f === './storage' && /utsending-storage\.js$/.test(forelder?.filename || '')) {
            const t = { listEntities: async function* () { for (const e of lager) yield e; }, upsertEntity: async () => {} };
            return { tabellKlient: () => t, sikreTabell: async () => t, odata: () => '' };
        }
        return ekteLoad.call(this, f, forelder, ...r);
    };
    let us;
    try { us = require('../src/lib/utsending-storage'); } finally { Module._load = ekteLoad; }

    const gammel = new Date(Date.now() - 5 * 86400000).toISOString();
    const rad = (pk, rk, ekstra = {}) => ({ partitionKey: pk, rowKey: rk, Opprettet: gammel, OpprettetAv: 'admin@x.no', ...ekstra });
    lager.push(
        rad('gevinst-gevinstestimat-kari@x.no-90', 'kari@x.no', { OpprettetAv: 'kari@x.no' }),   // for-meg fra før
        rad('gevinst-baseline-12', 'ola@x.no', { IkkePurr: true }),                              // ny gevinstlenke
        rad('emneevaluering-26h', 'student@x.no'),                                               // vanlig utsending
        rad('batch-til-meg', 'admin@x.no', { OpprettetAv: 'admin@x.no' })                        // admin til seg selv
    );
    const ubesvarte = (await us.listUbesvarte()).map(u => u.BatchId);
    sjekk('for-meg fra før: purres ikke', ubesvarte.includes('gevinst-gevinstestimat-kari@x.no-90'), false);
    sjekk('IkkePurr: purres ikke', ubesvarte.includes('gevinst-baseline-12'), false);
    sjekk('vanlig utsending: purres fortsatt', ubesvarte.includes('emneevaluering-26h'), true);
    // Bare formen for-meg gir — ikke enhver rad der admin sendte til seg selv.
    sjekk('admin til seg selv i en vanlig batch: purres', ubesvarte.includes('batch-til-meg'), true);

    const forMeg = utenKommentarer(fs.readFileSync(path.join(__dirname, '..', 'src', 'functions', 'utsending.js'), 'utf8'));
    const del = forMeg.slice(forMeg.indexOf("route: 'utsending/for-meg'"), forMeg.indexOf("route: 'utsending/for-meg'") + 4000);
    sjekk('for-meg lager nye rader med ikkePurr', (del.match(/ikkePurr:\s*true/g) || []).length, 2);

    // ---------- 3 og 4. endepunktene ----------
    process.env.OTP_HMAC_KEY = process.env.OTP_HMAC_KEY || 'test-nokkel-som-er-lang-nok-til-hmac';
    process.env.SWA_URL = 'https://skjema.x.no';
    process.env.ADMIN_UPNS = 'admin@x.no';
    const innst = new Map([['Gevinstestimat.SkjemaId', '90']]);
    const innstStorage = require('../src/lib/innstillinger-storage');
    innstStorage.hent = async (n) => (innst.has(n) ? { Nokkel: n, Verdi: innst.get(n) } : null);
    innstStorage.sett = async (n, v) => { innst.set(n, v); };
    require('../src/lib/skjema-storage').hentSkjematype = async (id) => (id === '12' ? { id: '12', navn: 'Permisjon', JSON: {} } : null);
    const opprettet = [];
    us.opprett = async (r) => { opprettet.push(r); };
    require('../src/lib/hendelser-storage').logg = () => {};

    const ruter = {};
    Module._load = function (f, ...r) {
        if (f === '@azure/functions') return { app: { http: (n, d) => { ruter[d.route] = d.handler; } } };
        return ekteLoad.call(this, f, ...r);
    };
    try { require('../src/functions/gevinst'); } finally { Module._load = ekteLoad; }
    const som = (upn, body) => ({
        headers: { get: (n) => (n.toLowerCase() === 'x-ms-client-principal' && upn
            ? Buffer.from(JSON.stringify({ userDetails: upn, userRoles: ['authenticated'] })).toString('base64') : null) },
        json: async () => body
    });
    const lenke = ruter['gevinst/lenke'];
    sjekk('lenke: bare admin', (await lenke(som('ola@x.no', { skjematypeId: '12', hva: 'baseline', mottaker: 'ola@x.no' }), { log() {} })).status, 403);
    sjekk('lenke: ugyldig hva', (await lenke(som('admin@x.no', { skjematypeId: '12', hva: 'noe', mottaker: 'ola@x.no' }), { log() {} })).status, 400);
    sjekk('lenke: mottaker må være e-post', (await lenke(som('admin@x.no', { skjematypeId: '12', hva: 'baseline', mottaker: 'ola' }), { log() {} })).status, 400);
    sjekk('lenke: rapportskjema ikke satt opp gir 400', (await lenke(som('admin@x.no', { skjematypeId: '12', hva: 'rapport', mottaker: 'ola@x.no' }), { log() {} })).status, 400);

    const r = await lenke(som('admin@x.no', { skjematypeId: '12', hva: 'baseline', mottaker: 'Ola@X.no' }), { log() {} });
    sjekk('lenke: ok', r.jsonBody?.status, 'ok');
    const o = opprettet.at(-1);
    sjekk('lenke: til baseline-skjemaet', o.skjematypeId, '90');
    sjekk('lenke: forhåndsutfylt med skjematypen', o.prefilled, { '1-01': ['12'], '1-02': ['Permisjon'] });
    sjekk('lenke: til mottakeren, med små bokstaver', o.mottaker, 'ola@x.no');
    sjekk('lenke: egen batch per skjematype', o.batchId, 'gevinst-baseline-12');
    sjekk('lenke: purres ikke', o.ikkePurr, true);
    sjekk('lenke: personlig utsendingslenke', /^https:\/\/skjema\.x\.no\/index\.html\?utsending=/.test(r.jsonBody.url), true);

    const fritak = ruter['gevinst/fritak'];
    sjekk('fritak: bare admin', (await fritak(som('ola@x.no', { skjematypeIder: ['12'], fritatt: true }), { log() {} })).status, 403);
    sjekk('fritak: fritatt må være boolsk', (await fritak(som('admin@x.no', { skjematypeIder: ['12'], fritatt: 'ja' }), { log() {} })).status, 400);
    sjekk('fritak: slå av', (await fritak(som('admin@x.no', { skjematypeIder: ['12', '3'], fritatt: true }), { log() {} })).jsonBody.fritatte, ['3', '12']);
    sjekk('fritak: slå på igjen', (await fritak(som('admin@x.no', { skjematypeIder: ['12'], fritatt: false }), { log() {} })).jsonBody.fritatte, ['3']);

    // ---------- 5. oversikten og siden ----------
    const les = (...p) => utenKommentarer(fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8'));
    const endepunkt = les('api', 'src', 'functions', 'skjematype-oversikt.js');
    sjekk('oversikten bruker statusregelen', /gevinstStatus\(rader,\s*gevinst\)/.test(endepunkt), true);
    const admin = les('frontend', 'admin.html');
    const tabell = admin.slice(admin.indexOf('function byggOversiktTabell'), admin.indexOf('function oversiktRad'));
    sjekk('tabellen har ikke Mellomlagret-kolonnen', /Mellomlagret/.test(tabell), false);
    sjekk('tabellen har Gevinst-kolonnen', /<th[^>]*>Gevinst<\/th>/.test(tabell), true);
    sjekk('siden avgjør ikke fargen selv', /g\.status/.test(admin) && !/baseline\s*&&\s*rapport/.test(admin), true);
    // Bare streker i kolonnen: siden skal si hvorfor, og skille gammelt API
    // fra baseline som ikke er valgt.
    const rå = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'admin.html'), 'utf8');
    const kilde = rå.slice(rå.indexOf('function gevinstMangler'), rå.indexOf('function gevinstCelle'));
    const gevinstMangler = new Function(`${kilde}; return gevinstMangler;`)();
    sjekk('melding: gammelt API', /eldre versjon/.test(gevinstMangler({ rader: [] })), true);
    sjekk('melding: baseline ikke valgt', /ikke valgt/.test(gevinstMangler({ gevinst: { konfigurert: false } })), true);
    sjekk('meldingen vises når status mangler', /:\s*gevinstMangler\(data\)/.test(admin), true);
    const eksport = require('../src/lib/skjematype-oversikt').EKSPORT_KOLONNER.map(k => k[0]);
    sjekk('eksporten har fortsatt Mellomlagret, og Gevinst', [eksport.includes('Mellomlagret'), eksport.includes('Gevinst')], [true, true]);

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
})().catch(e => { console.log('FEIL  testen kastet:', e.message, e.stack); process.exit(1); });
