/**
 * POST /api/skjemaer/{skjematypeId}/{skjemaId}/pdf
 *   Body (valgfritt): { format: 'base64' } — hvis satt, returneres JSON
 *   { filnavn, innhold(base64), contentType }, ellers binær application/pdf.
 *
 * Tilgang: samme regel som hentSkjema (admin, eier, innsender eller behandler).
 * Vedlegg hentes fra Blob og embeddes i PDF.
 */
const { app } = require('@azure/functions');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');
const skjemaStorage = require('../lib/skjema-storage');
const forekomstStorage = require('../lib/skjema-forekomst-storage');
const vedleggStorage = require('../lib/vedlegg-storage');
const { filtrerTyperPåTilgang } = require('../lib/tilgang');
const { beregnAktiveSteg, brukerErBehandlerAsync } = require('../lib/behandling');
const { genererOppsummeringPdf } = require('../lib/pdf-generator');
const kryptering = require('../lib/kryptering');
const nokkelStorage = require('../lib/nokkel-storage');

async function harTilgang(skjema, skjematypeId, upn) {
    if (erAdmin(upn)) return true;
    const upnLower = String(upn).toLowerCase();
    if ((skjema?.Innsender_Epost || '').toLowerCase() === upnLower) return true;

    // Eier på skjematypen
    const st = await skjemaStorage.hentSkjematype(skjematypeId);
    if (st) {
        const treff = await filtrerTyperPåTilgang([st], upn, 'Eiere');
        if (treff.length > 0) return true;
    }

    // Behandler på aktivt steg
    const aktive = beregnAktiveSteg(skjema);
    for (const s of aktive) {
        if (await brukerErBehandlerAsync(s, upn)) return true;
    }

    // Behandler på et TIDLIGERE steg (skjema.Behandling[].BehandletAv === upn)
    for (const s of (skjema?.Behandling || [])) {
        if (String(s.BehandletAv || '').toLowerCase() === upnLower) return true;
    }
    return false;
}

async function hentAlleVedlegg(skjematypeId, skjemaId, log) {
    const filer = await vedleggStorage.listVedlegg(skjematypeId, skjemaId);
    const out = [];
    for (const f of filer) {
        try {
            const stream = await vedleggStorage.hentVedleggStream(skjematypeId, skjemaId, f.filnavn);
            if (stream?.buffer) out.push({ name: f.filnavn, data: stream.buffer.toString('base64') });
        } catch (e) {
            log(`pdf: kunne ikke lese vedlegg "${f.filnavn}": ${e.message}`);
        }
    }
    return out;
}

function byggFilnavn(skjemaId) {
    const nu = new Date().toISOString().substring(0, 10);
    return `Oppsummering_${skjemaId || 'skjema'}_${nu}.pdf`;
}

app.http('genererPdf', {
    methods: ['POST', 'GET'],
    authLevel: 'anonymous',
    route: 'skjemaer/{skjematypeId}/{skjemaId}/pdf',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        try {
            const { skjematypeId, skjemaId } = request.params;
            const skjema = await forekomstStorage.hentSkjema(skjemaId, skjematypeId);
            if (!skjema) return { status: 404, jsonBody: { status: 'feil', melding: 'Skjema ikke funnet' } };

            if (!(await harTilgang(skjema, skjematypeId, upn))) {
                return { status: 403, jsonBody: { status: 'avvist', melding: 'Ingen tilgang' } };
            }

            // Bruk Skjema_navn fra definisjonen for header hvis skjemaet ikke har det
            let st;
            try {
                st = await skjemaStorage.hentSkjematype(skjematypeId);
                if (!skjema.Skjema_navn && !skjema.Overskrift && st?.JSON?.Skjema_navn) {
                    skjema.Skjema_navn = st.JSON.Skjema_navn;
                }
            } catch (_) { /* ikke kritisk */ }

            // Auto-dekryptering hvis skjemaet er kryptert
            const erKryptert = skjema?.Kryptert === true || (typeof skjema?.Kryptert === 'string' && skjema.Kryptert.length > 0);
            if (erKryptert) {
                try {
                    const nokkel = await nokkelStorage.hentNokkel(skjematypeId);
                    if (nokkel) {
                        skjema = kryptering.dekrypterSkjema(skjema, nokkel);
                        context.log(`pdf: dekrypterte skjema ${skjemaId}`);
                    } else {
                        context.log(`pdf: skjema ${skjemaId} er kryptert men nøkkel mangler — genererer med [Kryptert]-verdier`);
                    }
                } catch (e) {
                    context.log(`pdf: dekryptering feilet — ${e.message}`);
                }
            }

            const log = (m) => context.log(m);
            const vedlegg = await hentAlleVedlegg(skjematypeId, skjemaId, log);
            const buffer = await genererOppsummeringPdf(skjema, vedlegg);
            const filnavn = byggFilnavn(skjemaId);

            // Query-param eller body kan overstyre format
            let format = null;
            try {
                if (request.method === 'POST') {
                    const body = await request.json().catch(() => ({}));
                    format = body?.format;
                }
            } catch (_) { /* ignorer */ }
            format = format || request.query.get('format');

            if (format === 'base64') {
                return { jsonBody: {
                    filnavn,
                    innhold: buffer.toString('base64'),
                    contentType: 'application/pdf'
                }};
            }

            return {
                status: 200,
                headers: {
                    'Content-Type': 'application/pdf',
                    'Content-Disposition': `attachment; filename="${filnavn}"`
                },
                body: buffer
            };
        } catch (e) {
            context.log('pdf FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});
