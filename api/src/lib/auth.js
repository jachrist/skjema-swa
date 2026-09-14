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

function hentInnloggetUpn(request) {
    if (!request?.headers?.get) return null;
    const header = request.headers.get('x-ms-client-principal');
    if (!header) return null;
    try {
        const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
        return decoded.userDetails ? String(decoded.userDetails).toLowerCase() : null;
    } catch (_) {
        return null;
    }
}

function hentBrukerRoller(request) {
    if (!request?.headers?.get) return [];
    const header = request.headers.get('x-ms-client-principal');
    if (!header) return [];
    try {
        const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
        return Array.isArray(decoded.userRoles) ? decoded.userRoles : [];
    } catch (_) {
        return [];
    }
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

module.exports = { hentInnloggetUpn, hentBrukerRoller, erAdmin, harFlytNokkel };
