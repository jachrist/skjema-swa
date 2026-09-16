/**
 * SWA-auth-helper.
 *
 * Static Web Apps injiserer x-ms-client-principal på autentiserte requests.
 * Headeren er base64-encoded JSON med { userDetails, claims, userRoles, ... }.
 *
 * Modulen er backward-kompatibel: hvis headeren mangler returnerer
 * hentInnloggetUpn null. Kalleren avgjør om det skal 401 eller behandles anonymt.
 */

const crypto = require('crypto');

function lesPrincipal(request) {
    if (!request?.headers?.get) return null;
    const header = request.headers.get('x-ms-client-principal');
    if (!header) return null;
    try {
        return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    } catch (_) {
        return null;
    }
}

function hentInnloggetUpn(request) {
    const p = lesPrincipal(request);
    return p?.userDetails ? String(p.userDetails).toLowerCase() : null;
}

function hentBrukerRoller(request) {
    const p = lesPrincipal(request);
    return Array.isArray(p?.userRoles) ? p.userRoles : [];
}

/**
 * Navnet på den innloggede, fra claims i x-ms-client-principal.
 *
 * Returnerer null når navnet ikke finnes — ikke UPN-en. «Vi vet ikke» og
 * «navnet er e-postadressen» er to ulike ting, og bare kalleren vet hvilken
 * av dem som skal lagres eller vises.
 *
 * Claim-navnene varierer med hvordan SWA er satt opp: en egendefinert
 * AAD-registrering sender claims videre slik de står i id-tokenet
 * (`name`, `given_name`, `family_name`), mens plattformens egne mappinger
 * bruker de lange URI-formene. Begge godtas.
 *
 * `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name` er med sist og
 * med forbehold: i AAD-mappingen inneholder den ofte `preferred_username`,
 * altså e-postadressen. Et «navn» som er en e-postadresse er ikke et navn, og
 * ville her blitt lagret som Innsender_Navn for all ettertid.
 */
const NAVN_CLAIMS = [
    'name',
    'http://schemas.microsoft.com/identity/claims/displayname'
];
const FORNAVN_CLAIMS = ['given_name', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname'];
const ETTERNAVN_CLAIMS = ['family_name', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname'];
const NAVN_CLAIMS_USIKRE = ['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'];

function claimVerdi(claims, typer) {
    for (const t of typer) {
        const treff = claims.find(c => String(c?.typ || c?.type || '').toLowerCase() === t);
        const val = String(treff?.val || treff?.value || '').trim();
        if (val) return val;
    }
    return '';
}

function erEpostlignende(s) {
    return /\S+@\S+/.test(s);
}

function hentInnloggetNavn(request) {
    const p = lesPrincipal(request);
    const claims = Array.isArray(p?.claims) ? p.claims : [];
    if (claims.length === 0) return null;

    const navn = claimVerdi(claims, NAVN_CLAIMS);
    if (navn && !erEpostlignende(navn)) return navn;

    const fornavn = claimVerdi(claims, FORNAVN_CLAIMS);
    const etternavn = claimVerdi(claims, ETTERNAVN_CLAIMS);
    if (fornavn || etternavn) return [fornavn, etternavn].filter(Boolean).join(' ');

    const usikkert = claimVerdi(claims, NAVN_CLAIMS_USIKRE);
    if (usikkert && !erEpostlignende(usikkert)) return usikkert;

    return null;
}

/**
 * Sjekk om en upn er i ADMIN_UPNS (kommaseparert i env-var).
 */
function erAdmin(upn) {
    if (!upn) return false;
    const liste = String(process.env.ADMIN_UPNS || '')
        .toLowerCase()
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    return liste.includes(String(upn).toLowerCase());
}

/**
 * Gyldig `x-flow-key` fra en Power Automate-flyt?
 *
 * Flytene har ingen Entra-identitet, så en delt nøkkel i en header er det de
 * har. Nøkkelen hashes før sammenligningen: da er lengdene alltid like, og
 * `timingSafeEqual` kan brukes uten å kreve at nøklene er like lange på
 * forhånd — og svartiden røper ikke lengden på den riktige nøkkelen.
 *
 * Den innkommende trimmes. Power Automate legger lett på et linjeskift når
 * verdien kommer fra en variabel eller en Compose.
 *
 * `grunn` er til logg og feilmelding, og sier aldri noe om den forventede
 * verdien utover om den er satt.
 */
function harFlytNokkel(request) {
    const konfigurert = String(process.env.FLOW_CALLBACK_KEY || '').trim();
    if (!konfigurert) return { ok: false, grunn: 'FLOW_CALLBACK_KEY er ikke satt på serveren' };

    const gitt = String(request?.headers?.get?.('x-flow-key') || '').trim();
    if (!gitt) return { ok: false, grunn: 'x-flow-key-header mangler eller er tom' };

    const a = crypto.createHash('sha256').update(gitt).digest();
    const b = crypto.createHash('sha256').update(konfigurert).digest();
    return crypto.timingSafeEqual(a, b)
        ? { ok: true }
        : { ok: false, grunn: 'x-flow-key matcher ikke' };
}

module.exports = { hentInnloggetUpn, hentInnloggetNavn, hentBrukerRoller, erAdmin, harFlytNokkel };
