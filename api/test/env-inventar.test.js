/**
 * `config/env.*.json` er en INVENTARLISTE, og den skal være komplett.
 *
 * Filene er ikke autoritative, og skal ikke bli det. Et skript som setter app
 * settings må ha verdiene for å kunne sette dem, og da måtte hemmelighetene
 * innom en CI-runner eller et lokalt skall — nettopp spredningen vi unngår.
 * Managed Identity er dessuten ikke tilgjengelig for koden vår, så app
 * settings kan ikke peke på Key Vault selv; en autoritativ fil måtte båret
 * klartekst. Verdiene bor i Key Vault, og settes manuelt i SWA Configuration.
 *
 * Men en inventarliste som ingen kontrollerer, driver. Og det hadde den: da
 * denne testen ble skrevet, manglet `env.pilot.json` 15 av 29 variabler koden
 * leser — blant dem `STORAGE_CONNECTION_STRING`, `HASH_SALT` og
 * `OTP_HMAC_KEY` — og `env.prod.json` sto fortsatt med
 * «<sett-når-prod-storage-opprettes>» selv om prod var i drift.
 *
 * Det er en dyr form for feil, fordi lista ser ut som en oversikt. Den som
 * skal sette opp et nytt miljø, eller skrive tilbake etter et uhell, tror den
 * er fullstendig.
 *
 * Fire krav:
 *
 *   **Ingenting koden leser mangler.** Hver `process.env.X` i `api/src` skal
 *   stå i BEGGE de aktive miljøfilene. Unntaket er variabler PLATTFORMEN
 *   setter selv — de er ikke app settings, og er erklært i
 *   `SATT_AV_PLATTFORMEN` i koden som leser dem.
 *
 *   **Ingenting står der uten grunn.** En nøkkel som ikke leses av koden må
 *   enten være `public: true` (den går til frontend) eller merket
 *   `kun_dokumentasjon`. Ellers er den en rest ingen tør fjerne.
 *
 *   **Ingen plassholdere.** «<sett-når-X-opprettes>» i et miljø som er i
 *   drift er en påstand som er feil.
 *
 *   **Key Vault-navnene finnes i kartet.** `config/keyvault-secrets.md` er
 *   kilden for hvilken secret hver app-setting hentes fra. Peker en fil på et
 *   navn som ikke står der, er det ingen som vet hvor verdien kommer fra.
 *
 * Kjøres med:  node api/test/env-inventar.test.js
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

/**
 * De AKTIVE miljøene. Alle tre rulles ut: `deploy-dev.yml` og «Deploy API til
 * Function App» for dev, `deploy-pilot.yml` og `deploy-prod.yml` for de to
 * andre.
 *
 * `dev` kom til 15.10.2026. Kravene under gjelder den likt — et nytt miljø
 * som slipper unna inventaret er nettopp et inventar som ser komplett ut og
 * ikke er det.
 */
const MILJOER = ['dev', 'pilot', 'prod'];

/**
 * Hver app-setting api/src leser.
 *
 * Bare `api/src`: det er API-et som kjører i SWA. `scripts/` leser også
 * env-variabler, men de er lokale verktøy (`scripts/migrer/*`) eller settes
 * av GitHub Actions (`GITHUB_SHA`), og hører ikke hjemme i et inventar over
 * SWA Configuration.
 *
 * TO former må leses, ikke én. Den første versjonen av denne testen tok bare
 * `process.env.NAVN`, og var derfor blind for seks app settings:
 * `graph-opplast.js:46` leser via `process.env[n]` gjennom en `les()`-hjelper.
 * Testen så komplett ut og var det ikke — nøyaktig feilen den skal hindre.
 */
function lestAvKoden() {
    const funnet = new Set();
    const gå = (katalog) => {
        for (const n of fs.readdirSync(katalog, { withFileTypes: true })) {
            const p = path.join(katalog, n.name);
            if (n.isDirectory()) { gå(p); continue; }
            if (!n.name.endsWith('.js')) continue;
            const t = fs.readFileSync(p, 'utf8');
            for (const m of t.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) funnet.add(m[1]);
            for (const m of t.matchAll(/\bles\('([A-Z][A-Z0-9_]*)'\)/g)) funnet.add(m[1]);
        }
    };
    gå(path.join(rot, 'api', 'src'));
    return funnet;
}

/**
 * Navnene helsesjekken viser på `/api/system/info`.
 *
 * Dette er den TREDJE lista over de samme variablene, og den drev som de to
 * andre: 12.10.2026 manglet den ni av dem, blant dem `BACKUP_PASSPHRASE` —
 * er den ikke satt, er hver backup ulesbar, og helsesjekken sa ingenting.
 */
function vistIHelsesjekken() {
    const s = fs.readFileSync(path.join(rot, 'api', 'src', 'functions', 'system.js'), 'utf8');
    const ut = new Set();
    for (const navn of ['OFFENTLIGE_ENV', 'HEMMELIGE_ENV']) {
        const m = new RegExp(`${navn} = \\[([\\s\\S]*?)\\];`).exec(s);
        if (!m) { feil++; console.log(`FEIL  fant ikke ${navn} i system.js`); continue; }
        for (const t of m[1].matchAll(/'([A-Z][A-Z0-9_]*)'/g)) ut.add(t[1]);
    }
    return ut;
}

/**
 * Variabler som leses med et navn koden ikke kjenner på forhånd.
 *
 * `nokkelkalender-storage.js:117` gjør `process.env[rad.EnvVar]` — navnet
 * kommer fra en tabellrad. Den kan ikke finnes statisk, og skal ikke kreves
 * i inventaret.
 */
const DATASTYRTE_OPPSLAG = ['process.env[rad.EnvVar]'];

/**
 * Variabler PLATTFORMEN setter, som derfor ikke er app settings.
 *
 * `IDENTITY_ENDPOINT` og `IDENTITY_HEADER` settes av App Service når en
 * managed identity er på. Ingen fører dem opp i SWA Configuration, og ingen
 * limer inn en verdi for dem. Krevde inventaret at de sto i
 * `config/env.*.json`, ville lista påstått at noen må sette dem.
 *
 * Erklæringen bor i koden som leser dem — `SATT_AV_PLATTFORMEN` i
 * `mi-diagnose.js` — og leses HERFRA. En liste i denne testen ville vært en
 * kopi til av den samme regelen, og kopier nummer to er feilklassen dette
 * repoet lager flest av.
 */
function sattAvPlattformen() {
    const f = path.join(rot, 'api', 'src', 'functions', 'mi-diagnose.js');
    const s = fs.readFileSync(f, 'utf8');
    const m = /const SATT_AV_PLATTFORMEN = \[([^\]]*)\]/.exec(s);
    if (!m) {
        feil++;
        console.log('FEIL  fant ikke SATT_AV_PLATTFORMEN i mi-diagnose.js');
        return new Set();
    }
    return new Set([...m[1].matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map(x => x[1]));
}

const lestRått = lestAvKoden();
const plattformsatte = sattAvPlattformen();
// Lista skal ikke kunne bli et gjemmested. Et navn der som koden IKKE leser,
// er en rest — og en rest her slår av en kontroll uten at noen ser det.
sjekk('ingen rest i plattform-lista',
    [...plattformsatte].filter(n => !lestRått.has(n)).sort(), []);
sjekk('plattform-lista er ikke tom', plattformsatte.size > 0, true);

const lest = new Set([...lestRått].filter(n => !plattformsatte.has(n)));
const vist = vistIHelsesjekken();
const kvKart = fs.readFileSync(path.join(rot, 'config', 'keyvault-secrets.md'), 'utf8');

sjekk('koden leser env-variabler i det hele tatt', lest.size > 10, true);
sjekk('helsesjekken viser noen', vist.size > 10, true);

// Den dynamiske formen MÅ fortsatt finnes et sted, ellers har noen skrevet
// om graph-opplast.js og testen ble blind igjen uten å si fra.
{
    const graph = fs.readFileSync(path.join(rot, 'api', 'src', 'lib', 'graph-opplast.js'), 'utf8');
    sjekk('den dynamiske les()-formen leses fortsatt', /les\('GRAPH_TENANT_ID'\)/.test(graph), true);
    sjekk('og scanneren fant den', lest.has('GRAPH_TENANT_ID'), true);
    // Det datastyrte oppslaget er erklært, ikke oversett.
    const nk = fs.readFileSync(path.join(rot, 'api', 'src', 'lib', 'nokkelkalender-storage.js'), 'utf8');
    sjekk('det datastyrte oppslaget står der det er erklært',
        DATASTYRTE_OPPSLAG.every(f => nk.includes(f)), true);
}

// ---------- tre lister, ett svar ----------
{
    // Koden, helsesjekken og inventaret har hver sin håndholdte liste over de
    // samme variablene. De drev fra hverandre i alle tre retninger, og hver
    // uenighet var taus.
    sjekk('alt koden leser vises i helsesjekken',
        [...lest].filter(n => !vist.has(n)).sort(), []);
    // Noen vises med vilje uten at koden leser dem — auth-innstillingene
    // brukes av plattformen. Unntaket er ERKLÆRT i system.js, ikke her: en
    // liste i testen ville vært en fjerde kopi av den samme regelen.
    const systemKilde = fs.readFileSync(path.join(rot, 'api', 'src', 'functions', 'system.js'), 'utf8');
    const unntak = new Set([...(/VIST_UTEN_AT_KODEN_LESER = \[([^\]]*)\]/.exec(systemKilde)?.[1] || '')
        .matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map(m => m[1]));
    sjekk('alt helsesjekken viser leses av koden, eller er erklært unntak',
        [...vist].filter(n => !lest.has(n) && !unntak.has(n)).sort(), []);
    // Og unntakslista skal ikke samle støv: et navn der som koden faktisk
    // leser, eller som helsesjekken ikke viser, er en rest.
    sjekk('ingen rest i unntakslista',
        [...unntak].filter(n => lest.has(n) || !vist.has(n)).sort(), []);
}

for (const miljo of MILJOER) {
    const fil = path.join(rot, 'config', `env.${miljo}.json`);
    sjekk(`${miljo}: fila finnes`, fs.existsSync(fil), true);
    if (!fs.existsSync(fil)) continue;

    let d;
    try { d = JSON.parse(fs.readFileSync(fil, 'utf8')); }
    catch (e) { feil++; console.log(`FEIL  ${miljo}: ugyldig JSON — ${e.message}`); continue; }

    const nokler = Object.keys(d).filter(n => !n.startsWith('_'));

    // ---- 1. ingenting koden leser eller helsesjekken viser mangler ----
    sjekk(`${miljo}: alt koden leser er deklarert`,
        [...lest].filter(n => !nokler.includes(n)).sort(), []);
    sjekk(`${miljo}: alt helsesjekken viser er deklarert`,
        [...vist].filter(n => !nokler.includes(n)).sort(), []);

    // ---- 2. ingenting står der uten grunn ----
    const uforklart = nokler.filter(n => {
        if (lest.has(n) || vist.has(n)) return false;
        const e = d[n] || {};
        return e.public !== true && e.kun_dokumentasjon !== true;
    });
    sjekk(`${miljo}: ingen uforklart nøkkel`, uforklart.sort(), []);

    // ---- 3. ingen plassholdere ----
    const plassholdere = nokler.filter(n => {
        const v = d[n]?.value;
        return typeof v === 'string' && /^<.*>$/.test(v);
    });
    sjekk(`${miljo}: ingen plassholdere igjen`, plassholdere.sort(), []);

    // ---- 4. hver keyvault-referanse finnes i kartet ----
    const ukjenteSecrets = nokler
        .map(n => d[n]?.keyvault)
        .filter(Boolean)
        .filter(s => !new RegExp(`\`${s}\``).test(kvKart))
        .sort();
    sjekk(`${miljo}: alle keyvault-navn står i keyvault-secrets.md`, ukjenteSecrets, []);

    // ---- 5. hver oppføring har en kjent form ----
    // Uten dette kan en tastefeil («keyvalut») gi en oppføring som verken er
    // en verdi eller en referanse, og som ingen sjekk over fanger.
    const FORMER = ['keyvault', 'value', 'valgfri', 'settes_i_swa'];
    const formløse = nokler.filter(n => {
        const e = d[n];
        return !e || typeof e !== 'object' || !FORMER.some(f => f in e);
    });
    sjekk(`${miljo}: alle oppføringer har en kjent form`, formløse.sort(), []);
}

// ---------- de to utgåtte filene ----------
{
    // `env.production.json` ble aldri lest: `build-config.js` ruter
    // «production» til pilot så lenge `env.pilot.json` finnes. En fil som
    // ingen leser og ingen vedlikeholder, ser like autoritativ ut som de to
    // ekte — og det var nettopp forvirringen.
    sjekk('env.production.json er fjernet',
        fs.existsSync(path.join(rot, 'config', 'env.production.json')), false);

    // `development` hadde ingen deploy-workflow. CI bygde den som røyktest,
    // og bygger nå pilot i stedet — et miljø som faktisk finnes.
    sjekk('env.development.json er fjernet',
        fs.existsSync(path.join(rot, 'config', 'env.development.json')), false);
    const ci = fs.readFileSync(path.join(rot, '.github', 'workflows', 'ci.yml'), 'utf8');
    sjekk('CI bygger et miljø som finnes', /build-config\.js (pilot|prod)\b/.test(ci), true);
    sjekk('og ikke development', /build-config\.js development/.test(ci), false);
}

// ---------- ingen hemmelighet har sneket seg inn ----------
{
    // Konvensjonen har holdt, og den skal fortsette å holde. Dette er den
    // ene sjekken som må være rød FØR noen rekker å committe.
    const MØNSTRE = [
        [/sig=[A-Za-z0-9%_-]{10,}/, 'SAS-signatur i en flyt-URL'],
        [/AccountKey=/, 'nøkkel i en tilkoblingsstreng'],
        [/logic\.azure\.com/, 'ekte Logic Apps-/flyt-adresse'],
        [/BEGIN [A-Z ]*PRIVATE KEY/, 'privat nøkkel']
    ];
    for (const miljo of [...MILJOER, 'development', 'production']) {
        const fil = path.join(rot, 'config', `env.${miljo}.json`);
        if (!fs.existsSync(fil)) continue;
        const tekst = fs.readFileSync(fil, 'utf8');
        for (const [m, hva] of MØNSTRE) {
            sjekk(`${miljo}: ingen ${hva}`, m.test(tekst), false);
        }
    }
}

// ---------- dev skal ikke ha en tilkoblingsstreng ----------
//
// Hele poenget med dev er at lagringen går på managed identity. Settes
// STORAGE_CONNECTION_STRING likevel, velger koden den gamle veien — og da
// måler miljøet ikke lenger det det ble bygget for, uten at noe feiler.
//
// Inventaret er ikke app settings, så dette kan ikke garantere at ingen setter
// den i Azure. Det det KAN gjøre, er å hindre at lista ber noen om å gjøre det.
{
    const dev = JSON.parse(fs.readFileSync(path.join(rot, 'config', 'env.dev.json'), 'utf8'));
    const cs = dev.STORAGE_CONNECTION_STRING || {};
    sjekk('dev: STORAGE_CONNECTION_STRING er merket valgfri', cs.valgfri === true, true);
    sjekk('dev: og er ikke en keyvault-referanse', 'keyvault' in cs, false);
    sjekk('dev: og har ingen verdi', 'value' in cs, false);
    sjekk('dev: merknaden sier at den ikke skal settes',
        /SETTES IKKE I DEV/.test(cs.merknad || ''), true);

    // Og motsatt: unntaket skal være ETT, ikke to. TODO_STORAGE_CONNECTION_STRING
    // peker på en konto i en annen tenant der en MI ikke kan få rolle, og
    // forblir en delt nøkkel. Står den som valgfri, har noen trodd den også
    // kunne forsvinne.
    const todo = dev.TODO_STORAGE_CONNECTION_STRING || {};
    sjekk('dev: TODO-strengen er fortsatt en hemmelighet', 'keyvault' in todo, true);
}

// ---------- «valgfri» må stemme med koden ----------
//
// Formen i inventaret er en PÅSTAND om koden: `valgfri` betyr «knapp med
// default, trenger ikke settes». Står den feil, ber lista enten om en verdi
// ingen har, eller friskmelder en som faktisk kreves.
//
// Begge retningene har stått feil. BACKUP_SHAREPOINT_BIBLIOTEK og _MAPPE var
// merket `settes_i_swa` i alle tre miljøene til 16.10.2026, selv om
// graph-opplast.js aldri har krevd dem — ingen av miljøene har noen gang satt
// dem, og backupene har ligget i rota av standardbiblioteket hele tiden.
//
// Testen leser BEGGE sider: den påkrevde lista i koden, og formen i filene.
{
    const graph = fs.readFileSync(path.join(rot, 'api', 'src', 'lib', 'graph-opplast.js'), 'utf8');

    // `kreves`-objektet i manglerKonfig() er kildens egen liste over hva
    // Graph-veien ikke klarer seg uten.
    const m = /const kreves = \{([\s\S]*?)\};/.exec(graph);
    sjekk('fant kreves-lista i graph-opplast.js', !!m, true);
    const påkrevd = m ? [...m[1].matchAll(/([A-Z][A-Z0-9_]*):/g)].map(x => x[1]) : [];
    sjekk('kreves-lista er ikke tom', påkrevd.length > 0, true);

    // Dokumentert valgfrie, i samme fil. Står de i `kreves`, er kommentaren
    // over dem gal — og da skal denne testen si fra, ikke tilpasse seg.
    const VALGFRIE = ['BACKUP_SHAREPOINT_BIBLIOTEK', 'BACKUP_SHAREPOINT_MAPPE'];
    sjekk('de valgfrie står ikke i kreves-lista',
        VALGFRIE.filter(n => påkrevd.includes(n)), []);

    for (const miljo of MILJOER) {
        const d = JSON.parse(fs.readFileSync(path.join(rot, 'config', `env.${miljo}.json`), 'utf8'));
        // En påkrevd variabel merket valgfri er den farlige retningen:
        // helsesjekken friskmelder den, og Graph-veien faller stille tilbake
        // til flyten.
        sjekk(`${miljo}: ingen påkrevd variabel er merket valgfri`,
            påkrevd.filter(n => d[n] && d[n].valgfri === true).sort(), []);
        // Og motsatt: en valgfri merket som noe annet ber om en verdi ingen har.
        sjekk(`${miljo}: de valgfrie er merket valgfri`,
            VALGFRIE.filter(n => !(d[n] && d[n].valgfri === true)).sort(), []);
    }
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
