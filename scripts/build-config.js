/**
 * Genererer frontend/js/config.js fra config/env.<miljø>.json.
 * Bare oppføringer merket med "public": true tas med — resten er
 * server-side og eksponeres aldri til nettleseren.
 *
 * Bruk:  node scripts/build-config.js development
 *        node scripts/build-config.js production
 */
const fs = require('fs');
const path = require('path');

const miljo = process.argv[2];
if (!['development', 'production', 'lokal'].includes(miljo)) {
    console.error('Bruk: node scripts/build-config.js <development|production|lokal>');
    process.exit(1);
}

const envFil = path.join(__dirname, '..', 'config', `env.${miljo}.json`);
if (!fs.existsSync(envFil)) {
    console.error(`Fant ikke ${envFil}`);
    process.exit(1);
}
const konfig = JSON.parse(fs.readFileSync(envFil, 'utf8'));

const publicVerdier = {};
for (const [nokkel, verdi] of Object.entries(konfig)) {
    if (verdi && typeof verdi === 'object' && verdi.public === true) {
        publicVerdier[nokkel] = verdi.value;
    }
}

const ut = `// GENERERT av scripts/build-config.js — ikke rediger manuelt.\n`
    + `export const CONFIG = ${JSON.stringify(publicVerdier, null, 4)};\n`;

const utFil = path.join(__dirname, '..', 'frontend', 'js', 'config.js');
fs.writeFileSync(utFil, ut);
console.log(`Skrev ${utFil} for miljø=${miljo}`);
console.log(`Publiserte ${Object.keys(publicVerdier).length} public-verdier: ${Object.keys(publicVerdier).join(', ')}`);
