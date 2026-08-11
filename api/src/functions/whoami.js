/**
 * GET /api/whoami — returnerer basic info om innlogget bruker + admin-status.
 * Bruker kan lese denne uten å måtte kalle .auth/me OG sjekke admin separat.
 */
const { app } = require('@azure/functions');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');
const rollerStorage = require('../lib/roller-storage');

app.http('whoami', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'whoami',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        const admin = erAdmin(upn);
        // Skjemaskaper: admin, eller medlem av rollen (uansett omfang)
        let kanOppretteSkjematype = admin;
        if (!kanOppretteSkjematype) {
            try { kanOppretteSkjematype = await rollerStorage.erMedlem('Skjemaskaper', upn); }
            catch (_) { /* best-effort */ }
        }
        return {
            jsonBody: {
                upn,
                erAdmin: admin,
                kanOppretteSkjematype
            }
        };
    }
});
