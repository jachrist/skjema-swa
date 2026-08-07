/**
 * Skjema-forekomst-endepunkter.
 *
 *   POST /api/skjemaer                        — opprett/lagre skjema
 *   GET  /api/skjemaer/:skjematypeId/:skjemaId — hent én forekomst
 *
 * POST forventer body med:
 *   { Skjematype_id, Seksjoner: [...], Skjema_status?, Skjema_id? (kun ved oppdatering) }
 *
 * Innsender settes automatisk fra pålogget bruker (x-ms-client-principal).
 * Skjema_id genereres serverside for nye skjemaer.
 */
const { app } = require('@azure/functions');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');
const skjemaStorage = require('../lib/skjema-storage');
const forekomstStorage = require('../lib/skjema-forekomst-storage');
const { genererSkjemaId } = require('../lib/skjema-id');
const { filtrerTyperPåTilgang } = require('../lib/tilgang');

async function harPublikumTilgang(skjematypeId, upn) {
    if (erAdmin(upn)) return true;
    const st = await skjemaStorage.hentSkjematype(skjematypeId);
    if (!st) return false;
    const treff = await filtrerTyperPåTilgang([st], upn, 'Publikum');
    return treff.length > 0;
}

async function harEierTilgang(skjematypeId, upn) {
    if (erAdmin(upn)) return true;
    const st = await skjemaStorage.hentSkjematype(skjematypeId);
    if (!st) return false;
    const treff = await filtrerTyperPåTilgang([st], upn, 'Eiere');
    return treff.length > 0;
}

app.http('lagreSkjema', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'skjemaer',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };

        try {
            const body = await request.json();
            const skjematypeId = String(body.Skjematype_id || '');
            if (!skjematypeId) {
                return { status: 400, jsonBody: { status: 'feil', melding: 'Skjematype_id mangler' } };
            }

            // Tilgangskontroll: må være publikum eller eier for å lagre
            const tillatt = await harPublikumTilgang(skjematypeId, upn);
            if (!tillatt) {
                return { status: 403, jsonBody: { status: 'avvist', melding: 'Ingen tilgang til denne skjematypen' } };
            }

            // Generer nytt Skjema_id hvis ikke oppgitt
            let skjemaId = body.Skjema_id ? String(body.Skjema_id) : null;
            const erNytt = !skjemaId;
            if (erNytt) {
                skjemaId = await genererSkjemaId(skjematypeId);
            }

            // Bygg skjemadata
            const skjemaData = {
                ...body,
                Skjema_id: skjemaId,
                Skjematype_id: skjematypeId,
                Innsender_Epost: upn,
                Skjema_status: body.Skjema_status || 2 // 1=mellomlagret, 2=innsendt
            };

            await forekomstStorage.lagreSkjema(skjemaData, erNytt);
            context.log(`skjemaer: ${upn} ${erNytt ? 'opprettet' : 'oppdaterte'} ${skjemaId} (type ${skjematypeId})`);

            return {
                jsonBody: {
                    status: 'ok',
                    Skjema_id: skjemaId,
                    Skjematype_id: skjematypeId
                }
            };
        } catch (e) {
            context.log('skjemaer POST FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('hentSkjema', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'skjemaer/{skjematypeId}/{skjemaId}',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };

        try {
            const { skjematypeId, skjemaId } = request.params;
            const skjema = await forekomstStorage.hentSkjema(skjemaId, skjematypeId);
            if (!skjema) return { status: 404, jsonBody: { status: 'feil', melding: 'Skjema ikke funnet' } };

            // Tilgang: admin, eier eller innsender selv
            const upnLower = upn.toLowerCase();
            const erInnsender = (skjema.Innsender_Epost || '').toLowerCase() === upnLower;
            if (!erInnsender && !erAdmin(upn)) {
                const erEier = await harEierTilgang(skjematypeId, upn);
                if (!erEier) return { status: 403, jsonBody: { status: 'avvist', melding: 'Ingen tilgang' } };
            }

            return { jsonBody: skjema };
        } catch (e) {
            context.log('skjemaer GET FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});
