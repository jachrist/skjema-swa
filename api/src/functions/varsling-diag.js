/**
 * GET /api/varsling/diag
 *
 * Diagnose for varsling-oppsett. Krever admin.
 * Viser hva base_url + eksempellenke ville blitt for et gitt skjema.
 */
const { app } = require('@azure/functions');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');
const { baseUrl } = require('../lib/flyt-kaller');

app.http('varslingDiag', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'varsling/diag',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn || !erAdmin(upn)) {
            return { status: 403, jsonBody: { status: 'avvist', melding: 'Krever admin' } };
        }
        const base = baseUrl(request);
        return {
            jsonBody: {
                SWA_URL_env: process.env.SWA_URL || null,
                base_url_utledet: base,
                x_forwarded_host: request.headers.get('x-forwarded-host') || null,
                x_forwarded_proto: request.headers.get('x-forwarded-proto') || null,
                host: request.headers.get('host') || null,
                VARSLING_FLOW_URL_satt: !!process.env.VARSLING_FLOW_URL,
                VARSLING_DEAKTIVERT: process.env.VARSLING_DEAKTIVERT || null,
                eksempel_lenke: base ? `${base}/evaluering.html?skjematype_id=108&skjema_id=1` : '(base_url tom!)'
            }
        };
    }
});
