/**
 * Hvert designpanel i editoren skal ha en kort forklaring (TODO 7).
 *
 * Panelene er overskrifter uten kontekst for den som setter opp en skjematype
 * for første gang. Fire av sju hadde en `<small>`-forklaring fra før;
 * Grunnleggende, Tilgang og «Seksjoner og felter» hadde ingen.
 *
 * Forklaringen ligger inne i `<h2>`, ikke som en linje under. Det er ikke
 * tilfeldig: `.panel.kollapset > *:not(h2)` skjuler alt annet enn overskriften
 * når panelet slås sammen, og en forklaring som forsvinner idet man kollapser
 * er borte nettopp når man skanner etter riktig panel.
 *
 * Testen finnes fordi et nytt panel legges til ved å kopiere et eksisterende,
 * og en tom forklaring er lett å la stå.
 *
 * Kjøres med:  node frontend/test/editor-panelforklaringer.test.js
 */
const fs = require('fs');
const path = require('path');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const kilde = fs.readFileSync(path.join(__dirname, '..', 'editor.html'), 'utf8');

// Alle panel-overskrifter: <h2 onclick="togglePanel('id')">…</h2>
const paneler = [...kilde.matchAll(/<h2 onclick="togglePanel\('([^']+)'\)">([\s\S]*?)<\/h2>/g)]
    .map(m => ({ id: m[1], innhold: m[2] }));

sjekk('fant panelene', paneler.length > 0, true);

for (const panel of paneler) {
    const small = /<small[^>]*>([\s\S]*?)<\/small>/.exec(panel.innhold);
    sjekk(`${panel.id}: har forklaring`, !!small, true);
    if (!small) continue;

    // Fjern eventuell markup inni (Gevinst har en lenke) før vi måler teksten.
    const tekst = small[1].replace(/<[^>]+>/g, '').replace(/^\s*—\s*/, '').trim();
    sjekk(`${panel.id}: forklaringen har innhold`, tekst.length > 0, true);

    // Kort, ikke en bruksanvisning. Går den over dette, hører den hjemme i
    // panelet selv — og i mobilbredde spiser den hele overskriftslinja.
    sjekk(`${panel.id}: forklaringen er kort`, tekst.length <= 110, true);
}

console.log(`\n${ok} OK, ${feil} feil  (${paneler.length} paneler)`);
process.exit(feil ? 1 : 0);
