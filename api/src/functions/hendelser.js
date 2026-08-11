/**
 * GET /api/hendelser — audit-logg (admin only).
 *   Query-params: antall, fraDato, tilDato, type, aktor, objektId
 */
const { app } = require('@azure/functions');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');
const hendelserStorage = require('../lib/hendelser-storage');

app.http('hentHendelser', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'hendelser',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        if (!erAdmin(upn)) return { status: 403, jsonBody: { status: 'feil', melding: 'Krever admin-rolle' } };

        try {
            const url = new URL(request.url);
            const opts = {
                antall: url.searchParams.get('antall'),
                fraDato: url.searchParams.get('fraDato'),
                tilDato: url.searchParams.get('tilDato'),
                type: url.searchParams.get('type'),
                aktor: url.searchParams.get('aktor'),
                objektId: url.searchParams.get('objektId')
            };
            const liste = await hendelserStorage.hentSiste(opts);
            return { jsonBody: liste };
        } catch (e) {
            context.log('hendelser GET FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});
