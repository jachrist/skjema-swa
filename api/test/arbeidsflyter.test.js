/**
 * Noen få ting arbeidsflytene må holde.
 *
 * Testen er her fordi `.github/workflows/` er det ene stedet i repoet der en
 * feil ikke gir seg til kjenne før den har fått en konsekvens i et ekte miljø.
 *
 * Fire regler:
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
 *   **deploy-prod verifiserer at deployen landet** — i preview like mye som
 *   i produksjon. 12.10.2026 meldte kjøring
 *   #45 suksess, og prod serverte fortsatt #44 sin build fra 7. oktober. Det
 *   ble oppdaget 19.10, etter en formiddag med feilsøking i kode som ikke var
 *   deployet. `CLAUDE.md` har regelen — «ikke anta at deployet kode er
 *   gjeldende» — og steget håndhever den i stedet for å be noen huske den.
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

    // Hvilken action som gjør utrullingen varierer: SWA-appen deployes med
    // static-web-apps-deploy, et API på en egen Function App med
    // functions-action. Regelen er den samme, og den skal uttrykkes mot det
    // steget som faktisk ruller ut — ikke mot ett bestemt actionnavn.
    //
    // Sto navnet hardkodet, ville en ny arbeidsflyt med en annen action fått
    // indexOf === -1, og sammenligningen svart «testene kjøres ikke først» om
    // en fil der de gjør nøyaktig det.
    const UTRULLING = ['static-web-apps-deploy', 'functions-action', 'azure/webapps-deploy'];
    const utrulling = UTRULLING.map(a => kilde.toLowerCase().indexOf(a)).filter(i => i !== -1);
    sjekk(`${fil}: har et utrullingssteg`, utrulling.length > 0, true);
    sjekk(`${fil}: testene kjøres før deployen`,
        utrulling.every(i => kilde.indexOf('kjor-tester.js') < i), true);
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

// ---------- 4. prod-deployen verifiserer seg selv ----------
//
// En grønn workflow beviser at FILENE ble lastet opp, ikke at de serveres.
// Steget leser /api/ping og sammenligner commit-SHA-en med den som ble
// deployet.
{
    const prod = fs.readFileSync(path.join(mappe, 'deploy-prod.yml'), 'utf8');

    sjekk('deploy-prod leser /api/ping etter deploy', /\/api\/ping/.test(prod), true);
    sjekk('og sammenligner med commit-SHA-en som ble deployet',
        /github\.sha/.test(prod), true);

    // Et steg som bare SKRIVER avviket er ingenting. Det må felle kjøringen,
    // ellers er vi tilbake til «grønn deploy, gammel kode».
    const steget = prod.slice(prod.indexOf('Verifiser at deployen faktisk landet'));
    sjekk('verifiseringssteget finnes', steget.length > 0, true);
    sjekk('og avviksgrenen feller kjøringen',
        /Deployen ble rapportert vellykket[\s\S]{0,600}exit 1/.test(steget), true);
    sjekk('og sier fra med ::error::', /::error::/.test(steget), true);

    // Mangler adressen, kan ingenting verifiseres — og da skal steget si fra,
    // ikke hoppe stille over. En sjekk som kan slå seg selv av er ingen sjekk.
    sjekk('manglende SWA_URL feller steget i stedet for å hoppe over',
        /SWA_URL er ikke satt[\s\S]{0,400}exit 1/.test(steget), true);

    // Preview skal verifiseres også. En preview-deploy som ikke landet er
    // like villedende som en prod-deploy som ikke landet — og preview er
    // nettopp der man tester før man tør røre produksjon.
    sjekk('steget gjelder preview også — ingen if-betingelse',
        /- name: Verifiser at deployen faktisk landet\n\s+env:/.test(prod), true);
    sjekk('og henter preview-adressen fra deploy-steget',
        /steps\.builddeploy\.outputs\.static_web_app_url/.test(prod), true);

    // Azure gir ikke alltid preview-URL-en tilbake. Da kan ingenting
    // verifiseres — og det skal SIES, ikke hoppes stille over. En advarsel
    // som bare står i loggen er lett å overse, så den skal i sammendraget
    // også, med hva man gjør i stedet.
    const utenUrl = steget.slice(steget.indexOf('returnerte ingen URL'));
    sjekk('manglende preview-URL gir en ::warning::',
        /::warning::[\s\S]{0,600}returnerte ingen URL/.test(steget), true);
    sjekk('og sier hva man skal gjøre i stedet', /api\/ping/.test(utenUrl), true);
    sjekk('og havner i kjøringssammendraget',
        /GITHUB_STEP_SUMMARY/.test(utenUrl), true);

    // Men bare for preview. Mangler produksjonens adresse, skal det felle.
    sjekk('den milde grenen gjelder bare preview',
        /\[ -z "\$MAAL" \] && \[ -n "\$PREVIEW" \]/.test(steget), true);
}

console.log(`\n${ok} OK, ${feil} feil  (${deployer.length} deploy-arbeidsflyter)`);
process.exit(feil ? 1 : 0);
