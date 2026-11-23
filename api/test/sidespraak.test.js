/**
 * Språket på sidene: `<html lang="nb">`, ikke `lang="no"`.
 *
 * Meldt 23.11.2026: stavekontrollen rettet etter engelsk ordliste. Nettleseren
 * velger ordliste ut fra `lang`, og ordlistene heter `nb` (bokmål) og `nn`
 * (nynorsk) — ikke `no`. Firefox fant ingen ordliste for `no` og falt
 * tilbake til standarden, som ofte er engelsk, også der bokmål var
 * installert. `nb` er også det skjermlesere forstår best.
 *
 * Testen krever `nb` på HVER side i frontend/, så en ny side ikke kommer med
 * den gamle koden.
 *
 * Kjøres med:  node api/test/sidespraak.test.js
 */
const fs = require('fs');
const path = require('path');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const mappe = path.join(__dirname, '..', '..', 'frontend');
const sider = fs.readdirSync(mappe).filter(f => f.endsWith('.html'));
sjekk('fant sidene', sider.length > 10, true);

const feilSprak = sider.filter(f => {
    const m = /<html\b[^>]*>/i.exec(fs.readFileSync(path.join(mappe, f), 'utf8'));
    return !m || !/\blang="nb"/.test(m[0]);
});
sjekk('alle sider har <html lang="nb">', feilSprak, []);

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
