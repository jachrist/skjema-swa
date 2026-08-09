/**
 * Nøkkeladministrasjon.
 *
 *   GET  /api/nokkel/{skjematypeId}          — hent nøkkel (admin/eier). NB: eksponerer klartekst-nøkkel
 *   POST /api/nokkel/{skjematypeId}/generer  — generer ny nøkkel hvis ingen finnes
 *   POST /api/nokkel/{skjematypeId}/rekrypter — bytt nøkkel: dekrypter alle skjemaer med gammel,
 *                                              krypter med ny, oppdater lagret nøkkel. Body: { gammelNokkel }
 *
 * Auth: admin eller eier på skjematypen.
 */
const { app } = require('@azure/functions');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');
const skjemaStorage = require('../lib/skjema-storage');
const forekomstStorage = require('../lib/skjema-forekomst-storage');
const { filtrerTyperPåTilgang } = require('../lib/tilgang');
const nokkelStorage = require('../lib/nokkel-storage');
const kryptering = require('../lib/kryptering');

async function harEierTilgang(skjematypeId, upn) {
    if (erAdmin(upn)) return true;
    const st = await skjemaStorage.hentSkjematype(skjematypeId);
    if (!st) return false;
    const treff = await filtrerTyperPåTilgang([st], upn, 'Eiere');
    return treff.length > 0;
}

app.http('nokkelHent', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'nokkel/{skjematypeId}',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        try {
            const { skjematypeId } = request.params;
            if (!(await harEierTilgang(skjematypeId, upn))) {
                return { status: 403, jsonBody: { status: 'avvist', melding: 'Krever eier/admin' } };
            }
            const n = await nokkelStorage.hentNokkel(skjematypeId);
            return { jsonBody: { skjematypeId, nokkel: n || null, finnes: !!n } };
        } catch (e) {
            context.log('nokkel GET FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('nokkelGenerer', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'nokkel/{skjematypeId}/generer',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        try {
            const { skjematypeId } = request.params;
            if (!(await harEierTilgang(skjematypeId, upn))) {
                return { status: 403, jsonBody: { status: 'avvist', melding: 'Krever eier/admin' } };
            }
            const eksisterende = await nokkelStorage.hentNokkel(skjematypeId);
            if (eksisterende) {
                return { status: 409, jsonBody: { status: 'feil', melding: 'Nøkkel finnes allerede — bruk rekrypter for å bytte' } };
            }
            const ny = kryptering.genererNokkel();
            await nokkelStorage.lagreNokkel(skjematypeId, ny);
            context.log(`nokkel: ${upn} genererte ny nøkkel for skjematype ${skjematypeId}`);
            return { jsonBody: { status: 'ok', nokkel: ny } };
        } catch (e) {
            context.log('nokkel/generer FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('nokkelRekrypter', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'nokkel/{skjematypeId}/rekrypter',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        try {
            const { skjematypeId } = request.params;
            if (!(await harEierTilgang(skjematypeId, upn))) {
                return { status: 403, jsonBody: { status: 'avvist', melding: 'Krever eier/admin' } };
            }
            const body = await request.json();
            const gammelNokkel = String(body.gammelNokkel || '').trim();
            if (!gammelNokkel) {
                return { status: 400, jsonBody: { status: 'feil', melding: 'gammelNokkel mangler' } };
            }

            // Sjekk at gammelNokkel matcher lagret nøkkel — hindrer at feil nøkkel
            // gjør uopprettelig skade ved å dekryptere feil
            const lagret = await nokkelStorage.hentNokkel(skjematypeId);
            if (lagret && lagret !== gammelNokkel) {
                return { status: 400, jsonBody: { status: 'feil', melding: 'gammelNokkel matcher ikke lagret nøkkel' } };
            }

            const st = await skjemaStorage.hentSkjematype(skjematypeId);
            if (!st) return { status: 404, jsonBody: { status: 'feil', melding: 'Skjematype ikke funnet' } };
            const omfang = st?.JSON?.Krypteres || 'Nei';

            // Dekrypter alle krypterte skjemaer med gammel, krypter med ny
            const skjemaer = await forekomstStorage.hentAlleSkjemaerForType(skjematypeId, { fulltFormat: true });
            const ny = kryptering.genererNokkel();
            let antallRekryptert = 0;
            let antallFeilet = 0;
            for (const s of skjemaer) {
                try {
                    const erKryptert = s?.Kryptert === true || (typeof s?.Kryptert === 'string' && s.Kryptert.length > 0);
                    if (!erKryptert) continue;
                    const dekryptert = kryptering.dekrypterSkjema(s, gammelNokkel);
                    const rekryptert = kryptering.krypterSkjema(dekryptert, ny, omfang === 'Alt' ? 'Alt' : 'Svar');
                    // Bevar meta som ikke skal krypteres
                    if (omfang !== 'Alt') {
                        rekryptert.Innsender_Epost = s.Innsender_Epost;
                        rekryptert.Innsender_Navn = s.Innsender_Navn;
                    }
                    await forekomstStorage.lagreSkjema(rekryptert, false);
                    antallRekryptert++;
                } catch (e) {
                    context.log(`nokkel/rekrypter: feil for skjema ${s.Skjema_id}: ${e.message}`);
                    antallFeilet++;
                }
            }

            // Lagre ny nøkkel — gjør dette etter re-krypteringen så vi ikke mister
            // gammel nøkkel før alle skjemaer er konvertert
            await nokkelStorage.lagreNokkel(skjematypeId, ny);
            context.log(`nokkel: ${upn} rekrypterte ${antallRekryptert} skjemaer for type ${skjematypeId} (${antallFeilet} feil)`);
            return { jsonBody: {
                status: 'ok',
                nokkel: ny,
                antallRekryptert,
                antallFeilet
            }};
        } catch (e) {
            context.log('nokkel/rekrypter FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});
