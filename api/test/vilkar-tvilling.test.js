/**
 * `vilkar.js` finnes i TO eksemplarer, og ingen test leste begge.
 *
 * `api/src/lib/vilkar.js` og `frontend/js/vilkar.js` har samme logikk.
 * Frontend kan ikke `require` fra `api/`, og backend kan ikke importere en
 * ES-modul fra `frontend/` uten et byggsteg — duplikatet er tvunget fram.
 * Da gjelder husregelen: en test leser BEGGE og krever samme svar.
 *
 * 22.10.2026 fantes ingen slik test. De to var identiske da det ble målt
 * (bortsett fra `samleRefererteFelter`, som bare backend trenger), men
 * ingenting holdt dem der. Og motoren skal utvides: en betingelse skal
 * kunne sammenligne mot ET ANNET FELT, ikke bare mot en fast verdi. Den
 * utvidelsen må inn to steder, og uten denne testen ville de to kunne
 * svare ulikt på et skjema som allerede er sendt inn.
 *
 * Tilfellene under er derfor ikke bare en sammenligning: de er
 * regresjonsdekningen for utvidelsen. Hvert tilfelle kjøres gjennom BEGGE
 * implementasjonene, og svarene må stemme både med hverandre og med
 * fasiten.
 *
 * Kjøres med:  node api/test/vilkar-tvilling.test.js
 */
const fs = require('fs');
const path = require('path');
const { hentEksport } = require('../../scripts/test-kilde.js');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const rot = path.join(__dirname, '..', '..');
const les = (...p) => fs.readFileSync(path.join(rot, ...p), 'utf8');

const FRONTEND = path.join('frontend', 'js', 'vilkar.js');
const BACKEND = path.join('api', 'src', 'lib', 'vilkar.js');

// Avhengighetene i den rekkefølgen de må erklæres.
const DELER = ['UUID_RE', 'IDAG_REF', 'ISO_DATO_RE',
    'erDNFFormat', 'erLegacyFormat', 'migrerTilDNF',
    'svarFraFelt', 'hentSvar', 'parsTall',
    'erIsoDato', 'idagISO', 'datoPlussDager', 'hoyreVerdi',
    'evaluerBetingelse'];

// Begge hentes ut av kilden og kjøres. Ikke `require` på den ene og en kopi
// av den andre: da ville testen kunne bestå på sin egen kopi.
const fra = hentEksport(les(FRONTEND), 'evaluerVilkar', DELER);
const bak = hentEksport(les(BACKEND), 'evaluerVilkar', DELER);

// ---------- testdata ----------
//
// Ett skjema med felter av hver form referansene støtter: Id (uuid),
// posisjon (S-FF) og flervalg (array-svar).
const UID_START = '11111111-2222-3333-4444-555555555555';
const UID_SLUTT = '66666666-7777-8888-9999-aaaaaaaaaaaa';

const SEKSJONER = [
    {
        Seksjon_nummer: '1',
        Felter: [
            { Nummer: 1, Id: UID_START, Svar: ['2026-03-01'] },
            { Nummer: 2, Id: UID_SLUTT, Svar: ['2026-02-01'] },
            { Nummer: 3, Svar: ['42'] },
            { Nummer: 4, Svar: [] },
            { Nummer: 5, Svar: ['Oslo', 'Bergen'] },
            { Nummer: 6, Svar: ['3,5'] },
            { Nummer: 7, Svar: ['2026-03-20'] }
        ]
    }
];

const BEHANDLING = [
    { Steg: 1, Beslutning: 2, Beslutningsvalg: [{ Nummer: 2, Tekst: 'Godkjent' }] },
    { Steg: 2, Beslutning: 5 },
    { Steg: 3, Beslutning: 0 }
];

const en = (Felt, Operator, Verdi) => ({ EllerAv: [{ OgAv: [{ Felt, Operator, Verdi }] }] });

// ---------- 1. samme svar, og riktig svar ----------
const TILFELLER = [
    ['tomt vilkår er sant', null, true],
    ['tom EllerAv er sant', { EllerAv: [] }, true],
    // En gruppe UTEN betingelser gjør hele vilkåret usant: gruppa hoppes
    // over i løkka, og da er ingen gruppe sann. Begge svarer likt, så det
    // er oppførselen — ikke en forskjell. Men det er verdt å kjenne: en
    // tom gruppe i editoren betyr «vis aldri», ikke «ingen betingelse».
    ['gruppe uten betingelser gjør vilkåret usant', { EllerAv: [{ OgAv: [] }] }, false],

    ['uuid-referanse, likhet', en(UID_START, '=', '2026-03-01'), true],
    ['uuid-referanse, ulikhet', en(UID_START, '!=', '2026-03-01'), false],
    ['posisjonsreferanse S-FF', en('1-03', '=', '42'), true],
    ['posisjon uten nullpadding', en('1-3', '=', '42'), true],
    ['ukjent felt gir usant', en('1-99', '=', 'noe'), false],

    ['tom', en('1-04', 'tom', null), true],
    ['ikke_tom på utfylt', en('1-03', 'ikke_tom', null), true],
    ['tom på utfylt', en('1-03', 'tom', null), false],

    ['numerisk større enn', en('1-03', '>', 40), true],
    ['numerisk mindre enn', en('1-03', '<', 40), false],
    ['numerisk >= på lik verdi', en('1-03', '>=', 42), true],
    ['komma som desimalskille', en('1-06', '>', 3), true],
    ['tekst mot tall gir usant', en('1-05', '>', 1), false],

    ['flervalg: = treffer ett av dem', en('1-05', '=', 'Bergen'), true],
    ['flervalg: != når det treffer', en('1-05', '!=', 'Bergen'), false],
    ['inneholder, uavhengig av store bokstaver', en('1-03', 'inneholder', '4'), true],
    ['inneholder med tom streng er usant', en('1-03', 'inneholder', ''), false],

    ['behandlingssteg, beslutningstekst', en('behandling-1', '=', 'Godkjent'), true],
    ['behandlingssteg, beslutningsnummer', en('behandling-1', '=', 2), true],
    ['hoppet over steg', en('behandling-2', '=', 'Hoppet over'), true],
    ['ubesluttet steg er tomt', en('behandling-3', 'tom', null), true],

    // Legacy-formatet må ha BEGGE utfallene. Et vilkår som ikke lar seg
    // migrere blir `null`, og da returnerer motoren `true` — så et
    // legacy-tilfelle som skal være SANT består også når migreringen er
    // slått av. Mutasjonstesten fant nettopp det: grønt av gal grunn.
    ['legacy-format migreres, sant', { Seksjon: '1', Felt: 3, Verdi: '42' }, true],
    ['legacy-format migreres, usant', { Seksjon: '1', Felt: 3, Verdi: 'feil' }, false],

    ['OgAv krever alle', {
        EllerAv: [{ OgAv: [
            { Felt: '1-03', Operator: '=', Verdi: '42' },
            { Felt: '1-05', Operator: '=', Verdi: 'Trondheim' }
        ] }]
    }, false],
    ['EllerAv holder at én gruppe er sann', {
        EllerAv: [
            { OgAv: [{ Felt: '1-03', Operator: '=', Verdi: 'feil' }] },
            { OgAv: [{ Felt: '1-03', Operator: '=', Verdi: '42' }] }
        ]
    }, true],

    // Dette tilfellet sto med fasit `false` fram til 22.10.2026, da datoer
    // ikke kunne sammenlignes. Det er endringen, og den er synlig her.
    ['dato mot fast dato', en(UID_START, '>', '2026-02-01'), true],
    ['dato mot fast dato, andre vei', en(UID_START, '<', '2026-02-01'), false],

    // ---- høyresiden peker på et annet felt ----
    ['felt mot felt: slutt er FØR start', en(UID_SLUTT, '>', { Felt: UID_START }), false],
    ['felt mot felt: start er etter slutt', en(UID_START, '>', { Felt: UID_SLUTT }), true],
    ['felt mot felt, likhet', en(UID_START, '=', { Felt: UID_START }), true],
    ['felt mot felt via posisjon', en('1-07', '>', { Felt: '1-01' }), true],
    ['tall mot tall-felt', en('1-03', '>', { Felt: '1-06' }), true],

    // ---- forskyvning i dager ----
    ['minst 14 dager etter start', en('1-07', '>=', { Felt: UID_START, PlussDager: 14 }), true],
    ['minst 30 dager etter start', en('1-07', '>=', { Felt: UID_START, PlussDager: 30 }), false],
    ['negativ forskyvning', en(UID_SLUTT, '>=', { Felt: UID_START, PlussDager: -60 }), true],
    // 1. februar + 47 dager = 20. mars. Krysser februar, som har 28 dager
    // i 2026 — en forskyvning regnet i måneder ville bommet her.
    ['forskyvning over månedsskifte', en('1-07', '=', { Felt: UID_SLUTT, PlussDager: 47 }), true],

    // ---- dagens dato ----
    ['etter i dag', en('1-07', '>', { Felt: '@idag' }), true],
    ['før i dag', en(UID_SLUTT, '<', { Felt: '@idag' }), true],
    // 10. mars + 10 dager = 20. mars, som er nøyaktig feltets verdi: her
    // prøves også grensen i `>=`.
    ['minst 10 dager fram i tid, på dagen', en('1-07', '>=', { Felt: '@idag', PlussDager: 10 }), true],
    ['minst 14 dager fram i tid', en('1-07', '>=', { Felt: '@idag', PlussDager: 14 }), false],
    ['minst 90 dager fram i tid', en('1-07', '>=', { Felt: '@idag', PlussDager: 90 }), false],

    // ---- det som IKKE skal gå ----
    ['forskyvning på noe som ikke er en dato', en('1-03', '>', { Felt: '1-06', PlussDager: 1 }), false],
    ['høyreside som peker på ukjent felt', en(UID_START, '>', { Felt: '1-99' }), false],
    ['høyreside som peker på tomt felt', en(UID_START, '>', { Felt: '1-04' }), false],
    ['objekt uten Felt gir usant', en(UID_START, '>', { PlussDager: 5 }), false],
    ['@idag på VENSTRESIDEN er ikke et felt', en('@idag', '>', '2020-01-01'), false]
];

// `i dag` bindes, ellers endrer testen svar ved midnatt — og en test som
// feiler på en bestemt dato er en test ingen stoler på.
const CTX = { idag: '2026-03-10' };

for (const [navn, vilkar, ventet] of TILFELLER) {
    const a = fra(vilkar, SEKSJONER, BEHANDLING, CTX);
    const b = bak(vilkar, SEKSJONER, BEHANDLING, CTX);
    sjekk(`${navn} — frontend`, a, ventet);
    sjekk(`${navn} — backend`, b, ventet);
    sjekk(`${navn} — de to er enige`, a, b);
}

// ---------- 1b. høyresiden, prøvd direkte ----------
//
// `hoyreVerdi` må testes for seg. Gjennom `evaluerVilkar` er `null` og en
// søppelverdi som «NaN-NaN-NaN» ikke til å skille fra hverandre: begge gir
// NaN i parsTall og dermed `false`. Tre mutasjoner overlevde på nettopp
// det — vakten mot `PlussDager` på noe som ikke er en dato, objektet uten
// `Felt`, og det tomme feltet. De er ekte, og de er observerbare HER.
const hFra = hentEksport(les(FRONTEND), 'hoyreVerdi', DELER.filter(d => d !== 'hoyreVerdi'));
const hBak = hentEksport(les(BACKEND), 'hoyreVerdi', DELER.filter(d => d !== 'hoyreVerdi'));

const HOYRE = [
    ['literal tall går uendret gjennom', 42, 42],
    ['literal tekst går uendret gjennom', 'Oslo', 'Oslo'],
    ['null går uendret gjennom', null, null],
    ['array er en literal, ikke en referanse', ['a'], ['a']],

    ['feltreferanse løses', { Felt: UID_START }, '2026-03-01'],
    ['posisjonsreferanse løses', { Felt: '1-03' }, '42'],
    ['@idag løses til bundet dato', { Felt: '@idag' }, '2026-03-10'],
    ['forskyvning på dato', { Felt: UID_START, PlussDager: 19 }, '2026-03-20'],
    ['forskyvning på @idag', { Felt: '@idag', PlussDager: 10 }, '2026-03-20'],
    ['negativ forskyvning', { Felt: UID_START, PlussDager: -1 }, '2026-02-28'],

    // De tre mutasjonene som overlevde gjennom evaluerVilkar:
    ['objekt uten Felt gir null', { PlussDager: 5 }, null],
    ['forskyvning på et tall gir null, ikke en søppeldato',
        { Felt: '1-06', PlussDager: 1 }, null],
    ['tomt felt gir null, ikke tom streng', { Felt: '1-04' }, null],
    ['ukjent felt gir null', { Felt: '1-99' }, null],
    ['forskyvning på tomt felt gir null', { Felt: '1-04', PlussDager: 3 }, null],
    ['flervalg tar det første', { Felt: '1-05' }, 'Oslo']
];

// Invarianten `hoyreVerdi` hviler på: et TOMT svar gir `null`, ikke `[]`.
// Uten den ville `v[0]` gitt `undefined`. Den er ikke synlig gjennom
// hoyreVerdi — derfor prøves den direkte, på begge kopiene.
{
    const sFra = hentEksport(les(FRONTEND), 'svarFraFelt');
    const sBak = hentEksport(les(BACKEND), 'svarFraFelt');
    const FELT = [
        ['tomt svar gir null', { Svar: [] }, null],
        ['ett svar gir verdien, ikke en array', { Svar: ['Oslo'] }, 'Oslo'],
        ['flere svar gir arrayen', { Svar: ['Oslo', 'Bergen'] }, ['Oslo', 'Bergen']],
        ['svar som ikke er array', { Svar: 'Oslo' }, 'Oslo'],
        ['manglende svar gir null', {}, null]
    ];
    for (const [navn, felt, ventet] of FELT) {
        sjekk(`svarFraFelt: ${navn} — frontend`, sFra(felt), ventet);
        sjekk(`svarFraFelt: ${navn} — backend`, sBak(felt), ventet);
    }
}

for (const [navn, verdi, ventet] of HOYRE) {
    const a = hFra(verdi, SEKSJONER, BEHANDLING, CTX);
    const b = hBak(verdi, SEKSJONER, BEHANDLING, CTX);
    sjekk(`høyreside: ${navn} — frontend`, a, ventet);
    sjekk(`høyreside: ${navn} — backend`, b, ventet);
    sjekk(`høyreside: ${navn} — de to er enige`, a, b);
}

// ---------- 1c. samleRefererteFelter ser BEGGE sidene ----------
//
// Bare backend har den — frontend trenger den ikke, så dette er ikke en
// tvillingsjekk. Men nå som høyresiden kan peke på et felt, ville lista
// vært ufullstendig uten at noe sa fra, og en ufullstendig liste over
// «hvilke felter avhenger dette vilkåret av» er nettopp den slags som
// leses som fasit.
//
// Funksjonen er ikke i bruk ennå. Den beholdes fordi feltvelgeren i
// editoren (steg 3) trenger akkurat dette spørsmålet besvart — og en
// funksjon som er GAL når den tas i bruk, er verre enn en som mangler.
{
    const samle = hentEksport(les(BACKEND), 'samleRefererteFelter',
        ['IDAG_REF', 'erDNFFormat', 'erLegacyFormat', 'migrerTilDNF']);

    sjekk('tomt vilkår gir tom liste', samle(null), []);
    sjekk('venstresiden er med',
        samle(en('1-01', '=', 'x')), ['1-01']);
    sjekk('høyresiden er med når den peker på et felt',
        samle(en('1-02', '>=', { Felt: '1-01', PlussDager: 14 })), ['1-02', '1-01']);
    sjekk('@idag er ikke et felt',
        samle(en('1-02', '>', { Felt: '@idag' })), ['1-02']);
    sjekk('literal på høyresiden gir ingen ekstra',
        samle(en('1-02', '>', '2026-01-01')), ['1-02']);
    sjekk('duplikater telles én gang',
        samle({ EllerAv: [
            { OgAv: [{ Felt: '1-01', Operator: '=', Verdi: { Felt: '1-02' } }] },
            { OgAv: [{ Felt: '1-02', Operator: '=', Verdi: { Felt: '1-01' } }] }
        ] }), ['1-01', '1-02']);
}

// ---------- 2. ingen av dem kaster på søppel ----------
//
// Vilkår kommer fra lagrede skjematyper. En halvredigert struktur skal gi
// `true` eller `false`, aldri en exception midt i tegningen av et skjema.
const SOPPEL = [
    undefined, 0, '', 'tekst', [], { EllerAv: null }, { EllerAv: [null] },
    { EllerAv: [{ OgAv: null }] }, { EllerAv: [{ OgAv: [null] }] },
    { EllerAv: [{ OgAv: [{}] }] }
];
for (const s of SOPPEL) {
    let a, b, kastet = null;
    try { a = fra(s, SEKSJONER, BEHANDLING, CTX); b = bak(s, SEKSJONER, BEHANDLING, CTX); }
    catch (e) { kastet = e.message; }
    sjekk(`søppel ${JSON.stringify(s)} kaster ikke`, kastet, null);
    sjekk(`søppel ${JSON.stringify(s)}: de to er enige`, a, b);
}

// ---------- 3. seksjoner som mangler ----------
for (const sek of [null, undefined, [], 'ikke en liste']) {
    const v = en('1-03', '=', '42');
    sjekk(`seksjoner=${JSON.stringify(sek)}: de to er enige`,
        fra(v, sek, BEHANDLING, CTX), bak(v, sek, BEHANDLING, CTX));
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
