/**
 * GET /api/power-bi?skjematype_id=X&guid=Y&upn=Z
 *
 * Endepunkt som Power BI Web-connector kaller. Returnerer en JSON-array
 * med ett objekt per skjema, flat struktur (spørsmålstekst → svar).
 *
 * Auth: token (guid) må matche upn i Tilgangskontroll-tabellen og ikke
 * være utløpt. Ekstra sanity-sjekk: token må gjelde samme skjematype som
 * i query. Ingen SWA-cookie kreves — dette er en unlisted URL som PB
 * kan bruke uten interaktiv login.
 *
 * Kolonner: SkjemaNr, Innsender_Navn, Innsender_Epost, OpprettetDato,
 * FerdigbehandletDato + spørsmålstekst→svar. Multi-svar joines med "; ".
 */
const { app } = require('@azure/functions');
const skjemaStorage = require('../lib/skjema-storage');
const forekomstStorage = require('../lib/skjema-forekomst-storage');
const { validerPbToken } = require('../lib/pb-token-storage');
const { trekkUtSvar } = require('../lib/datauttrekk');

app.http('powerBi', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'power-bi',
    handler: async (request, context) => {
        try {
            const skjematypeId = request.query.get('skjematype_id');
            const guid = request.query.get('guid');
            const upn = request.query.get('upn');

            if (!skjematypeId || !guid || !upn) {
                return { status: 400, jsonBody: { status: 'feil', melding: 'Mangler skjematype_id, guid eller upn' } };
            }

            const validering = await validerPbToken({ upn, guid, skjematypeId });
            if (!validering.gyldig) {
                context.log(`power-bi: ugyldig token for ${upn}/${skjematypeId} — ${validering.melding}`);
                return { status: 403, jsonBody: { status: 'avvist', melding: validering.melding || 'Ugyldig token' } };
            }

            const st = await skjemaStorage.hentSkjematype(skjematypeId);
            if (!st) return { status: 404, jsonBody: { status: 'feil', melding: 'Skjematype ikke funnet' } };
            const definisjon = st.JSON || {};

            const skjemaer = await forekomstStorage.hentAlleSkjemaerForType(skjematypeId, { fulltFormat: true });
            const dataRader = skjemaer.map(s => trekkUtSvar(s, definisjon));

            context.log(`power-bi: ${upn} hentet ${dataRader.length} skjemaer for type ${skjematypeId}`);
            return { jsonBody: dataRader };
        } catch (e) {
            context.log('power-bi FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});
