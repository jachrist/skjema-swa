/**
 * «Avgjorte valg» på System-siden — svarene fra reglene, ikke fra env-varene.
 *
 * Kapittel 9 i KOKEBOK-PROD-V3.md ber deg lese `lagring.maate` og `flytAuth`
 * på Administrasjon → ⚙️ System. 27.10.2026 var de ikke der: `/api/system/info`
 * HAR returnert dem hele tiden, men `sysLast()` tegnet bare Aktør, Runtime,
 * env-varene og request-headerne. Et ferdig-kriterium som ikke kan inntreffe
 * er samme klasse som kapittel 4 hadde før — se felleregisteret.
 *
 * Hvorfor de to verdiene i det hele tatt finnes, står i system.js:
 *
 *   «To veier inn til samme konto betyr at "storage svarer ikke" har to helt
 *   ulike feilsøkinger, og den som leser helsesjekken skal ikke måtte utlede
 *   hvilken.»
 *
 * Det er nettopp derfor de ikke kan leses av env-varene under: `FLYT_AUTH` kan
 * stå til noe som ikke er en kjent verdi, og da er modusen `sas` selv om det
 * står noe annet der. Og lagringen velges av TO varer i kombinasjon.
 *
 * Testen binder tre ledd: regelen, API-svaret og siden som viser det.
 *
 * Kjøres med:  node api/test/system-avgjorte-valg.test.js
 */
const fs = require('fs');
const path = require('path');
const { utenKommentarer } = require('../../scripts/test-kilde.js');
const { lagringsvalg, STRENG_VAR, KONTO_VAR, KLIENTID_VAR } = require('../src/lib/lagringsvalg');
const { flytAuthModus } = require('../src/lib/flyt-auth');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const rot = path.join(__dirname, '..', '..');
const les = (...p) => utenKommentarer(fs.readFileSync(path.join(rot, ...p), 'utf8'));

// ---------- reglene, kjørt ----------
//
// Prod v3 er nettopp kombinasjonen kapittel 9 ber deg bekrefte: kontonavn
// satt, tilkoblingsstreng IKKE satt.
{
    const prodV3 = { [KONTO_VAR]: 'stskjema3prod', [KLIENTID_VAR]: '59d9e19f-a883-4dd7-a853-9d6d0726d822' };
    sjekk('kontonavn uten streng gir managed identity',
        lagringsvalg(prodV3).maate, 'managed-identity');
    sjekk('og kontoen er med', lagringsvalg(prodV3).konto, 'stskjema3prod');

    const medStreng = { ...prodV3, [STRENG_VAR]: 'DefaultEndpointsProtocol=https;AccountName=x;AccountKey=y;' };
    sjekk('streng vinner over kontonavn', lagringsvalg(medStreng).maate, 'tilkoblingsstreng');
    sjekk('ingen av delene gir ukonfigurert', lagringsvalg({}).maate, 'ukonfigurert');

    sjekk('FLYT_AUTH=entra gir entra', flytAuthModus({ FLYT_AUTH: 'entra' }).modus, 'entra');
    // Det er HER utledning fra env-varen ville tatt feil: det står noe, men
    // modusen er sas.
    sjekk('ukjent FLYT_AUTH er sas, ikke det som står der',
        flytAuthModus({ FLYT_AUTH: 'tull' }).modus, 'sas');
    sjekk('usatt FLYT_AUTH er sas', flytAuthModus({}).modus, 'sas');

    // Begge bærer en grunn. Uten den er «managed-identity» et ord uten
    // forklaring når noen lurer på hvorfor.
    sjekk('lagringsvalget begrunner seg', lagringsvalg(prodV3).grunn.length > 10, true);
    sjekk('flytvalget begrunner seg', flytAuthModus({ FLYT_AUTH: 'entra' }).grunn.length > 10, true);
}

// ---------- API-et svarer med dem ----------
{
    const sys = les('api', 'src', 'functions', 'system.js');
    sjekk('system.js svarer med lagringsvalget', /lagring: lagringsvalg\(\)/.test(sys), true);
    sjekk('og med flytmodusen', /flytAuth: flytAuthModus\(\)/.test(sys), true);
}

// ---------- og siden VISER dem ----------
//
// Dette leddet manglet. API-svaret alene er ikke en helsesjekk noen leser.
{
    const admin = les('frontend', 'admin.html');
    const i = admin.indexOf('async function sysLast()');
    sjekk('fant sysLast', i > -1, true);
    const sysLast = admin.slice(i, admin.indexOf('\n        }', i));

    sjekk('System-siden viser lagringsmåten', /d\.lagring\?\.maate/.test(sysLast), true);
    sjekk('og lagringskontoen', /d\.lagring\?\.konto/.test(sysLast), true);
    sjekk('og flytmodusen', /d\.flytAuth\?\.modus/.test(sysLast), true);
    // Begrunnelsene er halve poenget: «hvorfor» er det neste spørsmålet.
    sjekk('og begrunnelsen for lagringen', /d\.lagring\?\.grunn/.test(sysLast), true);
    sjekk('og begrunnelsen for flyten', /d\.flytAuth\?\.grunn/.test(sysLast), true);
}

// ---------- kokeboka ber om verdier koden kan gi ----------
//
// Kapittel 9 navngir både feltet og den forventede verdien. Er navnet feil,
// leter man etter noe som ikke finnes; er verdien feil, godkjenner man et
// miljø som er satt opp på en annen måte enn man tror.
{
    const kb = fs.readFileSync(path.join(rot, 'docs', 'KOKEBOK-PROD-V3.md'), 'utf8');
    const kap9 = kb.slice(kb.indexOf('## 9. Verifikasjon'), kb.indexOf('## 10.'));
    sjekk('kapittel 9 finnes', kap9.length > 100, true);

    const navngitt = [...kap9.matchAll(/`lagring\.(\w+)`/g)].map(m => m[1]);
    sjekk('kapittel 9 navngir et felt i lagringsvalget', navngitt.length > 0, true);
    const fraRegelen = Object.keys(lagringsvalg({ [KONTO_VAR]: 'stskjema3prod' }));
    sjekk('og feltet finnes i svaret',
        navngitt.filter(n => !fraRegelen.includes(n)), []);

    // Verdiene kapittel 9 venter seg må være verdier regelen kan returnere.
    for (const [verdi, faktisk] of [
        ['managed-identity', lagringsvalg({ [KONTO_VAR]: 'stskjema3prod' }).maate],
        ['entra', flytAuthModus({ FLYT_AUTH: 'entra' }).modus]
    ]) {
        sjekk(`kapittel 9 venter «${verdi}», og regelen kan gi den`, faktisk, verdi);
        sjekk(`og «${verdi}» står i kapittel 9`, kap9.includes(verdi), true);
    }
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
