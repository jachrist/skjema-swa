/**
 * Svargrensen i grensesnittet.
 *
 * To sider er involvert, og de har hver sin jobb:
 *
 *   **editor.html** eier innstillingen. Den ligger nå under «Tilgjengelighet»,
 *   sammen med periodene — panelet het «Tilgjengelighetsperioder» og dekker to
 *   ting nå.
 *
 *   **index.html** spør FØR den tegner skjemaet. Uten det fyller en person ut
 *   hele skjemaet og får først ved innsending vite at hen ikke kan svare. For
 *   en avstemning er det en dårlig opplevelse; for et langt skjema er det
 *   tapt arbeid.
 *
 * Det viktigste testen passer på er at index.html IKKE avgjør noe selv.
 * Regelen bor i `lib/svargrense.js` på serveren, og en kopi i nettleseren
 * ville før eller siden sagt noe annet — med den forskjellen at kopien er den
 * brukeren ser.
 *
 * Kjøres med:  node frontend/test/svargrense-ui.test.js
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

const rot = path.join(__dirname, '..');
const les = (f) => utenKommentarer(fs.readFileSync(path.join(rot, f), 'utf8'));

// ---------- editoren ----------
{
    const e = les('editor.html');

    // Panelet dekker to ting nå, og skal ikke hete som om det bare dekker ett.
    sjekk('panelet heter Tilgjengelighet', /▼<\/span>Tilgjengelighet /.test(e), true);
    sjekk('ikke lenger Tilgjengelighetsperioder som overskrift',
        /▼<\/span>Tilgjengelighetsperioder/.test(e), false);
    // Periodene er fortsatt der — omdøpingen skal ikke ha spist dem.
    sjekk('periodene er beholdt', /id="perioder-container"/.test(e), true);
    sjekk('og kan fortsatt legges til', /leggTilPeriode\(\)/.test(e), true);

    sjekk('feltet finnes', /id="maks-svar"/.test(e), true);
    sjekk('det er et tallfelt', /type="number"[^>]*id="maks-svar"/.test(e), true);
    sjekk('det kan ikke settes negativt', /id="maks-svar"[\s\S]{0,200}min="0"|min="0"[^>]*id="maks-svar"/.test(e), true);
    sjekk('verdien leses fra skjematypen', /data\.MaksSvarPerBruker \|\| 0/.test(e), true);
    sjekk('og skrives tilbake', /data\.MaksSvarPerBruker =/.test(e), true);

    // Feltet ligger i riktig panel. Uten dette kunne det havnet hvor som helst
    // og testen over ville fortsatt bestått.
    const panelStart = e.indexOf('data-panel-id="tilgjengelighet"');
    const nestePanel = e.indexOf('<div class="panel"', panelStart + 10);
    sjekk('feltet ligger i tilgjengelighetspanelet',
        panelStart > -1 && e.slice(panelStart, nestePanel).includes('id="maks-svar"'), true);
}

// ---------- utfyllingssiden ----------
{
    const i = les('index.html');

    sjekk('siden spør serveren', /kan-svare/.test(i), true);
    sjekk('og holder eget skjema utenfor', /unntatt=\$\{encodeURIComponent\(skjemaId\)\}/.test(i), true);

    // Begge autentiseringsveiene — innlogget og ekstern OTP. Én av dem alene
    // ville gitt en grense som bare gjaldt halvparten av brukerne.
    sjekk('sjekken kjøres to steder',
        (i.match(/svargrenseTillater\(\)\) return/g) || []).length, 2);

    // Den må ligge FØR tegningen. Etterpå er skjemaet allerede synlig.
    const kall = [...i.matchAll(/if \(!await svargrenseTillater\(\)\) return;\s*\n\s*rendrer\(\);/g)];
    sjekk('sjekken står rett før rendrer()', kall.length, 2);

    // Siden skal ikke ha sin egen kopi av regelen.
    sjekk('ingen egen telling i nettleseren', /MaksSvarPerBruker/.test(i), false);
    sjekk('ingen egen statusregel', /Skjema_status.*>=\s*2/.test(i), false);

    // 409 fra innsendingen er ikke en teknisk feil, og skal ikke se ut som en.
    sjekk('409 håndteres særskilt', /e\.status === 409/.test(i), true);
    sjekk('og gir ikke en alert', /e\.status === 409[\s\S]{0,400}alert\(/.test(i), false);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
