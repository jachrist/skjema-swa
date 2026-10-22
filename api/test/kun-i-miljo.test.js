/**
 * `KUN_I_MILJO` i helsesjekken, og inventaret, skal si det samme.
 *
 * 22.10.2026, etter at kravlista for prod v3 var kjørt: `AAD_CLIENT_SECRET`
 * sto der som påkrevd. Men `api/src/functions/system.js` erklærer at den
 * hører hjemme i `pilot` og `lokal` — prod autentiserer med SERTIFIKAT via
 * `clientSecretCertificateKeyVaultReference`, og en satt verdi der er
 * «dokumentasjonsgjeld, ikke noe som brukes», med helsesjekkens egne ord.
 *
 * To lister, to svar. Den ene ba om å lime en ekte klienthemmelighet inn i
 * prod, den andre sa at den skal stå tom. Og den som setter opp miljøet
 * leser kravlista, ikke kildekoden til helsesjekken.
 *
 * Regelen: er en variabel erklært til å høre hjemme bare i noen miljøer, kan
 * inventaret for de ANDRE miljøene ikke kreve en verdi. `valgfri` og
 * `kun_dokumentasjon` er greit — de er nettopp måtene å si «står her for
 * oversiktens skyld».
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
const MILJOER = ['dev', 'pilot', 'prod'];

// Formene som betyr «denne MÅ ha en verdi». Samme tre som
// `MA_SETTES` i vis-appsettings.js — lest derfra, ikke skrevet opp her.
const { MA_SETTES } = require(path.join(rot, 'scripts', 'vis-appsettings.js'));
sjekk('fant formene som krever en verdi', MA_SETTES.length > 0, true);

// Erklæringen i helsesjekken. Leses ut av kilden, ikke importert: system.js
// registrerer Azure Functions-handlere ved modullast.
const kilde = fs.readFileSync(
    path.join(rot, 'api', 'src', 'functions', 'system.js'), 'utf8');

const fra = kilde.indexOf('const KUN_I_MILJO = {');
sjekk('fant KUN_I_MILJO i system.js', fra > 0, true);

// Hver oppføring: NAVN: { miljoer: [...] }
const blokk = kilde.slice(fra, kilde.indexOf('\n};', fra));
const oppforinger = [...blokk.matchAll(
    /^\s{4}(\w+):\s*\{[\s\S]*?miljoer:\s*\[([^\]]*)\]/gm)]
    .map(m => ({
        navn: m[1],
        miljoer: m[2].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean)
    }));

sjekk('fant oppføringer i KUN_I_MILJO', oppforinger.length > 0, true);

// Inventaret, per miljø.
const inventar = {};
for (const miljo of MILJOER) {
    const data = JSON.parse(fs.readFileSync(
        path.join(rot, 'config', `env.${miljo}.json`), 'utf8'));
    const flat = {};
    (function samle(o) {
        if (o && typeof o === 'object') {
            for (const [k, v] of Object.entries(o)) {
                if (v && typeof v === 'object'
                    && ('keyvault' in v || 'value' in v || 'valgfri' in v
                        || 'settes_direkte' in v || 'kun_dokumentasjon' in v)) flat[k] = v;
                else samle(v);
            }
        }
    })(data);
    inventar[miljo] = flat;
}

for (const { navn, miljoer } of oppforinger) {
    // Den skal finnes i alle tre uansett — env-inventar.test.js krever det,
    // og en erklæring om et navn som ikke står der, beskriver ingenting.
    const mangler = MILJOER.filter(m => !inventar[m][navn]);
    sjekk(`${navn} står i alle inventarene`, mangler, []);

    for (const miljo of MILJOER) {
        const opp = inventar[miljo][navn];
        if (!opp) continue;

        const kreves = MA_SETTES.some(f => f in opp)
            && !opp.kun_dokumentasjon;
        const horerHjemme = miljoer.includes(miljo);

        if (!horerHjemme) {
            sjekk(`${navn} kreves ikke i ${miljo} (KUN_I_MILJO: ${miljoer.join(', ')})`,
                kreves, false);
        }
    }
}

// REGELEN GÅR BARE ÉN VEI, og det er en beslutning.
//
// «Hører hjemme i dette miljøet» ⇒ «inventaret må kreve den» ville vært den
// naturlige motsatsen. Den kan ikke kreves i dag: `AAD_CLIENT_ID` er erklært
// for `prod`, og prod-inventaret har den som `kun_dokumentasjon`. Begge har
// rett, om hver sin prod — v2 kjører API-et INNE i SWA-en, så der ER
// env-varen verdien innloggingen bruker; v3 har API-et på en egen Function
// App, der en kopi ikke er i bruk og kan drive fra originalen (4.3).
//
// `KUN_I_MILJO` beskriver altså v2-arkitekturen, inventaret v3. Det løses
// når v2 rives (kapittel 11), ikke av en test som tvinger fram ett svar.

// Og motsatt vei: står en variabel som `kun_dokumentasjon` i ETT miljø og
// kreves i et annet, skal forskjellen være erklært. Ellers er den en
// tilfeldighet noen retter opp i feil retning.
{
    const erklaert = new Set(oppforinger.map(o => o.navn));
    const ujevne = [];
    const alle = new Set(MILJOER.flatMap(m => Object.keys(inventar[m])));
    for (const navn of alle) {
        if (erklaert.has(navn)) continue;
        const kreves = MILJOER.filter(m => {
            const o = inventar[m][navn];
            return o && MA_SETTES.some(f => f in o) && !o.kun_dokumentasjon;
        });
        const dokumentert = MILJOER.filter(m => {
            const o = inventar[m][navn];
            return o && o.kun_dokumentasjon;
        });
        if (kreves.length && dokumentert.length) ujevne.push(navn);
    }
    sjekk('ingen uerklært forskjell mellom miljøene', ujevne, []);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
