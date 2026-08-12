/**
 * Utsending — mass-utsending av utfyllings-lenker fra PA-flyt.
 *
 *   POST /api/utsending
 *     Auth: x-flow-key (FLOW_CALLBACK_KEY) — kalles fra PA-flyt som behandlingssteg,
 *           eller autentisert admin.
 *     Body: {
 *       skjematypeId: "42",
 *       batchId: "SKJ-2026-011" | "custom-id",   // gruppe-nøkkel for status/purring
 *       senderSkjemaId?: "SKJ-2026-011",         // sporing: skjemaet som utløste utsendingen
 *       kanalHint?: "epost" | "sms",
 *       mottakere: [
 *         { mottaker: "nn@mil.no", prefilled?: { "1-01": ["Verdi"], "2-03": ["4"] } },
 *         ...
 *       ]
 *     }
 *     Returnerer: { batchId, lenker: [{ mottaker, url, utloper }] }
 *
 *   GET /api/utsending/valider?t=TOKEN
 *     Anonymt. Verifiserer HMAC + slår opp i Utsendinger.
 *     Returnerer: { skjematypeId, mottaker, prefilled, alleredeBesvart, svarSkjemaId? }
 *
 *   GET /api/utsending/batch/{batchId}
 *     Admin. Viser status per mottaker (opprettet/besvart/sist-purret).
 */
const { app } = require('@azure/functions');
const crypto = require('crypto');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');
const utsendingStorage = require('../lib/utsending-storage');
const utsendingToken = require('../lib/utsending-token');
const hendelser = require('../lib/hendelser-storage');
const skjemaStorage = require('../lib/skjema-storage');
const { hentOgSettFasteData } = require('../lib/faste-data');
const { hentDropdownVerdier } = require('../lib/oppslag');

function harFlytNokkel(request) {
    const forventet = process.env.FLOW_CALLBACK_KEY;
    if (!forventet) return false;
    const gitt = request.headers.get('x-flow-key') || '';
    if (!gitt || gitt.length !== forventet.length) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(gitt), Buffer.from(forventet));
    } catch (_) { return false; }
}

function baseUrl(request) {
    if (process.env.SWA_URL) return String(process.env.SWA_URL).replace(/\/$/, '');
    // Fallback: rekonstruér fra request
    const proto = request.headers.get('x-forwarded-proto') || 'https';
    const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || '';
    return `${proto}://${host}`;
}

app.http('utsendingOpprett', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'utsending',
    handler: async (request, context) => {
        // Auth: enten flyt-nøkkel eller admin
        const upn = hentInnloggetUpn(request);
        const flytOk = harFlytNokkel(request);
        if (!flytOk && !(upn && erAdmin(upn))) {
            return { status: 401, jsonBody: { status: 'feil', melding: 'Krever x-flow-key eller admin-innlogging' } };
        }

        try {
            const body = await request.json();
            const skjematypeId = String(body.skjematypeId || '').trim();
            const batchId = String(body.batchId || '').trim() || `batch-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
            const senderSkjemaId = String(body.senderSkjemaId || '').trim();
            const kanalHint = String(body.kanalHint || 'epost').trim();
            const mottakere = Array.isArray(body.mottakere) ? body.mottakere : [];
            const opprettetAv = upn || 'flyt';

            if (!skjematypeId) return { status: 400, jsonBody: { status: 'feil', melding: 'Mangler skjematypeId' } };
            if (mottakere.length === 0) return { status: 400, jsonBody: { status: 'feil', melding: 'Mangler mottakere' } };
            if (mottakere.length > 500) return { status: 400, jsonBody: { status: 'feil', melding: 'Maks 500 mottakere per batch' } };

            const b = baseUrl(request);
            const lenker = [];

            for (const rå of mottakere) {
                const mottaker = String(rå?.mottaker || '').trim().toLowerCase();
                if (!mottaker) continue;
                const prefilled = rå?.prefilled && typeof rå.prefilled === 'object' ? rå.prefilled : null;
                const jti = crypto.randomBytes(8).toString('hex');
                const token = utsendingToken.utsted({ batchId, mottaker, skjematypeId, jti });
                await utsendingStorage.opprett({
                    batchId, mottaker, skjematypeId, jti, prefilled,
                    kanalHint, senderSkjemaId, opprettetAv
                });
                lenker.push({
                    mottaker,
                    url: `${b}/index.html?utsending=${encodeURIComponent(token)}`,
                    utloper: utsendingToken.valider(token).utloper
                });
            }

            hendelser.logg({
                Type: 'utsending.opprett', Aktor: opprettetAv,
                ObjektType: 'utsending', ObjektId: batchId,
                Melding: `Opprettet ${lenker.length} utsendings-lenker for skjematype ${skjematypeId}`,
                Detaljer: { batchId, skjematypeId, antall: lenker.length, kanalHint, senderSkjemaId }
            });

            return { jsonBody: { status: 'ok', batchId, lenker } };
        } catch (e) {
            context.log('utsending POST FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('utsendingValider', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'utsending/valider',
    handler: async (request, context) => {
        try {
            const url = new URL(request.url);
            const token = url.searchParams.get('t') || '';
            const v = utsendingToken.valider(token);
            if (!v.gyldig) return { status: 401, jsonBody: { status: 'feil', melding: v.melding } };

            const post = await utsendingStorage.hent(v.batchId, v.mottaker);
            if (!post) return { status: 404, jsonBody: { status: 'feil', melding: 'Utsending ikke funnet' } };
            if (post.Jti !== v.jti) return { status: 401, jsonBody: { status: 'feil', melding: 'Token matcher ikke lagret jti (kan være erstattet)' } };

            // Beriker med skjematype (samme berikning som publikum-endepunktet)
            // så frontend slipper ekstra kall og trenger ikke EksternTilgang=true.
            let skjematype = null;
            try {
                const st = await skjemaStorage.hentSkjematype(post.SkjematypeId);
                if (st?.JSON) {
                    skjematype = await hentOgSettFasteData(
                        st.JSON,
                        (dk, fb, fo, fv) => hentDropdownVerdier(dk, fb, fo, fv, (m) => context.log('oppslag: ' + m)),
                        null,
                        (m) => context.log('faste-data: ' + m)
                    );
                }
            } catch (e) {
                context.log('utsending/valider: kunne ikke hente skjematype — ' + e.message);
            }

            return {
                jsonBody: {
                    status: 'ok',
                    skjematypeId: post.SkjematypeId,
                    mottaker: post.Mottaker,
                    prefilled: post.Prefilled || null,
                    alleredeBesvart: !!post.SvarSkjemaId,
                    svarSkjemaId: post.SvarSkjemaId || null,
                    utloper: v.utloper,
                    skjematype
                }
            };
        } catch (e) {
            context.log('utsending/valider FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('utsendingBatchStatus', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'utsending/batch/{batchId}',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        if (!erAdmin(upn)) return { status: 403, jsonBody: { status: 'feil', melding: 'Krever admin' } };

        try {
            const batchId = request.params.batchId;
            const rader = await utsendingStorage.listBatch(batchId);
            const antall = rader.length;
            const besvart = rader.filter(r => r.SvarSkjemaId).length;
            return {
                jsonBody: {
                    status: 'ok',
                    batchId,
                    antall,
                    besvart,
                    ubesvart: antall - besvart,
                    rader
                }
            };
        } catch (e) {
            context.log('utsending/batch FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});
