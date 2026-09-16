/**
 * To responsive regler som må gjelde på hver side (TODO 21).
 *
 * Sidene har egen inline CSS med vilje — samme mønster som referanse-appen, og
 * `CLAUDE.md` sier at felles CSS ikke skal trekkes ut uten avtale. Prisen er at
 * samme blokk finnes i tolv filer, og at en ny side lages ved å kopiere en
 * gammel. Da arver den også feilene.
 *
 * Derfor testes reglene her i stedet for å samles ett sted:
 *
 *   **`.topprad` må kunne brytes.** Uten `flex-wrap` presser en lang UPN seg ut
 *   av containeren i stedet for ned på egen linje. Det var symptomet: «Pålogget
 *   bruker ligger utenfor rammen og opptar halve bredden i mobilvisning.»
 *
 *   **`.brukerinfo` må kunne krympe og brytes.** Et flex-element går ellers
 *   aldri under innholdsbredden, og en UPN er ett langt ord uten brytepunkter.
 *
 *   **`.informasjon` må bryte lange ord.** En overskrift uten mellomrom brøt ut
 *   av boksen sin. `overflow-wrap` arves, så regelen dekker h1–h3 inni.
 *
 * Kjøres med:  node frontend/test/responsiv.test.js
 */
const fs = require('fs');
const path = require('path');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const mappe = path.join(__dirname, '..');
const sider = fs.readdirSync(mappe).filter(f => f.endsWith('.html')).sort();

/** Hent innholdet i én CSS-regel, med klammetelling så nøstede blokker ikke kutter for tidlig. */
function regel(kilde, velger) {
    const start = kilde.indexOf(velger + ' {');
    if (start === -1) return null;
    let i = kilde.indexOf('{', start), dybde = 0;
    for (let j = i; j < kilde.length; j++) {
        if (kilde[j] === '{') dybde++;
        else if (kilde[j] === '}') { dybde--; if (dybde === 0) return kilde.slice(i + 1, j); }
    }
    return null;
}

sjekk('det finnes sider å teste', sider.length > 0, true);

let medTopprad = 0, medBrukerinfo = 0, medInformasjon = 0;

for (const fil of sider) {
    const kilde = fs.readFileSync(path.join(mappe, fil), 'utf8');

    const topprad = regel(kilde, '.topprad');
    if (topprad) {
        medTopprad++;
        sjekk(`${fil}: .topprad kan brytes`, /flex-wrap\s*:\s*wrap/.test(topprad), true);
    }

    const brukerinfo = regel(kilde, '.brukerinfo');
    if (brukerinfo) {
        medBrukerinfo++;
        sjekk(`${fil}: .brukerinfo kan krympe`, /min-width\s*:\s*0/.test(brukerinfo), true);
        sjekk(`${fil}: .brukerinfo kan brytes`, /overflow-wrap\s*:/.test(brukerinfo), true);
    }

    // En side som viser brukeren må også ha en regel for den. Uten dette
    // ville en ny side kunne slippe unna ved å droppe regelen helt.
    if (kilde.includes('class="brukerinfo"')) {
        sjekk(`${fil}: har en .brukerinfo-regel`, brukerinfo !== null, true);
    }

    const informasjon = regel(kilde, '.informasjon');
    if (informasjon) {
        medInformasjon++;
        sjekk(`${fil}: .informasjon bryter lange ord`, /overflow-wrap\s*:/.test(informasjon), true);
    }
}

// Finner testen ingen regler, tester den ingenting — og ville meldt «alt OK».
sjekk('fant .topprad-regler', medTopprad > 0, true);
sjekk('fant .brukerinfo-regler', medBrukerinfo > 0, true);
sjekk('fant .informasjon-regler', medInformasjon > 0, true);

console.log(`\n${ok} OK, ${feil} feil  (${medTopprad} topprad, ${medBrukerinfo} brukerinfo, ${medInformasjon} informasjon)`);
process.exit(feil ? 1 : 0);
