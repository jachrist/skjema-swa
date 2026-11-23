/**
 * Månedsvarselet om ubrukte skjematyper med M365-kobling (lib/ubrukt-varsel.js).
 *
 * Testen passer på at varselet går til de rette, og ikke til de gale:
 *
 *   - ubrukt = både siste bruk OG siste endring er eldre enn grensen. En ny
 *     skjematype, eller en noen jobber med, skal ikke få varsel.
 *   - en skjematype uten M365-kobling er ikke med
 *   - avkrysningen i admin («Varsle eier») stopper varselet, og lagres uten
 *     å røre skjematypedefinisjonen
 *   - en skjematype uten eier med e-postadresse meldes som feil, ikke tie
 *
 * Kjører den ekte jobben med lagring og e-post stubbet.
 *
 * Kjøres med:  node api/test/ubrukt-varsel.test.js
 */
const Module = require('module');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const uv = require('../src/lib/ubrukt-varsel');
const { byggOversikt } = require('../src/lib/skjematype-oversikt');
const hendelser = require('../src/lib/hendelser-storage');
const hendelseLogg = [];
hendelser.logg = (h) => { hendelseLogg.push(h); };

const NAA = Date.parse('2026-11-23T12:00:00Z');
const dagerSiden = (n) => new Date(NAA - n * 86400000).toISOString();
const KANAL = { Behandling: [{ Steg: 1, Varsling: ['teamskanal'], TeamsKanalInnlegg: { Team: 'Støtte', Kanal: 'K' } }] };
const st = (id, navn, { brukt = null, endret = 400, def = KANAL, eiere = { Personer: [`eier${id}@x.no`] } } = {}) => ({
    id, navn, endret: endret === null ? '' : dagerSiden(endret),
    JSON: { Skjema_navn: navn, Fase: 'Produksjon', Eiere: eiere, ...def }, _brukt: brukt
});
const antallFor = (typer) => new Map(typer.filter(t => t._brukt !== null).map(t => [t.id, { Antall: 1, SisteDato: dagerSiden(t._brukt) }]));

// ---------- 1. hvem som er ubrukt ----------
{
    const typer = [
        st('1', 'Gammel', { brukt: 200, endret: 300 }),
        st('2', 'Gammel bruk, nylig endret', { brukt: 200, endret: 10 }),
        st('3', 'Aldri brukt, gammel', { brukt: null, endret: 400 }),
        st('4', 'Aldri brukt, ny', { brukt: null, endret: 2 }),
        st('5', 'Uten kobling', { brukt: 400, endret: 400, def: {} }),
        st('6', 'I bruk', { brukt: 5, endret: 400 }),
        st('7', 'Avslått', { brukt: 400, endret: 400 })
    ];
    const k = uv.kandidater(typer, byggOversikt(typer, antallFor(typer)), new Set(['7']), NAA);
    sjekk('ubrukte: gammel bruk og endring, aldri brukt og gammel', k.map(x => x.id).sort(), ['1', '3']);
    sjekk('nylig endret gir ikke varsel', k.some(x => x.id === '2'), false);
    sjekk('ny skjematype uten bruk gir ikke varsel', k.some(x => x.id === '4'), false);
    sjekk('uten M365-kobling: ikke med', k.some(x => x.id === '5'), false);
    sjekk('avslått: ikke med', k.some(x => x.id === '7'), false);
    sjekk('koblingene følger med til e-posten', k.find(x => x.id === '1').koblinger.map(m => m.mal), ['Støtte']);
    // Akkurat på grensen er ikke over grensen.
    const grense = [st('8', 'Grense', { brukt: uv.GRENSE_DAGER - 1, endret: 999 })];
    sjekk('like innenfor grensen: ikke ubrukt', uv.kandidater(grense, byggOversikt(grense, antallFor(grense)), new Set(), NAA).length, 0);
}

// ---------- 2. avkrysningen ----------
(async () => {
    const lager = new Map();
    const innst = {
        hent: async (n) => (lager.has(n) ? { Nokkel: n, Verdi: lager.get(n) } : null),
        sett: async (n, v) => { lager.set(n, v); }
    };
    sjekk('tomt lager: ingen avslått', [...await uv.lesAvslatte(innst)], []);
    await uv.settVarsling(['2', '10', '3'], false, 'admin@x.no', innst);
    sjekk('skru av: lagret sortert', JSON.parse(lager.get(uv.INNSTILLING)), ['2', '3', '10']);
    await uv.settVarsling(['3'], true, 'admin@x.no', innst);
    sjekk('skru på igjen: fjernet', [...await uv.lesAvslatte(innst)].sort(), ['10', '2']);
    lager.set(uv.INNSTILLING, 'ikke json');
    sjekk('ødelagt verdi: tom liste, ikke kast', [...await uv.lesAvslatte(innst)], []);

    // ---------- 3. jobben ----------
    const typer = [
        st('1', 'Gammel <b>', { brukt: 200, endret: 300 }),
        st('3', 'Uten eier', { brukt: null, endret: 400, eiere: { Team: ['Et team'] } }),
        st('6', 'I bruk', { brukt: 5, endret: 400 }),
        st('7', 'Avslått', { brukt: 400, endret: 400 })
    ];
    lager.set(uv.INNSTILLING, JSON.stringify(['7']));
    const sendt = [];
    let sendSvar = { status: 'ok' };
    const deps = {
        skjematyper: { hentAlleSkjematyper: async () => typer },
        saker: { hentAntallPerType: async () => antallFor(typer) },
        innstillinger: innst,
        varsling: { løsMottakere: async (oppsett) => (oppsett.Personer || []).map(e => ({ epost: e })) },
        flytKaller: { sendEpostViaFlyt: async (args) => { sendt.push(args); return sendSvar; } }
    };
    process.env.SWA_URL = 'https://skjema.x.no';
    let r = await uv.kjorUbruktVarsel({ kilde: 'test', naa: NAA, deps });
    sjekk('jobben: én e-post, til eieren av den ubrukte', sendt.map(s => s.mottakere.map(m => m.epost)), [['eier1@x.no']]);
    sjekk('jobben: uten eier med adresse er feil, ikke stille', r.feil.map(f => f.id), ['3']);
    sjekk('jobben: utfall delvis', r.utfall, 'delvis');
    sjekk('jobben: avslått og i bruk er ikke med', r.ubrukte, ['1', '3']);
    const e = sendt[0];
    sjekk('e-post: navnet escapes', [/Gammel <b>/.test(e.html), /Gammel &lt;b&gt;/.test(e.html)], [false, true]);
    sjekk('e-post: teamet står i den', /Støtte/.test(e.html), true);
    sjekk('e-post: lenke til skjematypen', /https:\/\/skjema\.x\.no\/editor\.html\?skjematype_id=1/.test(e.html), true);
    sjekk('hendelsen logges', hendelseLogg.some(h => h.Type === 'skjematype.ubrukt-varsel'), true);

    sendt.length = 0; sendSvar = { status: 'feil', melding: 'flyten svarte 500' };
    r = await uv.kjorUbruktVarsel({ kilde: 'test', naa: NAA, deps });
    sjekk('jobben: e-post som feiler meldes', r.feil.some(f => f.id === '1' && /flyten svarte 500/.test(f.melding)), true);

    // ---------- 4. endepunktet for avkrysningen ----------
    const innstStorage = require('../src/lib/innstillinger-storage');
    innstStorage.hent = innst.hent; innstStorage.sett = innst.sett;
    const ruter = {};
    const ekteLoad = Module._load;
    Module._load = function (f, ...rest) {
        if (f === '@azure/functions') return { app: { http: (n, d) => { ruter[d.route] = d.handler; }, timer() {} } };
        return ekteLoad.call(this, f, ...rest);
    };
    try { require('../src/functions/ubrukt-varsel'); } finally { Module._load = ekteLoad; }
    const som = (upn, body) => ({
        headers: { get: (n) => (n.toLowerCase() === 'x-ms-client-principal' && upn
            ? Buffer.from(JSON.stringify({ userDetails: upn, userRoles: ['authenticated'] })).toString('base64') : null) },
        json: async () => body
    });
    process.env.ADMIN_UPNS = 'admin@x.no';
    const rute = ruter['m365-koblinger/varsling'];
    sjekk('avkrysning: bare admin', (await rute(som('vanlig@x.no', { skjematypeIder: ['1'], varsle: false }), { log() {} })).status, 403);
    sjekk('avkrysning: varsle må være boolsk', (await rute(som('admin@x.no', { skjematypeIder: ['1'], varsle: 'nei' }), { log() {} })).status, 400);
    sjekk('avkrysning: id-er kreves', (await rute(som('admin@x.no', { skjematypeIder: [], varsle: false }), { log() {} })).status, 400);
    lager.clear();
    const svar = await rute(som('admin@x.no', { skjematypeIder: ['1', '2'], varsle: false }), { log() {} });
    sjekk('avkrysning: skru av alle', svar.jsonBody.avslatte, ['1', '2']);
    const svar2 = await rute(som('admin@x.no', { skjematypeIder: ['1', '2'], varsle: true }), { log() {} });
    sjekk('avkrysning: varsle alle', svar2.jsonBody.avslatte, []);
    sjekk('kjør nå: krever admin eller nøkkel', (await ruter['m365-koblinger/varsle-ubrukte'](som(null, {}), { log() {} })).status, 403);

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
})().catch(e => { console.log('FEIL  testen kastet:', e.message, e.stack); process.exit(1); });
