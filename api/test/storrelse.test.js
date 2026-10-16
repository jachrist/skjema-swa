/**
 * Filstørrelser som tekst — og de TO eksemplarene av regelen.
 *
 * `frontend/js/storrelse.js` og `api/src/lib/storrelse.js` har samme funksjon.
 * Frontend kan ikke importere fra `api/`, og backend kan ikke importere en
 * ES-modul fra `frontend/` uten et byggsteg, så duplikatet er tvunget fram.
 * Da gjelder husregelen: en test leser BEGGE og krever samme svar.
 *
 * Bakgrunnen for selve funksjonen: formelen
 * `Math.round(bytes / 1024 / 1024 * 10) / 10` sto i ni eksemplarer i
 * `admin.html` og ni til i backend, i flere varianter — én uten MB-trinn, én
 * med `toFixed(1)`, én med `Math.max(1, …)`. Alle avrundet for hardt: med én
 * desimal i MB leses alt under ~50 kB som «0 MB». Den første backupen i dev
 * viste «0 MB kryptert» og så tom ut uten å være det.
 *
 * Testen holder fast tre ting:
 *
 *   **De to eksemplarene svarer likt** på hver verdi i tabellen under.
 *
 *   **Små tall forsvinner ikke.** «0 B» skal bety tomt, og bare det.
 *
 *   **Ingen lager sin egen igjen.** Den gamle formelen skal ikke finnes noe
 *   sted, og hver fil som KALLER funksjonen må ha den i scope — en glemt
 *   import gir en ReferenceError først når kodestien kjøres, og den stien er
 *   typisk en feilmelding om at noe er for stort.
 *
 * Kjøres med:  node api/test/storrelse.test.js
 */
const fs = require('fs');
const path = require('path');
const { hentEksport, utenKommentarer, bundneNavn } = require('../../scripts/test-kilde.js');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const rot = path.join(__dirname, '..', '..');
const les = (...p) => fs.readFileSync(path.join(rot, ...p), 'utf8');

const FRONTEND = path.join('frontend', 'js', 'storrelse.js');
const BACKEND = path.join('api', 'src', 'lib', 'storrelse.js');

// Begge hentes ut av kilden og kjøres. Ikke `require` på den ene og en kopi
// av den andre: da ville testen kunne bestå på sin egen kopi.
const fra = hentEksport(les(FRONTEND), 'formatStorrelse');
const bak = hentEksport(les(BACKEND), 'formatStorrelse');

const KB = 1024, MB = 1024 * 1024, GB = 1024 * 1024 * 1024;

// ---------- 1. selve formateringen ----------
{
    const TILFELLER = [
        [0, '0 B'],
        [1, '1 B'],
        [512, '512 B'],
        [1023, '1023 B'],
        [KB, '1 kB'],
        [1536, '1,5 kB'],
        [3 * KB, '3 kB'],
        [50 * KB, '50 kB'],
        // Dette er tallet hele øvelsen handler om: den første backupen i dev.
        // Den viste «0 MB». Nå viser den noe en leser kan skille fra tomt.
        [4200, '4,1 kB'],
        // Avrundingen skjer før valget av enhet. Uten det blir dette «1024 B»,
        // altså et trinn som ikke finnes i tabellen.
        [1023.6, '1 kB'],
        [MB - 1, '1024 kB'],
        [MB, '1 MB'],
        [1.5 * MB, '1,5 MB'],
        // Desimalen beholdes helt opp til 100. Grensen pinnes fra begge sider:
        // settes den til 10 i stedet, blir «12,3 MB» til «12 MB», og en
        // backup på 12,3 MB kan ikke skilles fra en på 12,4.
        [12.3 * MB, '12,3 MB'],
        [99.94 * MB, '99,9 MB'],
        // Over 100 droppes den. «128 MB» er like presist for den som leser
        // som «128,4 MB», og kortere.
        [100.4 * MB, '100 MB'],
        [128 * MB, '128 MB'],
        [GB, '1 GB'],
        [1536 * MB, '1,5 GB'],
        [1024 * GB, '1 TB']
    ];
    for (const [verdi, forventet] of TILFELLER) {
        sjekk(`${verdi} B`, fra(verdi), forventet);
    }

    // «Vet ikke» er ikke «tom». Number(null) er 0, så uten en egen sjekk ville
    // et felt som mangler blitt til «0 B» — en påstand om at fila er tom.
    for (const tom of [null, undefined, '']) {
        sjekk(`${JSON.stringify(tom)} gir null`, fra(tom), null);
    }
    sjekk('NaN gir null', fra(NaN), null);
    sjekk('Infinity gir null', fra(Infinity), null);
    sjekk('negativt gir null', fra(-1), null);
    sjekk('tekst som ikke er et tall gir null', fra('stor'), null);
    // Et tall som streng er et tall. API-svar har hatt begge former.
    sjekk('tallstreng godtas', fra('2048'), '2 kB');

    // Desimalskilletegnet er komma, som i resten av grensesnittet.
    sjekk('komma, ikke punktum', /\./.test(fra(1536)), false);
    sjekk('og komma finnes der det skal', fra(1536).includes(','), true);
}

// ---------- 2. de to eksemplarene svarer likt ----------
//
// Dette er hele grunnen til at duplikatet godtas. Endres den ene, feiler
// dette til den andre er endret likt.
{
    const VERDIER = [null, undefined, '', NaN, Infinity, -1, -0.4, 0, 1, 999, 1023, 1024,
        1025, 1536, 4200, 50 * KB, MB - 1, MB, 1.5 * MB, 99.9 * MB, 100 * MB, 128 * MB,
        GB - 1, GB, 1536 * MB, 1024 * GB, 1e15, '2048', '0', 0.4, 1023.6];
    const ulike = VERDIER
        .filter(v => JSON.stringify(fra(v)) !== JSON.stringify(bak(v)))
        .map(v => `${JSON.stringify(v)}: frontend ${JSON.stringify(fra(v))} ≠ backend ${JSON.stringify(bak(v))}`);
    sjekk('de to eksemplarene svarer likt', ulike, []);
    sjekk('og tabellen er ikke tom', VERDIER.length > 20, true);

    // Og de er faktisk to ulike filer, ikke den samme lest to ganger.
    sjekk('frontend eksporterer som ES-modul', /export function formatStorrelse/.test(les(FRONTEND)), true);
    sjekk('backend eksporterer som CommonJS', /module\.exports = \{ formatStorrelse \}/.test(les(BACKEND)), true);

    // Strengere enn «samme svar»: funksjonskroppene skal være TEGN FOR TEGN
    // like. En tabell på tretti verdier kan ikke utelukke at to utgaver skiller
    // lag på den trettiførste, og en omskriving av bare den ene er nøyaktig
    // slik to kopier begynner å svare ulikt. Må de en dag skille lag, skal det
    // være en beslutning noen tar mens denne sjekken er rød — ikke noe som
    // sklir inn.
    const kropp = (kilde) => {
        const start = kilde.indexOf('function formatStorrelse(');
        const slutt = kilde.indexOf('\n}', start);
        return kilde.slice(start, slutt + 2);
    };
    sjekk('funksjonskroppene er identiske', kropp(les(FRONTEND)) === kropp(les(BACKEND)), true);
}

// ---------- 3. ingen tredje kopi ----------
{
    const filer = [];
    const gå = (...deler) => {
        const katalog = path.join(rot, ...deler);
        for (const n of fs.readdirSync(katalog, { withFileTypes: true })) {
            if (n.isDirectory()) { gå(...deler, n.name); continue; }
            if (n.name.endsWith('.js') || n.name.endsWith('.html')) filer.push([...deler, n.name]);
        }
    };
    gå('api', 'src');
    gå('frontend');

    // Den gamle formelen, i alle variantene den fanst i.
    const GAMMEL = /\/\s*1024\s*\/\s*1024/;
    const FRITATT = new Set([
        // Minnet på maskinen, ikke en filstørrelse. «16 GB» ville vært fint,
        // men verdien går til et felt som heter minneMB og leses som et tall.
        path.join('api', 'src', 'functions', 'system.js')
    ]);
    const kopier = filer
        .map(d => d.join(path.sep))
        .filter(rel => !FRITATT.has(rel))
        .filter(rel => GAMMEL.test(utenKommentarer(les(rel))));
    sjekk('ingen bruker den gamle formelen', kopier.sort(), []);

    // Og fritaket skal ikke samle støv.
    const dodeFritak = [...FRITATT].filter(rel => !GAMMEL.test(utenKommentarer(les(rel))));
    sjekk('ingen død oppføring i fritakslista', dodeFritak.sort(), []);
}

// ---------- 4. hver bruker har funksjonen i scope ----------
//
// En glemt import gir en ReferenceError først når kodestien KJØRES, og de
// stiene er typisk feilmeldinger om at noe er for stort — altså akkurat det
// som sjelden testes. `ai-analyser.js` manglet importen i et par minutter
// mens dette ble skrevet, og hele testsuiten var grønn hele tiden.
{
    const mangler = [];

    const gåApi = (...deler) => {
        const katalog = path.join(rot, ...deler);
        for (const n of fs.readdirSync(katalog, { withFileTypes: true })) {
            if (n.isDirectory()) { gåApi(...deler, n.name); continue; }
            if (!n.name.endsWith('.js')) continue;
            const rel = [...deler, n.name].join(path.sep);
            if (rel === BACKEND) continue;
            const kode = utenKommentarer(les(rel));
            if (!/\bformatStorrelse\s*\(/.test(kode)) continue;
            if (!/require\(['"][^'"]*storrelse['"]\)/.test(kode)) mangler.push(rel);
        }
    };
    gåApi('api', 'src');

    for (const rel of [path.join('frontend', 'admin.html'), path.join('frontend', 'editor.html'),
        path.join('frontend', 'js', 'felt-render.js')]) {
        const kode = utenKommentarer(les(rel));
        if (!/\bformatStorrelse\s*\(/.test(kode)) { mangler.push(`${rel} (bruker den ikke lenger)`); continue; }
        if (!bundneNavn(kode).has('formatStorrelse')) mangler.push(rel);
    }

    sjekk('hver bruker har formatStorrelse i scope', mangler.sort(), []);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
