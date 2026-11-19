/**
 * E-post via Graph (lib/graph-epost.js) — fase 1, første del.
 *
 * Fire ting holdes fast:
 *
 *   **Standard er uendret.** Uten EPOST_VEI går alt til flyten, med den
 *   samme nyttelasten som før. Pilot og prod skal ikke merke at koden finnes.
 *
 *   **Bare e-posten flyttes.** Teams, Planner og Teams-kanal går fortsatt til
 *   flyten. Er e-post eneste kanal, kalles ikke flyten.
 *
 *   **Kopi blir én e-post med Cc.** Kopiadressene står også i `mottakere`
 *   (overgangsformen i flyt-kaller.js), og skal ikke få en ekstra e-post.
 *
 *   **Feilen sier hva som gikk galt.** Mangler identiteten, avsenderen eller
 *   tillatelsen, skal årsaken stå i svaret — ikke forsvinne.
 *
 * Kjøres med:  node api/test/graph-epost.test.js
 */
const Module = require('module');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const ge = require('../src/lib/graph-epost');
const flytKaller = require('../src/lib/flyt-kaller');

const VARER = ['EPOST_VEI', 'EPOST_AVSENDER', 'IDENTITY_ENDPOINT', 'IDENTITY_HEADER', 'AZURE_CLIENT_ID',
    'VARSLING_FLOW_URL', 'VARSLING_DEAKTIVERT', 'FLYT_AUTH', 'FLOW_CALLBACK_KEY', 'ADMIN_UPNS'];
const MI = {
    IDENTITY_ENDPOINT: 'https://identitet.invalid/msi/token', IDENTITY_HEADER: 'HEMMELIG',
    AZURE_CLIENT_ID: '11111111-2222-3333-4444-555555555555',
    VARSLING_FLOW_URL: 'https://flyt.invalid/varsling'
};
const GRAPH = { ...MI, EPOST_VEI: 'graph', EPOST_AVSENDER: 'skjema@dev.no' };

// Stubbet nett: identity-endepunktet, Graph og flyten hver for seg.
let kall = [];
let graphSvar = [];   // kø av { status, headers?, body? } — tom kø gir 202
const ekteFetch = globalThis.fetch;
const svar = (status, body = '', headere = {}) => ({
    status, ok: status >= 200 && status < 300,
    headers: { get: (n) => headere[String(n).toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? JSON.parse(body || '{}') : body)
});
globalThis.fetch = async (u, opts = {}) => {
    const url = String(u);
    if (url.startsWith('https://identitet.invalid')) {
        kall.push({ hvor: 'identitet', url });
        return svar(200, { access_token: 'GRAPH.TOKEN', expires_on: String(Math.floor(Date.now() / 1000) + 3600) });
    }
    if (url.startsWith('https://graph.microsoft.com')) {
        kall.push({ hvor: 'graph', url, opts, kropp: JSON.parse(opts.body || '{}') });
        const s = graphSvar.shift() || { status: 202 };
        return svar(s.status, s.body || '', s.headers || {});
    }
    kall.push({ hvor: 'flyt', url, kropp: JSON.parse(opts.body || '{}') });
    return svar(200, { ok: true });
};

async function medMiljo(env, f) {
    const foer = {};
    for (const n of VARER) {
        foer[n] = process.env[n];
        if (env[n] === undefined) delete process.env[n]; else process.env[n] = env[n];
    }
    ge._glemToken();
    kall = []; graphSvar = [];
    try { return await f(); } finally {
        for (const [n, v] of Object.entries(foer)) { if (v === undefined) delete process.env[n]; else process.env[n] = v; }
        ge._glemToken();
    }
}
const hvor = (h) => kall.filter(k => k.hvor === h);
const adr = (liste) => (liste || []).map(r => r.emailAddress.address);

const VARSEL = {
    handling: 'sendBehandlingsVarsling', emne: 'Til behandling', html: '<p>Hei</p>',
    mottakere: [{ epost: 'a@dev.no', navn: 'A' }, { epost: 'b@dev.no' }]
};

(async () => {
    // ---------- 1. veien ----------
    sjekk('usatt → flyt', ge.epostVei({}).vei, 'flyt');
    sjekk('graph med avsender → graph', [ge.epostVei({ EPOST_VEI: 'graph', EPOST_AVSENDER: 's@x.no' }).vei,
        ge.epostVei({ EPOST_VEI: 'graph', EPOST_AVSENDER: 's@x.no' }).gyldig], ['graph', true]);
    sjekk('GRAPH med mellomrom → graph', ge.epostVei({ EPOST_VEI: ' GRAPH ', EPOST_AVSENDER: 's@x.no' }).vei, 'graph');
    const tast = ge.epostVei({ EPOST_VEI: 'graf' });
    sjekk('tastefeil → flyt, og det sies', [tast.vei, /ikke er graph eller flyt/.test(tast.grunn)], ['flyt', true]);
    const utenAvs = ge.epostVei({ EPOST_VEI: 'graph' });
    sjekk('graph uten avsender → ugyldig, ikke flyt', [utenAvs.vei, utenAvs.gyldig], ['graph', false]);
    sjekk('alltid fire felt', [{}, { EPOST_VEI: 'graph' }, { EPOST_VEI: 'x' }]
        .every(e => Object.keys(ge.epostVei(e)).sort().join() === 'avsender,grunn,gyldig,vei'), true);

    // ---------- 2. hvem får hva ----------
    const p = (m, k) => ge.planlegg(m, k).map(e => [e.til.map(x => x.epost), e.kopi.map(x => x.epost)]);
    sjekk('uten kopi: én per mottaker', p([{ epost: 'a@x' }, { epost: 'b@x' }]), [[['a@x'], []], [['b@x'], []]]);
    sjekk('dubletter, uansett store bokstaver, slås sammen', p([{ epost: 'a@x' }, { epost: 'A@X' }]), [[['a@x'], []]]);
    // Overgangsformen: kopiadressen står også i mottakere.
    sjekk('kvittering med kopi: én e-post, kopi i Cc',
        p([{ epost: 'innsender@x' }, { epost: 'leder@x' }], [{ epost: 'leder@x' }]), [[['innsender@x'], ['leder@x']]]);
    sjekk('uten innsender: til første kopi, resten i Cc',
        p([{ epost: 'k1@x' }, { epost: 'k2@x' }], [{ epost: 'k1@x' }, { epost: 'k2@x' }]), [[['k1@x'], ['k2@x']]]);
    sjekk('flere hovedmottakere: kopien får én e-post',
        p([{ epost: 'a@x' }, { epost: 'b@x' }, { epost: 'k@x' }], [{ epost: 'k@x' }]), [[['a@x'], ['k@x']], [['b@x'], []]]);
    sjekk('tom liste', p([], []), []);

    // ---------- 3. én e-post: kallet til Graph ----------
    await medMiljo(GRAPH, async () => {
        const r = await ge.sendEnEpost({ til: [{ epost: 'a@dev.no', navn: 'A' }], kopi: [{ epost: 'k@dev.no' }], emne: 'E', html: '<p>H</p>' },
            { avsender: 'skjema@dev.no' });
        sjekk('202 er ok', [r.status, r.forsok], ['ok', 1]);
        const id = new URL(hvor('identitet')[0].url);
        sjekk('token for Graph', id.searchParams.get('resource'), 'https://graph.microsoft.com');
        sjekk('med identitetens klient-ID', id.searchParams.get('client_id'), MI.AZURE_CLIENT_ID);
        const g = hvor('graph')[0];
        sjekk('sendMail på avsenderens postboks', g.url, 'https://graph.microsoft.com/v1.0/users/skjema%40dev.no/sendMail');
        sjekk('Bearer-token', g.opts.headers.Authorization, 'Bearer GRAPH.TOKEN');
        sjekk('mottaker og kopi', [adr(g.kropp.message.toRecipients), adr(g.kropp.message.ccRecipients)], [['a@dev.no'], ['k@dev.no']]);
        sjekk('HTML', g.kropp.message.body.contentType, 'HTML');
        sjekk('identity-nøkkelen går ikke til Graph', /HEMMELIG/.test(JSON.stringify(g.opts)), false);
    });
    await medMiljo(GRAPH, async () => {
        await ge.sendEnEpost({ til: [{ epost: 'a@dev.no' }], emne: 'E', html: '' }, { avsender: 'skjema@dev.no' });
        sjekk('uten kopi: ingen ccRecipients', 'ccRecipients' in hvor('graph')[0].kropp.message, false);
    });

    // Struping: prøv igjen så lenge Retry-After sier.
    await medMiljo(GRAPH, async () => {
        graphSvar = [{ status: 429, headers: { 'retry-after': '2' } }, { status: 202 }];
        const ventet = [];
        const r = await ge.sendEnEpost({ til: [{ epost: 'a@dev.no' }], emne: 'E', html: '' },
            { avsender: 'skjema@dev.no', vent: async (ms) => { ventet.push(ms); } });
        sjekk('429 og så 202: ok på andre forsøk', [r.status, r.forsok], ['ok', 2]);
        sjekk('ventet så lenge Retry-After sa', ventet, [2000]);
    });
    await medMiljo(GRAPH, async () => {
        graphSvar = [{ status: 503 }, { status: 503 }, { status: 503 }, { status: 202 }];
        const r = await ge.sendEnEpost({ til: [{ epost: 'a@dev.no' }], emne: 'E', html: '' },
            { avsender: 'skjema@dev.no', vent: async () => {} });
        sjekk('gir opp etter tre forsøk', [r.status, r.forsok, hvor('graph').length], ['feil', ge.MAKS_FORSOK, 3]);
    });
    await medMiljo(GRAPH, async () => {
        graphSvar = [{ status: 403, body: { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } } }];
        const r = await ge.sendEnEpost({ til: [{ epost: 'a@dev.no' }], emne: 'E', html: '' },
            { avsender: 'skjema@dev.no', vent: async () => { throw new Error('skal ikke vente'); } });
        sjekk('403 er endelig', [r.status, r.forsok], ['feil', 1]);
        sjekk('og årsaken følger med', /403: ErrorAccessDenied/.test(r.melding), true);
    });
    // Ingen identitet: årsaken, og ingen kall til Graph.
    await medMiljo({ ...GRAPH, IDENTITY_ENDPOINT: undefined }, async () => {
        const r = await ge.sendEnEpost({ til: [{ epost: 'a@dev.no' }], emne: 'E', html: '' }, { avsender: 'skjema@dev.no' });
        sjekk('uten identitet: feil med årsak', [r.status, /ingen managed identity/.test(r.melding)], ['feil', true]);
        sjekk('og Graph kalles ikke', hvor('graph').length, 0);
    });

    // ---------- 4. varslingen: hvem går hvor ----------
    // STANDARD: uten EPOST_VEI går alt til flyten, som før.
    await medMiljo(MI, async () => {
        const r = await flytKaller.sendVarslerViaFlyt({ ...VARSEL, varslinger: ['epost', 'teams'] });
        sjekk('standard: flyten kalles', hvor('flyt').length, 1);
        sjekk('standard: med e-post i kanalene', hvor('flyt')[0].kropp.varslinger, ['epost', 'teams']);
        sjekk('standard: Graph kalles ikke', hvor('graph').length + hvor('identitet').length, 0);
        sjekk('standard: ok', r.status, 'ok');
    });

    await medMiljo(GRAPH, async () => {
        const r = await flytKaller.sendVarslerViaFlyt({ ...VARSEL, varslinger: ['epost'] });
        sjekk('bare e-post: én e-post per mottaker via Graph', hvor('graph').map(g => adr(g.kropp.message.toRecipients)), [['a@dev.no'], ['b@dev.no']]);
        sjekk('bare e-post: flyten kalles ikke', hvor('flyt').length, 0);
        sjekk('bare e-post: ok', r.status, 'ok');
        sjekk('emne og tekst fra varslingen', [hvor('graph')[0].kropp.message.subject, hvor('graph')[0].kropp.message.body.content],
            ['Til behandling', '<p>Hei</p>']);
    });

    await medMiljo(GRAPH, async () => {
        const r = await flytKaller.sendVarslerViaFlyt({ ...VARSEL, varslinger: ['epost', 'teams', 'planner'] });
        sjekk('e-post og Teams: e-posten via Graph', hvor('graph').length, 2);
        sjekk('og flyten får resten, uten e-post', hvor('flyt').map(f => f.kropp.varslinger), [['teams', 'planner']]);
        sjekk('og flyten har fortsatt teksten (Teams bruker den)', hvor('flyt')[0].kropp.epost_og_teams.emne, 'Til behandling');
        sjekk('begge ok → ok', r.status, 'ok');
    });

    // Varsling uten e-postkanal: urørt.
    await medMiljo(GRAPH, async () => {
        await flytKaller.sendVarslerViaFlyt({ ...VARSEL, varslinger: ['planner'] });
        sjekk('uten e-post: bare flyten', [hvor('flyt').length, hvor('graph').length], [1, 0]);
    });

    // Kvitteringen med kopi, i overgangsformen.
    await medMiljo(GRAPH, async () => {
        await flytKaller.sendVarslerViaFlyt({
            handling: 'sendInnsenderKvittering', emne: 'Kvittering', html: '',
            mottakere: [{ epost: 'innsender@dev.no' }, { epost: 'leder@dev.no' }],
            kopi: [{ epost: 'leder@dev.no' }]
        });
        sjekk('kvittering: én e-post', hvor('graph').length, 1);
        sjekk('kvittering: kopien i Cc', [adr(hvor('graph')[0].kropp.message.toRecipients), adr(hvor('graph')[0].kropp.message.ccRecipients)],
            [['innsender@dev.no'], ['leder@dev.no']]);
    });

    // VARSLING_DEAKTIVERT gjelder Graph-veien også.
    await medMiljo({ ...GRAPH, VARSLING_DEAKTIVERT: 'true' }, async () => {
        const r = await flytKaller.sendVarslerViaFlyt({ ...VARSEL, varslinger: ['epost'] });
        sjekk('deaktivert: ingenting sendes', [r.status, hvor('graph').length, hvor('identitet').length], ['deaktivert', 0, 0]);
    });

    // Satt opp feil: si fra, ikke send via flyten i det stille.
    await medMiljo({ ...GRAPH, EPOST_AVSENDER: undefined }, async () => {
        const r = await flytKaller.sendVarslerViaFlyt({ ...VARSEL, varslinger: ['epost'] });
        sjekk('uten avsender: feil med årsak', [r.status, /EPOST_AVSENDER/.test(r.melding)], ['feil', true]);
        sjekk('uten avsender: ikke til flyten heller', hvor('flyt').length, 0);
    });

    // Feil i én del sier hvilken.
    await medMiljo(GRAPH, async () => {
        graphSvar = [{ status: 403, body: { error: { code: 'ErrorAccessDenied' } } }, { status: 202 }];
        const r = await flytKaller.sendVarslerViaFlyt({ ...VARSEL, varslinger: ['epost', 'teams'] });
        sjekk('delvis feil: status feil', r.status, 'feil');
        sjekk('og meldingen sier at det var e-posten', /^e-post via Graph: 1 av 2/.test(r.melding), true);
        sjekk('og flyten ble likevel kalt for Teams', hvor('flyt').length, 1);
    });

    // ---------- 5. diagnosen ----------
    const ruter = {};
    const ekteLoad = Module._load;
    Module._load = function (f, ...r) {
        if (f === '@azure/functions') return { app: { http: (navn, def) => { ruter[def.route] = def.handler; } } };
        return ekteLoad.call(this, f, ...r);
    };
    try { require('../src/functions/varsling-diag'); } finally { Module._load = ekteLoad; }
    const som = (upn, body) => ({
        headers: { get: (n) => (n.toLowerCase() === 'x-ms-client-principal'
            ? Buffer.from(JSON.stringify({ userDetails: upn, userRoles: ['authenticated'] })).toString('base64') : null) },
        json: async () => body || {}
    });

    await medMiljo({ ...GRAPH, ADMIN_UPNS: 'admin@dev.no', VARSLING_FLOW_URL: undefined }, async () => {
        const d = (await ruter['varsling/diag'](som('admin@dev.no'), { log() {} })).jsonBody;
        sjekk('diag: Graph uten flyt-URL sender likevel', d.sender_ikke, false);
        sjekk('diag: viser veien', d.epost.vei, 'graph');

        sjekk('graph-test: bare admin', (await ruter['varsling/graph-test'](som('vanlig@dev.no'), {})).status, 403);
        const t = await ruter['varsling/graph-test'](som('admin@dev.no', { til: 'noen.andre@ekstern.no' }), {});
        sjekk('graph-test: sendt', t.jsonBody.status, 'ok');
        sjekk('graph-test: alltid til admin selv, aldri til en adresse fra kallet',
            hvor('graph').map(g => adr(g.kropp.message.toRecipients)), [['admin@dev.no']]);
    });
    await medMiljo({ ...MI, ADMIN_UPNS: 'admin@dev.no' }, async () => {
        const d = (await ruter['varsling/diag'](som('admin@dev.no'), { log() {} })).jsonBody;
        sjekk('diag: standard er flyt', d.epost.vei, 'flyt');
        // Prøven kan kjøres før EPOST_VEI er slått på, men trenger avsenderen.
        const t = await ruter['varsling/graph-test'](som('admin@dev.no'), {});
        sjekk('graph-test uten avsender: 400', t.status, 400);
    });
    await medMiljo({ ...MI, EPOST_AVSENDER: 'skjema@dev.no', ADMIN_UPNS: 'admin@dev.no' }, async () => {
        const t = await ruter['varsling/graph-test'](som('admin@dev.no'), {});
        sjekk('graph-test før EPOST_VEI er på: sender likevel', [t.jsonBody.status, t.jsonBody.epostVei.vei], ['ok', 'flyt']);
    });

    globalThis.fetch = ekteFetch;
    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
})().catch(e => { globalThis.fetch = ekteFetch; console.log('FEIL  testen kastet:', e.message, e.stack); process.exit(1); });
