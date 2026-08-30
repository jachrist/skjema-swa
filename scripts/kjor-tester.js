#!/usr/bin/env node
/**
 * Kjører alle testene i repoet.
 *
 * Testene er vanlige node-skript uten testrammeverk: de skriver «N OK, M feil»
 * og avslutter med kode 1 hvis noe feiler. Denne runneren finner dem, kjører
 * dem hver for seg og oppsummerer.
 *
 * Ingen av testene skal trenge `node_modules`. Azure-SDK-ene lastes lat i
 * storage.js og blob.js nettopp for at det skal holde — da kan både CI og
 * deploy kjøre testene uten å installere avhengigheter først.
 *
 * Bruk:
 *   node scripts/kjor-tester.js
 *   npm test            (fra api/ — samme sti)
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROT = path.join(__dirname, '..');
const MAPPER = ['api/test', 'frontend/test'];

function finnTester() {
    const filer = [];
    for (const mappe of MAPPER) {
        const full = path.join(ROT, mappe);
        if (!fs.existsSync(full)) continue;
        for (const navn of fs.readdirSync(full).sort()) {
            if (navn.endsWith('.test.js')) filer.push(path.join(full, navn));
        }
    }
    return filer;
}

const tester = finnTester();
if (tester.length === 0) {
    // Ingen tester er ikke det samme som grønne tester. Si fra tydelig, men
    // ikke velt bygget på det.
    console.log('Fant ingen *.test.js-filer i ' + MAPPER.join(', '));
    process.exit(0);
}

let feilet = 0;
for (const fil of tester) {
    const kort = path.relative(ROT, fil).split(path.sep).join('/');
    console.log(`\n─── ${kort} ${'─'.repeat(Math.max(0, 60 - kort.length))}`);
    const res = spawnSync(process.execPath, [fil], { stdio: 'inherit', cwd: ROT });
    if (res.status !== 0) {
        feilet++;
        console.log(`✗ ${kort} feilet (exit ${res.status})`);
    }
}

console.log(`\n${tester.length - feilet} av ${tester.length} testfiler OK`);
if (feilet > 0) {
    console.log(`${feilet} testfil(er) feilet.`);
    process.exit(1);
}
