/**
 * POST /api/pb-token
 *   Body: { skjematypeId }
 *   Krever eier-tilgang (eller admin).
 *   Returnerer: { guid, url, utloper }
 *
 * URL-en peker på /api/power-bi?skjematype_id=X&guid=Y&upn=Z og kan limes inn
 * i Power BI Desktop sin Web-connector.
 */
const { app } = require('@azure/functions');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');
const skjemaStorage = require('../lib/skjema-storage');
const { filtrerTyperPåTilgang } = require('../lib/tilgang');
const { opprettPbToken } = require('../lib/pb-token-storage');
const { baseUrl } = require('../lib/flyt-kaller');

async function harEierTilgang(skjematypeId, upn) {
    if (erAdmin(upn)) return true;
    const st = await skjemaStorage.hentSkjematype(skjematypeId);
    if (!st) return false;
    const treff = await filtrerTyperPåTilgang([st], upn, 'Eiere');
    return treff.length > 0;
}

app.http('opprettPbToken', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'pb-token',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        try {
            const body = await request.json();
            const skjematypeId = String(body.skjematypeId || '');
            if (!skjematypeId) return { status: 400, jsonBody: { status: 'feil', melding: 'skjematypeId mangler' } };
            if (!(await harEierTilgang(skjematypeId, upn))) {
                return { status: 403, jsonBody: { status: 'avvist', melding: 'Krever eier- eller admin-tilgang' } };
            }
            const { guid, utloper } = await opprettPbToken({ upn, skjematypeId });
            const base = baseUrl(request);
            const url = `${base}/api/power-bi?skjematype_id=${encodeURIComponent(skjematypeId)}&guid=${encodeURIComponent(guid)}&upn=${encodeURIComponent(upn)}`;
            context.log(`pb-token: ${upn} opprettet token for skjematype ${skjematypeId} (utløper ${utloper})`);
            return { jsonBody: { status: 'ok', guid, url, utloper } };
        } catch (e) {
            context.log('pb-token FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});
