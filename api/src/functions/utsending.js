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
 *     En prefilled-verdi kan også være en oppslags-referanse i stedet for tekst:
 *       { "1-02": { "emnebeskrivelse": "26H|CBU1503-1" } }
 *     Da lagres bare referansen, og teksten slås opp når mottakeren åpner lenka.
 *     Referansene valideres her — ukjent emne gir 400. Se lib/utsending-prefill.js.
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
const prefill = require('../lib/utsending-prefill');

function harFlytNokkel(request, context) {
    const forventet = String(process.env.FLOW_CALLBACK_KEY || '').trim();
    if (!forventet) {
        context?.log('utsending: FLOW_CALLBACK_KEY env-var er ikke satt');
        return { ok: false, årsak: 'FLOW_CALLBACK_KEY env-var er ikke satt i backend' };
    }
    const gitt = String(request.headers.get('x-flow-key') || '').trim();
    if (!gitt) return { ok: false, årsak: 'x-flow-key-header mangler eller er tom' };
    if (gitt.length !== forventet.length) {
        context?.log(`utsending: x-flow-key lengdemismatch (gitt=${gitt.length}, forventet=${forventet.length})`);
        return { ok: false, årsak: `x-flow-key har feil lengde (${gitt.length} vs forventet ${forventet.length})` };
    }
    try {
        const match = crypto.timingSafeEqual(Buffer.from(gitt), Buffer.from(forventet));
        return match ? { ok: true } : { ok: false, årsak: 'x-flow-key matcher ikke' };
    } catch (e) { return { ok: false, årsak: 'x-flow-key sammenligning feilet: ' + e.message }; }
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
        const flyt = harFlytNokkel(request, context);
        if (!flyt.ok && !(upn && erAdmin(upn))) {
            return {
                status: 401,
                jsonBody: {
                    status: 'feil',
                    melding: upn
                        ? `Krever admin eller gyldig x-flow-key. Innlogget som ${upn} (ikke admin). Flyt-nøkkel: ${flyt.årsak}`
                        : `Krever gyldig x-flow-key eller admin-innlogging. Flyt-nøkkel: ${flyt.årsak}`
                }
            };
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

            // Oppslags-referanser (f.eks. { emnebeskrivelse: "26H|CBU1503-1" })
            // valideres FØR noe skrives. En skrivefeil i emnekoden skal stoppe
            // utsendingen her, ikke gi et tomt felt hos alle mottakerne.
            const oppslagsCache = new Map();
            for (const rå of mottakere) {
                if (!rå?.prefilled || typeof rå.prefilled !== 'object') continue;
                const feil = await prefill.validerOppslag(rå.prefilled, oppslagsCache);
                if (feil.length > 0) {
                    return {
                        status: 400,
                        jsonBody: {
                            status: 'feil',
                            melding: `Ugyldig prefilled-oppslag for ${rå.mottaker || '(uten mottaker)'}: ${feil.join('; ')}`
                        }
                    };
                }
            }

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

/**
 * POST /api/utsending/for-meg
 * Auth: authenticated. Aksepterer kun oppretting av token der mottaker = innlogget bruker.
 * Brukbart for editor/gevinstoppfølging der vi trenger prefylt lenke til pålogget bruker
 * uten å kreve admin/x-flow-key.
 *
 * Body: { skjematypeId, batchId?, prefilled? }
 * Returnerer: { batchId, mottaker, url, utloper }
 */
app.http('utsendingForMeg', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'utsending/for-meg',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };

        try {
            const body = await request.json();
            const skjematypeId = String(body.skjematypeId || '').trim();
            if (!skjematypeId) return { status: 400, jsonBody: { status: 'feil', melding: 'Mangler skjematypeId' } };
            const prefilled = body?.prefilled && typeof body.prefilled === 'object' ? body.prefilled : null;
            if (prefilled) {
                const feil = await prefill.validerOppslag(prefilled);
                if (feil.length > 0) {
                    return { status: 400, jsonBody: { status: 'feil', melding: `Ugyldig prefilled-oppslag: ${feil.join('; ')}` } };
                }
            }
            // Idempotent batchId per (upn, skjematypeId, evt. custom-suffix) så vi ikke
            // fyller storage med duplikater ved gjentatte editor-loads.
            const suffix = String(body.batchId || 'for-meg').trim();
            const batchId = `${suffix}-${upn}-${skjematypeId}`.toLowerCase();
            // Idempotent: gjenbruk jti hvis raden finnes, ellers generer ny.
            // Da forblir URL stabil på tvers av editor-loads.
            const eksist = await utsendingStorage.hent(batchId, upn);
            let jti;
            if (eksist && !eksist.SvarSkjemaId) {
                jti = eksist.Jti;
                // Oppdater prefilled hvis endret
                await utsendingStorage.opprett({
                    batchId, mottaker: upn, skjematypeId, jti, prefilled,
                    kanalHint: 'epost', senderSkjemaId: '', opprettetAv: upn
                });
            } else {
                jti = crypto.randomBytes(8).toString('hex');
                await utsendingStorage.opprett({
                    batchId, mottaker: upn, skjematypeId, jti, prefilled,
                    kanalHint: 'epost', senderSkjemaId: '', opprettetAv: upn
                });
            }
            const token = utsendingToken.utsted({ batchId, mottaker: upn, skjematypeId, jti });
            const b = baseUrl(request);
            const url = `${b}/index.html?utsending=${encodeURIComponent(token)}`;
            const v = utsendingToken.valider(token);
            return { jsonBody: { status: 'ok', batchId, mottaker: upn, url, utloper: v.utloper } };
        } catch (e) {
            context.log('utsending/for-meg FEIL:', e.message);
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
                    // Referanser slås opp her, når skjemaet faktisk åpnes —
                    // se lib/utsending-prefill.js
                    prefilled: await prefill.resolverPrefilled(post.Prefilled || null, (m) => context.log(m)),
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

/**
 * POST /api/utsending/purre — kalles av scheduler (GitHub Actions cron) eller admin.
 * Auth: x-scheduler-key (SCHEDULER_KEY) eller admin.
 *
 * Går gjennom alle ubesvarte utsendinger som ikke ble purret nylig,
 * kaller PURRE_FLOW_URL (PA-flyt) med batch av mottakere, og markerer
 * hver som purret. Fire-and-forget — feiler ikke om PA er nede.
 *
 * Body (valgfritt):
 *   { batchId?: "..." }   — hvis satt: purr KUN denne batchen (manuell trigger)
 *
 * Returnerer: { antallPurret, antallHoppetOver, feil? }
 */
app.http('utsendingPurre', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'utsending/purre',
    handler: async (request, context) => {
        // Auth: scheduler-key eller admin
        const schedulerKey = request.headers.get('x-scheduler-key');
        const configuredKey = String(process.env.SCHEDULER_KEY || '').trim();
        const upn = hentInnloggetUpn(request);
        const schedulerOk = configuredKey && schedulerKey && schedulerKey === configuredKey;
        if (!schedulerOk && !(upn && erAdmin(upn))) {
            return { status: 401, jsonBody: { status: 'feil', melding: 'Krever x-scheduler-key eller admin' } };
        }

        try {
            const body = await request.json().catch(() => ({}));
            const batchFilter = String(body?.batchId || '').trim();
            const maksDager = Number(process.env.PURRE_MAKS_DAGER || 14);
            const minDagerMellom = Number(process.env.PURRE_MIN_DAGER_MELLOM || 3);

            let kandidater = await utsendingStorage.listUbesvarte({
                maksDagerSidenOpprettet: maksDager,
                minDagerSidenPurring: minDagerMellom
            });
            if (batchFilter) kandidater = kandidater.filter(k => k.BatchId === batchFilter);

            if (kandidater.length === 0) {
                return { jsonBody: { status: 'ok', antallPurret: 0, antallHoppetOver: 0, melding: 'Ingen kandidater å purre' } };
            }

            const purreFlyt = String(process.env.PURRE_FLOW_URL || '').trim();
            const b = baseUrl(request);
            const nå = Date.now();

            // Bygg mottakere-liste med regenerert token (bevarer jti — samme identitet, ny exp)
            const mottakere = kandidater.map(k => {
                const token = utsendingToken.utsted({
                    batchId: k.BatchId, mottaker: k.Mottaker, skjematypeId: k.SkjematypeId, jti: k.Jti
                });
                const dagerSiden = Math.floor((nå - new Date(k.Opprettet).getTime()) / (24 * 3600 * 1000));
                return {
                    mottaker: k.Mottaker,
                    url: `${b}/index.html?utsending=${encodeURIComponent(token)}`,
                    batchId: k.BatchId,
                    skjematypeId: k.SkjematypeId,
                    kanal: k.KanalHint || 'epost',
                    dagerSiden
                };
            });

            let antallPurret = 0, feil = null;
            if (!purreFlyt) {
                context.log('utsending/purre: PURRE_FLOW_URL ikke satt — markerer likevel som purret (dry-run)');
            } else {
                try {
                    const res = await fetch(purreFlyt, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ handling: 'purreUtsendinger', mottakere })
                    });
                    if (!res.ok) {
                        feil = `PA-flyt returnerte ${res.status}`;
                        context.log(`utsending/purre: ${feil}`);
                    }
                } catch (e) {
                    feil = `PA-flyt-kall feilet: ${e.message}`;
                    context.log(`utsending/purre: ${feil}`);
                }
            }

            // Marker alle som purret (også hvis PA feilet — så vi ikke spammer neste kjøring)
            for (const k of kandidater) {
                try {
                    await utsendingStorage.markerPurret(k.BatchId, k.Mottaker);
                    antallPurret++;
                } catch (e) {
                    context.log(`utsending/purre: markerPurret feilet for ${k.BatchId}/${k.Mottaker}: ${e.message}`);
                }
            }

            hendelser.logg({
                Type: 'utsending.purre', Aktor: upn || 'scheduler',
                ObjektType: 'utsending', ObjektId: batchFilter || '(alle)',
                Melding: `Purret ${antallPurret} ubesvarte utsending${antallPurret === 1 ? '' : 'er'}${feil ? ' (PA-flyt feilet: ' + feil + ')' : ''}`,
                Detaljer: { antallPurret, batchFilter, feil, maksDager, minDagerMellom }
            });

            return {
                jsonBody: {
                    status: 'ok', antallPurret, antallHoppetOver: 0, feil,
                    melding: purreFlyt ? undefined : 'PURRE_FLOW_URL ikke satt — dry-run (markert som purret men ingen e-post sendt)'
                }
            };
        } catch (e) {
            context.log('utsending/purre FEIL:', e.message, e.stack);
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
