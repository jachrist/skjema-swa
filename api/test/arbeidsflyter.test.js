/**
 * Noen få ting arbeidsflytene må holde.
 *
 * Testen er her fordi `.github/workflows/` er det ene stedet i repoet der en
 * feil ikke gir seg til kjenne før den har fått en konsekvens i et ekte miljø.
 *
 * Tre regler:
 *
 *   **Hver deploy kjører testene først.** `CLAUDE.md` sier det, og uten steget
 *   ruller en rød suite rett ut. Det er den eneste porten mellom en dårlig
 *   commit og et miljø med brukere i.
 *
 *   **deploy-pilot har ingen pull_request-trigger.** SWA-actionen lager et
 *   preview-miljø per PR, og ingen åpner dem — arbeidsflyten er å merge og
 *   teste på pilot. Regelen står her fordi Azures egen genererte workflow HAR
 *   den triggeren: regenererer noen fila, kommer den tilbake av seg selv.
 *
 *   **deploy-prod kjøres bare manuelt.** Den skal aldri kunne utløses av en
 *   push. Får den en automatisk trigger, er produksjon ett uhell unna.
 *
 * Kjøres med:  node api/test/arbeidsflyter.test.js
 */
const fs = require('fs');
const path = require('path');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const mappe = path.join(__dirname, '..', '..', '.github', 'workflows');
const les = (f) => fs.readFileSync(path.join(mappe, f), 'utf8');

/**
 * Hent `on:`-blokken uten en YAML-parser.
 *
 * Testene skal kunne kjøre uten `node_modules`, så js-yaml er ikke
 * tilgjengelig. Blokken er alt fra linja `on:` til neste linje uten innrykk.
 */
function triggere(kilde) {
    const linjer = kilde.split('\n');
    const start = linjer.findIndex(l => /^on:\s*$/.test(l));
    if (start === -1) return [];
    const ut = [];
    for (let i = start + 1; i < linjer.length; i++) {
        const l = linjer[i];
        if (/^\S/.test(l)) break;                       // ny toppnivå-nøkkel
        if (/^\s*#/.test(l) || !l.trim()) continue;     // kommentar eller tom
        const m = /^  ([a-z_]+):/.exec(l);              // nøyaktig to mellomrom
        if (m) ut.push(m[1]);
    }
    return ut;
}

const deployer = fs.readdirSync(mappe).filter(f => f.startsWith('deploy-'));
sjekk('fant deploy-arbeidsflyter', deployer.length >= 2, true);

for (const fil of deployer) {
    const kilde = les(fil);
    // Testene før utrullingen, ikke etter — rekkefølgen er hele poenget.
    sjekk(`${fil}: kjører testene`, /run: node scripts\/kjor-tester\.js/.test(kilde), true);
    sjekk(`${fil}: testene kjøres før deployen`,
        kilde.indexOf('kjor-tester.js') < kilde.indexOf('static-web-apps-deploy'), true);
}

// ---------- pilot ----------
{
    const t = triggere(les('deploy-pilot.yml'));
    sjekk('pilot: triggere', t.sort(), ['push', 'workflow_dispatch']);
    sjekk('pilot: ingen preview per PR', t.includes('pull_request'), false);
    // Close-jobben har ingen hendelse å kjøre på uten triggeren, og en jobb
    // som aldri kan kjøre ser ut som en sikkerhetsmekanisme som finnes.
    sjekk('pilot: ingen død close-jobb',
        /close_pull_request_job:/.test(les('deploy-pilot.yml')), false);
}

// ---------- prod ----------
{
    const t = triggere(les('deploy-prod.yml'));
    sjekk('prod: bare manuell', t, ['workflow_dispatch']);
    const kilde = les('deploy-prod.yml');
    // Bekreftelsen er det som skiller «kjør denne» fra «kjør denne mot
    // produksjon».
    sjekk('prod: krever bekreftelse', /DEPLOY-PROD/.test(kilde), true);
    // Det navngitte preview-miljøet er en bevisst mulighet, ikke en rest.
    sjekk('prod: preview-valget finnes', /preview:/.test(kilde), true);
}

// ---------- ci ----------
{
    const t = triggere(les('ci.yml'));
    sjekk('ci: både PR og main', t.sort(), ['pull_request', 'push']);
}

console.log(`\n${ok} OK, ${feil} feil  (${deployer.length} deploy-arbeidsflyter)`);
process.exit(feil ? 1 : 0);
