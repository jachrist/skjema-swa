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
 *   stå i BEGGE de aktive miljøfilene.
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
 * De AKTIVE miljøene. Det er disse to som rulles ut
 * (`deploy-pilot.yml`, `deploy-prod.yml`); noe tredje miljø finnes ikke.
 */
const MILJOER = ['pilot', 'prod'];

/**
 * Hver `process.env.X` i api/src.
 *
 * Bare `api/src`: det er API-et som kjører i SWA og som leser app settings.
 * `scripts/` leser også env-variabler, men de er lokale verktøy
 * (`scripts/migrer/*`) eller settes av GitHub Actions (`GITHUB_SHA`), og
 * hører ikke hjemme i et inventar over SWA Configuration.
 */
function lestAvKoden() {
    const funnet = new Set();
    const gå = (katalog) => {
        for (const n of fs.readdirSync(katalog, { withFileTypes: true })) {
            const p = path.join(katalog, n.name);
            if (n.isDirectory()) { gå(p); continue; }
            if (!n.name.endsWith('.js')) continue;
            for (const m of fs.readFileSync(p, 'utf8').matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
                funnet.add(m[1]);
            }
        }
    };
    gå(path.join(rot, 'api', 'src'));
    return funnet;
}

const lest = lestAvKoden();
const kvKart = fs.readFileSync(path.join(rot, 'config', 'keyvault-secrets.md'), 'utf8');

sjekk('koden leser env-variabler i det hele tatt', lest.size > 10, true);

for (const miljo of MILJOER) {
    const fil = path.join(rot, 'config', `env.${miljo}.json`);
    sjekk(`${miljo}: fila finnes`, fs.existsSync(fil), true);
    if (!fs.existsSync(fil)) continue;

    let d;
    try { d = JSON.parse(fs.readFileSync(fil, 'utf8')); }
    catch (e) { feil++; console.log(`FEIL  ${miljo}: ugyldig JSON — ${e.message}`); continue; }

    const nokler = Object.keys(d).filter(n => !n.startsWith('_'));

    // ---- 1. ingenting koden leser mangler ----
    sjekk(`${miljo}: alt koden leser er deklarert`,
        [...lest].filter(n => !nokler.includes(n)).sort(), []);

    // ---- 2. ingenting står der uten grunn ----
    const uforklart = nokler.filter(n => {
        if (lest.has(n)) return false;
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

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
