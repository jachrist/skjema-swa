/**
 * Hvilken Key Vault hører til hvilket miljø — ett svar per miljø.
 *
 * Navnet på en vault fanst i repoet i syv varianter, og to av dem var feil:
 *
 *   `kv-fhsskjema-prod`      — bare i docs/DEPLOY.md, som planla prod FØR den
 *                              fanst («f.eks.», sammen med et sertifikatnavn
 *                              og en ressursgruppe som heller ikke ble brukt).
 *   `kv-fhsskjema-pilot-prod` — bare i config/env.pilot.json. Nøyaktig det
 *                              «-prod»-suffikset config/keyvault-secrets.md
 *                              sier ble rettet 12.10.2026 etter å ha lest
 *                              pilots levende KEYVAULT_NAME. Rettingen traff
 *                              de to dokumentene notatet nevner, og gikk
 *                              forbi inventarfila.
 *
 * Et vault-navn er ikke en detalj: det er pekeren hemmelighetene hentes fra,
 * og et galt navn ser ut som manglende tilgang. Prod sitt navn leses derfor
 * ut av `staticwebapp.config.prod.json`, der det står i en KV-referanse
 * PLATTFORMEN løser ved oppstart — altså den ene forekomsten som ikke kan
 * være feil uten at innloggingen i prod er nede.
 *
 * Kjøres med:  node api/test/keyvault-navn.test.js
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
const les = (...p) => fs.readFileSync(path.join(rot, ...p), 'utf8');
const lesJson = (...p) => JSON.parse(les(...p));

// ---------- 1. kanonisk navn per miljø, lest ut av kilden ----------
//
// dev og pilot: KEYVAULT_NAME i inventarfila. prod: KV-referansen i
// staticwebapp.config.prod.json, som er levende konfigurasjon.
const KANONISK = {};
for (const miljo of ['dev', 'pilot']) {
    const v = lesJson('config', `env.${miljo}.json`).KEYVAULT_NAME;
    sjekk(`env.${miljo}.json har KEYVAULT_NAME`, !!v, true);
    KANONISK[miljo] = v && v.value;
    sjekk(`env.${miljo}.json gir et vault-navn`, typeof KANONISK[miljo], 'string');
}

{
    const prodConf = lesJson('staticwebapp.config.prod.json');
    const ref = prodConf?.auth?.identityProviders?.azureActiveDirectory
        ?.registration?.clientSecretCertificateKeyVaultReference;
    sjekk('prod-konfigurasjonen har en KV-referanse for auth-sertifikatet',
        typeof ref, 'string');
    const m = /SecretUri=https:\/\/([^.]+)\.vault\.azure\.net\//.exec(ref || '');
    sjekk('og verten kan leses ut av den', !!m, true);
    KANONISK.prod = m && m[1];
}

sjekk('tre miljøer har hvert sitt navn', Object.keys(KANONISK).sort(),
    ['dev', 'pilot', 'prod']);
sjekk('og de tre navnene er forskjellige',
    new Set(Object.values(KANONISK)).size, 3);

// Får env.prod.json en verdi en dag, skal den være den samme. Uten denne
// kunne prod fått to kilder igjen, uten at noe ble rødt.
{
    const prodEnv = lesJson('config', 'env.prod.json').KEYVAULT_NAME;
    sjekk('env.prod.json har KEYVAULT_NAME i inventaret', !!prodEnv, true);
    if (prodEnv && prodEnv.value !== undefined) {
        sjekk('og verdien er den samme som i prod-konfigurasjonen',
            prodEnv.value, KANONISK.prod);
    } else {
        sjekk('og den settes i SWA, ikke i repoet', !!prodEnv.settes_i_swa, true);
    }
}

// ---------- 2. ingen andre vault-navn i repoet ----------
//
// Hver oppføring her er en forekomst som IKKE er en vault for et av
// miljøene, med grunnen i seg. En liste uten grunner blir en liste folk
// legger nye navn i for å få testen grønn.
const UNNTAK = {
    'kv-skjema-3-prod': 'alternativet i kokebokas valg «gjenbruk fhs-kv-01, eller ny» — ikke en vault som finnes',
    'kv-1': 'rad-ID i en testfikstur i jobb-bokforing.test.js, ikke et vault-navn',
    'FHSFunctionKeys': 'sitert fra Microsofts egen dokumentasjon i BESLUTNING-EGEN-FUNCTION-APP.md',
    'kv': 'maskeringseksempel i system-miljo.test.js'
};

// Denne fila navngir unntakene selv. Leses den med, er «ingen død
// oppføring»-sjekken under alltid grønn, og da beviser den ingenting.
const DENNE_FILA = path.join('api', 'test', 'keyvault-navn.test.js');

const NAVN = /\b((?:fhs-kv|kv)-[a-z0-9][a-z0-9-]*)\b/g;
const VERT = /\b([A-Za-z][A-Za-z0-9._-]*)\.vault\.azure\.net/g;
const ENDELSER = ['.md', '.json', '.js', '.yml', '.yaml', '.ps1'];

function filer(katalog, ut = []) {
    for (const n of fs.readdirSync(path.join(rot, katalog), { withFileTypes: true })) {
        if (n.name === 'node_modules' || n.name === '.git') continue;
        const rel = path.join(katalog, n.name);
        if (n.isDirectory()) filer(rel, ut);
        else if (ENDELSER.some(e => n.name.endsWith(e))) ut.push(rel);
    }
    return ut;
}

const alle = filer('.').map(f => f.replace(/^\.[/\\]/, ''))
    .filter(f => f !== DENNE_FILA);
sjekk('det finnes filer å skanne', alle.length > 50, true);

const funnet = new Map();   // navn -> [steder]
for (const f of alle) {
    const linjer = les(f).split('\n');
    linjer.forEach((l, i) => {
        for (const m of l.matchAll(NAVN)) {
            if (!funnet.has(m[1])) funnet.set(m[1], []);
            funnet.get(m[1]).push(`${f}:${i + 1}`);
        }
        for (const m of l.matchAll(VERT)) {
            if (!funnet.has(m[1])) funnet.set(m[1], []);
            funnet.get(m[1]).push(`${f}:${i + 1}`);
        }
    });
}

const kanoniske = new Set(Object.values(KANONISK));
const ukjente = [...funnet.keys()]
    .filter(n => !kanoniske.has(n) && !(n in UNNTAK))
    .sort()
    .map(n => `${n} (${funnet.get(n)[0]})`);
sjekk('ingen vault-navn i repoet utenom de tre og de erklærte unntakene',
    ukjente, []);

// Hvert miljøs navn skal faktisk stå et sted — ellers er «kanonisk» et navn
// ingen bruker.
sjekk('hvert kanonisk navn brukes i repoet',
    Object.entries(KANONISK).filter(([, n]) => !funnet.has(n)).map(([m]) => m), []);

// Og ingen død oppføring i unntakslista.
sjekk('ingen død oppføring i UNNTAK',
    Object.keys(UNNTAK).filter(n => !funnet.has(n)), []);

// ---------- 3. prod-navnet står likt i koden og i konfigurasjonen ----------
//
// `nokkelkalender-storage.js` forteller en administrator hvor
// auth-sertifikatet ligger. Står det et annet vault-navn der, sender
// diagnosen folk til feil sted.
{
    const kilde = les('api', 'src', 'lib', 'nokkelkalender-storage.js');
    const navn = [...kilde.matchAll(NAVN)].map(m => m[1]);
    sjekk('diagnosen navngir en vault', navn.length > 0, true);
    sjekk('og det er prod-vaulten', [...new Set(navn)], [KANONISK.prod]);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
