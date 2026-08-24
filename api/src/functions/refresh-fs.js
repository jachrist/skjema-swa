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

        // Fire-and-forget: SWA-proxyen har ~45 s response timeout og full FS-refresh
        // tar 2-4 min. Vi markerer status='kjører' og starter jobben uten å await —
        // Function-hosten holder prosessen i live til den asynkrone jobben er ferdig.
        // Status leses via GET /api/refresh-fs/status.
        const startTid = new Date().toISOString();
        try {
            const t = tabellKlient('CacheMetadata');
            await t.upsertEntity({
                partitionKey: 'Meta',
                rowKey: 'FS-Emner',
                Status: 'kjører',
                Startet: startTid,
                Kilde: auth.kilde,
                SistFeil: ''
            }, 'Merge');
        } catch (_) { /* ikke-kritisk */ }

        // Start jobben asynkront (ikke await!)
        const jobbLog = (...a) => context.log(...a);
        jobbLog(`refresh-fs: trigget av ${auth.kilde} (fire-and-forget)`);
        refreshFS(jobbLog)
            .then(async res => {
                jobbLog(`refresh-fs: OK — ${JSON.stringify(res)}`);
                try {
                    const t = tabellKlient('CacheMetadata');
                    await t.upsertEntity({
                        partitionKey: 'Meta',
                        rowKey: 'FS-Emner',
                        Status: 'ok',
                        Ferdig: new Date().toISOString(),
                        VarighetSekunder: res.varighetSekunder,
                        Terminer: (res.terminer || []).join(',')
                    }, 'Merge');
                } catch (_) { /* ikke-kritisk */ }
            })
            .catch(async e => {
                jobbLog(`refresh-fs FEIL: ${e.message}`);
                try {
                    const t = tabellKlient('CacheMetadata');
                    await t.upsertEntity({
                        partitionKey: 'Meta',
                        rowKey: 'FS-Emner',
                        Status: 'feil',
                        Ferdig: new Date().toISOString(),
                        SistFeil: String(e.message || e).slice(0, 500)
                    }, 'Merge');
                } catch (_) { /* ignorer sekundærfeil */ }
            });

        return {
            status: 202,
            jsonBody: {
                status: 'startet',
                startet: startTid,
                melding: 'Jobben kjører asynkront. Sjekk /api/refresh-fs/status om et par minutter.'
            }
        };
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

/**
 * POST /api/refresh-fs/diag-lu — hvorfor er LU-kolonnen tom?
 *
 * Kjører den samme emne-spørringen med ulike varianter av
 * beskrivelsesavsnitt-filteret mot et lite utvalg emner, og rapporterer hvor
 * mange som fikk innhold. Da slipper vi å gjette på hvilket filterledd som
 * tømmer resultatet. Hver variant kjøres for seg — feiler én (ukjent felt i
 * skjemaet), rapporteres feilmeldingen og de andre kjører videre.
 */
app.http('refreshFsDiagLu', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'refresh-fs/diag-lu',
    handler: async (request, context) => {
        const auth = autorisert(request);
        if (!auth.ok) return { status: 403, jsonBody: { status: 'avvist' } };

        try {
            const terminer = require('../lib/terminer');
            const fs = require('../lib/fs-client');
            const aktive = terminer.aktiveTerminer();
            const idMap = await fs.hentTerminer(aktive.map(t => ({ arstall: t.arstall, betegnelse: t.betegnelse })));

            // Bruk inneværende termin til å plukke emner — der finnes det data
            const naa = aktive[1];
            const terminId = idMap.get(`${naa.arstall}-${naa.betegnelse}`);
            if (!terminId) return { status: 500, jsonBody: { status: 'feil', melding: `Fant ikke termin-id for ${naa.kort}` } };

            const antall = Number((await request.json().catch(() => ({})))?.antall || 8);
            const termFilter = (t) => `gjelderFraTerminer: [{arstall: ${t.arstall}, terminbetegnelse: "${t.betegnelse}"}]`;

            const varianter = [
                { navn: 'dagens (gjelderFra = neste termin)', filter: `(filter: { tekstkategorikoder: "E-FHSLUB" sprakkode6392: "NOR" ${termFilter(aktive[2])} })`, felt: 'innhold' },
                { navn: 'gjelderFra = inneværende termin', filter: `(filter: { tekstkategorikoder: "E-FHSLUB" sprakkode6392: "NOR" ${termFilter(aktive[1])} })`, felt: 'innhold' },
                { navn: 'gjelderFra = forrige termin', filter: `(filter: { tekstkategorikoder: "E-FHSLUB" sprakkode6392: "NOR" ${termFilter(aktive[0])} })`, felt: 'innhold' },
                { navn: 'uten gjelderFraTerminer', filter: `(filter: { tekstkategorikoder: "E-FHSLUB" sprakkode6392: "NOR" })`, felt: 'innhold' },
                { navn: 'kun tekstkategori (uten språk)', filter: `(filter: { tekstkategorikoder: "E-FHSLUB" })`, felt: 'innhold' },
                { navn: 'helt ufiltrert', filter: '', felt: 'innhold' },
                { navn: 'ufiltrert med metadata', filter: '', felt: 'innhold tekstkategori { kode } sprak { kode }' }
            ];

            const resultater = [];
            for (const v of varianter) {
                const query = `
                    query DiagLu($terminer: [ID!]!, $first: Int!, $eier: String!) {
                        undervisningsenheter(filter: { eierOrganisasjonskode: $eier, terminer: $terminer } first: $first) {
                            nodes {
                                emne {
                                    kode
                                    beskrivelsesavsnitt${v.filter} { nodes { ${v.felt} } }
                                }
                            }
                        }
                    }
                `;
                try {
                    const data = await fs.kallGraphQl(query, {
                        terminer: [terminId], first: antall,
                        eier: process.env.FS_EIER_ORG_KODE || '1627'
                    });
                    const noder = data.undervisningsenheter?.nodes || [];
                    const medInnhold = noder.filter(n => (n.emne?.beskrivelsesavsnitt?.nodes || []).some(x => x?.innhold));
                    const forste = medInnhold[0]?.emne?.beskrivelsesavsnitt?.nodes || [];
                    resultater.push({
                        variant: v.navn,
                        emnerSjekket: noder.length,
                        emnerMedInnhold: medInnhold.length,
                        eksempelEmne: medInnhold[0]?.emne?.kode || null,
                        eksempelAvsnitt: forste.slice(0, 3).map(x => ({
                            kategori: x?.tekstkategori?.kode,
                            sprak: x?.sprak?.kode,
                            innhold: String(x?.innhold || '').slice(0, 220)
                        }))
                    });
                } catch (e) {
                    resultater.push({ variant: v.navn, feil: String(e.message || e).slice(0, 300) });
                }
            }

            // Hvordan ser det ut i tabellen etter siste oppfriskning?
            const emnerStorage = require('../lib/emner-storage');
            const lagrede = await emnerStorage.hentAlleEmner();
            const medLu = lagrede.filter(e => (e.LU || '').trim().length > 0);
            const tabellStatus = {
                emnerITabellen: lagrede.length,
                medBeskrivelse: medLu.length,
                eksempel: medLu[0] ? { EK: medLu[0].EK, Termin: medLu[0].Termin, LU: String(medLu[0].LU).slice(0, 220) } : null
            };

            return {
                jsonBody: {
                    status: 'ok',
                    aktiveTerminer: aktive.map(t => t.kort),
                    plukketFraTermin: naa.kort,
                    tabellStatus,
                    resultater
                }
            };
        } catch (e) {
            return { status: 500, jsonBody: { status: 'feil', melding: String(e.message || e), stack: (e.stack || '').split('\n').slice(0, 6) } };
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
            const kilder = ['FS-Emner', 'FS-Studenter', 'FS-FilterStudent', 'FS-Klasser'];
            const status = {};
            for (const k of kilder) {
                try {
                    const e = await t.getEntity('Meta', k);
                    status[k] = {
                        sistOppdatert: e.SistOppdatert || null,
                        antallRader: e.AntallRader ?? 0,
                        status: e.Status || 'ukjent',
                        sistFeil: e.SistFeil || '',
                        startet: e.Startet || null,
                        ferdig: e.Ferdig || null,
                        varighetSekunder: e.VarighetSekunder ?? null,
                        terminer: e.Terminer || null,
                        kilde: e.Kilde || null,
                        // Klasse-diagnostikk (kun satt på FS-Klasser)
                        klasserFraFs: e.KlasserFraFs ?? null,
                        klasserMedStudenter: e.KlasserMedStudenter ?? null,
                        klasserUtenStudenter: e.KlasserUtenStudenter ?? null,
                        klasserAvkortet: e.KlasserAvkortet ?? null
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
