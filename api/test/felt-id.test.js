/**
 * Feltets Id — hva som kjennes igjen som en Id-referanse `{…}`.
 *
 * Papirskjema-importen i editoren ga feltene Id på formen `f-xxxx-xxxx`, ikke
 * en UUID. Editoren skriver `{1-02}` om til `{feltets Id}` ved innlasting
 * (feltref-migrering.js), så skjematyper fra importen fikk referanser på den
 * formen — og API-et kjente bare igjen UUID-er. Kvitteringen 24.11.2026 sa
 * «Tiltak: {f-7ayo1o14-mwndgmjv}». Diagnosen godtok referansen (den slår opp
 * Id-en uten å se på formen), så «Sjekk oppsettet» var grønn.
 *
 * Mønsteret står fem steder — frontend kan ikke `require` backend, og
 * vilkårsmotoren finnes i to eksemplarer. Testen leser alle fem og krever
 * samme mønster, og kjører de ekte funksjonene med en Id av hver form.
 *
 * Kjøres med:  node api/test/felt-id.test.js
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

const UUID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const IMPORT = 'f-7ayo1o14-mwndgmjv';

// ---------- 1. samme mønster alle fem steder ----------
const STEDER = [
    ['api/src/lib/vilkar.js', /const UUID_RE = \/\^(.+?)\$\/i;/],
    ['frontend/js/vilkar.js', /const UUID_RE = \/\^(.+?)\$\/i;/],
    ['api/src/lib/faste-data.js', /const UUID_RE = \/\^(.+?)\$\/i;/],
    ['api/src/lib/placeholder.js', /s = s\.replace\(\/\\\{\((.+?)\)\\\}\/gi,/],
    ['frontend/js/feltref-migrering.js', /const UUID = \/\\\{\((.+?)\)\\\}\/gi;/]
];
const monstre = STEDER.map(([fil, re]) => {
    const m = re.exec(les(...fil.split('/')));
    return m ? m[1] : `(fant ikke mønsteret i ${fil})`;
});
for (let i = 1; i < STEDER.length; i++) {
    sjekk(`${STEDER[i][0]} har samme Id-mønster som ${STEDER[0][0]}`, monstre[i], monstre[0]);
}
const ID = new RegExp(`^${monstre[0]}$`, 'i');
sjekk('mønsteret godtar en UUID', ID.test(UUID), true);
sjekk('mønsteret godtar Id-en fra importen', ID.test(IMPORT), true);
sjekk('mønsteret godtar ikke en posisjon', ID.test('1-02'), false);
sjekk('mønsteret godtar ikke en plassholder', ID.test('$navn'), false);

// ---------- 2. de ekte funksjonene ----------
const SEKSJONER = [{
    Seksjon_nummer: 1,
    Felter: [
        { Nummer: '01', Id: UUID, Type: 'Tekst', Svar: ['Første'] },
        { Nummer: '02', Id: IMPORT, Type: 'Tekst', Svar: ['Fra papirskjema'] }
    ]
}];

const { erstattPlassholdere } = require('../src/lib/placeholder');
const diagnose = require('../src/lib/skjematype-diagnose');
for (const [navn, id, svar] of [['UUID', UUID, 'Første'], ['import-Id', IMPORT, 'Fra papirskjema']]) {
    sjekk(`melding: ${navn} erstattes med svaret`,
        erstattPlassholdere(`Tiltak: {${id}}`, { seksjoner: SEKSJONER }), `Tiltak: ${svar}`);
    // Diagnosen og meldingen skal svare likt. Det var forskjellen mellom dem
    // som gjorde at feilen ikke ble sett.
    sjekk(`diagnosen finner ${navn}-feltet`, diagnose.refFinnes(SEKSJONER, id), true);
}
sjekk('melding: en import-Id uten felt blir tom, ikke stående',
    erstattPlassholdere('Tiltak: {f-finnes-ikke}', { seksjoner: SEKSJONER }), 'Tiltak: ');

const vilkarBak = require('../src/lib/vilkar');
const DELER = ['UUID_RE', 'IDAG_REF', 'ISO_DATO_RE',
    'erDNFFormat', 'erLegacyFormat', 'migrerTilDNF',
    'svarFraFelt', 'stegnummerFraRef', 'hentSvar', 'parsTall',
    'erIsoDato', 'idagISO', 'datoPlussDager', 'hoyreVerdi',
    'evaluerBetingelse'];
const vilkarFra = hentEksport(les('frontend', 'js', 'vilkar.js'), 'evaluerVilkar', DELER);
const vilkar = (id, verdi) => ({ EllerAv: [{ OgAv: [{ Felt: id, Operator: '=', Verdi: verdi }] }] });
for (const [navn, ev] of [['backend', vilkarBak.evaluerVilkar], ['frontend', vilkarFra]]) {
    sjekk(`vilkår (${navn}): import-Id treffer`, ev(vilkar(IMPORT, 'Fra papirskjema'), SEKSJONER, [], {}), true);
    sjekk(`vilkår (${navn}): import-Id med annet svar`, ev(vilkar(IMPORT, 'Noe annet'), SEKSJONER, [], {}), false);
}

const { erFeltreferanse } = require('../src/lib/faste-data');
sjekk('faste data: import-Id er en feltreferanse', erFeltreferanse(`{${IMPORT}}`), true);

const migKilde = les('frontend', 'js', 'feltref-migrering.js').replace(/export /g, '');
const { migrerStreng, byggPosisjonskart } = (new Function(
    migKilde + '\nreturn { migrerStreng, byggPosisjonskart };'))();
const kart = byggPosisjonskart(SEKSJONER);
sjekk('migrering: {1-02} festes til import-Id-en', migrerStreng('{1-02}', kart).tekst, `{${IMPORT}}`);
sjekk('migrering: en import-Id uten felt meldes som uløst',
    migrerStreng('{f-finnes-ikke}', kart).uloste, ['{f-finnes-ikke}']);

// ---------- 3. editoren lager Id-er mønsteret kjenner ----------
const editor = les('frontend', 'editor.html');
sjekk('papirskjema-importen bruker samme Id-kilde som resten av editoren',
    /function nyFeltId\b/.test(editor), false);
const nyIdKilde = /function nyId\(\) \{[\s\S]*?\n        \}/.exec(editor)?.[0] || '';
const nyId = (crypto) => new Function('crypto', `${nyIdKilde}; return nyId();`)(crypto);
sjekk('ny Id: UUID', ID.test(nyId({ randomUUID: () => UUID })), true);
sjekk('ny Id uten randomUUID: kjennes likevel igjen', ID.test(nyId({})), true);

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
