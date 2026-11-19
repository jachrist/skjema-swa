/**
 * E-post via Graph for engangskode, utsending og purring — fase 1, andre del.
 *
 * Disse tre e-postene skrev flyten selv. Med EPOST_VEI=graph bygges teksten
 * i lib/epost-maler.js, og de går til EKSTERNE mottakere. Testen passer på:
 *
 *   - at det som kommer fra skjematypen, escapes, og at Markdown rendres
 *   - at standarden er uendret: uten EPOST_VEI går alt til flytene
 *   - at en kjøring sender høyst MAKS_PER_KJORING_GRAPH, og markerer bare
 *     de mottakerne som faktisk fikk e-posten
 *
 * Kjører de ekte jobbene, med lagringen stubbet og nettet stubbet.
 *
 * Kjøres med:  node api/test/graph-utsending.test.js
 */
const Module = require('module');
const path = require('path');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const maler = require('../src/lib/epost-maler');

// ---------- 1. malene ----------
{
    const u = maler.utsending({
        skjemanavn: 'Evaluering <script>', url: 'https://x.no/i?u="a"&b=1',
        skjemabeskrivelse: 'Les **dette** først', skjemabeskrivelseFormat: 'Markdown', avslutningsdato: '2026-12-01'
    });
    sjekk('utsending: emne', u.emne, 'Skjema til utfylling: Evaluering <script>');
    sjekk('utsending: navnet escapes i teksten', [/<script>/.test(u.html), /Evaluering &lt;script&gt;/.test(u.html)], [false, true]);
    sjekk('utsending: Markdown rendres', /<strong>dette<\/strong>/.test(u.html), true);
    sjekk('utsending: lenka escapes i attributtet', /href="https:\/\/x\.no\/i\?u=&quot;a&quot;&amp;b=1"/.test(u.html), true);
    sjekk('utsending: svarfrist som dato', /Svarfrist: <b>01\.12\.2026<\/b>/.test(u.html), true);
    const ren = maler.utsending({ skjemanavn: 'S', url: 'https://x', skjemabeskrivelse: 'Les **ikke** dette', skjemabeskrivelseFormat: 'Tekst' });
    sjekk('utsending: ren tekst rendres ikke', /<strong>/.test(ren.html), false);
    sjekk('utsending: uten frist, ingen fristlinje', /Svarfrist/.test(ren.html), false);

    const p = maler.purring({ skjemanavn: 'S', url: 'https://x', purretekst: 'Vi mangler <b>svaret</b> ditt.' });
    sjekk('purring: emne', p.emne, 'Påminnelse: S');
    sjekk('purring: egen purretekst, escapet', /Vi mangler &lt;b&gt;svaret&lt;\/b&gt; ditt\./.test(p.html), true);
    const p2 = maler.purring({ skjemanavn: 'S', url: 'https://x' });
    sjekk('purring: standardtekst uten egen', /ennå ikke fått svaret ditt/.test(p2.html), true);

    const e = maler.engangskode({ kode: '123456', gyldigMinutter: 15 });
    sjekk('engangskode: koden står i teksten', /123456/.test(e.html), true);
    sjekk('engangskode: varigheten', /15 minutter/.test(e.html), true);
}

// ---------- felles nett og miljø ----------
const VARER = ['EPOST_VEI', 'EPOST_AVSENDER', 'IDENTITY_ENDPOINT', 'IDENTITY_HEADER', 'AZURE_CLIENT_ID',
    'VARSLING_FLOW_URL', 'OTP_FLOW_URL', 'VARSLING_DEAKTIVERT', 'SWA_URL', 'MILJO'];
const GRAPH = {
    IDENTITY_ENDPOINT: 'https://identitet.invalid/msi/token', IDENTITY_HEADER: 'H', AZURE_CLIENT_ID: 'klient',
    EPOST_VEI: 'graph', EPOST_AVSENDER: 'skjema@dev.no', SWA_URL: 'https://skjema.dev.no',
    VARSLING_FLOW_URL: 'https://flyt.invalid/varsling', OTP_FLOW_URL: 'https://flyt.invalid/otp'
};
let kall = [], graphSvar = {};  // graphSvar: mottaker → status
const ekteFetch = globalThis.fetch;
globalThis.fetch = async (u, opts = {}) => {
    const url = String(u);
    const svar = (status, body = '') => ({ status, ok: status < 300, headers: { get: () => null },
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), json: async () => body });
    if (url.startsWith('https://identitet.invalid')) return svar(200, { access_token: 'T', expires_on: String(Math.floor(Date.now() / 1000) + 3600) });
    if (url.startsWith('https://graph.microsoft.com')) {
        const k = JSON.parse(opts.body);
        const til = k.message.toRecipients[0].emailAddress.address;
        kall.push({ hvor: 'graph', til, emne: k.message.subject, html: k.message.body.content });
        return svar(graphSvar[til] || 202, { error: { code: 'ErrorAccessDenied' } });
    }
    kall.push({ hvor: 'flyt', url, kropp: JSON.parse(opts.body || '{}') });
    return svar(200, '{}');
};
async function medMiljo(env, f) {
    const foer = {};
    for (const n of VARER) { foer[n] = process.env[n]; if (env[n] === undefined) delete process.env[n]; else process.env[n] = env[n]; }
    require('../src/lib/graph-epost')._glemToken();
    kall = []; graphSvar = {};
    try { return await f(); } finally {
        for (const [n, v] of Object.entries(foer)) { if (v === undefined) delete process.env[n]; else process.env[n] = v; }
    }
}

// Jobben med lagringen stubbet. Stubbene settes bare for utsending-jobb.js
// sine egne avhengigheter; graph-epost, flyt-kaller og malene er ekte.
let kandidater = [], markert = [];
const STUBBER = {
    './utsending-storage': {
        listForfalteUtsendinger: async () => kandidater,
        listUbesvarte: async () => kandidater,
        markerSendt: async (b, m) => { markert.push(['sendt', m]); },
        markerPurret: async (b, m) => { markert.push(['purret', m]); }
    },
    './utsending-token': { utsted: ({ mottaker }) => `tok-${mottaker}` },
    './skjema-storage': { hentSkjematype: async () => ({ navn: 'Emneevaluering', JSON: { Skjemaforklaring: { Innhold: 'Hei **alle**', Format: 'Markdown' } } }) },
    './hendelser-storage': { logg: () => {} },
    './storage': { tabellKlient: () => ({ upsertEntity: async () => {} }) }
};
const ekteLoad = Module._load;
Module._load = function (f, forelder, ...r) {
    if (forelder && /utsending-jobb\.js$/.test(forelder.filename || '') && STUBBER[f]) return STUBBER[f];
    return ekteLoad.call(this, f, forelder, ...r);
};
const jobb = require('../src/lib/utsending-jobb');
const flytKaller = require('../src/lib/flyt-kaller');
Module._load = ekteLoad;

const lagKandidater = (n, ekstra = {}) => Array.from({ length: n }, (_, i) => ({
    BatchId: 'B1', Mottaker: `m${i}@ekstern.no`, SkjematypeId: '70', Jti: `j${i}`,
    Opprettet: new Date().toISOString(), Purretekst: '', Avslutningsdato: '2026-12-01', KanalHint: 'epost', ...ekstra
}));

(async () => {
    // ---------- 2. utsending via Graph ----------
    await medMiljo(GRAPH, async () => {
        kandidater = lagKandidater(30); markert = [];
        const r = await jobb.kjorSendForfalte({ kilde: 'test' });
        sjekk('utsending: høyst MAKS per kjøring', hvor('graph').length, jobb.MAKS_PER_KJORING_GRAPH);
        sjekk('utsending: de sendte er markert', markert.length, jobb.MAKS_PER_KJORING_GRAPH);
        sjekk('utsending: resten tas neste kjøring', r.gjenstaar, 30 - jobb.MAKS_PER_KJORING_GRAPH);
        sjekk('utsending: utfall ok', r.utfall, 'ok');
        sjekk('utsending: flyten kalles ikke', hvor('flyt').length, 0);
        const e = hvor('graph')[0];
        sjekk('utsending: personlig lenke til mottakeren', /utsending=tok-m0%40ekstern\.no/.test(e.html), true);
        sjekk('utsending: emnet fra malen', e.emne, 'Skjema til utfylling: Emneevaluering');
    });

    await medMiljo(GRAPH, async () => {
        kandidater = lagKandidater(3); markert = [];
        graphSvar['m1@ekstern.no'] = 403;
        const r = await jobb.kjorSendForfalte({ kilde: 'test' });
        sjekk('feil for én: de andre markeres', markert.map(m => m[1]), ['m0@ekstern.no', 'm2@ekstern.no']);
        sjekk('feil for én: utfall delvis', r.utfall, 'delvis');
        sjekk('feil for én: årsaken følger med', /m1@ekstern\.no: Graph svarte 403/.test(r.feil || ''), true);
    });

    await medMiljo(GRAPH, async () => {
        kandidater = [...lagKandidater(1), ...lagKandidater(1, { Mottaker: '+4791234567', KanalHint: 'sms' })]; markert = [];
        await jobb.kjorSendForfalte({ kilde: 'test' });
        sjekk('sms-kanal: ikke sendt via Graph', hvor('graph').map(g => g.til), ['m0@ekstern.no']);
        sjekk('sms-kanal: ikke markert', markert.map(m => m[1]), ['m0@ekstern.no']);
    });

    // ---------- 3. purring via Graph ----------
    await medMiljo(GRAPH, async () => {
        kandidater = lagKandidater(2, { Purretekst: 'Husk å svare!' }); markert = [];
        graphSvar['m0@ekstern.no'] = 403;
        const r = await jobb.kjorPurring({ kilde: 'test' });
        sjekk('purring: bare de som fikk e-post er markert', markert, [['purret', 'm1@ekstern.no']]);
        sjekk('purring: egen purretekst i e-posten', /Husk å svare!/.test(hvor('graph')[1].html), true);
        sjekk('purring: utfall delvis', r.utfall, 'delvis');
    });

    // ---------- 4. standard og bryter ----------
    await medMiljo({ ...GRAPH, EPOST_VEI: undefined }, async () => {
        kandidater = lagKandidater(30); markert = [];
        const r = await jobb.kjorSendForfalte({ kilde: 'test' });
        sjekk('standard: flyten får alle i ett kall', [hvor('flyt').length, hvor('flyt')[0]?.kropp.mottakere.length], [1, 30]);
        sjekk('standard: Graph kalles ikke', hvor('graph').length, 0);
        sjekk('standard: alle markert', [r.utfall, markert.length], ['ok', 30]);
    });
    await medMiljo({ ...GRAPH, VARSLING_DEAKTIVERT: 'true' }, async () => {
        kandidater = lagKandidater(3); markert = [];
        const r = await jobb.kjorSendForfalte({ kilde: 'test' });
        sjekk('deaktivert: ingenting sendt eller markert', [r.utfall, hvor('graph').length, markert.length], ['deaktivert', 0, 0]);
    });
    await medMiljo({ ...GRAPH, EPOST_AVSENDER: undefined }, async () => {
        kandidater = lagKandidater(3); markert = [];
        const r = await jobb.kjorSendForfalte({ kilde: 'test' });
        sjekk('uten avsender: feil, ingenting markert, ikke til flyten', [r.utfall, markert.length, hvor('flyt').length], ['feil', 0, 0]);
    });

    // ---------- 5. engangskoden ----------
    await medMiljo(GRAPH, async () => {
        const r = await flytKaller.sendOtpViaFlyt({ kanal: 'epost', mottaker: 'ekstern@x.no', kode: '654321', gyldigMinutter: 10 });
        sjekk('otp: sendt via Graph', [r.status, hvor('graph').length, hvor('flyt').length], ['ok', 1, 0]);
        sjekk('otp: koden i e-posten', /654321/.test(hvor('graph')[0].html), true);
    });
    await medMiljo({ ...GRAPH, EPOST_VEI: undefined }, async () => {
        await flytKaller.sendOtpViaFlyt({ kanal: 'epost', mottaker: 'ekstern@x.no', kode: '654321' });
        sjekk('otp standard: til OTP-flyten', [hvor('flyt').length, hvor('flyt')[0]?.url, hvor('graph').length], [1, 'https://flyt.invalid/otp', 0]);
    });
    await medMiljo({ ...GRAPH, VARSLING_DEAKTIVERT: 'true' }, async () => {
        const r = await flytKaller.sendOtpViaFlyt({ kanal: 'epost', mottaker: 'ekstern@x.no', kode: '1' });
        sjekk('otp deaktivert: ingenting sendt', [r.status, hvor('graph').length], ['deaktivert', 0]);
    });

    globalThis.fetch = ekteFetch;
    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
})().catch(e => { globalThis.fetch = ekteFetch; console.log('FEIL  testen kastet:', e.message, e.stack); process.exit(1); });

function hvor(h) { return kall.filter(k => k.hvor === h); }
