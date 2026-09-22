/**
 * Vis alle / Skjul alle følger med nedover siden.
 *
 * Skjemaeditoren er lang, og behovet for å kollapse alt oppstår nettopp når
 * man har blad langt ned. Måtte man tilbake til toppen for å nå knappen, var
 * den ikke der da den trengtes.
 *
 * Tre ting testes, og to av dem går i stykker uten at noe sier fra:
 *
 *   **Bare ÉN linje flyter.** `.kollaps-verktoy` brukes to steder — øverst og
 *   inne i Seksjoner-panelet. Fester begge seg, kjemper to striper om samme
 *   plass øverst på skjermen. Derfor `flytende` som egen klasse, og derfor
 *   en telling her.
 *
 *   **Ingen forelder klipper.** `position: sticky` slutter å virke uten
 *   feilmelding i det en forelder får `overflow: hidden` eller `auto`.
 *   `.container` er den eneste forelderen mellom stripa og body, og den er
 *   derfor låst til `overflow: visible`.
 *
 *   **Stripa må dekke.** Bakgrunn og z-index: uten dem glir innholdet
 *   synlig under knappene i stedet for bak dem. Modalene ligger på 1000 og
 *   9999, og stripa skal bli under dem.
 *
 * Kjøres med:  node frontend/test/flytende-verktoylinje.test.js
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

const kode = utenKommentarer(fs.readFileSync(path.join(__dirname, '..', 'editor.html'), 'utf8'));
sjekk('editor.html ble lest', kode.length > 50000, true);

// ---------- regelen finnes ----------
const regel = /\.kollaps-verktoy\.flytende\s*\{([\s\S]*?)\}/.exec(kode);
sjekk('flytende-regelen finnes', !!regel, true);
const css = regel ? regel[1] : '';

sjekk('den fester seg', /position:\s*sticky/.test(css), true);
sjekk('til toppen', /top:\s*0/.test(css), true);
sjekk('den har bakgrunn', /background:\s*var\(--bg-container\)/.test(css), true);

// ---------- bare én linje flyter ----------
{
    const alle = [...kode.matchAll(/class="kollaps-verktoy([^"]*)"/g)].map(m => m[1]);
    // Begge linjene skal fortsatt finnes — forsvinner den i Seksjoner-panelet,
    // er det en regresjon, ikke en forbedring.
    sjekk('begge verktøylinjene finnes', alle.length, 2);
    sjekk('nøyaktig én er flytende', alle.filter(k => k.includes('flytende')).length, 1);
}

// ---------- ingen forelder klipper ----------
{
    sjekk('containeren klipper ikke', /\.container \{ overflow: visible; \}/.test(kode), true);

    // Og ingen ANNEN regel setter overflow på .container. En sticky som
    // slutter å feste seg gir ingen feilmelding — bare en knapp som ikke er
    // der lenger.
    const containerRegler = [...kode.matchAll(/\.container\s*\{([^}]*)\}/g)].map(m => m[1]);
    const klipper = containerRegler.filter(r => /overflow[^:]*:\s*(hidden|auto|scroll|clip)/.test(r));
    sjekk('ingen container-regel klipper', klipper, []);
}

// ---------- under modalene ----------
{
    const z = /z-index:\s*(\d+)/.exec(css);
    sjekk('stripa har z-index', !!z, true);
    if (z) {
        const verdi = Number(z[1]);
        sjekk('den er over panelene', verdi > 0, true);
        // Modalene i denne fila ligger på 1000 og 9999. Havner stripa over
        // dem, legger den seg oppå dialogene.
        const modaler = [...kode.matchAll(/z-index:\s*(\d+)/g)]
            .map(m => Number(m[1]))
            .filter(v => v !== verdi);
        sjekk('fant modal-nivåene å sammenligne med', modaler.length > 0, true);
        sjekk('og stripa ligger under alle', modaler.every(m => m > verdi), true);
    }
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
