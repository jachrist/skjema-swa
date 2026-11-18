/**
 * «Alle må avgjøre» — avslag avgjør, og ompuss nullstiller svarene.
 *
 * Besluttet 18.11.2026. Før dette:
 *
 *   - ble steget stående til ALLE hadde svart, og det SISTE svaret ble
 *     stegets beslutning. Et avslag fra én og en godkjenning fra en annen ga
 *     et utfall som hang på hvem som svarte sist.
 *   - nullstilte ompuss steget, men ikke svarene. Godkjenninger gitt før
 *     rettingen sto seg, selv om innholdet var endret.
 *
 * Nå avgjør et avslag steget med en gang, og ompuss flytter svarene til
 * `TidligereBeslutninger` slik at alle må svare på nytt.
 *
 * «Avslag» er det samme som det røde utfallet: `typeFor` i
 * lib/behandling-utfall.js — erklært «Avvisning», eller en tekst som
 * «Avslått» eller «Ikke anbefalt».
 *
 * Testen kjører den EKTE beslutningsruten med lagringen stubbet.
 *
 * Kjøres med:  node api/test/alle-avgjor.test.js
 */
const Module = require('module');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const ekteLoad = Module._load;
Module._load = function (f, ...r) {
    if (f === '@azure/functions') return { app: { http() {}, timer() {} } };
    return ekteLoad.call(this, f, ...r);
};
let ruten;
try { ({ lagreBeslutning: ruten } = require('../src/functions/skjemaer')); }
finally { Module._load = ekteLoad; }

const forekomst = require('../src/lib/skjema-forekomst-storage');
const skjemaStorage = require('../src/lib/skjema-storage');
const hendelser = require('../src/lib/hendelser-storage');
const varsling = require('../src/lib/varsling');

let sak = null;
forekomst.hentSkjema = async () => JSON.parse(JSON.stringify(sak));
forekomst.lagreSkjema = async (s) => { sak = JSON.parse(JSON.stringify(s)); };
skjemaStorage.hentSkjematype = async () => ({ JSON: { Behandling: [] } });
hendelser.logg = async () => {};
for (const f of ['sendBeslutningVarsling', 'sendVarslingAktiveSteg', 'sendFerdigVarsling']) varsling[f] = async () => ({ status: 'ok' });
varsling.loggVarslingsutfall = async () => [];

const VALG = [
    { Nummer: 1, Tekst: 'Godkjent' },
    { Nummer: 2, Tekst: 'Avslått' },
    { Nummer: 3, Tekst: 'Må revideres', Handling: 'ompuss' },
    { Nummer: 4, Tekst: 'Ikke anbefalt' },
    { Nummer: 6, Tekst: 'Nei', Handling: 'avvisning' },
    { Nummer: 7, Tekst: 'Ikke relevant' }
];
const nySak = () => ({
    Skjema_id: '9', Skjematype_id: '70', Skjema_status: 2, Innsender_Epost: 'kari@x.no',
    Behandling: [
        { Steg: 1, Stegnavn: 'Godkjenning', Beslutning_alle: true,
          Personer: ['a@x.no', 'b@x.no', 'c@x.no'], Beslutningsvalg: VALG },
        { Steg: 2, Stegnavn: 'Publisering', AvhengigAv: 1, Personer: ['p@x.no'],
          Beslutningsvalg: [{ Nummer: 1, Tekst: 'Publisert' }] }
    ]
});

async function svar(upn, beslutning) {
    const principal = Buffer.from(JSON.stringify({ userDetails: upn, userRoles: ['authenticated'] })).toString('base64');
    const r = await ruten({
        params: { skjematypeId: '70', skjemaId: '9' },
        headers: { get: (n) => (n.toLowerCase() === 'x-ms-client-principal' ? principal : null) },
        json: async () => ({ steg: 1, beslutning, kommentar: `${upn} sa ${beslutning}` })
    }, { log: () => {} });
    return r.jsonBody || {};
}
const steg1 = () => sak.Behandling[0];

(async () => {
    // ---------- 1. alle godkjenner: steget avgjøres når den siste har svart ----------
    sak = nySak();
    let r = await svar('a@x.no', 1);
    sjekk('én av tre: ikke avgjort', Number(steg1().Beslutning || 0), 0);
    sjekk('og venter på de to andre', r.venterPaa, ['b@x.no', 'c@x.no']);
    await svar('b@x.no', 1);
    r = await svar('c@x.no', 1);
    sjekk('alle tre: avgjort', [steg1().Beslutning, steg1().BehandletAv], [1, 'alle-behandlere']);
    sjekk('ingen venter', r.venterPaa, []);

    // ---------- 2. et avslag avgjør med en gang ----------
    sak = nySak();
    await svar('a@x.no', 1);
    r = await svar('b@x.no', 2);
    sjekk('avslag: avgjort uten å vente på c', [steg1().Beslutning, steg1().BehandletAv], [2, 'b@x.no']);
    sjekk('avslag: ingen venter', r.venterPaa, []);
    sjekk('avslag: svaret er lagret som delbeslutning',
        (steg1().Beslutninger || []).map(b => [b.Aktor, b.Beslutning]), [['a@x.no', 1], ['b@x.no', 2]]);
    sjekk('avslag: steg 2 starter, for det venter bare på at steg 1 er ferdig',
        typeof sak.Behandling[1].AktivFra, 'string');

    // Samme regel som fargen: tekst uten erklæring, og erklæring uten tekst.
    sak = nySak();
    await svar('a@x.no', 4);
    sjekk('«Ikke anbefalt» (tekst) avgjør', steg1().Beslutning, 4);
    sak = nySak();
    await svar('a@x.no', 6);
    sjekk('«Avvisning» (erklært) avgjør', steg1().Beslutning, 6);
    // Et nøytralt utfall er ikke et avslag.
    sak = nySak();
    await svar('a@x.no', 7);
    sjekk('«Ikke relevant» avgjør ikke', Number(steg1().Beslutning || 0), 0);

    // ---------- 3. ompuss nullstiller svarene ----------
    sak = nySak();
    await svar('a@x.no', 1);
    await svar('b@x.no', 1);
    await svar('c@x.no', 3);
    sjekk('ompuss: sendt tilbake', sak.Skjema_status, 3);
    sjekk('ompuss: svarene er nullstilt', steg1().Beslutninger, undefined);
    sjekk('ompuss: og kravstatusen', steg1().BeslutningKrav, undefined);
    sjekk('ompuss: svarene er tatt vare på',
        (steg1().TidligereBeslutninger || []).map(b => [b.Aktor, b.Beslutning, typeof b.Nullstilt]),
        [['a@x.no', 1, 'string'], ['b@x.no', 1, 'string']]);
    sjekk('ompuss: kommentarene er med', steg1().TidligereBeslutninger[0].Kommentar, 'a@x.no sa 1');

    // Innsenderen retter og sender inn igjen. Da må alle svare på nytt — også
    // a og b, som godkjente før.
    sak.Skjema_status = 2;
    await svar('b@x.no', 1);
    r = await svar('c@x.no', 1);
    sjekk('etter retting: a sin gamle godkjenning teller ikke', Number(steg1().Beslutning || 0), 0);
    sjekk('etter retting: det ventes på a', r.venterPaa, ['a@x.no']);
    await svar('a@x.no', 1);
    sjekk('etter retting: avgjort når alle har svart på nytt', steg1().Beslutning, 1);

    // En ompuss til legger til, ikke erstatter.
    sak = nySak();
    await svar('a@x.no', 1); await svar('b@x.no', 3);
    sak.Skjema_status = 2;
    await svar('a@x.no', 1); await svar('c@x.no', 3);
    sjekk('to runder ompuss: begge rundene er tatt vare på', steg1().TidligereBeslutninger.length, 2);

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
})().catch(e => { console.log('FEIL  testen kastet:', e.message, e.stack); process.exit(1); });
