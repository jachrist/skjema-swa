/**
 * Diagnosen i `POST /api/skjemaer` — og at den ALDRI avviser.
 *
 * Valgt 22.10.2026, etter spørsmålet «hvordan skal et skjema som bryter
 * valideringen komme inn via API-et?». Svaret var at det er to veier:
 * utfyllingssiden, som validerer, og `register.html`, som redigerer svar
 * og poster til samme endepunkt UTEN å validere.
 *
 * Backend håndhever likevel ikke. Samme endepunkt lagrer UTKAST, som med
 * vilje er uten validering, og en regel lagt til i ettertid ville gjort et
 * gammelt utkast umulig å sende inn — brukeren ville stått fast i en
 * definisjon hen ikke rår over.
 *
 * Fire ting holdes fast:
 *
 *   **Den avviser ikke.** Ingen `return` med feilstatus i blokka, og
 *   lagringen skjer etterpå uansett.
 *
 *   **Den gjelder bare innsending.** Et utkast som ikke holder er helt
 *   normalt — det er halvveis utfylt.
 *
 *   **Den skriver ALLTID en linje, også ved null brudd.** En logglinje som
 *   bare finnes når noe er galt, kan ikke skille «ingen brudd» fra «koden
 *   er ikke deployet».
 *
 *   **Den kan ikke velte innsendingen.** En feil i diagnosen fanges.
 *
 * Kjøres med:  node api/test/validering-diagnose.test.js
 */
const fs = require('fs');
const path = require('path');
const { utenKommentarer } = require('../../scripts/test-kilde.js');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const rot = path.join(__dirname, '..', '..');
const les = (...p) => fs.readFileSync(path.join(rot, ...p), 'utf8');

const kilde = les('api', 'src', 'functions', 'skjemaer.js');
const ren = utenKommentarer(kilde);

// Blokka: fra diagnosen til lagringen.
const fra = ren.indexOf('vilkar.bruddISkjema(');
sjekk('diagnosen finnes i endepunktet', fra > 0, true);
const til = ren.indexOf('await forekomstStorage.lagreSkjema(skjemaData, erNytt)', fra);
sjekk('og står FØR lagringen', til > fra, true);

// Hele if-blokka, fra betingelsen.
const start = ren.lastIndexOf('if (Number(skjemaData.Skjema_status) >= 2)', fra);
sjekk('den er betinget av status', start > 0 && start < fra, true);
const blokk = ren.slice(start, til);

// ---------- 1. den avviser ikke ----------
sjekk('ingen retur med feilstatus i diagnosen',
    /return\s*\{\s*status:/.test(blokk), false);
sjekk('ingen throw heller', /\bthrow\b/.test(blokk), false);

// ---------- 2. bare ved innsending ----------
sjekk('utkast (status 1) er utenfor',
    /Skjema_status\) >= 2/.test(blokk), true);

// ---------- 3. alltid en linje ----------
//
// Antallet skrives uavhengig av om det er noe å melde. Uten det er en tom
// logg ikke til å skille fra en som ikke kjører.
sjekk('linja bærer et antall', /brudd\.length\} brudd/.test(blokk), true);
{
    // Logg-kallet må ligge UTENFOR en if på brudd.length.
    const loggIdx = blokk.indexOf('context.log(`validering:');
    const foran = blokk.slice(0, loggIdx);
    sjekk('logg-kallet står ikke bak en test på antallet',
        /if\s*\([^)]*brudd\.length[^)]*\)\s*\{\s*$/.test(foran.trimEnd()), false);
}

// ---------- 4. den kan ikke velte innsendingen ----------
sjekk('diagnosen er pakket i try', /try\s*\{/.test(blokk), true);
sjekk('og fanger feilen', /catch\s*\(e\)/.test(blokk), true);
sjekk('og sier fra når den selv feiler',
    /diagnosen feilet/.test(blokk), true);

// ---------- 5. registeret advarer, men sperrer ikke ----------
//
// Det er veien forbi `valider()`. Den skal si fra, og slippe gjennom.
{
    const reg = utenKommentarer(les('frontend', 'register.html'));

    sjekk('registeret importerer bruddISkjema',
        /import \{[^}]*\bbruddISkjema\b[^}]*\} from '\.\/js\/vilkar\.js'/.test(reg), true);

    const iBrudd = reg.indexOf('bruddISkjema(state.skjematype');
    const iPost = reg.indexOf("api.post('/api/skjemaer'");
    sjekk('sjekken står før lagringen', iBrudd > 0 && iBrudd < iPost, true);

    const blokk2 = reg.slice(iBrudd, iPost);

    // SVARET må avgjøre. Første utgave sjekket bare at `confirm` sto der,
    // og en mutasjon til `false && confirm(...)` overlevde — da sperrer
    // registeret i stedet for å spørre, som er nøyaktig det motsatte av
    // valget. Her kreves formen der svaret faktisk brukes.
    sjekk('svaret kommer direkte fra dialogen',
        /const svar = confirm\(/.test(blokk2), true);
    sjekk('og bare et NEI stopper lagringen',
        /if \(!svar\) return;/.test(blokk2), true);
    sjekk('og lar brukeren fortsette', /Lagre likevel\?/.test(blokk2), true);
    sjekk('meldingene vises', /b\.melding/.test(blokk2), true);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
