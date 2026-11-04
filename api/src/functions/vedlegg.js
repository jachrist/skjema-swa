/**
 * Vedlegg-endepunkter.
 *
 *   POST   /api/vedlegg/:skjematypeId/:skjemaId          (multipart, felt "fil") — opplast én fil
 *   GET    /api/vedlegg/:skjematypeId/:skjemaId          — list filer for skjema
 *   GET    /api/vedlegg-fil/:skjematypeId/:skjemaId/:filnavn — last ned én fil
 *   DELETE /api/vedlegg-fil/:skjematypeId/:skjemaId/:filnavn — slett én fil
 *
 * Tilgang: avgjorTilgang under — én regel for alle fire, også for eksterne
 * (utsending, sak-lenke, OTP).
 *
 * Størrelses-grense: 4 MB per fil (SWA request body-limit for managed functions).
 */
const { app } = require('@azure/functions');
const { formatStorrelse } = require('../lib/storrelse');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');
const utsendingToken = require('../lib/utsending-token');
const vedleggStorage = require('../lib/vedlegg-storage');
const forekomstStorage = require('../lib/skjema-forekomst-storage');
const skjemaStorage = require('../lib/skjema-storage');
const { filtrerTyperPåTilgang } = require('../lib/tilgang');
const { erBehandlerPaaNoeSteg, STATUS_SENDT_TILBAKE } = require('../lib/behandling');
const { velgAuthvei, autentiserEkstern, eksternInnsenderUpn, autentiserSak } = require('../lib/ekstern-auth');


const MAX_FIL_STORRELSE = 4 * 1024 * 1024; // 4 MB

/** Et avslag fra avgjorTilgang som HTTP-svar. */
function avvist({ status, melding }) {
    return { status, jsonBody: { status: status === 403 ? 'avvist' : 'feil', melding } };
}

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

const nei = (status, melding) => ({ ok: false, status, melding });
const innsenderPaa = (skjema) => String(skjema?.Innsender_Epost || skjema?.Innsender_epost || '').trim().toLowerCase();

/**
 * Hvem står bak kallet, og får hen lese eller skrive vedleggene på saken?
 *
 * Én regel for alle fire endepunktene, og for alle fire autentiseringsveiene
 * (rekkefølgen bor i lib/ekstern-auth.js). Fram til 04.11.2026 kjente
 * endepunktene bare innlogging, pluss utsendingstokenet ved opplasting — og
 * frontend sendte ikke engang det. En ekstern kunne derfor verken laste opp
 * et vedlegg eller laste ned sitt eget.
 *
 *   utsending  lese og skrive på egen sak; skrive også før saken er lagret
 *   sak        lese egen sak; skrive bare når den er sendt tilbake (status 3),
 *              samme regel som lagringen bruker for tokenet
 *   OTP        lese og skrive på egen sak; skrive også før saken er lagret
 *   innlogget  admin, innsender, eier — og for LESING også behandler på et
 *              steg, som PDF-en og saken selv. Vedleggslenkene på
 *              behandlingssiden ga ellers 403 for en behandler som ikke var eier.
 *
 * «Før saken er lagret»: vedlegg lastes opp før skjemaet sendes, mot en
 * forhåndsgenerert Skjema_id. Da finnes ingen innsender å sjekke mot ennå.
 *
 * @param {'les'|'skriv'} handling
 * @returns {Promise<{ ok: true, aktor } | { ok: false, status, melding }>}
 */
async function avgjorTilgang(request, skjematypeId, skjemaId, handling) {
    const upn = hentInnloggetUpn(request);
    const vei = velgAuthvei(request, upn);
    const skjema = await forekomstStorage.hentSkjema(skjemaId, skjematypeId);
    const skriv = handling === 'skriv';

    if (vei === 'utsending') {
        const v = utsendingToken.valider(request.headers.get('x-utsending-token'));
        if (!v.gyldig || v.skjematypeId !== skjematypeId) return nei(401, v.melding || 'Ugyldig utsendings-token');
        if (skjema ? innsenderPaa(skjema) === v.mottaker : skriv) return { ok: true, aktor: v.mottaker };
        return nei(403, 'Ikke ditt skjema');
    }
    if (vei === 'sak') {
        const sak = autentiserSak(request, skjematypeId, skjemaId, skjema);
        if (!sak.ok) return sak;
        if (skriv && Number(skjema.Skjema_status) !== STATUS_SENDT_TILBAKE) {
            return nei(409, 'Vedleggene kan bare endres når saken er sendt tilbake til deg');
        }
        return { ok: true, aktor: sak.mottaker };
    }
    if (vei === 'ekstern') {
        const forsøk = await autentiserEkstern(request, skjematypeId);
        if (forsøk.ok) {
            const id = eksternInnsenderUpn(forsøk.mottaker, forsøk.kanal);
            if (skjema ? innsenderPaa(skjema) === id.toLowerCase() : skriv) return { ok: true, aktor: id };
            if (!upn) return nei(403, 'Ikke ditt skjema');
        } else if (!upn) {
            return nei(401, forsøk.melding || 'Ikke innlogget');
        }
        // Ugyldig eller fremmed OTP-token, men innlogget: vanlige regler.
    }
    if (!upn) return nei(401, 'Ikke innlogget');
    if (await harTilgangTilSkjema(skjematypeId, skjemaId, upn)) return { ok: true, aktor: upn };
    if (!skriv && skjema && await erBehandlerPaaNoeSteg(skjema, upn)) return { ok: true, aktor: upn };
    return nei(403, 'Ingen tilgang');
}

app.http('opplastVedlegg', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'vedlegg/{skjematypeId}/{skjemaId}',
    handler: async (request, context) => {
        const { skjematypeId, skjemaId } = request.params;
        const tilgang = await avgjorTilgang(request, skjematypeId, skjemaId, 'skriv');
        if (!tilgang.ok) return avvist(tilgang);
        const upn = tilgang.aktor; // brukes til logging (opplasterUpn)

        try {
            const formData = await request.formData();
            const fil = formData.get('fil');
            if (!fil || typeof fil === 'string') {
                return { status: 400, jsonBody: { status: 'feil', melding: 'Ingen fil sendt (må hete "fil")' } };
            }
            const buffer = Buffer.from(await fil.arrayBuffer());
            if (buffer.length > MAX_FIL_STORRELSE) {
                return { status: 413, jsonBody: { status: 'feil', melding: `Filen er for stor (maks ${formatStorrelse(MAX_FIL_STORRELSE)})` } };
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
        const { skjematypeId, skjemaId } = request.params;
        const tilgang = await avgjorTilgang(request, skjematypeId, skjemaId, 'les');
        if (!tilgang.ok) return avvist(tilgang);

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
        const { skjematypeId, skjemaId, filnavn } = request.params;
        const tilgang = await avgjorTilgang(request, skjematypeId, skjemaId, 'les');
        if (!tilgang.ok) return avvist(tilgang);

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
        const { skjematypeId, skjemaId, filnavn } = request.params;
        const tilgang = await avgjorTilgang(request, skjematypeId, skjemaId, 'skriv');
        if (!tilgang.ok) return avvist(tilgang);
        const upn = tilgang.aktor;

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

// Eksportert for test: regelen kjøres der med stubbet lagring.
module.exports = { _avgjorTilgang: avgjorTilgang };
