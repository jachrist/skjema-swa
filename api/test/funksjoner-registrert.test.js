/**
 * Hver funksjonsmodul må være registrert i src/index.js.
 *
 * Azure Functions v4 oppdager ingenting selv: en modul blir en rute først når
 * `app.http()` faktisk kjører, og det skjer bare hvis noen `require`-er den.
 * `src/index.js` er den lista, og den vedlikeholdes for hånd.
 *
 * 18.09.2026 ble `functions/samtale.js` skrevet, testet og merget uten å bli
 * lagt til der. Alt så riktig ut — filen fantes, testene var grønne, koden var
 * i produksjon — og hvert eneste kall mot samtale-endepunktene svarte 404.
 *
 * Det er en feil ingen test kunne fange, fordi ingen test spurte om ruten var
 * registrert. Nå gjør denne det.
 *
 * Kjøres med:  node api/test/funksjoner-registrert.test.js
 */
const fs = require('fs');
const path = require('path');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const src = path.join(__dirname, '..', 'src');
const index = fs.readFileSync(path.join(src, 'index.js'), 'utf8');

// Bare aktive require-er teller. Fila har en «Etter hvert:»-blokk med
// utkommenterte linjer, og en modul som står DER er ikke registrert.
const registrerte = new Set(
    index.split('\n')
        .filter(l => !l.trim().startsWith('//'))
        .map(l => /require\('\.\/functions\/([^']+)'\)/.exec(l)?.[1])
        .filter(Boolean)
);

const filer = fs.readdirSync(path.join(src, 'functions'))
    .filter(f => f.endsWith('.js'))
    .map(f => f.replace(/\.js$/, ''))
    .sort();

sjekk('fant funksjonsmoduler', filer.length > 10, true);

for (const modul of filer) {
    // Bare moduler som faktisk registrerer en rute. En hjelpefil som havner i
    // mappa uten app.http skal ikke kreve en linje i index.js.
    const kilde = fs.readFileSync(path.join(src, 'functions', `${modul}.js`), 'utf8');
    if (!/app\.http\(/.test(kilde)) continue;
    sjekk(`${modul}: registrert i index.js`, registrerte.has(modul), true);
}

// Og motsatt vei: en require som peker på en fil som ikke finnes, velter hele
// API-et ved oppstart — alle ruter, ikke bare én.
for (const modul of registrerte) {
    sjekk(`${modul}: fila finnes`, fs.existsSync(path.join(src, 'functions', `${modul}.js`)), true);
}

console.log(`\n${ok} OK, ${feil} feil  (${filer.length} moduler, ${registrerte.size} registrert)`);
process.exit(feil ? 1 : 0);
