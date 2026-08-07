/**
 * POST /api/refresh-fs
 *
 * Kjører refreshFS-jobben.
 *
 * Autentisering:
 *   - Admin-bruker via SWA-cookie (x-ms-client-principal + ADMIN_UPNS)
 *     → for manuell trigging fra admin-panelet
 *   - Scheduler-nøkkel via header "x-scheduler-key" som må matche SCHEDULER_KEY
 *     → for GitHub Actions cron (headless, uten SWA-cookie)
 *
 * GET /api/refresh-fs/status — sist-kjørt-info fra CacheMetadata (åpent for innloggede)
 */
const { app } = require('@azure/functions');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');
const { refreshFS } = require('../lib/refresh-fs');
const { tabellKlient } = require('../lib/storage');

function autorisert(request) {
    const schedulerKey = request.headers.get('x-scheduler-key');
    const configuredKey = process.env.SCHEDULER_KEY;
    if (schedulerKey && configuredKey && schedulerKey === configuredKey) return { ok: true, kilde: 'scheduler' };

    const upn = hentInnloggetUpn(request);
    if (upn && erAdmin(upn)) return { ok: true, kilde: `admin:${upn}` };

    return { ok: false };
}

app.http('refreshFs', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'refresh-fs',
    handler: async (request, context) => {
        const auth = autorisert(request);
        if (!auth.ok) {
            return { status: 403, jsonBody: { status: 'avvist', melding: 'Krever admin eller service-key' } };
        }
        try {
            const log = (...a) => context.log(...a);
            log(`refresh-fs: trigget av ${auth.kilde}`);
            const res = await refreshFS(log);
            return { jsonBody: { status: 'ok', ...res } };
        } catch (e) {
            context.log('refresh-fs FEIL:', e.message);
            // Skriv feil-status til CacheMetadata så admin kan se det
            try {
                const t = tabellKlient('CacheMetadata');
                await t.upsertEntity({
                    partitionKey: 'Meta',
                    rowKey: 'FS-Emner',
                    SistOppdatert: new Date().toISOString(),
                    Status: 'feil',
                    SistFeil: String(e.message || e).slice(0, 500)
                }, 'Merge');
            } catch (_) { /* ignorer sekundærfeil */ }
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('refreshFsDiag', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'refresh-fs/diag',
    handler: async (request, context) => {
        const auth = autorisert(request);
        if (!auth.ok) return { status: 403, jsonBody: { status: 'avvist' } };

        const startTid = Date.now();
        const trinn = [];
        const merk = (navn) => trinn.push({ trinn: navn, ms: Date.now() - startTid });

        try {
            const env = {
                FS_API_URL: process.env.FS_API_URL ? 'satt' : 'MANGLER',
                FS_API_USER: process.env.FS_API_USER ? 'satt' : 'MANGLER',
                FS_API_PASSWORD: process.env.FS_API_PASSWORD ? 'satt' : 'MANGLER',
                FS_EIER_ORG_KODE: process.env.FS_EIER_ORG_KODE || 'default 1627'
            };
            merk('env sjekket');

            const terminer = require('../lib/terminer');
            const fs = require('../lib/fs-client');
            const aktive = terminer.aktiveTerminer();
            merk('aktive terminer beregnet');

            const idMap = await fs.hentTerminer(aktive.map(t => ({ arstall: t.arstall, betegnelse: t.betegnelse })));
            merk('hentTerminer OK');

            const terminIder = [];
            for (const t of aktive) {
                const id = idMap.get(`${t.arstall}-${t.betegnelse}`);
                if (id) terminIder.push(id);
            }

            // Ett lite GraphQL-kall — 5 enheter, uten LU
            const enheter = await fs.hentUndervisningsenheter(terminIder.slice(0, 1), 5, null);
            merk('hentUndervisningsenheter (5 enheter, 1 termin) OK');

            return {
                jsonBody: {
                    status: 'ok',
                    env,
                    aktiveTerminer: aktive.map(t => t.kort),
                    terminIder,
                    antallEnheter: enheter.length,
                    første: enheter[0]?.emne?.kode || null,
                    trinn
                }
            };
        } catch (e) {
            return {
                status: 500,
                jsonBody: {
                    status: 'feil',
                    melding: String(e.message || e),
                    stack: (e.stack || '').split('\n').slice(0, 6),
                    trinn
                }
            };
        }
    }
});

app.http('refreshFsStatus', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'refresh-fs/status',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        try {
            const t = tabellKlient('CacheMetadata');
            const kilder = ['FS-Emner', 'FS-Studenter'];
            const status = {};
            for (const k of kilder) {
                try {
                    const e = await t.getEntity('Meta', k);
                    status[k] = {
                        sistOppdatert: e.SistOppdatert || null,
                        antallRader: e.AntallRader ?? 0,
                        status: e.Status || 'ukjent',
                        sistFeil: e.SistFeil || ''
                    };
                } catch (err) {
                    if (err.statusCode === 404) status[k] = { status: 'aldri kjørt' };
                    else throw err;
                }
            }
            return { jsonBody: status };
        } catch (e) {
            context.log('refresh-fs/status FEIL:', e.message);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});
