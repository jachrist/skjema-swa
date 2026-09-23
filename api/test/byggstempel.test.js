/**
 * Byggstempel — hvilken commit kjører egentlig?
 *
 * Bakgrunnen er en time brukt 23.09.2026 på å avgjøre om en rettelse var ute i
 * pilot. Deploy-jobben var grønn, koden på main var riktig, og API-svaret så
 * gammelt ut. Ingenting i systemet kunne skille «ikke deployet» fra
 * «deployet, men feil» — og uten det spørsmålet besvart er all videre
 * feilsøking gjetting.
 *
 * Fire ting testes:
 *
 *   **Stempelet skrives begge steder.** Frontend og API deployes sammen, men
 *   den ene kan bli hengende. Ett stempel ville ikke avslørt det.
 *
 *   **Det kommer fra GITHUB_SHA.** Et stempel som ikke følger commiten er
 *   verre enn ingen — det svarer selvsikkert og feil.
 *
 *   **Utenfor Actions står det 'lokal'.** Ser du «lokal» i et miljø, kjører
 *   ikke build-config der. Nøyaktig den feilen har rammet dette repoet før:
 *   Oryx hoppet over byggetrinnet i stillhet, og config.js lå som sist
 *   innsjekket i alle miljøer.
 *
 *   **Ping tåler at fila mangler.** Den er generert og ikke sjekket inn.
 *   Kaster helsesjekken fordi et diagnosefelt mangler, har diagnosen gjort
 *   skade i stedet for nytte.
 *
 * Kjøres med:  node api/test/byggstempel.test.js
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { utenKommentarer } = require('../../scripts/test-kilde.js');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const rot = path.join(__dirname, '..', '..');
const versjonFil = path.join(rot, 'api', 'src', 'versjon.json');
const configFil = path.join(rot, 'frontend', 'js', 'config.js');

// ---------- stempelet følger commiten ----------
{
    // Kjør skriptet med en kjent SHA og se at den kommer ut i begge endene.
    execFileSync('node', [path.join(rot, 'scripts', 'build-config.js'), 'pilot'], {
        cwd: rot,
        env: { ...process.env, GITHUB_SHA: 'abcdef1234567890', GITHUB_RUN_NUMBER: '321' },
        stdio: 'pipe'
    });

    const versjon = JSON.parse(fs.readFileSync(versjonFil, 'utf8'));
    sjekk('API-stempelet har commiten', versjon.commit, 'abcdef1');
    sjekk('og kjøringsnummeret', versjon.kjoring, '321');
    sjekk('og miljøet', versjon.miljø, 'pilot');
    sjekk('og et tidspunkt', /^\d{4}-\d{2}-\d{2}T/.test(versjon.tid || ''), true);

    const config = fs.readFileSync(configFil, 'utf8');
    sjekk('frontend-stempelet eksporteres', /export const BUILD = \{/.test(config), true);
    sjekk('med samme commit', /"commit": "abcdef1"/.test(config), true);
    // CONFIG skal fortsatt være der — stempelet kommer i tillegg, ikke i stedet.
    sjekk('CONFIG er urørt', /export const CONFIG = \{/.test(config), true);
}

// ---------- uten Actions står det 'lokal' ----------
{
    const env = { ...process.env };
    delete env.GITHUB_SHA;
    delete env.GITHUB_RUN_NUMBER;
    execFileSync('node', [path.join(rot, 'scripts', 'build-config.js'), 'pilot'],
        { cwd: rot, env, stdio: 'pipe' });
    const versjon = JSON.parse(fs.readFileSync(versjonFil, 'utf8'));
    sjekk('lokalt bygg merkes som lokalt', versjon.commit, 'lokal');
}

// ---------- ping svarer med stempelet ----------
{
    const ping = utenKommentarer(fs.readFileSync(path.join(rot, 'api', 'src', 'functions', 'ping.js'), 'utf8'));
    sjekk('ping leser versjon.json', /require\('\.\.\/versjon\.json'\)/.test(ping), true);
    sjekk('og svarer med den', /\bbygg\b/.test(ping), true);
    // Fila er generert og ikke sjekket inn. Kaster helsesjekken uten den, har
    // diagnosen gjort skade.
    sjekk('manglende fil tas i mot', /catch \(_\)/.test(ping), true);
    sjekk('og gir «ukjent»', /commit: 'ukjent'/.test(ping), true);
}

// ---------- den genererte fila er ikke sjekket inn ----------
{
    const ignore = fs.readFileSync(path.join(rot, '.gitignore'), 'utf8');
    sjekk('versjon.json er ignorert', /^api\/src\/versjon\.json$/m.test(ignore), true);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
