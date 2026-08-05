/**
 * SWA-auth-helper.
 *
 * Static Web Apps injiserer x-ms-client-principal på autentiserte requests.
 * Headeren er base64-encoded JSON med { userDetails, claims, userRoles, ... }.
 *
 * Modulen er backward-kompatibel: hvis headeren mangler returnerer
 * hentInnloggetUpn null. Kalleren avgjør om det skal 401 eller behandles anonymt.
 */

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

module.exports = { hentInnloggetUpn, hentBrukerRoller, erAdmin };
