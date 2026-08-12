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

        const bring = require('../lib/bring-postnummer');
        const { tabellKlient } = require('../lib/storage');
        const hendelser = require('../lib/hendelser-storage');
        const kilde = schedulerOk ? 'scheduler' : upn;
        const startTid = new Date().toISOString();

        // Marker som "kjører" i CacheMetadata
        try {
            const t = tabellKlient('CacheMetadata');
            try { await t.createTable(); } catch (_) {}
            await t.upsertEntity({
                partitionKey: 'Meta', rowKey: 'Postnumre-Bring',
                Status: 'kjører', Startet: startTid, Kilde: kilde, SistFeil: ''
            }, 'Merge');
        } catch (_) { /* ikke-kritisk */ }

        const jobbLog = (...a) => context.log(...a);
        jobbLog(`postnumre/refresh-bring: trigget av ${kilde} (fire-and-forget)`);

        // Fire-and-forget — kan ta 30-90 s
        bring.oppdaterFraBring(jobbLog)
            .then(async res => {
                jobbLog(`postnumre/refresh-bring: OK — ${JSON.stringify(res)}`);
                try {
                    const t = tabellKlient('CacheMetadata');
                    await t.upsertEntity({
                        partitionKey: 'Meta', rowKey: 'Postnumre-Bring',
                        Status: 'ok', SistOppdatert: new Date().toISOString(),
                        AntallRader: res.antallSkrevet, AntallSlettet: res.antallSlettet,
                        VarighetSekunder: res.varighetSekunder, SistFeil: ''
                    }, 'Merge');
                } catch (_) {}
                hendelser.logg({
                    Type: 'postnumre.bring-oppdatert', Aktor: kilde,
                    ObjektType: 'postnumre', ObjektId: 'Bring',
                    Melding: `Oppdaterte postnummerregister — ${res.antallSkrevet} skrevet, ${res.antallSlettet} slettet (${res.varighetSekunder}s)`,
                    Detaljer: res
                });
            })
            .catch(async e => {
                jobbLog(`postnumre/refresh-bring FEIL: ${e.message}`);
                try {
                    const t = tabellKlient('CacheMetadata');
                    await t.upsertEntity({
                        partitionKey: 'Meta', rowKey: 'Postnumre-Bring',
                        Status: 'feil', Ferdig: new Date().toISOString(),
                        SistFeil: String(e.message || e).slice(0, 500)
                    }, 'Merge');
                } catch (_) {}
                hendelser.logg({
                    Type: 'postnumre.bring-feil', Aktor: kilde,
                    ObjektType: 'postnumre', ObjektId: 'Bring',
                    Melding: `Bring-oppdatering feilet: ${e.message}`.slice(0, 500)
                });
            });

        return {
            status: 202,
            jsonBody: { status: 'startet', startet: startTid, melding: 'Jobben kjører asynkront (30-90 s). Sjekk /api/postnumre/status.' }
        };
    }
});

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
