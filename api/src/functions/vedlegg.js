/**
 * Vedlegg-endepunkter.
 *
 *   POST   /api/vedlegg/:skjematypeId/:skjemaId          (multipart, felt "fil") — opplast én fil
 *   GET    /api/vedlegg/:skjematypeId/:skjemaId          — list filer for skjema
 *   GET    /api/vedlegg-fil/:skjematypeId/:skjemaId/:filnavn — last ned én fil
 *   DELETE /api/vedlegg-fil/:skjematypeId/:skjemaId/:filnavn — slett én fil
 *
 * Tilgang:
 *   - Opplast / slett: eier, admin eller innsender (kun for eget skjema)
 *   - Hent liste / last ned: samme
 *
 * Størrelses-grense: 4 MB per fil (SWA request body-limit for managed functions).
 */
const { app } = require('@azure/functions');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');
const utsendingToken = require('../lib/utsending-token');
const vedleggStorage = require('../lib/vedlegg-storage');
const forekomstStorage = require('../lib/skjema-forekomst-storage');
const skjemaStorage = require('../lib/skjema-storage');
const { filtrerTyperPåTilgang } = require('../lib/tilgang');

const MAX_FIL_STORRELSE = 4 * 1024 * 1024; // 4 MB

async function harTilgangTilSkjema(skjematypeId, skjemaId, upn) {
    if (erAdmin(upn)) return true;
    const skjema = await forekomstStorage.hentSkjema(skjemaId, skjematypeId);
    // For nytt skjema (ikke enda lagret): tillat hvis bruker er Publikum på skjematypen
    if (!skjema) {
        const st = await skjemaStorage.hentSkjematype(skjematypeId);
        if (!st) return false;
        const treff = await filtrerTyperPåTilgang([st], upn, 'Publikum');
        return treff.length > 0;
    }
    // Innsender selv
    if ((skjema.Innsender_Epost || '').toLowerCase() === upn.toLowerCase()) return true;
    // Eier
    const st = await skjemaStorage.hentSkjematype(skjematypeId);
    if (!st) return false;
    const treff = await filtrerTyperPåTilgang([st], upn, 'Eiere');
    return treff.length > 0;
}

app.http('opplastVedlegg', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'vedlegg/{skjematypeId}/{skjemaId}',
    handler: async (request, context) => {
        const { skjematypeId, skjemaId } = request.params;
        let upn = hentInnloggetUpn(request);
        const utsendingHeader = request.headers.get('x-utsending-token');
        if (utsendingHeader) {
            const v = utsendingToken.valider(utsendingHeader);
            if (!v.gyldig || v.skjematypeId !== skjematypeId) {
                return { status: 401, jsonBody: { status: 'feil', melding: v.melding || 'Ugyldig utsendings-token' } };
            }
            upn = v.mottaker; // brukes kun til logging (opplasterUpn)
        } else if (!upn) {
            return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        } else if (!(await harTilgangTilSkjema(skjematypeId, skjemaId, upn))) {
            return { status: 403, jsonBody: { status: 'avvist', melding: 'Ingen tilgang' } };
        }

        try {
            const formData = await request.formData();
            const fil = formData.get('fil');
            if (!fil || typeof fil === 'string') {
                return { status: 400, jsonBody: { status: 'feil', melding: 'Ingen fil sendt (må hete "fil")' } };
            }
            const buffer = Buffer.from(await fil.arrayBuffer());
            if (buffer.length > MAX_FIL_STORRELSE) {
                return { status: 413, jsonBody: { status: 'feil', melding: `Filen er for stor (maks ${MAX_FIL_STORRELSE / 1024 / 1024} MB)` } };
            }

            const res = await vedleggStorage.opplastVedlegg({
                skjematypeId, skjemaId,
                filnavn: fil.name,
                contentType: fil.type,
                buffer,
                opplasterUpn: upn
            });
            context.log(`vedlegg POST: ${upn} lastet opp ${res.filnavn} (${res.storrelse} bytes) til ${skjematypeId}/${skjemaId}`);
            return { jsonBody: { status: 'ok', ...res } };
        } catch (e) {
            context.log('vedlegg POST FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('listVedlegg', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'vedlegg/{skjematypeId}/{skjemaId}',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };

        const { skjematypeId, skjemaId } = request.params;
        if (!(await harTilgangTilSkjema(skjematypeId, skjemaId, upn))) {
            return { status: 403, jsonBody: { status: 'avvist', melding: 'Ingen tilgang' } };
        }

        try {
            const filer = await vedleggStorage.listVedlegg(skjematypeId, skjemaId);
            return { jsonBody: filer };
        } catch (e) {
            context.log('vedlegg GET FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('hentVedlegg', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'vedlegg-fil/{skjematypeId}/{skjemaId}/{filnavn}',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };

        const { skjematypeId, skjemaId, filnavn } = request.params;
        if (!(await harTilgangTilSkjema(skjematypeId, skjemaId, upn))) {
            return { status: 403, jsonBody: { status: 'avvist', melding: 'Ingen tilgang' } };
        }

        try {
            const fil = await vedleggStorage.hentVedleggStream(skjematypeId, skjemaId, filnavn);
            if (!fil) return { status: 404, jsonBody: { status: 'feil', melding: 'Fil ikke funnet' } };
            return {
                status: 200,
                headers: {
                    'Content-Type': fil.contentType,
                    'Content-Disposition': `attachment; filename="${encodeURIComponent(fil.filnavn)}"`,
                    'Content-Length': String(fil.storrelse)
                },
                body: fil.buffer
            };
        } catch (e) {
            context.log('vedlegg-fil GET FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('slettVedlegg', {
    methods: ['DELETE'],
    authLevel: 'anonymous',
    route: 'vedlegg-fil/{skjematypeId}/{skjemaId}/{filnavn}',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };

        const { skjematypeId, skjemaId, filnavn } = request.params;
        if (!(await harTilgangTilSkjema(skjematypeId, skjemaId, upn))) {
            return { status: 403, jsonBody: { status: 'avvist', melding: 'Ingen tilgang' } };
        }

        try {
            const slettet = await vedleggStorage.slettVedlegg(skjematypeId, skjemaId, filnavn);
            if (!slettet) return { status: 404, jsonBody: { status: 'feil', melding: 'Fil ikke funnet' } };
            context.log(`vedlegg DELETE: ${upn} slettet ${filnavn} fra ${skjematypeId}/${skjemaId}`);
            return { jsonBody: { status: 'ok' } };
        } catch (e) {
            context.log('vedlegg DELETE FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});
