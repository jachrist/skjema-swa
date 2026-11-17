/**
 * scripts/hr-skjema.js — JSON-skjema fra en datafil, uten verdier.
 *
 * Verktøyet skal brukes på HR-filer med persondata. Det viktigste testen
 * passer på er derfor det verktøyet IKKE gjør: ingen verdi fra fila skal
 * finnes i utdataene, og fila skal ikke kunne snakke med nettverket.
 *
 * Alle data her er oppdiktede. Fødselsnumrene er syntetiske, laget med riktige
 * kontrollsifre.
 *
 * Kjøres med:  node api/test/hr-skjema.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const FIL = path.join(__dirname, '..', '..', 'scripts', 'hr-skjema.js');
const h = require(FIL);

// Syntetiske fødselsnumre: ni sifre + to beregnede kontrollsifre.
function lagFnr(ni) {
    const d = [...ni].map(Number);
    const k = (v, ds) => { const r = 11 - (v.reduce((s, x, i) => s + x * ds[i], 0) % 11); return r === 11 ? 0 : r; };
    const k1 = k([3, 7, 6, 1, 8, 9, 4, 5, 2], d);
    if (k1 === 10) return null;
    const k2 = k([5, 4, 3, 2, 7, 6, 5, 4, 3, 2], [...d, k1]);
    if (k2 === 10) return null;
    return ni + k1 + k2;
}
const fnr = [];
for (let i = 0; fnr.length < 3; i++) { const f = lagFnr(String(150390100 + i * 7)); if (f) fnr.push(f); }

// ---------- 1. kontrollsifrene ----------
sjekk('syntetisk fnr er gyldig', fnr.every(h.erFnr), true);
sjekk('ett siffer feil er ikke fnr', h.erFnr(fnr[0].slice(0, 10) + ((Number(fnr[0][10]) + 1) % 10)), false);
sjekk('ti sifre er ikke fnr', h.erFnr(fnr[0].slice(1)), false);

// ---------- 2. CSV: persondata ----------
const person = [
    'Ansattnr;Fornavn;Etternavn;Fodselsnummer;Epost;Mobil;Enhet;Startdato;Stillingsprosent;Leder',
    `00417;Kjellfrid;Brattvollsen;${fnr[0]};kjellfrid.brattvollsen@eksempel.no;91234567;ORG-STABSKOLE;2019-08-01;100;true`,
    `00418;"Ola ""Junior""";Trøndersmo;${fnr[1]};ola.trondersmo@eksempel.no;;ORG-STABSKOLE;2021-01-15;80,5;false`,
    `00419;Synnøve;"Hagen; Lie";${fnr[2]};synnove.hl@eksempel.no;47112233;ORG-LUFTKRIGSSKOLE;2023-03-01;100;false`
].join('\r\n');
const sp = h.lagSkjema(Buffer.from(person, 'utf8'), { navn: 'Person', filnavn: '/hjem/x/person.csv' });
const felt = sp.items.properties;

sjekk('csv: kilde', [sp['x-kilde'].format, sp['x-kilde'].skilletegn, sp['x-kilde'].rader, sp['x-kilde'].tegnkoding], ['csv', ';', 3, 'utf-8']);
sjekk('csv: bare filnavnet, ikke stien', sp['x-kilde'].fil, 'person.csv');
sjekk('csv: alle feltene', Object.keys(felt), ['Ansattnr', 'Fornavn', 'Etternavn', 'Fodselsnummer', 'Epost', 'Mobil', 'Enhet', 'Startdato', 'Stillingsprosent', 'Leder']);
sjekk('ansattnr med null foran er tekst, ikke tall', [felt.Ansattnr.type, felt.Ansattnr['x-format']], ['string', 'sifre']);
sjekk('ansattnr er unikt', felt.Ansattnr['x-statistikk'].unik, true);
sjekk('enhet er ikke unik', [felt.Enhet['x-statistikk'].unik, felt.Enhet['x-statistikk'].distinkte], [false, 2]);
sjekk('fødselsnummer gjenkjent', felt.Fodselsnummer['x-mistanke'].includes('fødselsnummer'), true);
sjekk('e-post', [felt.Epost.format, felt.Epost['x-mistanke']], ['email', ['e-post']]);
sjekk('mobil med tom verdi', [felt.Mobil.type, felt.Mobil['x-statistikk'].tomme, felt.Mobil['x-mistanke']], [['string', 'null'], 1, ['telefon']]);
sjekk('dato', felt.Startdato.format, 'date');
sjekk('desimal med komma gir number', felt.Stillingsprosent.type, 'number');
sjekk('boolsk', felt.Leder.type, 'boolean');
sjekk('navn mistenkt', [felt.Fornavn['x-mistanke'], felt.Etternavn['x-mistanke']], [['navn'], ['navn']]);
sjekk('anførselstegn og skilletegn i felt', h.parseCsv(person, ';').map(r => [r.length, r[1], r[2]]).slice(2),
    [[10, 'Ola "Junior"', 'Trøndersmo'], [10, 'Synnøve', 'Hagen; Lie']]);
sjekk('fødselsnummer i CSV er tekst', [felt.Fodselsnummer.type, felt.Fodselsnummer['x-format']], ['string', 'sifre']);
sjekk('kort tall er fortsatt tall', h.csvVerdi('4100'), 4100);
sjekk('required = alle kolonnene', sp.items.required.length, 10);

// ---------- 3. INGEN verdi i utdataene ----------
// Hver verdi som står i fila, testes mot hele utdataene. Unntak: korte
// tall og ord som også er JSON-Schema-ord eller tellinger.
function verdier(tekst, skille) {
    return h.parseCsv(tekst, skille).slice(1).flat().map(v => v.trim()).filter(v => v.length >= 4 && !/^(true|false|100)$/.test(v));
}
const utPerson = JSON.stringify(sp);
const lekk = verdier(person, ';').filter(v => utPerson.includes(v));
sjekk('ingen verdi fra persondata i utdataene', lekk, []);
sjekk('fant verdier å sjekke mot', verdier(person, ';').length > 20, true);

// ---------- 4. JSON: strukturdata ----------
const struktur = {
    eksportert: '2026-11-17T06:00:00Z',
    enheter: [
        { id: 'ORG-STABSKOLE', navn: 'Stabsskolen Eksempel', overordnet: null, kostnadssted: 41007, leder: { ansattnr: '00417' } },
        { id: 'ORG-LUFTKRIGSSKOLE', navn: 'Luftkrigsskolen Eksempel', overordnet: 'ORG-STABSKOLE', kostnadssted: 41008, leder: { ansattnr: '00419' }, nedlagt: '2027-01-01' }
    ]
};
const sj = h.lagSkjema(Buffer.from(JSON.stringify(struktur), 'utf8'), { navn: 'Struktur' });
const enhet = sj.properties.enheter.items;
sjekk('json: format', sj['x-kilde'].format, 'json');
sjekk('json: tidsstempel', sj.properties.eksportert.format, 'date-time');
sjekk('json: felt i enheter', Object.keys(enhet.properties), ['id', 'navn', 'overordnet', 'kostnadssted', 'leder', 'nedlagt']);
sjekk('json: nedlagt er ikke påkrevd', enhet.required.includes('nedlagt'), false);
sjekk('json: id er påkrevd', enhet.required.includes('id'), true);
sjekk('json: overordnet kan være null', enhet.properties.overordnet.type, ['string', 'null']);
sjekk('json: nøstet objekt', Object.keys(enhet.properties.leder.properties), ['ansattnr']);
sjekk('json: tall forblir tall', enhet.properties.kostnadssted.type, 'integer');
const utStruktur = JSON.stringify(sj);
sjekk('ingen verdi fra strukturdata i utdataene',
    ['Stabsskolen Eksempel', 'Luftkrigsskolen Eksempel', 'ORG-STABSKOLE', 'ORG-LUFTKRIGSSKOLE', '41007', '00417', '2027-01-01', '2026-11-17T06'].filter(v => utStruktur.includes(v)), []);

// Format bare når ALLE verdiene har det. «ukjent» blant datoene gjør feltet
// til vanlig tekst — ellers lover skjemaet noe fila ikke holder.
const blandet = h.lagSkjema(Buffer.from('Dato\n2026-01-01\nukjent\n'), {}).items.properties.Dato;
sjekk('blandet format gir ikke format', [blandet.format, blandet['x-format']], [undefined, undefined]);

// Funnet i det første HR-uttrekket: en liste som alltid er tom, og felt som
// sier noe om beskyttelse og opphav.
const hr = h.lagSkjema(Buffer.from(JSON.stringify([
    { stillinger: [], skjermet: false, dsfSpesStatusKode: '0', nasjonalitet: 'NOR' },
    { stillinger: [], skjermet: false, dsfSpesStatusKode: '0', nasjonalitet: 'NOR' }
])), {}).items.properties;
sjekk('alltid tom liste: ingen items', [hr.stillinger.items, hr.stillinger['x-alltid-tom']], [undefined, true]);
sjekk('liste med innhold har items', sj.properties.enheter.items.type, 'object');
sjekk('skjerming', hr.skjermet['x-mistanke'], ['skjerming']);
sjekk('folkeregister', hr.dsfSpesStatusKode['x-mistanke'], ['folkeregister']);
sjekk('nasjonalitet', hr.nasjonalitet['x-mistanke'], ['nasjonalitet']);
sjekk('konkatenert enhetsnavn er ikke personnavn', h.lagSkjema(Buffer.from('[{"konkatenertNavn":"x"},{"konkatenertNavn":"y"}]'), {}).items.properties.konkatenertNavn['x-mistanke'], undefined);

// ---------- 5. tegnkoding ----------
const latin = Buffer.from('Navn,By\nSynnøve,Tromsø\n', 'latin1');
const sl = h.lagSkjema(latin, {});
sjekk('windows-1252 gjenkjent', sl['x-kilde'].tegnkoding, 'windows-1252');
sjekk('komma som skilletegn', sl['x-kilde'].skilletegn, ',');
const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('A\tB\n1\t2\n')]);
const sb = h.lagSkjema(bom, {});
sjekk('BOM og tab', [sb['x-kilde'].tegnkoding, sb['x-kilde'].skilletegn, Object.keys(sb.items.properties)], ['utf-8 med BOM', 'tab', ['A', 'B']]);

// ---------- 6. ødelagt JSON siterer ikke innholdet ----------
let melding = '';
try { h.lagSkjema(Buffer.from(`[{"fnr": "${fnr[0]}", }]`), {}); } catch (e) { melding = e.message; }
sjekk('ødelagt JSON: feilmelding uten innhold', [melding.length > 0, melding.includes(fnr[0])], [true, false]);
sjekk('0 er ikke et fødselsnummer', h.lagSkjema(Buffer.from('[{"n":0},{"n":0}]'), {}).items.properties.n['x-mistanke'], undefined);

// ---------- 7. nekter filer i et git-repo ----------
sjekk('denne testfila ligger i et repo', !!h.iGitRepo(__filename), true);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-skjema-'));
const utenfor = path.join(tmp, 'p.csv');
fs.writeFileSync(utenfor, 'a;b\n1;2\n');
sjekk('fil utenfor repo er ok', h.iGitRepo(utenfor), null);
const feilUt = console.error; let stderr = '';
console.error = (m) => { stderr += m; };
const kode = h.main(['node', 'x', __filename]);
console.error = feilUt;
sjekk('main nekter fil i repo', [kode, /git-repo/.test(stderr)], [2, true]);
const utFil = path.join(tmp, 'p.schema.json');
console.error = () => {};
const kode2 = h.main(['node', 'x', utenfor, '--ut', utFil, '--navn', 'P']);
console.error = feilUt;
sjekk('main skriver skjema utenfor repo', [kode2, JSON.parse(fs.readFileSync(utFil, 'utf8')).title], [0, 'P']);
fs.rmSync(tmp, { recursive: true, force: true });

// ---------- 8. ingen nettverk ----------
// Les kilden, uten kommentarene: dokumentasjonen nevner gjerne ordene.
const kilde = fs.readFileSync(FIL, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const krav = [...kilde.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]).sort();
sjekk('bare fs og path', krav, ['fs', 'path']);
sjekk('ingen fetch, import() eller process.binding', /\bfetch\s*\(|\bimport\s*\(|process\.binding|WebSocket|XMLHttpRequest/.test(kilde), false);

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
