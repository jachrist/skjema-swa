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
 *     Begge kaller varslingsflyten med samme payload, og skiller seg bare på
 *     `handling` ('sendUtsendinger' / 'purreUtsendinger'). Flyten må forgrene
 *     på det feltet. Se kallUtsendingsflyt().
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
const { hentInnloggetUpn, erAdmin, harFlytNokkel } = require('../lib/auth');
const utsendingStorage = require('../lib/utsending-storage');
const utsendingToken = require('../lib/utsending-token');
const hendelser = require('../lib/hendelser-storage');
const skjemaStorage = require('../lib/skjema-storage');
const { hentOgSettFasteData } = require('../lib/faste-data');
const { hentDropdownVerdier } = require('../lib/oppslag');
const prefill = require('../lib/utsending-prefill');

// Mottakerbyggingen, flyt-kallet og `baseUrl` lå her til 17.10.2026. De bor
// nå i `lib/utsending-jobb.js`, sammen med de to døgnjobbene som bruker dem —
// en lib kan ikke importere fra `functions/`, og `baseUrl` måtte dessuten få
// en HARD SPERRE for timer-veien: uten `SWA_URL` og uten en request finnes
// ingen adresse, og e-posten ville båret døde lenker til ekte mottakere.
const {
    baseUrl, kjorSendForfalte, kjorPurring, BESKRIVELSE_MAKS
} = require('../lib/utsending-jobb');
const { stotterTimere } = require('../lib/plattform');
const { jobbForId, jobbSchedule, meldTimer } = require('../lib/jobber');

app.http('utsendingOpprett', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'utsending',
    handler: async (request, context) => {
        // Auth: enten flyt-nøkkel eller admin.
        //
        // Flyt-nøkkelen ble stengt 14.09.2026, i den tro at ingen flyt kalte
        // endepunktet — frontend har ingen kaller, og kjøreloggen for
        // varslingsflyten viste bare cron-jobben. Det var å lese feil logg:
        // gevinst-batchene (`gevinst-…-<skjematypeId>`) opprettes av en flyt,
        // og har `OpprettetAv: 'flyt'` på hver rad i Utsendinger. Stengingen
        // ble reversert samme dag.
        //
        // Vil noen stenge den igjen: sjekk
        // `GET /api/hendelser?type=utsending.opprett` og se på Aktor. Står det
        // `flyt` der, er endepunktet i bruk — og utfallet av å ta feil er at
        // utsendinger slutter å bli opprettet, uten at noe sier fra.
        const upn = hentInnloggetUpn(request);
        const flyt = harFlytNokkel(request);
        if (!flyt.ok && !(upn && erAdmin(upn))) {
            // Manglende nøkkel på serveren er en driftsfeil, ikke et avvist
            // kall — den må være synlig i loggen. Resten av årsakene gjelder
            // kalleren og går bare i svaret.
            if (!String(process.env.FLOW_CALLBACK_KEY || '').trim()) {
                context.log('utsending: FLOW_CALLBACK_KEY env-var er ikke satt');
            }
            return {
                status: 401,
                jsonBody: {
                    status: 'feil',
                    melding: upn
                        ? `Krever admin eller gyldig x-flow-key. Innlogget som ${upn} (ikke admin). Flyt-nøkkel: ${flyt.grunn}`
                        : `Krever gyldig x-flow-key eller admin-innlogging. Flyt-nøkkel: ${flyt.grunn}`
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

            // Skjematypen må tillate ekstern innsending. Lenka vi utsteder gir
            // tilgang uten Entra-pålogging, og det er et valg eieren av
            // skjematypen skal ha tatt bevisst.
            //
            // Sjekken ligger her og ikke ved utsendingen: her er det én
            // skjematype å ta stilling til, og svaret gjelder hele batchen.
            // Ved utsendingen ville hver mottaker måttet klassifiseres som
            // intern eller ekstern — et spørsmål uten et ærlig svar.
            //
            // «for-meg» er ikke omfattet: der utsteder en innlogget bruker en
            // lenke til seg selv, og har allerede tilgangen lenka gir.
            const st = await skjemaStorage.hentSkjematype(skjematypeId);
            const eksternOk = utsendingStorage.sjekkEksternUtsending(st?.JSON);
            if (!eksternOk.ok) {
                return { status: 400, jsonBody: { status: 'feil', melding: eksternOk.melding } };
            }

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
 * flyten med batch av mottakere, og markerer hver som purret. Ruta VENTER på
 * jobben (den har alltid gjort det), men en feil i PA feiler den ikke:
 * mottakerne markeres likevel, så vi ikke purrer på nytt dagen etter.
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

        const body = await request.json().catch(() => ({}));
        const batchFilter = String(body?.batchId || '').trim();
        // Overstyrer batchens egen purretekst — nyttig sammen med batchId
        // når én bestemt gruppe skal purres med en annen ordlyd.
        const tekstOverstyring = String(body?.purretekst || '').trim().slice(0, BESKRIVELSE_MAKS);

        // Bokføringen bor i jobbmodulen, slik at timeren i dev og denne veien
        // gir admin-panelet SAMME bilde av samme kjøring.
        const res = await kjorPurring({
            kilde: upn || 'scheduler', batchFilter, tekstOverstyring, request,
            log: (m) => context.log(m)
        });

        // Utfall → HTTP-status, ett sted. 502 når kallet aldri nådde fram er
        // ikke kosmetikk: cron-jobben blir rød, og en purring som ikke ble
        // sendt skal ikke se ut som en vellykket kjøring.
        const { utfall, ...kropp } = res;
        // Bryteren står: 200, men ikke «ok» — panelet og cron-loggen skal se
        // at ingenting gikk ut.
        if (utfall === 'deaktivert') return { jsonBody: { status: 'deaktivert', ...kropp } };
        if (utfall === 'kom-ikke-fram') return { status: 502, jsonBody: { status: 'feil', ...kropp } };
        if (utfall === 'feil') return { status: 500, jsonBody: { status: 'feil', ...kropp } };
        return { jsonBody: { status: 'ok', ...kropp } };
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
 * dem som sendt. Speiler purre-jobben, med én forskjell: purringen markerer
 * som purret også når flyten kom fram og så feilet, for å slippe å spamme
 * dagen etter. Her ville det samme betydd at mottakeren aldri fikk lenka.
 * Derfor settes Sendt bare når flyten faktisk tok imot kallet — feiler den,
 * prøves de samme radene på nytt neste døgn.
 *
 * Nådde kallet ALDRI fram, markerer ingen av dem noe. Se lib/flyt-utfall.js.
 *
 * Payload til VARSLING_FLOW_URL:
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

        const body = await request.json().catch(() => ({}));
        const batchFilter = String(body?.batchId || '').trim();

        const res = await kjorSendForfalte({
            kilde: upn || 'scheduler', batchFilter, request, log: (m) => context.log(m)
        });

        // Samme kart som purringen, med én ekstra: 503 når flyt-adressen
        // mangler. Den skiller «vi klarte ikke å sende» fra «vi er ikke satt
        // opp til å sende», og de to krever ulik handling.
        const { utfall, ...kropp } = res;
        if (utfall === 'deaktivert') return { jsonBody: { status: 'deaktivert', ...kropp } };
        if (utfall === 'mangler-flyt') return { status: 503, jsonBody: { status: 'feil', ...kropp } };
        if (utfall === 'flyt-feilet') return { status: 502, jsonBody: { status: 'feil', ...kropp } };
        if (utfall === 'feil') return { status: 500, jsonBody: { status: 'feil', ...kropp } };
        return { jsonBody: { status: 'ok', ...kropp } };
    }
});

// ==================== TIMER-TRIGGERE (steg 5) ====================
//
// To jobber, to registreringer, samme vakt som alle de andre. Tidspunktene
// står i lib/jobber.js, og testen krever at de er cron-ene i
// send-utsendinger.yml og purre-utsendinger.yml med et sekundfelt foran.
//
// **DISSE SENDER TIL EKSTERNE MOTTAKERE**, og timeren har ingen request. Uten
// `SWA_URL` kaster `baseUrl()` FØR noe sendes — se sperren i
// lib/utsending-jobb.js. Utfallet blir da «feil» med årsaken i statusraden,
// og ingen e-post med døde lenker går ut.
if (stotterTimere()) {
    const sendJobb = jobbForId('send-utsendinger');
    const sendValgt = jobbSchedule(sendJobb);
    if (sendValgt.avvist) console.warn(`send-utsendinger-timer: avviste «${sendValgt.avvist}» — ${sendValgt.grunn}`);
    else if (sendValgt.kilde !== 'standard') console.log(`send-utsendinger-timer: schedule fra ${sendValgt.kilde}: ${sendValgt.schedule}`);

    meldTimer('send-utsendinger', 'sendUtsendingerTimer', sendValgt.schedule);
    app.timer('sendUtsendingerTimer', {
        schedule: sendValgt.schedule,
        handler: async (timer, context) => {
            const log = (m) => context.log(m);
            if (timer?.isPastDue) log('send-utsendinger-timer: forsinket kjøring');
            await kjorSendForfalte({ kilde: 'timer', log });
        }
    });

    const purreJobb = jobbForId('purre-utsendinger');
    const purreValgt = jobbSchedule(purreJobb);
    if (purreValgt.avvist) console.warn(`purre-utsendinger-timer: avviste «${purreValgt.avvist}» — ${purreValgt.grunn}`);
    else if (purreValgt.kilde !== 'standard') console.log(`purre-utsendinger-timer: schedule fra ${purreValgt.kilde}: ${purreValgt.schedule}`);

    meldTimer('purre-utsendinger', 'purreUtsendingerTimer', purreValgt.schedule);
    app.timer('purreUtsendingerTimer', {
        schedule: purreValgt.schedule,
        handler: async (timer, context) => {
            const log = (m) => context.log(m);
            if (timer?.isPastDue) log('purre-utsendinger-timer: forsinket kjøring');
            await kjorPurring({ kilde: 'timer', log });
        }
    });
}
