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
 *       purretekst?: "...",                      // følger batchen til purre-flyten
 *       utsendingsdato?: "2026-09-01",           // appen sender denne dagen
 *       purredato?: "2026-09-08",                // én purring denne dagen
 *       avslutningsdato?: "2026-09-15",          // lenka stenges etter denne
 *       mottakere: [
 *         { mottaker: "nn@mil.no", prefilled?: { "1-01": ["Verdi"], "2-03": ["4"] } },
 *         ...
 *       ]
 *     }
 *     En prefilled-verdi kan også være en oppslags-referanse i stedet for tekst:
 *       { "1-02": { "emnebeskrivelse": "26H|CBU1503-1" } }
 *     Da lagres bare referansen, og teksten slås opp når mottakeren åpner lenka.
 *     Referansene valideres her — ukjent emne gir 400. Se lib/utsending-prefill.js.
 *     Returnerer: { batchId, lenker: [{ mottaker, url, utloper }], sendesAvAppen, planlagt }
 *
 *     Datoene er valgfrie, og uten dem oppfører batchen seg som før: kalleren
 *     sender selv, purringen følger PURRE_*-tersklene, og lenka lever til
 *     tokenet utløper. Settes `utsendingsdato`, tar cron-jobben over
 *     sendingen — da skal ikke kalleren sende i tillegg.
 *
 *   POST /api/utsending/send-forfalte
 *     Auth: x-scheduler-key eller admin. Sender lenker med forfalt
 *     utsendingsdato. Se handleren nederst.
 *
 *   POST /api/utsending/purre
 *     Auth: x-scheduler-key eller admin. Purrer ubesvarte lenker.
 *
 *     Begge kaller samme flyt med samme payload, og skiller seg bare på
 *     `handling` ('sendUtsendinger' / 'purreUtsendinger'). Normaloppsettet er
 *     ÉN PA-flyt som forgrener på det feltet — sett UTSENDING_FLOW_URL og la
 *     PURRE_FLOW_URL stå tom. Se kallUtsendingsflyt().
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

// Skjemaforklaringen er skrevet for skjemasida og kan være lang. I en purring
// trengs bare nok til å kjenne igjen skjemaet, og teksten sendes per mottaker.
const BESKRIVELSE_MAKS = 1000;

function baseUrl(request) {
    if (process.env.SWA_URL) return String(process.env.SWA_URL).replace(/\/$/, '');
    // Fallback: rekonstruér fra request
    const proto = request.headers.get('x-forwarded-proto') || 'https';
    const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || '';
    return `${proto}://${host}`;
}

/**
 * Bygg mottakerlista som sendes til en PA-flyt — både ved førstegangs utsending
 * og ved purring.
 *
 * En kjøring kan spenne over flere skjematyper, og mottakeren har bare en lenke
 * å gå etter. Navnet må derfor følge med, ellers kan ikke flyten skrive hva
 * meldingen gjelder. Slås opp én gang per skjematype — en batch på 500
 * mottakere er typisk 1-2 typer.
 *
 * Tokenet utstedes på nytt med samme jti: samme identitet, ny utløpstid. Lenka
 * i en purring er derfor alltid fersk, selv om batchen er gammel.
 */
async function byggUtsendingsposter(kandidater, basisUrl, context, navn, { tekstOverstyring = '' } = {}) {
    const typeCache = new Map();
    for (const id of new Set(kandidater.map(k => String(k.SkjematypeId)))) {
        let info = { navn: '', beskrivelse: '', format: 'Tekst' };
        try {
            const type = await skjemaStorage.hentSkjematype(id);
            if (type) {
                // Skjemaforklaring er normalt { Innhold, Format }, men eldre
                // definisjoner har den som ren streng.
                const forklaring = type.JSON?.Skjemaforklaring || null;
                const erTekst = typeof forklaring === 'string';
                info = {
                    navn: type.navn || '',
                    beskrivelse: String(erTekst ? forklaring : (forklaring?.Innhold || '')).slice(0, BESKRIVELSE_MAKS),
                    format: (erTekst ? 'Tekst' : forklaring?.Format) || 'Tekst'
                };
            } else {
                context.log(`${navn}: fant ikke skjematype ${id} — sender uten navn`);
            }
        } catch (e) {
            // Et navn er ikke verdt å avlyse hele kjøringen for.
            context.log(`${navn}: oppslag av skjematype ${id} feilet (${e.message}) — sender uten navn`);
        }
        typeCache.set(id, info);
    }

    const nå = Date.now();
    return kandidater.map(k => {
        const type = typeCache.get(String(k.SkjematypeId)) || { navn: '', beskrivelse: '', format: 'Tekst' };
        const token = utsendingToken.utsted({
            batchId: k.BatchId, mottaker: k.Mottaker, skjematypeId: k.SkjematypeId, jti: k.Jti
        });
        const referanse = k.Sendt || k.Utsendingsdato || k.Opprettet;
        return {
            mottaker: k.Mottaker,
            url: `${basisUrl}/index.html?utsending=${encodeURIComponent(token)}`,
            batchId: k.BatchId,
            skjematypeId: k.SkjematypeId,
            skjemanavn: type.navn,
            skjemabeskrivelse: type.beskrivelse,
            skjemabeskrivelseFormat: type.format,
            purretekst: tekstOverstyring || k.Purretekst || '',
            avslutningsdato: k.Avslutningsdato || '',
            kanal: k.KanalHint || 'epost',
            dagerSiden: Math.floor((nå - new Date(referanse).getTime()) / (24 * 3600 * 1000))
        };
    });
}

/**
 * Kall flyten som sender ut lenker — første gang eller som purring.
 *
 * De to kjøringene sender samme payload og skiller seg bare på `handling`, så
 * normaloppsettet er ÉN flyt som forgrener på det feltet og velger ordlyd
 * deretter. Da holder det å sette én env-var; den andre kan stå tom.
 *
 *   UTSENDING_FLOW_URL — flyten for begge handlinger
 *   PURRE_FLOW_URL     — valgfri: egen flyt for purring, hvis du heller vil
 *                        holde de to adskilt
 *
 * Mangler den ene, brukes den andre. Flyten må uansett se på `handling`:
 * får den 'sendUtsendinger' og svarer med purretekst, er meldingen feil.
 *
 * Kallet har en tidsgrense godt under SWA-gatewayens ~45 sekunder. Uten den
 * ville en treg flyt kvele hele cron-kjøringen, og feilen kommet som en naken
 * 502 uten spor i loggen.
 */
const FLYT_TIMEOUT_MS = 35000;

function flytUrlFor(handling) {
    const utsending = String(process.env.UTSENDING_FLOW_URL || '').trim();
    const purre = String(process.env.PURRE_FLOW_URL || '').trim();
    return handling === 'purreUtsendinger' ? (purre || utsending) : (utsending || purre);
}

async function kallUtsendingsflyt(handling, mottakere, context, navn) {
    const url = flytUrlFor(handling);
    if (!url) return { ok: false, mangler: true, feil: 'Verken UTSENDING_FLOW_URL eller PURRE_FLOW_URL er satt' };

    const start = Date.now();
    let vertsnavn = 'ugyldig-url';
    try { vertsnavn = new URL(url).hostname; } catch (_) { /* logges som ugyldig */ }

    const avbryt = new AbortController();
    const timer = setTimeout(() => avbryt.abort(), FLYT_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ handling, mottakere }),
            signal: avbryt.signal
        });
        const ms = Date.now() - start;
        if (!res.ok) {
            const tekst = await res.text().catch(() => '');
            return { ok: false, feil: `PA-flyt (${vertsnavn}) svarte HTTP ${res.status} etter ${ms} ms: ${tekst.slice(0, 300)}` };
        }
        context.log(`${navn}: PA-flyt (${vertsnavn}) tok imot ${mottakere.length} mottakere på ${ms} ms (handling=${handling})`);
        return { ok: true, ms };
    } catch (e) {
        const ms = Date.now() - start;
        return {
            ok: false,
            feil: e.name === 'AbortError'
                ? `PA-flyt (${vertsnavn}) svarte ikke innen ${FLYT_TIMEOUT_MS / 1000} sekunder`
                : `PA-flyt-kall mot ${vertsnavn} feilet etter ${ms} ms: ${e.message}`
        };
    } finally {
        clearTimeout(timer);
    }
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
            const purretekst = String(body.purretekst || '').trim();
            const mottakere = Array.isArray(body.mottakere) ? body.mottakere : [];
            const opprettetAv = upn || 'flyt';

            if (!skjematypeId) return { status: 400, jsonBody: { status: 'feil', melding: 'Mangler skjematypeId' } };
            if (mottakere.length === 0) return { status: 400, jsonBody: { status: 'feil', melding: 'Mangler mottakere' } };
            if (mottakere.length > 500) return { status: 400, jsonBody: { status: 'feil', melding: 'Maks 500 mottakere per batch' } };

            // Datoene styrer når lenka går ut, når det purres og når den
            // stenges. En skrivefeil her ville ellers blitt lagret som «ingen
            // dato», og batchen ville oppført seg som om planen aldri fantes.
            const datoer = {};
            for (const [navn, slutten] of [['utsendingsdato', false], ['purredato', false], ['avslutningsdato', true]]) {
                const normalisert = utsendingStorage.normaliserDato(body[navn], { slutten });
                if (normalisert === null) {
                    return { status: 400, jsonBody: { status: 'feil', melding: `${navn} "${body[navn]}" er ikke en gyldig dato. Bruk "2026-09-01" eller full ISO-tid.` } };
                }
                datoer[navn] = normalisert;
            }
            if (datoer.avslutningsdato && datoer.utsendingsdato && datoer.avslutningsdato < datoer.utsendingsdato) {
                return { status: 400, jsonBody: { status: 'feil', melding: 'avslutningsdato er før utsendingsdato — lenka ville vært stengt før den ble sendt' } };
            }
            if (datoer.avslutningsdato && datoer.purredato && datoer.avslutningsdato < datoer.purredato) {
                return { status: 400, jsonBody: { status: 'feil', melding: 'avslutningsdato er før purredato — purringen ville aldri gått ut' } };
            }
            if (datoer.purredato && datoer.utsendingsdato && datoer.purredato < datoer.utsendingsdato) {
                return { status: 400, jsonBody: { status: 'feil', melding: 'purredato er før utsendingsdato — det ville blitt purret før lenka gikk ut' } };
            }

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

            // En mottaker uten brukbart `mottaker`-felt ble tidligere hoppet
            // stille over, og kalleren fikk 200 med tom lenke-liste. Den
            // vanligste årsaken er at lista er pakket i en ekstra array —
            // lett å få til i Power Automate, og umulig å se på svaret.
            const avviste = [];
            for (const [i, rå] of mottakere.entries()) {
                if (Array.isArray(rå)) {
                    avviste.push(`mottakere[${i}] er en liste, ikke et objekt — er mottakerlista pakket i en ekstra array?`);
                    continue;
                }
                if (!rå || typeof rå !== 'object') {
                    avviste.push(`mottakere[${i}] er ${rå === null ? 'null' : typeof rå}, forventet objekt med { mottaker }`);
                    continue;
                }
                if (!String(rå.mottaker || '').trim()) {
                    avviste.push(`mottakere[${i}] mangler feltet "mottaker"`);
                    continue;
                }
            }
            if (avviste.length > 0) {
                return {
                    status: 400,
                    jsonBody: {
                        status: 'feil',
                        melding: `Ingen lenker opprettet — ${avviste.length} av ${mottakere.length} mottakere er ugyldige`,
                        avviste: avviste.slice(0, 20)
                    }
                };
            }

            for (const rå of mottakere) {
                const mottaker = String(rå?.mottaker || '').trim().toLowerCase();
                if (!mottaker) continue;
                const prefilled = rå?.prefilled && typeof rå.prefilled === 'object' ? rå.prefilled : null;
                const jti = crypto.randomBytes(8).toString('hex');
                const token = utsendingToken.utsted({ batchId, mottaker, skjematypeId, jti });
                await utsendingStorage.opprett({
                    batchId, mottaker, skjematypeId, jti, prefilled,
                    kanalHint, senderSkjemaId, opprettetAv, purretekst,
                    ...datoer
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

            // sendesAvAppen sier hvem som har ansvaret for å få lenka ut.
            // Er utsendingsdato satt, gjør cron-jobben det — da skal ikke
            // kalleren sende i tillegg, ellers får mottakeren to e-poster.
            return {
                jsonBody: {
                    status: 'ok', batchId, lenker,
                    sendesAvAppen: !!datoer.utsendingsdato,
                    planlagt: {
                        utsendingsdato: datoer.utsendingsdato || null,
                        purredato: datoer.purredato || null,
                        avslutningsdato: datoer.avslutningsdato || null
                    }
                }
            };
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

            // Fristen er ute. 410 Gone framfor 401 — lenka var gyldig, den
            // gjelder bare ikke lenger, og frontend skal vise fristen.
            if (utsendingStorage.erAvsluttet(post)) {
                return {
                    status: 410,
                    jsonBody: {
                        status: 'feil', avsluttet: true,
                        avslutningsdato: post.Avslutningsdato,
                        melding: 'Fristen for å svare på dette skjemaet er ute'
                    }
                };
            }

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
 * Går gjennom alle ubesvarte utsendinger som ikke ble purret nylig, kaller
 * flyten med batch av mottakere, og markerer hver som purret. Fire-and-forget
 * — feiler ikke om PA er nede, og markerer likevel, så vi ikke purrer på nytt
 * dagen etter.
 *
 * Body (valgfritt):
 *   { batchId?: "...",      // hvis satt: purr KUN denne batchen (manuell trigger)
 *     purretekst?: "..." }  // overstyrer teksten batchen ble opprettet med
 *
 * Payload til PA-flyten — ett kall per kjøring, flyten løkker selv:
 *   {
 *     handling: 'purreUtsendinger',
 *     mottakere: [{
 *       mottaker, url, batchId, skjematypeId,
 *       skjemanavn,                 // slått opp nå, ikke frosset ved utsending
 *       skjemabeskrivelse,          // Skjemaforklaring, kuttet ved 1000 tegn
 *       skjemabeskrivelseFormat,    // "Tekst" | "HTML"
 *       purretekst,                 // '' hvis ingen er satt
 *       avslutningsdato,            // '' hvis batchen ikke har frist
 *       kanal, dagerSiden
 *     }]
 *   }
 *
 * Utsendingsjobben sender nøyaktig samme form, bare med
 * handling: 'sendUtsendinger'.
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
            // Overstyrer batchens egen purretekst — nyttig sammen med batchId
            // når én bestemt gruppe skal purres med en annen ordlyd.
            const tekstOverstyring = String(body?.purretekst || '').trim().slice(0, BESKRIVELSE_MAKS);
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

            const mottakere = await byggUtsendingsposter(kandidater, baseUrl(request), context, 'utsending/purre', {
                tekstOverstyring
            });

            const res = await kallUtsendingsflyt('purreUtsendinger', mottakere, context, 'utsending/purre');
            let antallPurret = 0;
            const feil = res.ok ? null : res.feil;
            if (feil) context.log(`utsending/purre: ${feil}`);

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
                    melding: res.mangler ? 'Ingen flyt-URL satt — dry-run (markert som purret, men ingen e-post sendt)' : undefined
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

/**
 * POST /api/utsending/send-forfalte — kalles av scheduler (GitHub Actions cron)
 * eller admin. Auth: x-scheduler-key (SCHEDULER_KEY) eller admin.
 *
 * Sender ut lenker for batcher der utsendingsdatoen er passert, og markerer
 * dem som sendt. Speiler purre-jobben, med én viktig forskjell: purringen
 * markerer som purret selv om flyten feiler, for å slippe å spamme dagen
 * etter. Her ville det samme betydd at mottakeren aldri fikk lenka. Derfor
 * settes Sendt bare når flyten faktisk tok imot kallet — feiler den, prøves
 * de samme radene på nytt neste døgn.
 *
 * Payload til UTSENDING_FLOW_URL:
 *   { handling: 'sendUtsendinger', mottakere: [ ...samme form som purringen ] }
 *
 * Returnerer: { antallSendt, antallKandidater, feil? }
 */
app.http('utsendingSendForfalte', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'utsending/send-forfalte',
    handler: async (request, context) => {
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

            let kandidater = await utsendingStorage.listForfalteUtsendinger();
            if (batchFilter) kandidater = kandidater.filter(k => k.BatchId === batchFilter);
            if (kandidater.length === 0) {
                return { jsonBody: { status: 'ok', antallSendt: 0, antallKandidater: 0, melding: 'Ingen forfalte utsendinger' } };
            }

            const mottakere = await byggUtsendingsposter(
                kandidater, baseUrl(request), context, 'utsending/send-forfalte'
            );

            // Ingen dry-run her: markerer vi som sendt uten å sende, får
            // mottakeren aldri lenka, og ingenting plukker den opp igjen.
            const res = await kallUtsendingsflyt('sendUtsendinger', mottakere, context, 'utsending/send-forfalte');
            const feil = res.ok ? null : res.feil;

            if (res.mangler) {
                const melding = `${res.feil} — ${kandidater.length} forfalte utsendinger venter`;
                context.log(`utsending/send-forfalte: ${melding}`);
                return { status: 503, jsonBody: { status: 'feil', antallSendt: 0, antallKandidater: kandidater.length, melding } };
            }

            if (feil) {
                context.log(`utsending/send-forfalte: ${feil} — ingen markert som sendt, prøves igjen neste kjøring`);
                hendelser.logg({
                    Type: 'utsending.send-forfalte', Aktor: upn || 'scheduler',
                    ObjektType: 'utsending', ObjektId: batchFilter || '(alle)',
                    Melding: `Utsending av ${kandidater.length} lenker feilet: ${feil}`,
                    Detaljer: { antallKandidater: kandidater.length, feil }
                });
                return { status: 502, jsonBody: { status: 'feil', antallSendt: 0, antallKandidater: kandidater.length, feil } };
            }

            let antallSendt = 0;
            for (const k of kandidater) {
                try {
                    await utsendingStorage.markerSendt(k.BatchId, k.Mottaker);
                    antallSendt++;
                } catch (e) {
                    context.log(`utsending/send-forfalte: markerSendt feilet for ${k.BatchId}/${k.Mottaker}: ${e.message}`);
                }
            }

            hendelser.logg({
                Type: 'utsending.send-forfalte', Aktor: upn || 'scheduler',
                ObjektType: 'utsending', ObjektId: batchFilter || '(alle)',
                Melding: `Sendte ${antallSendt} planlagte utsending${antallSendt === 1 ? '' : 'er'}`,
                Detaljer: { antallSendt, antallKandidater: kandidater.length, batchFilter }
            });

            return { jsonBody: { status: 'ok', antallSendt, antallKandidater: kandidater.length } };
        } catch (e) {
            context.log('utsending/send-forfalte FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});
