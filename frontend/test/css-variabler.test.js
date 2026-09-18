/**
 * Hver CSS-variabel en side bruker, må være definert på siden.
 *
 * `var(--finnes-ikke)` er ikke en feil nettleseren melder fra om. Den gjør
 * deklarasjonen ugyldig, og egenskapen faller tilbake til arvet eller
 * opprinnelig verdi. En ramme forsvinner, en bakgrunn blir gjennomsiktig — og
 * siden ser bare litt annerledes ut enn tenkt.
 *
 * 18.09.2026 ble samtale-widgeten stylet med `--bg-kort`, `--bg-sekundaer`,
 * `--bg-input` og `--border`. Ingen av dem finnes i dette prosjektet; de heter
 * `--bg-container`, `--bg-section`, `--bg-svar` og `--border-color`.
 * Skrivefeltet sto derfor uten ramme og uten bakgrunn, og det ble meldt som at
 * «editoren mangler avgrensning» — ikke som fire skrivefeil.
 *
 * Det er nettopp slik denne feilen oppfører seg: den ser ut som et
 * designvalg.
 *
 * `var(--x, fallback)` godtas — der er en manglende variabel håndtert.
 *
 * `CLAUDE.md` sier at sidene har inline CSS med vilje, så hver side må ha sine
 * egne definisjoner. Testen leser derfor hver fil for seg.
 *
 * Kjøres med:  node frontend/test/css-variabler.test.js
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

sjekk('det finnes sider å teste', sider.length > 0, true);

let brukteTotalt = 0;

for (const fil of sider) {
    const kilde = fs.readFileSync(path.join(mappe, fil), 'utf8');

    // Definisjoner: `--navn:` i en deklarasjonsblokk.
    const definert = new Set(
        [...kilde.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map(m => m[1])
    );

    // Bruk UTEN fallback. `var(--x, noe)` er håndtert og teller ikke.
    const brukt = [...kilde.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*\)/g)]
        .map(m => m[1])
        .filter((v, i, a) => a.indexOf(v) === i);

    brukteTotalt += brukt.length;

    const udefinerte = brukt.filter(v => !definert.has(v)).sort();
    sjekk(`${fil}: ingen udefinerte variabler`, udefinerte, []);
}

// Finner testen ingen variabelbruk, tester den ingenting.
sjekk('fant variabelbruk', brukteTotalt > 0, true);

console.log(`\n${ok} OK, ${feil} feil  (${sider.length} sider)`);
process.exit(feil ? 1 : 0);
