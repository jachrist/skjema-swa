/**
 * GET /api/whoami — returnerer basic info om innlogget bruker + admin-status.
 * Bruker kan lese denne uten å måtte kalle .auth/me OG sjekke admin separat.
 *
 * `navn` og `navnKilde` er med for å kunne se ETT sted hvor navnet kommer fra:
 *   'claims'  — SWA sender claims videre til API-et
 *   'lagret'  — fra Brukernavn-tabellen, fylt ved innlogging
 *   null      — ikke funnet noe sted, og da blir $innsender_navn
 *               e-postadressen. Logg inn på nytt hvis dette er uventet:
 *               tabellen fylles først ved neste innlogging.
 */
const { app } = require('@azure/functions');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');
const brukernavn = require('../lib/brukernavn-storage');
const rollerStorage = require('../lib/roller-storage');

app.http('whoami', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'whoami',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        const admin = erAdmin(upn);
        let navnFunn = { navn: '', kilde: null };
        try { navnFunn = await brukernavn.losNavn(request, upn); }
        catch (_) { /* best-effort */ }
        // Skjemaskaper: admin, eller medlem av rollen (uansett omfang)
        let kanOppretteSkjematype = admin;
        if (!kanOppretteSkjematype) {
            try { kanOppretteSkjematype = await rollerStorage.erMedlem('Skjemaskaper', upn); }
            catch (_) { /* best-effort */ }
        }
        return {
            jsonBody: {
                upn,
                navn: navnFunn.navn || null,
                navnKilde: navnFunn.kilde,
                erAdmin: admin,
                kanOppretteSkjematype
            }
        };
    }
});
