/**
 * Tester for miljøavhengige env-variabler i helsesjekken.
 *
 * `AAD_CLIENT_SECRET` hører hjemme i pilot, men ikke i prod: der autentiserer
 * SWA med sertifikat fra Key Vault. Uten dette skillet rapporterer
 * helsesjekken en mangel i prod som ikke er en mangel, og den som forvalter
 * løsningen leter etter noe som ikke skal finnes.
 *
 * Den motsatte feilen er verre og testes derfor også: skillet må ikke skjule
 * en ekte mangel i pilot, der hemmeligheten faktisk trengs.
 *
 * Kjøres med:  node api/test/system-miljo.test.js
 */
let modul = null;
try { modul = require('../src/functions/system'); } catch (_) { /* uten @azure/functions */ }

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

if (!modul?._medForventning) {
    console.log('(hopper over — @azure/functions ikke installert)');
    console.log('\n0 OK, 0 feil, 1 hoppet over');
    process.exit(0);
}
const { _medForventning: medForventning } = modul;

const før = process.env.MILJO;
const TOM = { satt: false };
const SATT = { satt: true, lengde: 40 };

// ---------- prod: hemmeligheten skal ikke finnes ----------
{
    process.env.MILJO = 'prod';
    const r = medForventning('AAD_CLIENT_SECRET', TOM);
    sjekk('prod: tom verdi er forventet', r.gjelderHer, false);
    sjekk('prod: får en forklaring', typeof r.merknad === 'string' && r.merknad.length > 0, true);
    sjekk('prod: satt-flagget røres ikke', r.satt, false);

    // Historisk skrivemåte — pilot-SWA-en het «Production» en stund.
    process.env.MILJO = 'Production';
    sjekk('production regnes som prod', medForventning('AAD_CLIENT_SECRET', TOM).gjelderHer, false);
}

// ---------- pilot: en manglende hemmelighet er en ekte mangel ----------
{
    process.env.MILJO = 'pilot';
    const r = medForventning('AAD_CLIENT_SECRET', TOM);
    sjekk('pilot: ingen unnskyldning for tom verdi', r.gjelderHer, undefined);
    sjekk('pilot: ingen merknad', r.merknad, undefined);
    sjekk('pilot: rapporten er uendret', r, TOM);
}

// ---------- andre variabler røres ikke ----------
{
    process.env.MILJO = 'prod';
    sjekk('STORAGE_CONNECTION_STRING uendret i prod',
        medForventning('STORAGE_CONNECTION_STRING', TOM), TOM);
    sjekk('AAD_CLIENT_ID uendret i prod',
        medForventning('AAD_CLIENT_ID', SATT), SATT);
}

// ---------- ukjent miljø skal ikke friskmelde noe ----------
{
    // Er MILJO ikke satt, vet vi ikke nok til å påstå at en tom verdi er
    // greit. Da er det tryggere å la den framstå som en mangel.
    process.env.MILJO = '';
    sjekk('tomt MILJO gir ingen unnskyldning',
        medForventning('AAD_CLIENT_SECRET', TOM).gjelderHer, undefined);
    delete process.env.MILJO;
    sjekk('MILJO mangler helt gir ingen unnskyldning',
        medForventning('AAD_CLIENT_SECRET', TOM).gjelderHer, undefined);
}

// ---------- en satt verdi i prod skjules ikke ----------
{
    process.env.MILJO = 'prod';
    const r = medForventning('AAD_CLIENT_SECRET', SATT);
    sjekk('prod: satt verdi rapporteres fortsatt', r.satt, true);
    sjekk('prod: og markeres som utenfor miljøet', r.gjelderHer, false);
}

if (før === undefined) delete process.env.MILJO; else process.env.MILJO = før;

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
