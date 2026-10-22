/**
 * Noen få ting arbeidsflytene må holde.
 *
 * Testen er her fordi `.github/workflows/` er det ene stedet i repoet der en
 * feil ikke gir seg til kjenne før den har fått en konsekvens i et ekte miljø.
 *
 * Fem regler:
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
 *   **API-deployen til Function App gjør det samme.** Den deployer dev, og
 *   manglet steget til 20.10.2026 — da en backup gikk stille feil vei fordi
 *   Function App-en kjørte eldre kode enn app-settingene forutsatte.
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

const rot = path.join(__dirname, '..', '..');
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

// ---------- 5. API-deployen til Function App verifiserer seg også ----------
//
// deploy-prod.yml fikk verifiseringen 19.10.2026. Denne workflowen deployer
// dev sitt API og hadde den ikke — og 20.10 kostet nettopp det en runde:
// sertifikatet var satt opp, GRAPH_CLIENT_SECRET fjernet, men Function
// App-en kjørte kode fra før sertifikatstøtten. erKonfigurert() ble usann,
// backupen gikk stille via PA-flyten, og feilsøkingen gikk mot flyten.
{
    const fa = fs.readFileSync(path.join(mappe, 'deploy-funcapp-pilot.yml'), 'utf8');

    sjekk('API-deployen leser /api/ping', /\/api\/ping/.test(fa), true);
    sjekk('og sammenligner med commit-SHA-en', /github\.sha/.test(fa), true);

    const steget = fa.slice(fa.indexOf('Verifiser at deployen faktisk landet'));
    sjekk('verifiseringssteget finnes', steget.length > 0, true);
    sjekk('og avviksgrenen feller kjøringen',
        /Deployen ble rapportert vellykket[\s\S]{0,600}exit 1/.test(steget), true);

    // Adressen er et EKSPLISITT input. `vars.SWA_URL` faller tilbake til
    // repo-nivå når miljøet ikke har sin egen, og da ville sjekken lest et
    // annet miljø og meldt et falskt avvik. En sjekk som kan ta feil slik er
    // verre enn ingen.
    sjekk('adressen kommer fra et eget input', /inputs\.verifiser_url/.test(fa), true);
    sjekk('og ikke fra vars.SWA_URL', /\$\{\{\s*vars\.SWA_URL/.test(fa), false);

    // Uten adresse kan ingenting verifiseres. Da skal det SIES, ikke hoppes
    // stille over — men det skal ikke felle en deploy som kanskje er fin.
    sjekk('manglende adresse gir en ::warning::',
        /::warning::[\s\S]{0,300}IKKE verifisert/.test(steget), true);
    sjekk('og havner i kjøringssammendraget',
        /IKKE verifisert[\s\S]{0,200}GITHUB_STEP_SUMMARY/.test(steget), true);
}

// ---------- 6. dev-frontenden kan peke på en annen SWA ----------
//
// Dev-tenanten kan ha mer enn én SWA: gjennomkjøringen av kokeboka oppretter
// en v3-SWA ved siden av den eksisterende, og den har sin egen deployment
// token. Alternativet var å bytte verdien på den faste hemmeligheten fram og
// tilbake — og den som glemmer å bytte tilbake, deployer neste rettelse til
// prøveoppsettet.
//
// Det viktigste her er at STANDARDEN er uendret: en kjøring uten valg skal
// treffe samme SWA som før.
{
    const dev = fs.readFileSync(path.join(mappe, 'deploy-dev.yml'), 'utf8');

    sjekk('det finnes et valg for hemmeligheten', /swa_token_secret:/.test(dev), true);
    sjekk('og standarden er den som har vært brukt hele tiden',
        /default: 'AZURE_STATIC_WEB_APPS_API_TOKEN_DEV'/.test(dev), true);
    sjekk('valget er ikke paakrevd', /swa_token_secret:[\s\S]{0,200}required: false/.test(dev), true);

    // Oppslaget maa ha samme fallback i uttrykket ogsaa. Kjoeres workflowen
    // fra et API-kall uten inputs, er `inputs.swa_token_secret` tom, og da
    // ville `secrets['']` gitt en tom token — altsaa den feilen vakten under
    // skal fange, i en kjoering som ikke ba om noe uvanlig.
    sjekk('uttrykket har samme standard',
        /secrets\[inputs\.swa_token_secret \|\| 'AZURE_STATIC_WEB_APPS_API_TOKEN_DEV'\]/.test(dev), true);

    // En hemmelighet som ikke finnes blir en TOM STRENG, ikke en feil.
    // SWA-actionen svarer «deployment token is invalid», som ser ut som en
    // utloept token og sender feilsoekingen mot Azure-portalen.
    sjekk('tomt token stopper kjoeringen med en egen melding',
        /if \[ -z "\$SWA_TOKEN" \][\s\S]{0,400}exit 1/.test(dev), true);
    sjekk('og meldingen navngir hemmeligheten som mangler',
        /::error::Hemmeligheten/.test(dev), true);

    // Vakten maa staa FOER deployen. Etterpaa er den uten verdi.
    //
    // `indexOf` gir -1 for noe som ikke finnes, og -1 er mindre enn hva som
    // helst — en sjekk som BESTAAR naar vakten er borte, er ingen sjekk.
    // Derfor kreves det foerst at den finnes.
    const iVakt = dev.indexOf('Sjekk at tokenet finnes');
    sjekk('vakten finnes', iVakt > -1, true);
    sjekk('og kommer foer opplastingen',
        iVakt > -1 && iVakt < dev.indexOf('static-web-apps-deploy'), true);

    // Og ingen hardkodet token igjen — en glemt forekomst ville gjort valget
    // til pynt.
    sjekk('ingen hardkodet token igjen',
        /secrets\.AZURE_STATIC_WEB_APPS_API_TOKEN_DEV\s*\}\}/.test(dev), false);
}

// ---------- 7. ingen peker på en arbeidsflyt som ikke finnes ----------
//
// `steg1-funcapp.ps1` ba deg kjøre «Deploy innhold til prøve-SWA (steg 1)».
// Den fulgte steg 1-forsøket 14.10.2026 og ble revet med det, mens
// henvisningen ble stående. 21.10.2026 lette noen etter den i Actions-fanen
// midt i en prod-gjennomkjøring.
//
// En henvisning til noe som ikke finnes er dyrere enn en manglende
// henvisning: den som leter, antar at feilen er hos dem selv.
{
    const navn = new Set(
        fs.readdirSync(mappe).filter(f => f.endsWith('.yml'))
            .map(f => /^name:\s*(.+)$/m.exec(fs.readFileSync(path.join(mappe, f), 'utf8')))
            .filter(Boolean).map(m => m[1].trim()));
    sjekk('fant navnene på arbeidsflytene', navn.size > 5, true);

    // Navn som ER borte, og som nevnes med vilje som historikk. Lista er
    // kort og synlig — det er forskjellen på et dokumentert fravær og en
    // død henvisning.
    const HISTORISKE = new Set(['Deploy innhold til prøve-SWA (steg 1)']);

    const kilder = [
        ...fs.readdirSync(path.join(rot, 'scripts')).filter(f => f.endsWith('.ps1'))
            .map(f => ['scripts/' + f, fs.readFileSync(path.join(rot, 'scripts', f), 'utf8')]),
        ['docs/KOKEBOK-PROD-V3.md',
            fs.readFileSync(path.join(rot, 'docs', 'KOKEBOK-PROD-V3.md'), 'utf8')]
    ];

    // Bare navn som ser ut som en arbeidsflyt her: «Deploy …», «Refresh …»,
    // «Backup», «Synkroniser …». Ellers fanger regelen all sitert tekst.
    const SER_UT_SOM = /^(Deploy|Refresh|Backup|Send|Sjekk|Synkroniser|Oppdater|Purre|CI)\b/;
    const ukjente = [];
    for (const [fil, tekst] of kilder) {
        for (const m of tekst.matchAll(/«([^»]{3,60})»/g)) {
            const n = m[1].trim();
            if (!SER_UT_SOM.test(n)) continue;
            if (navn.has(n) || HISTORISKE.has(n)) continue;
            ukjente.push(`${fil}: ${n}`);
        }
    }
    sjekk('alle arbeidsflyter det henvises til finnes', ukjente, []);
}

// ---------- 8. frontend-deployene kan velge SWA-ressurs ----------
//
// Både dev og prod får en NY SWA ved siden av den gamle: dev under
// gjennomkjøringen av kokeboka, prod som v3. En hardkodet token-hemmelighet
// gir da to veier, og begge er gale — deploye den nye med den gamles token,
// eller bytte verdien på hemmeligheten og sende neste deploy av det GAMLE
// miljøet til det nye. I prod rammer det produksjon.
//
// Pilot står utenfor med vilje: der finnes ingen andre SWA, og et valg
// ingen bruker er en bryter som ikke er prøvd.
{
    for (const fil of ['deploy-dev.yml', 'deploy-prod.yml']) {
        const w = fs.readFileSync(path.join(mappe, fil), 'utf8');
        const standard = fil === 'deploy-dev.yml'
            ? 'AZURE_STATIC_WEB_APPS_API_TOKEN_DEV'
            : 'AZURE_STATIC_WEB_APPS_API_TOKEN_PROD';

        sjekk(`${fil}: har et valg for hemmeligheten`, /swa_token_secret:/.test(w), true);
        sjekk(`${fil}: standarden er den som har vært brukt`,
            w.includes(`default: '${standard}'`), true);
        sjekk(`${fil}: uttrykket har samme standard`,
            w.includes(`secrets[inputs.swa_token_secret || '${standard}']`), true);

        const iVakt = w.indexOf('Sjekk at tokenet finnes');
        sjekk(`${fil}: vakten finnes`, iVakt > -1, true);
        sjekk(`${fil}: og kommer før opplastingen`,
            iVakt > -1 && iVakt < w.indexOf('static-web-apps-deploy'), true);
        sjekk(`${fil}: ingen hardkodet token igjen`,
            new RegExp(`secrets\\.${standard}\\s*\\}\\}`).test(w), false);
    }
}

// ---------- api_location bestemmer ARKITEKTUR, og må være et valg ----------
//
// 22.10.2026: v3-SWA-en ble rullet ut med «Deploy prod», som har
// `api_location: "api"` fordi v2 kjører API-et PÅ SWA-en. v3 har
// arkitekturen fra dev — API-et i en lenket Function App — så kopien som
// havnet på SWA-en svarte på /api/* med SWA-ressursens app settings, uten
// lagringsoppsettet.
//
// Symptomet pekte feil vei: «Lagring er ikke konfigurert» leses som at
// Function App-en mangler verdier. Function App-en var ikke involvert.
//
// Og en SWA kan ikke ha både managed functions og en lenket backend, så
// kopien stenger kapittel 5.3.
{
    const dev = fs.readFileSync(path.join(mappe, 'deploy-dev.yml'), 'utf8');
    const prod = fs.readFileSync(path.join(mappe, 'deploy-prod.yml'), 'utf8');

    // Dev er frontend-alene, og begrunnelsen må stå der — ellers ser den tomme
    // verdien ut som en forglemmelse noen «retter».
    sjekk('deploy-dev ruller ikke ut API-et',
        /api_location:\s*""/.test(dev), true);
    sjekk('og sier at det ikke er en forglemmelse',
        /ikke en forglemmelse/.test(dev), true);

    // Prod må kunne gjøre begge deler, og valget må være et input.
    sjekk('deploy-prod har api_location som et valg',
        /api_location:\s*\$\{\{/.test(prod), true);
    sjekk('og det er et deklarert input',
        /deploy_api:\s*\n\s*description:/.test(prod), true);

    // Standarden skal være v2 sin, ellers endrer dette oppførselen for
    // miljøet som virker.
    const inp = /deploy_api:[\s\S]{0,300}?default:\s*(\S+)/.exec(prod);
    sjekk('fant standardverdien', !!inp, true);
    sjekk('og den er v2 sin oppførsel', inp && inp[1], 'true');

    // Uttrykket må gi 'api' når valget er på, og tom streng når det er av.
    sjekk('uttrykket velger mellom api og tom streng',
        /inputs\.deploy_api\s*&&\s*'api'\s*\|\|\s*''/.test(prod), true);

    // Og kokeboka må si hva v3 skal velge, der deployen kjøres.
    const kokebok = fs.readFileSync(
        path.join(rot, 'docs', 'KOKEBOK-PROD-V3.md'), 'utf8');
    const fra = kokebok.indexOf('### 5.2');
    const kap = kokebok.slice(fra, kokebok.indexOf('### 5.3', fra));
    sjekk('kokeboka 5.2 krever deploy_api = false for v3',
        /`deploy_api`[\s\S]{0,60}`false`/.test(kap), true);
    sjekk('og sier hvorfor det betyr noe',
        /Lagring er ikke konfigurert/.test(kap), true);
    sjekk('og at lenkingen da er stengt',
        /5\.3 stengt|stengt/.test(kap), true);
    // Og at en ny utrulling ER nok. Uten dette står neste kjøring med samme
    // ubesvarte spørsmål: må kopien rives på en egen måte? Målt 22.10.2026.
    sjekk('og at en ny utrulling fjerner kopien',
        /M\u00e5lt 22\.10\.2026: det er nok/.test(kap), true);
}

// ---------- «doesn't exist» betyr to ting ----------
//
// 22.10.2026 ble `Skjema-3-dev` oppgitt som appnavn — visningsnavnet på
// SWA-en ved siden av. `Azure/functions-action` svarte «Resource
// Skjema-3-dev of type Microsoft.Web/Sites doesn't exist», og den
// meldingen dekker BEGGE: feil navn, og en tjenestehovedstol som ikke ser
// ressursen (kapittel 8 i kokeboka sier at oppslaget kan trenge bredere
// leserett).
//
// Vakten skiller dem ved å liste det den FAKTISK ser.
{
    const wf = fs.readFileSync(path.join(mappe, 'deploy-funcapp-pilot.yml'), 'utf8');

    sjekk('workflowen sjekker at appen finnes f\u00f8r deploy',
        /name: Finnes appen\?/.test(wf), true);

    // Rekkefølgen er hele poenget: etter innlogging, før deploy.
    const iLogin = wf.indexOf('azure/login');
    const iSjekk = wf.indexOf('name: Finnes appen?');
    // `uses:`, ikke bare navnet: vaktens egen kommentar nevner handlingen,
    // og et søk på navnet alene traff den i stedet for steget.
    const iDeploy = wf.indexOf('uses: Azure/functions-action');
    sjekk('og den st\u00e5r etter innlogging', iLogin < iSjekk, true);
    sjekk('og f\u00f8r deployen', iSjekk < iDeploy, true);

    // Den må LISTE det den ser — ellers er den bare en annen formulering
    // av samme tvetydige melding.
    sjekk('vakten lister de synlige appene',
        /functionapp list --query "\[\]\.name"/.test(wf), true);
    sjekk('og skiller tomt oppslag fra feil navn',
        /elif \[ -z "\$SYNLIGE" \]/.test(wf), true);
    sjekk('og peker p\u00e5 leserett i det tilfellet',
        /LESERETT som mangler/.test(wf), true);

    // Et tomt oppslag skal ikke STOPPE kjøringen: manglende leserett
    // hindrer ikke nødvendigvis deployen, og en vakt som stopper noe som
    // ville gått, er verre enn ingen.
    const blokk = wf.slice(iSjekk, iDeploy);
    const iTomt = blokk.indexOf('elif [ -z "$SYNLIGE" ]');
    const iElse = blokk.indexOf('else', iTomt);
    sjekk('tomt oppslag advarer, men stopper ikke',
        /::warning::/.test(blokk.slice(iTomt, iElse)), true);
    sjekk('mens feil navn stopper', /exit 1/.test(blokk.slice(iElse)), true);

    // Og navnekonvensjonen må stå i input-beskrivelsen, der den skrives inn.
    sjekk('appnavn-feltet viser formen',
        /description: '[^']*fa-skjema-3-dev/.test(wf), true);
}

console.log(`\n${ok} OK, ${feil} feil  (${deployer.length} deploy-arbeidsflyter)`);
process.exit(feil ? 1 : 0);
