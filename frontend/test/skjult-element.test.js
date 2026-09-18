/**
 * `hidden` må faktisk skjule.
 *
 * `hidden` er ikke en CSS-regel siden har skrevet — den kommer fra
 * nettleserens egen stilark som `[hidden] { display: none }`. Enhver
 * author-regel med `display` slår den, uansett spesifisitet, fordi
 * author-laget vinner over UA-laget.
 *
 * Det var akkurat det som skjedde på kvitteringen 18.09.2026:
 *
 *     <div class="knapperad" id="samtale-rad" hidden>
 *     .knapperad { display: flex; }
 *
 * Knappen sto framme uansett hva JS-en bestemte, og pekte på en funksjon
 * brukeren ikke hadde tilgang til. Attributtet så riktig ut i markupen, og
 * koden som satte `hidden = false` så riktig ut — det var kombinasjonen som
 * ikke virket.
 *
 * Regelen her er enkel og lett å holde: en side som bruker `hidden` må også
 * slå fast at `hidden` vinner.
 *
 * Kjøres med:  node frontend/test/skjult-element.test.js
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

let medHidden = 0;

for (const fil of sider) {
    const kilde = fs.readFileSync(path.join(mappe, fil), 'utf8');

    // Tre veier til det samme elementet:
    //   hidden i markupen
    //   hidden satt fra sidens eget skript
    //   hidden satt fra en modul siden importerer
    //
    // Den tredje er den som traff oss: widgeten i js/samtale.js setter
    // `container.hidden`, og containeren får klassen sin fra siden. Ser
    // testen bare på HTML-fila, går akkurat det tilfellet fri.
    const iMarkup = /<[a-z][^>]*\shidden(?=[\s>])/i.test(kilde);
    const fraJs = /\.hidden\s*=/.test(kilde);
    const fraModul = [...kilde.matchAll(/from '\.\/(js\/[^']+)'/g)]
        .map(m => path.join(mappe, m[1]))
        .filter(f => fs.existsSync(f))
        .some(f => /\.hidden\s*=/.test(fs.readFileSync(f, 'utf8')));
    if (!iMarkup && !fraJs && !fraModul) continue;

    medHidden++;
    sjekk(`${fil}: [hidden] slår display-regler`,
        /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(kilde), true);
}

// Finner testen ingen sider, tester den ingenting — og ville meldt «alt OK».
sjekk('fant sider som bruker hidden', medHidden > 0, true);

console.log(`\n${ok} OK, ${feil} feil  (${medHidden} av ${sider.length} sider bruker hidden)`);
process.exit(feil ? 1 : 0);
