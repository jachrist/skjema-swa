/**
 * Postnummer-endepunkter.
 *
 *   GET  /api/postnumre/sok?q=X&maks=10   — søk (postnr eller poststed)
 *   POST /api/postnumre/seed              — legger inn eksempeldata (admin)
 *   POST /api/postnumre/import            — importer full liste (admin) — TODO
 */
const { app } = require('@azure/functions');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');
const postnumreStorage = require('../lib/postnumre-storage');
const { stotterTimere } = require('../lib/plattform');
const { jobbForId, jobbSchedule } = require('../lib/jobber');

app.http('postnumreSok', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'postnumre/sok',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        try {
            const q = request.query.get('q') || '';
            const maks = Math.min(parseInt(request.query.get('maks') || '10', 10) || 10, 50);
            const treff = await postnumreStorage.sokPostnumre(q, maks);
            return { jsonBody: treff };
        } catch (e) {
            context.log('postnumre/sok FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

// Et minimum sett postnumre for pilot. Erstattes senere med full Bring-import.
const EKSEMPEL_POSTNUMRE = [
    { Postnr: '0010', Poststed: 'OSLO', Kommune: 'Oslo' },
    { Postnr: '0150', Poststed: 'OSLO', Kommune: 'Oslo' },
    { Postnr: '0180', Poststed: 'OSLO', Kommune: 'Oslo' },
    { Postnr: '0250', Poststed: 'OSLO', Kommune: 'Oslo' },
    { Postnr: '0350', Poststed: 'OSLO', Kommune: 'Oslo' },
    { Postnr: '0450', Poststed: 'OSLO', Kommune: 'Oslo' },
    { Postnr: '0550', Poststed: 'OSLO', Kommune: 'Oslo' },
    { Postnr: '0850', Poststed: 'OSLO', Kommune: 'Oslo' },
    { Postnr: '1300', Poststed: 'SANDVIKA', Kommune: 'Bærum' },
    { Postnr: '1440', Poststed: 'DRØBAK', Kommune: 'Frogn' },
    { Postnr: '1750', Poststed: 'HALDEN', Kommune: 'Halden' },
    { Postnr: '2000', Poststed: 'LILLESTRØM', Kommune: 'Lillestrøm' },
    { Postnr: '2317', Poststed: 'HAMAR', Kommune: 'Hamar' },
    { Postnr: '3005', Poststed: 'DRAMMEN', Kommune: 'Drammen' },
    { Postnr: '3120', Poststed: 'TØNSBERG', Kommune: 'Tønsberg' },
    { Postnr: '4013', Poststed: 'STAVANGER', Kommune: 'Stavanger' },
    { Postnr: '4614', Poststed: 'KRISTIANSAND S', Kommune: 'Kristiansand' },
    { Postnr: '5003', Poststed: 'BERGEN', Kommune: 'Bergen' },
    { Postnr: '5020', Poststed: 'BERGEN', Kommune: 'Bergen' },
    { Postnr: '5231', Poststed: 'PARADIS', Kommune: 'Bergen' },
    { Postnr: '6002', Poststed: 'ÅLESUND', Kommune: 'Ålesund' },
    { Postnr: '7010', Poststed: 'TRONDHEIM', Kommune: 'Trondheim' },
    { Postnr: '7020', Poststed: 'TRONDHEIM', Kommune: 'Trondheim' },
    { Postnr: '8003', Poststed: 'BODØ', Kommune: 'Bodø' },
    { Postnr: '9008', Poststed: 'TROMSØ', Kommune: 'Tromsø' }
];

/**
 * POST /api/postnumre/refresh-bring
 * Auth: x-scheduler-key (SCHEDULER_KEY) eller admin.
 * Henter Bring sitt postnummerregister og importerer med erstattAlt=true.
 * Fire-and-forget — status leses via GET /api/postnumre/status.
 */
app.http('postnumreRefreshBring', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'postnumre/refresh-bring',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        const schedulerKey = request.headers.get('x-scheduler-key');
        const configuredKey = String(process.env.SCHEDULER_KEY || '').trim();
        const schedulerOk = configuredKey && schedulerKey && schedulerKey === configuredKey;
        if (!schedulerOk && !(upn && erAdmin(upn))) {
            return { status: 401, jsonBody: { status: 'feil', melding: 'Krever x-scheduler-key eller admin' } };
        }

        const { kjorBringOppdatering } = require('../lib/postnummer-jobb');
        const kilde = schedulerOk ? 'scheduler' : upn;
        const startTid = new Date().toISOString();
        const jobbLog = (...a) => context.log(...a);

        // Fire-and-forget: SWA-proxyen har ~45 s response timeout, og jobben
        // tar 30-90 s. Vi svarer 202 og lar hosten holde prosessen i live.
        // Bokføringen skjer inne i jobben — se lib/postnummer-jobb.js.
        kjorBringOppdatering({ kilde, log: jobbLog });

        return {
            status: 202,
            jsonBody: { status: 'startet', startet: startTid, melding: 'Jobben kjører asynkront (30-90 s). Sjekk /api/postnumre/status.' }
        };
    }
});

// ==================== TIMER-TRIGGER (steg 4) ====================
//
// Samme jobb, uten GitHub Actions i mellom. Første steg bort fra de åtte
// cron-workflowene som kaller HTTP-endepunkter med en delt nøkkel — se steg 4
// og 5 i docs/BESLUTNING-EGEN-FUNCTION-APP.md.
//
// **VAKTEN STÅR RUNDT REGISTRERINGEN, IKKE INNE I HANDLEREN.** SWA Managed
// Functions støtter ikke timer-triggere, og en timer som registreres der er
// ikke en stille no-op — den kan velte oppstarten for HELE appen, og da er
// alle HTTP-rutene borte også. `stotterTimere()` leses ved modullast, og i
// pilot og prod blir `app.timer` aldri kalt.
//
// GitHub Actions-workflowen kjører MOT pilot og prod, ikke mot dev (se
// matrisen i .github/workflows/refresh-postnumre.yml), så jobben kan ikke
// kjøre to ganger i samme miljø. Workflowen fjernes først i steg 5, når alle
// miljøene har timere.
//
// NCRONTAB har SEKS felt — sekund først. GitHub-cron har fem. Skrives
// GitHub-uttrykket rett inn, blir «30 4 15 1,7 *» lest som
// sekund-minutt-time-dag-måned og kjører 1,7 ganger i uka i stedet for to
// ganger i året. Uttrykket står i `lib/jobber.js`, og
// api/test/timer-trigger.test.js krever at det er det samme som cron-en i
// workflowen, med et sekundfelt foran.
if (stotterTimere()) {
    // Tidspunktet står i `lib/jobber.js`, ikke her — sammen med ruta,
    // statusraden og navnet på workflowen som kjører den samme jobben mot
    // pilot og prod. `POSTNUMRE_SCHEDULE` kan overstyre det uten en deploy,
    // men leses VED REGISTRERING: en endret app-setting slår inn ved neste
    // omstart av appen.
    const jobb = jobbForId('postnumre-bring');
    const valgt = jobbSchedule(jobb);
    // Logges ved modullast, fordi en overstyring som bare forsvinner er
    // umulig å feilsøke. Den gjeldende verdien står også i GET /api/jobber.
    if (valgt.avvist) console.warn(`postnumre-timer: avviste «${valgt.avvist}» — ${valgt.grunn}`);
    else if (valgt.kilde !== 'standard') console.log(`postnumre-timer: schedule fra ${valgt.kilde}: ${valgt.schedule}`);

    app.timer('postnumreTimer', {
        // `runOnStartup` settes IKKE: den ville kjørt jobben ved hver eneste
        // deploy og omstart.
        schedule: valgt.schedule,
        handler: async (timer, context) => {
            const { kjorBringOppdatering } = require('../lib/postnummer-jobb');
            const jobbLog = (...a) => context.log(...a);
            if (timer?.isPastDue) jobbLog('postnumre-timer: forsinket kjøring');
            // Her ventes det, i motsetning til HTTP-veien: ingen proxy med
            // tidsavbrudd sitter og ser på. Da bærer også loggen hele kjøringen.
            await kjorBringOppdatering({ kilde: 'timer', log: jobbLog });
        }
    });
}

app.http('postnumreStatus', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'postnumre/status',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        if (!erAdmin(upn)) return { status: 403, jsonBody: { status: 'avvist', melding: 'Krever admin' } };
        try {
            const antall = await postnumreStorage.hentAntall();
            // Hent Bring-import-metadata hvis finnes
            const { tabellKlient } = require('../lib/storage');
            let bring = null;
            try {
                const t = tabellKlient('CacheMetadata');
                const e = await t.getEntity('Meta', 'Postnumre-Bring');
                bring = {
                    status: e.Status || 'ukjent',
                    sistOppdatert: e.SistOppdatert || null,
                    antallRader: e.AntallRader ?? null,
                    antallSlettet: e.AntallSlettet ?? null,
                    varighetSekunder: e.VarighetSekunder ?? null,
                    startet: e.Startet || null,
                    ferdig: e.Ferdig || null,
                    kilde: e.Kilde || null,
                    sistFeil: e.SistFeil || ''
                };
            } catch (err) {
                if (err.statusCode !== 404) throw err;
                bring = { status: 'aldri kjørt' };
            }
            return { jsonBody: { antall, bring } };
        } catch (e) {
            context.log('postnumre/status FEIL:', e.message);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('postnumreSeed', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'postnumre/seed',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        if (!erAdmin(upn)) return { status: 403, jsonBody: { status: 'avvist', melding: 'Krever admin-tilgang' } };
        try {
            await postnumreStorage.upsertBatch(EKSEMPEL_POSTNUMRE);
            context.log(`postnumre/seed: ${upn} seedet ${EKSEMPEL_POSTNUMRE.length} postnumre`);
            return { jsonBody: { status: 'ok', antall: EKSEMPEL_POSTNUMRE.length } };
        } catch (e) {
            context.log('postnumre/seed FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});
