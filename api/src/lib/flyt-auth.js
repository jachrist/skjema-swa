/**
 * Hvordan vi autentiserer OSS mot Power Automate-flytene.
 *
 * To måter, og de utelukker hverandre ikke teknisk — men de hører til hver
 * sin verden:
 *
 *   **sas** — signaturen i flyt-URL-en (`sig=`). Den som har adressen kan
 *   kalle flyten. URL-en ER legitimasjonen, og derfor er den en hemmelighet
 *   som ikke tåler å stå i en e-post, en sak eller en logg. Pilot og prod
 *   gjør det slik i dag.
 *
 *   **entra** — flyten er satt opp til å kreve et Entra-token, og vi sender
 *   `Authorization: Bearer`. Da er ikke adressen lenger en hemmelighet, og
 *   hele «lenken er legitimasjon»-kategorien forsvinner — svakhet 9.1 i
 *   overleveringsdokumentet. Dev gjør det slik fra 16.10.2026.
 *
 * VALGET ER EN APP-SETTING, IKKE NOE VI UTLEDER. «Flyten krever Entra» er en
 * egenskap ved FLYTEN, ikke ved vår konfigurasjon, og den kan ikke leses ut
 * av noe vi har. Standard er `sas`, altså dagens oppførsel — et miljø som
 * ikke vet om dette, endrer seg ikke.
 *
 * Bare strengen `entra` slår den på, uansett kasus og med mellomrom rundt.
 * Samme konvensjon som `VARSLING_DEAKTIVERT` i `flyt-kaller.js`: én verdi
 * betyr noe, alt annet betyr standard. En tastefeil gir altså `sas`, og det
 * er den trygge retningen — kallet går som før og flyten avviser det med 401
 * hvis den krever Entra. Motsatt vei ville et token blitt sendt til en flyt
 * som ikke venter det, og `/api/system/info` viser hvilken modus som gjelder.
 *
 * Tokenet hentes med `lib/plattform-token.js` — SAMME vei som `mi-flyt`-
 * prøven måler. Les kommentaren der for hvorfor det ikke kan gå gjennom
 * `DefaultAzureCredential`: skråstreken bakerst i ressursen overlever ikke.
 */
const { tokenFraPlattformen } = require('./plattform-token');

/**
 * Audience Power Automate krever. **Skråstreken bakerst er ikke pynt.**
 *
 * Microsoft: «Audience values must be an exact match, including trailing
 * slashes.» Det er en bokstavelig strengsammenligning, og den feiler på ett
 * tegn. Målt 15.10.2026: uten skråstreken svarer flyten
 * `MisMatchingOAuthClaims`.
 */
const FLYT_RESSURS = 'https://service.flow.microsoft.com/';

/** Lovlige verdier for `FLYT_AUTH`. */
const MODUS = ['sas', 'entra'];

/**
 * Hvor lenge før utløp tokenet hentes på nytt.
 *
 * Et token som utløper mellom «vi leste cachen» og «flyten validerte det»
 * gir en 401 som ser ut som feil oppsett. Fem minutter er rikelig for et
 * HTTP-kall og kort nok til at vi ikke henter unødig ofte.
 */
const FORNY_FOR_MS = 5 * 60 * 1000;

let bufret = null;  // { verdi: 'Bearer …', utloper: ms | null }

/**
 * Hvilken modus dette miljøet kjører. Alltid én av `MODUS`.
 *
 * `grunn` sier hvorfor, slik at helsesjekken kan vise det uten å gjette.
 */
function flytAuthModus(env = process.env) {
    const satt = String(env.FLYT_AUTH || '').trim().toLowerCase();
    if (satt === 'entra') {
        return { modus: 'entra', grunn: 'FLYT_AUTH=entra — flytene krever Entra-token' };
    }
    if (satt && satt !== 'sas') {
        return {
            modus: 'sas',
            grunn: `FLYT_AUTH er satt til noe annet enn ${MODUS.join(' eller ')} `
                + '— kallene går som før, med signaturen i URL-en'
        };
    }
    return {
        modus: 'sas',
        grunn: satt
            ? 'FLYT_AUTH=sas — signaturen i flyt-URL-en'
            : 'FLYT_AUTH er ikke satt — signaturen i flyt-URL-en (standard)'
    };
}

/**
 * `Authorization`-headeren for et flyt-kall, eller `null` når modusen er sas.
 *
 * **Kaster hvis modusen er entra og tokenet ikke kan hentes.** Alternativet
 * var å sende kallet uten header og la flyten svare 401 — og da er «vi har
 * ingen managed identity» umulig å skille fra «flyten avviste oss». Årsaken
 * skal følge med feilen, ikke forsvinne på veien.
 */
async function flytAutorisasjon() {
    if (flytAuthModus().modus !== 'entra') return null;
    const na = Date.now();
    if (bufret && (bufret.utloper === null || bufret.utloper - FORNY_FOR_MS > na)) {
        return bufret.verdi;
    }
    const klientId = String(process.env.AZURE_CLIENT_ID || '').trim();
    let svar;
    try {
        svar = await tokenFraPlattformen(FLYT_RESSURS, klientId);
    } catch (e) {
        throw new Error(`FLYT_AUTH=entra, men tokenet kunne ikke hentes: ${e.message}`);
    }
    if (!svar || !svar.token) {
        throw new Error('FLYT_AUTH=entra, men identity-endepunktet ga ingen access_token');
    }
    // Kan utløpet ikke leses, caches ingenting. Et token vi ikke vet levetiden
    // på er verre å gjenbruke enn å hente på nytt.
    const ms = Date.parse(svar.utloper);
    bufret = { verdi: `Bearer ${svar.token}`, utloper: Number.isFinite(ms) ? ms : na };
    return bufret.verdi;
}

/** Bare for test: glem det bufrede tokenet. */
function glemToken() {
    bufret = null;
}

/**
 * Bærer en flyt-URL en SAS-signatur, mens vi autentiserer med Entra?
 *
 * Spørsmålet kom 21.10.2026: trengs flyt-URLene i Key Vault når de ikke har
 * `sig=` lenger? Svaret er nei — uten signaturen er adressen ingen
 * legitimasjon, bare et navn. Men det hviler på en egenskap ved FLYTEN, og
 * den kan endres uten at noe i dette repoet røres: importeres en gammel
 * flyt, eller settes en `When a HTTP request is received`-trigger opp uten
 * Entra, kommer `sig=` tilbake. Da ligger en hemmelighet i klartekst i app
 * settings, og ingenting feiler.
 *
 * Derfor denne: den ser etter signaturen i verdien vi faktisk har, og sier
 * fra. Ren funksjon, så den kan prøves uten en flyt.
 *
 * Returnerer null når alt er som det skal — da har kalleren ingenting å vise.
 */
function sasIUrlTrossEntra(verdi, modus = flytAuthModus()) {
    // MODUS er en LISTE (['sas','entra']), ikke et objekt med navngitte
    // felt. `MODUS.ENTRA` er undefined, og sammenligningen ble da sann for
    // alt — altså en vakt som aldri slo til. Fanget av testen under, før den
    // kom ut.
    if (String(modus) !== 'entra') return null;
    const s = String(verdi || '');
    if (!/[?&]sig=/i.test(s)) return null;
    return 'URL-en bærer en SAS-signatur (sig=) mens FLYT_AUTH=entra. Da ER '
        + 'adressen legitimasjon, og den står i klartekst i app settings. '
        + 'Enten krever flyten likevel ikke Entra — og da er modusen gal — '
        + 'eller URL-en er en gammel kopi som må byttes.';
}

module.exports = {
    flytAuthModus, flytAutorisasjon, FLYT_RESSURS, MODUS,
    sasIUrlTrossEntra, _glemToken: glemToken
};
