/**
 * Samtale-stilene må finnes på hver side som viser samtalen.
 *
 * `CLAUDE.md` sier at HTML-filene har inline CSS med vilje, og at felles CSS
 * ikke skal trekkes ut uten avtale. Prisen er at den samme blokken finnes to
 * steder — `evaluering.html` for behandlere og `visning.html` for innsender —
 * og at de kan gli fra hverandre uten at noe sier fra.
 *
 * Det er ikke kosmetikk her. Widgeten setter klassenavn; mangler regelen, blir
 * samtalen en stabel med uformatert tekst uten rulling og uten skille mellom
 * innlegg. Den VISES fortsatt, så ingenting feiler — den er bare ubrukelig.
 *
 * Testen sjekker at sidene er ENIGE om reglene, og at de tre som bærer
 * oppsettet finnes. Den krever ikke en regel per klassenavn: flere av dem er
 * rene JS-kroker, og et slikt krav ville tvunget fram tomme CSS-regler for å
 * blidgjøre testen.
 *
 * Kjøres med:  node frontend/test/samtale-css.test.js
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

// Sidene som faktisk importerer widgeten.
const sider = fs.readdirSync(mappe)
    .filter(f => f.endsWith('.html'))
    .filter(f => fs.readFileSync(path.join(mappe, f), 'utf8').includes("from './js/samtale.js'"));

sjekk('minst to sider viser samtalen', sider.length >= 2, true);

/** Alle .samtale*-velgere som er DEFINERT på en side. */
function velgere(kilde) {
    return [...kilde.matchAll(/(\.samtale[a-z-]*)(?=[\s,.:{])/g)]
        .map(m => m[1])
        .filter((v, i, a) => a.indexOf(v) === i)
        .sort();
}

// Parity er det som faktisk ryker: to inline-kopier som glir fra hverandre
// fordi noen rettet den ene. Ikke «har hver klasse en regel» — flere av dem er
// rene JS-kroker (`samtale-felt`, `samtale-send`, `samtale-demp-boks`), og å
// kreve CSS for dem ville tvunget fram tomme regler for å blidgjøre en test.
{
    const fasit = velgere(fs.readFileSync(path.join(mappe, sider[0]), 'utf8'));
    sjekk(`${sider[0]} definerer samtale-regler`, fasit.length > 5, true);
    for (const fil of sider.slice(1)) {
        sjekk(`${fil}: samme regler som ${sider[0]}`,
            velgere(fs.readFileSync(path.join(mappe, fil), 'utf8')), fasit);
    }
}

for (const fil of sider) {
    const kilde = fs.readFileSync(path.join(mappe, fil), 'utf8');
    // Rullefeltet må ha et tak. Uten max-height vokser samtalen nedover i det
    // uendelige og skyver resten av siden ut av syne.
    sjekk(`${fil}: samtale-liste har maks høyde`,
        /\.samtale-liste\s*\{[^}]*max-height/.test(kilde), true);
    // Et innlegg er fritekst og kan inneholde en URL uten mellomrom.
    sjekk(`${fil}: innlegg bryter lange ord`,
        /\.samtale-innlegg\s*\{[^}]*overflow-wrap/.test(kilde), true);
    // pre-wrap: linjeskift brukeren har skrevet skal bevares. Uten den blir
    // et avsnitt til én lang linje.
    sjekk(`${fil}: teksten beholder linjeskift`,
        /\.samtale-tekst\s*\{[^}]*white-space:\s*pre-wrap/.test(kilde), true);
}

console.log(`\n${ok} OK, ${feil} feil  (${sider.length} sider)`);
process.exit(feil ? 1 : 0);
