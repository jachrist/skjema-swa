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
const DELER = ['UUID_RE', 'erDNFFormat', 'erLegacyFormat', 'migrerTilDNF',
    'svarFraFelt', 'hentSvar', 'parsTall', 'evaluerBetingelse'];

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
            { Nummer: 6, Svar: ['3,5'] }
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

    // Datoene ligger her med vilje: i dag sammenlignes de som TEKST, og
    // `>` på to datoer gir usant fordi parsTall ikke klarer dem. Det er
    // nettopp hullet utvidelsen skal fylle, og tilfellet står her for at
    // endringen skal bli SYNLIG når den kommer.
    ['dato mot dato er ikke støttet ennå', en(UID_START, '>', '2026-02-01'), false]
];

for (const [navn, vilkar, ventet] of TILFELLER) {
    const a = fra(vilkar, SEKSJONER, BEHANDLING);
    const b = bak(vilkar, SEKSJONER, BEHANDLING);
    sjekk(`${navn} — frontend`, a, ventet);
    sjekk(`${navn} — backend`, b, ventet);
    sjekk(`${navn} — de to er enige`, a, b);
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
    try { a = fra(s, SEKSJONER, BEHANDLING); b = bak(s, SEKSJONER, BEHANDLING); }
    catch (e) { kastet = e.message; }
    sjekk(`søppel ${JSON.stringify(s)} kaster ikke`, kastet, null);
    sjekk(`søppel ${JSON.stringify(s)}: de to er enige`, a, b);
}

// ---------- 3. seksjoner som mangler ----------
for (const sek of [null, undefined, [], 'ikke en liste']) {
    const v = en('1-03', '=', '42');
    sjekk(`seksjoner=${JSON.stringify(sek)}: de to er enige`,
        fra(v, sek, BEHANDLING), bak(v, sek, BEHANDLING));
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
