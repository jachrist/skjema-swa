/**
 * Hvilken legitimasjon lagringen bruker — ÉTT sted.
 *
 * Det finnes to veier inn til samme lagringskonto:
 *
 *   **tilkoblingsstreng** — delt nøkkel i en app setting. Pilot og prod gjør
 *   det slik, fordi SWA Managed Functions ikke eksponerer noe MI-token og
 *   heller ikke løser `@Microsoft.KeyVault(...)`-referanser. Nøkkelen gir full
 *   tilgang til alt i kontoen og kan ikke begrenses.
 *
 *   **managed identity** — `DefaultAzureCredential` mot
 *   `https://<konto>.table.core.windows.net`. Dev gjør det slik: der er API-et
 *   en frittstående Function App, og identiteten finnes. Målt 14.10.2026 og
 *   16.10.2026 — se 8e, 8f og 8i i `docs/BESLUTNING-EGEN-FUNCTION-APP.md`.
 *
 * REGELEN: er `STORAGE_CONNECTION_STRING` satt, brukes den. Er den ikke satt,
 * men `STORAGE_ACCOUNT_NAME` er, brukes managed identity. Er ingen satt, er
 * lagringen ukonfigurert — og det sies med én gang, ikke som en 401 langt
 * unna årsaken.
 *
 * Rekkefølgen er valgt med vilje. Pilot og prod har begge en tilkoblingsstreng
 * OG et kontonavn i inventaret; hadde MI-veien vunnet, ville den slått inn i
 * prod i samme øyeblikk dette ble merget, mot en identitet som ikke finnes
 * der. Slik det står er endringen inert i de to miljøene som er i drift, og
 * gaffelen rives i steg 6.
 *
 * VALGET STÅR HER, OG BARE HER. `storage.js` og `blob.js` spør; de bestemmer
 * ikke. To kopier av «hvilken legitimasjon bruker vi» er nøyaktig feilklassen
 * dette repoet lager flest av — og to kopier som har drevet fra hverandre gir
 * et blob-oppslag som svarer annerledes enn et tabelloppslag mot samme konto,
 * i samme prosess. `api/test/lagringsvalg.test.js` kjører de ekte funksjonene
 * i begge modulene og krever samme svar.
 *
 * Tilkoblingsstrengen er IKKE med i det `lagringsvalg()` returnerer. Den
 * hentes med et eget, tydelig navngitt kall, slik at svaret fra valget kan
 * vises i helsesjekken uten at noen må huske å plukke felt av det.
 */

/** Navnene på de tre app settingene regelen leser. */
const STRENG_VAR = 'STORAGE_CONNECTION_STRING';
const KONTO_VAR = 'STORAGE_ACCOUNT_NAME';
const KLIENTID_VAR = 'AZURE_CLIENT_ID';

/** Lovlige svar fra `lagringsvalg().maate`. */
const MAATER = ['tilkoblingsstreng', 'managed-identity', 'ukonfigurert'];

/**
 * Et lagringskontonavn er 3–24 små bokstaver og sifre, og ingenting annet.
 *
 * Navnet går inn i et vertsnavn. Validert her, ett sted, fordi den
 * nærliggende feilen er å lime en hel tilkoblingsstreng inn i
 * `STORAGE_ACCOUNT_NAME`. Uten sjekken blir symptomet et DNS-oppslag på noe
 * som ser ut som sludder — og nøkkelen havner i feilmeldingen på veien dit.
 */
const KONTONAVN = /^[a-z0-9]{3,24}$/;

/** Tjenestenavnet i vertsnavnet. Suffikset er det samme for begge. */
const TJENESTER = { tabell: 'table', blob: 'blob' };
const SUFFIKS = 'core.windows.net';

function tekst(verdi) {
    return String(verdi || '').trim();
}

/**
 * Hvilken vei lagringen går i DETTE miljøet.
 *
 * Leses ved hvert kall, ikke ved modullast: en app setting som endres krever
 * omstart av appen uansett, men en test som må tømme require-cachen for å
 * endre en env-var er en test folk slutter å skrive.
 *
 * Alle fire feltene settes ALLTID. `JSON.stringify` dropper `undefined`, og en
 * nøkkel som kan forsvinne kan ikke feilsøkes: «MI-veien ble valgt uten
 * klientId» må se annerledes ut enn «svaret manglet feltet».
 */
function lagringsvalg(env = process.env) {
    // Lest med navnet SKREVET UT, ikke gjennom konstantene over. Scanneren i
    // `api/test/env-inventar.test.js` leter etter `env.NAVN` og
    // `process.env.NAVN`; leses verdien gjennom en variabel, ser inventaret
    // komplett ut mens tre app settings mangler fra det. Det har skjedd før —
    // `graph-opplast.js` gjemte seks på nøyaktig den måten.
    const streng = tekst(env.STORAGE_CONNECTION_STRING);
    const konto = tekst(env.STORAGE_ACCOUNT_NAME);
    const klientId = tekst(env.AZURE_CLIENT_ID);

    if (streng) {
        return {
            maate: 'tilkoblingsstreng',
            konto: null,
            klientId: '',
            grunn: `${STRENG_VAR} er satt — delt nøkkel`
        };
    }
    if (konto && !KONTONAVN.test(konto)) {
        return {
            maate: 'ukonfigurert',
            konto: null,
            klientId: '',
            grunn: `${KONTO_VAR} er ikke et lovlig kontonavn (3–24 små bokstaver og sifre). `
                + 'Står det en hel tilkoblingsstreng der?'
        };
    }
    if (konto) {
        return {
            maate: 'managed-identity',
            konto,
            klientId,
            grunn: `${STRENG_VAR} er ikke satt; bruker ${KONTO_VAR}=${konto} med managed identity`
                + (klientId ? '' : ` — ${KLIENTID_VAR} er ikke satt, så SDK-en leter etter en `
                    + 'system-assigned identitet')
        };
    }
    return {
        maate: 'ukonfigurert',
        konto: null,
        klientId: '',
        grunn: `verken ${STRENG_VAR} eller ${KONTO_VAR} er satt`
    };
}

/**
 * Tilkoblingsstrengen, når valget er den veien.
 *
 * Eget kall fordi returverdien er en HEMMELIGHET. Den som skriver
 * `const valg = lagringsvalg()` og sender `valg` videre til et svar, skal ikke
 * kunne lekke nøkkelen ved uhell.
 */
function tilkoblingsstreng(env = process.env) {
    return tekst(env.STORAGE_CONNECTION_STRING);
}

/**
 * Endepunktet for en tjeneste på en konto.
 *
 * Her, og ikke i hver modul: `storage.js`, `blob.js` og mi-prøvene bygde
 * tidligere hver sin URL av samme to deler.
 */
function endepunkt(tjeneste, konto) {
    const t = TJENESTER[tjeneste];
    if (!t) throw new Error(`ukjent lagringstjeneste: ${tjeneste}`);
    // Verdien gjentas IKKE i meldingen. Den vanligste gale verdien her er en
    // hel tilkoblingsstreng, og da ville nøkkelen stått i en exception — og
    // derfra i loggen. Lengden er nok til å kjenne den igjen.
    if (!KONTONAVN.test(String(konto || ''))) {
        throw new Error(`ugyldig lagringskontonavn på ${String(konto || '').length} tegn `
            + '— forventet 3–24 små bokstaver og sifre');
    }
    return `https://${konto}.${t}.${SUFFIKS}`;
}

/**
 * Kontonavnet ut av en tilkoblingsstreng.
 *
 * Til visning: gjør det mulig å se hvilket lager et miljø faktisk snakker med
 * uten å eksponere nøkkelen. Lå i `storage.js` til 16.10.2026, og flyttet hit
 * fordi `miljoetsKonto()` under må kunne svare for BEGGE veiene — og den som
 * spør «hvilken konto er dette» skal ikke måtte vite hvilken vei miljøet går.
 */
function kontoNavnFra(connectionString) {
    const s = String(connectionString || '');
    const m = /(?:^|;)\s*AccountName=([^;]+)/i.exec(s);
    if (m) return m[1].trim();
    // En SAS-basert connection string fra portalen har ingen AccountName — bare
    // endepunkter og signaturen. Da må navnet leses ut av vertsnavnet, ellers
    // står det «ukjent konto» i admin-panelet akkurat når man trenger å vite
    // hvilken konto man faktisk snakker med.
    const e = /(?:Blob|Table|Queue|File)Endpoint=https?:\/\/([^.;/]+)\./i.exec(s);
    return e ? e[1].trim() : null;
}

/**
 * Hvilken lagringskonto DETTE miljøet bruker — uansett vei inn.
 *
 * Svaret følger `lagringsvalg()`, og det er hele poenget: går miljøet på
 * tilkoblingsstreng, leses navnet UT AV STRENGEN, ikke av
 * `STORAGE_ACCOUNT_NAME`. De to kan være uenige — pilot har en verdi i
 * inventaret som ikke nødvendigvis er den strengen peker på — og da er det
 * strengen som forteller hvor dataene faktisk ligger.
 *
 * Tre vakter i appen sammenligner noe mot «vår egen konto»: den som nekter en
 * ekstern backup av vårt eget lager, og de to som sier fra når en delt SAS
 * peker hjem i stedet for til den delte kontoen. Alle tre leste tidligere
 * `STORAGE_CONNECTION_STRING` direkte, og ble derfor STILLE SLÅTT AV i et
 * miljø som går på managed identity. En vakt som ikke sier fra at den har
 * sluttet å virke er verre enn ingen vakt.
 *
 * `null` betyr «vet ikke», og alle tre vaktene behandler det som «ikke
 * sammenlign» — som før.
 */
function miljoetsKonto(env = process.env) {
    const valg = lagringsvalg(env);
    if (valg.maate === 'managed-identity') return valg.konto;
    if (valg.maate === 'tilkoblingsstreng') return kontoNavnFra(tilkoblingsstreng(env));
    return null;
}

/**
 * AccountName og AccountKey ut av en tilkoblingsstreng.
 *
 * Eneste bruk er SAS-signering med delt nøkkel. Kaster hvis noen av dem
 * mangler — en SAS signert med halve opplysninger er ikke en SAS.
 *
 * Verdien gjentas aldri i feilmeldingen: det er en kontonøkkel.
 */
function kontonokkelFra(connectionString) {
    const kv = {};
    for (const del of String(connectionString || '').split(';')) {
        const i = del.indexOf('=');
        if (i < 0) continue;
        kv[del.substring(0, i).trim()] = del.substring(i + 1).trim();
    }
    const konto = kv.AccountName;
    const nokkel = kv.AccountKey;
    if (!konto || !nokkel) {
        throw new Error(`${STRENG_VAR} mangler AccountName eller AccountKey — `
            + 'en SAS kan ikke signeres med delt nøkkel uten begge');
    }
    return { konto, nokkel };
}

/**
 * Nøkkel for klientcachen på MI-veien.
 *
 * Nøkkelen identifiserer LAGERET, ikke tabellen eller containeren. For delt
 * nøkkel er den connection stringen selv — to miljøer med hver sin streng skal
 * ikke dele klient. For managed identity er den denne, og formen kan ikke
 * kollidere med en connection string: en slik inneholder alltid `=`.
 *
 * Den står her fordi `storage.js` og `blob.js` begge trenger den, og to
 * strengformater som skal være like er to som kan bli ulike.
 */
function miNokkel(valg) {
    return `mi:${valg.klientId || 'standard'}@${valg.konto}`;
}

// SDK-en lastes først ved første bruk, samme grunn som i storage.js: testene
// skal kunne kjøre uten node_modules.
let DefaultAzureCredential = null;
const legitimasjoner = new Map();

/**
 * Identiteten koden bruker mot lagringen.
 *
 * Caches per klientId. En `DefaultAzureCredential` cacher tokenet sitt
 * internt, så én instans per identitet sparer et tokenoppslag per kall.
 *
 * Uten `clientId` leter SDK-en etter en system-assigned identitet. Er den
 * user-assigned — som `mi-skjema-3-dev` er — svarer identity-endepunktet
 * «Unable to load the proper Managed Identity», også når det bare finnes én.
 * Derfor sendes `AZURE_CLIENT_ID` med når den er satt.
 */
function legitimasjon(klientId) {
    const n = klientId || '';
    if (!legitimasjoner.has(n)) {
        if (!DefaultAzureCredential) {
            ({ DefaultAzureCredential } = require('@azure/identity'));
        }
        legitimasjoner.set(n, new DefaultAzureCredential(n ? { managedIdentityClientId: n } : undefined));
    }
    return legitimasjoner.get(n);
}

module.exports = {
    lagringsvalg, tilkoblingsstreng, endepunkt, legitimasjon, miNokkel,
    kontoNavnFra, miljoetsKonto, kontonokkelFra,
    STRENG_VAR, KONTO_VAR, KLIENTID_VAR, MAATER, KONTONAVN
};
