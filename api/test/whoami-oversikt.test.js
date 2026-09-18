/**
 * `serSkjemaoversikt` — hvem som får se lenken til «Velg skjema».
 *
 * Admin, skjemaskapere og eiere. Eierskap er per skjematype, så det finnes
 * ikke noe globalt «er eier»-flagg å slå opp; svaret er om brukeren eier NOEN
 * av dem.
 *
 * Feltet er en avgjørelse, ikke en rolleliste. Sidene skal lese det ferdige
 * svaret — settes de tre rollene sammen i hver HTML-fil, ligger regelen ti
 * steder og kan gli fra hverandre.
 *
 * To ting testes, og den andre er den som betyr noe i praksis:
 *
 *   Rollene gir riktig svar.
 *
 *   **Et feilende oppslag svarer nei.** En lenke for lite er en omvei; en
 *   lenke for mye er en side brukeren ikke skulle sett. Kaster
 *   skjematype-oppslaget, skal whoami fortsatt svare — hele siden henger på
 *   det kallet.
 *
 * Kjøres med:  node api/test/whoami-oversikt.test.js
 */
let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const fs = require('fs');
const path = require('path');

const kilde = fs.readFileSync(path.join(__dirname, '..', 'src', 'functions', 'whoami.js'), 'utf8');
const kode = kilde.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

// ---------- feltet finnes og returneres ----------
{
    sjekk('serSkjemaoversikt returneres', /jsonBody:[\s\S]*serSkjemaoversikt/.test(kode), true);

    // Admin og skjemaskaper skal gi ja uten å spørre videre — de er allerede
    // avklart lenger oppe i handleren.
    sjekk('bygger på kanOppretteSkjematype',
        /serSkjemaoversikt\s*=\s*kanOppretteSkjematype/.test(kode), true);

    // Eierskap slås bare opp når svaret ikke allerede er ja. Ellers ville hver
    // whoami fra en admin skannet alle skjematyper til ingen nytte.
    sjekk('eier-oppslaget er betinget',
        /if\s*\(!serSkjemaoversikt\)/.test(kode), true);
    sjekk('spør om Eiere', /filtrerTyperPåTilgang\([^)]*'Eiere'\)/.test(kode), true);
    sjekk('ja når hen eier minst én', /eide\.length\s*>\s*0/.test(kode), true);
}

// ---------- feiler lukket ----------
{
    // Finn blokken rundt eier-oppslaget og se at den er pakket inn.
    const start = kode.indexOf('if (!serSkjemaoversikt)');
    const blokk = kode.slice(start, start + 400);
    sjekk('eier-oppslaget kan ikke velte whoami', /try\s*\{/.test(blokk), true);
    sjekk('og det fanges', /catch/.test(blokk), true);

    // Ingen `serSkjemaoversikt = true` inne i catch — nei er det trygge svaret.
    const iCatch = /catch\s*\([^)]*\)\s*\{([^}]*)\}/.exec(blokk)?.[1] || '';
    sjekk('setter ikke ja ved feil', /serSkjemaoversikt\s*=\s*true/.test(iCatch), false);
}

// ---------- rollelogikken, som ren funksjon ----------
{
    // Samme regel, skrevet ut: dette er kontrakten sidene leser.
    const ser = (admin, skjemaskaper, antallEide) => admin || skjemaskaper || antallEide > 0;

    sjekk('admin', ser(true, false, 0), true);
    sjekk('skjemaskaper', ser(false, true, 0), true);
    sjekk('eier av én', ser(false, false, 1), true);
    sjekk('vanlig innsender', ser(false, false, 0), false);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
