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
if (!['development', 'production', 'pilot', 'prod', 'lokal'].includes(miljo)) {
    console.error('Bruk: node scripts/build-config.js <pilot|prod|development|lokal>');
    console.error('(production er alias for pilot — beholdt for bakoverkompatibilitet)');
    process.exit(1);
}

// Bakoverkompatibilitet: production → pilot hvis env.pilot.json finnes
let effektivtMiljo = miljo;
if (miljo === 'production' && fs.existsSync(path.join(__dirname, '..', 'config', 'env.pilot.json'))) {
    effektivtMiljo = 'pilot';
    console.log('(alias production → pilot)');
}

const envFil = path.join(__dirname, '..', 'config', `env.${effektivtMiljo}.json`);
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

/**
 * Byggstempelet — hvilken commit som faktisk kjører.
 *
 * Lagt til 23.09.2026, etter en time brukt på å finne ut om en rettelse var
 * ute i miljøet eller ikke. Det spørsmålet lot seg ikke besvare: API-svaret
 * så feil ut, koden så riktig ut, og deploy-jobben var grønn. Uten et stempel
 * er «er dette deployet?» et gjettespørsmål — og et dyrt et.
 *
 * GITHUB_SHA settes av Actions. Lokalt blir det 'lokal', som er det ærlige
 * svaret: da er det arbeidstreet ditt som kjører, ikke en commit.
 */
const bygg = {
    commit: (process.env.GITHUB_SHA || '').slice(0, 7) || 'lokal',
    kjoring: process.env.GITHUB_RUN_NUMBER || '',
    tid: new Date().toISOString(),
    miljø: effektivtMiljo
};

const ut = `// GENERERT av scripts/build-config.js — ikke rediger manuelt.\n`
    + `export const CONFIG = ${JSON.stringify(publicVerdier, null, 4)};\n`
    + `export const BUILD = ${JSON.stringify(bygg, null, 4)};\n`;

// Samme stempel til API-et. Det er to separate spørsmål — frontend og API
// deployes sammen, men en av dem kan bli hengende, og da vil man vite hvilken.
const versjonFil = path.join(__dirname, '..', 'api', 'src', 'versjon.json');
fs.writeFileSync(versjonFil, JSON.stringify(bygg, null, 4) + '\n');
console.log(`Skrev ${versjonFil} (commit=${bygg.commit})`);

const utFil = path.join(__dirname, '..', 'frontend', 'js', 'config.js');
fs.writeFileSync(utFil, ut);
console.log(`Skrev ${utFil} for miljø=${miljo}`);
console.log(`Publiserte ${Object.keys(publicVerdier).length} public-verdier: ${Object.keys(publicVerdier).join(', ')}`);

// Kopier riktig staticwebapp.config.<miljø>.json → staticwebapp.config.json
// Pilot og prod har ulik auth-konfig (ClientSecret vs sertifikat via KV).
const swaConfigKilde = path.join(__dirname, '..', `staticwebapp.config.${effektivtMiljo}.json`);
if (fs.existsSync(swaConfigKilde)) {
    // SWA leser staticwebapp.config.json fra app_location — som er frontend/,
    // ikke repo-roten. Kopien i roten er derfor bare til lesing og lokal
    // referanse; det er den i frontend/ plattformen faktisk bruker.
    //
    // Sto den bare i roten, ble hele fila ignorert i stillhet: ingen
    // ruteregler, ingen globale headere, og innloggingen falt tilbake til
    // SWA sin innebygde AAD-provider mot /common/. Alt så ut til å virke.
    const mal = [
        path.join(__dirname, '..', 'staticwebapp.config.json'),
        path.join(__dirname, '..', 'frontend', 'staticwebapp.config.json')
    ];
    for (const m of mal) fs.copyFileSync(swaConfigKilde, m);
    console.log(`Kopierte staticwebapp.config.${effektivtMiljo}.json → ${mal.map(m => path.relative(path.join(__dirname, '..'), m)).join(' og ')}`);
} else if (effektivtMiljo !== 'lokal' && effektivtMiljo !== 'development') {
    console.warn(`ADVARSEL: ${swaConfigKilde} finnes ikke — beholder eksisterende staticwebapp.config.json`);
}
