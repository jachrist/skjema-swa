/**
 * PowerShell-skriptene i scripts/ skal være UTF-8 MED BOM.
 *
 * Windows PowerShell 5.1 leser en .ps1-fil uten BOM som ANSI (CP1252), ikke
 * som UTF-8. En tankestrek «—» er tre byte i UTF-8, og den siste av dem
 * (0x94) blir da tegnet «”» — som PowerShell godtar som strengavslutter.
 * Resten av linja tolkes som kode, og feilen kommer ut som «Unexpected token»
 * et helt annet sted enn der problemet er.
 *
 * Det skjedde 15.09.2026 med opprett-testbrukere.ps1. opprett-backup-app.ps1
 * hadde samme feil liggende — 24 tankestreker og ingen BOM — uten at noen
 * hadde kjørt den på 5.1 ennå.
 *
 * To alternativer fantes: droppe alle tegn over ASCII, eller sette BOM.
 * Norsk i skriptene er et krav her, så BOM er svaret. Testen finnes fordi en
 * editor eller et verktøy som lagrer om fila stille kan fjerne den igjen.
 *
 * Kjøres med:  node api/test/ps1-bom.test.js
 */
const fs = require('fs');
const path = require('path');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const mappe = path.join(__dirname, '..', '..', 'scripts');
const skript = fs.readdirSync(mappe).filter(f => f.toLowerCase().endsWith('.ps1')).sort();

// Finner testen ingen skript, tester den ingenting — og ville sagt «alt OK».
sjekk('det finnes .ps1-skript å teste', skript.length > 0, true);

for (const navn of skript) {
    const bytes = fs.readFileSync(path.join(mappe, navn));
    const harBom = bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;
    sjekk(`${navn} har UTF-8 BOM`, harBom, true);

    // Selve grunnen til at BOM-en trengs: tegn som CP1252 gjør om til
    // hermetegn. Er de borte, er skriptet trygt uansett — men da skal BOM-en
    // likevel stå, for æ, ø og å blir uleselige uten den.
    const tekst = bytes.slice(harBom ? 3 : 0).toString('utf8');
    const farlige = [...tekst].filter(c => '–—‘’“”'.includes(c));
    if (farlige.length > 0 && !harBom) {
        feil++;
        console.log(`FEIL  ${navn} har ${farlige.length} typografiske tegn og ingen BOM — parsefeil i PowerShell 5.1`);
    }
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
