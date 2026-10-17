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
const { tabellKlient } = require('../lib/storage');
const { stotterTimere } = require('../lib/plattform');
const { jobbForId, jobbSchedule, meldTimer } = require('../lib/jobber');

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
        // tar 2-4 min. Vi svarer 202 og lar hosten holde prosessen i live.
        // Bokføringen skjer inne i jobben — se lib/refresh-fs-jobb.js.
        // Status leses via GET /api/refresh-fs/status.
        const { kjorRefreshFs } = require('../lib/refresh-fs-jobb');
        const startTid = new Date().toISOString();
        const jobbLog = (...a) => context.log(...a);
        kjorRefreshFs({ kilde: auth.kilde, log: jobbLog });

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

// ==================== TIMER-TRIGGER (steg 5) ====================
//
// Samme vakt og samme form som postnumre — se kommentaren der og 8m/8n i
// docs/BESLUTNING-EGEN-FUNCTION-APP.md. Vakten står rundt REGISTRERINGEN:
// en timer på en vert som ikke støtter dem kan velte oppstarten for hele
// appen, og da er HTTP-rutene borte også.
//
// Tidspunktet står i lib/jobber.js, ikke her, og testen krever at det er det
// samme som cron-en i refresh-fs.yml med et sekundfelt foran.
//
// **DENNE VENTER, OG VENTINGEN ER LANG.** Jobben tar 2-4 minutter, og hele
// den tiden er én funksjonskjøring. HTTP-veien slipper unna fordi den svarer
// 202 med en gang; timeren gjør ikke det. `host.json` setter ingen
// `functionTimeout`, så standarden på Consumption gjelder — fem minutter.
// Blir kjøringen kuttet, står statusraden igjen på «kjører», og Jobber-fanen
// viser det. Se 8n for app-settingen som hever grensen i dev alene.
if (stotterTimere()) {
    const jobb = jobbForId('refresh-fs');
    const valgt = jobbSchedule(jobb);
    if (valgt.avvist) console.warn(`refresh-fs-timer: avviste «${valgt.avvist}» — ${valgt.grunn}`);
    else if (valgt.kilde !== 'standard') console.log(`refresh-fs-timer: schedule fra ${valgt.kilde}: ${valgt.schedule}`);

    // Meld fra om at registreringen SKJEDDE, slik at Jobber-fanen kan si
    // forskjell på «ingen timer er registrert» og «registrert, men fyrer
    // ikke». De to krever helt ulik feilsøking.
    meldTimer('refresh-fs', 'refreshFsTimer', valgt.schedule);
    app.timer('refreshFsTimer', {
        // `runOnStartup` settes IKKE: den ville kjørt en 2-4 minutters jobb
        // ved hver eneste deploy og omstart.
        schedule: valgt.schedule,
        handler: async (timer, context) => {
            const { kjorRefreshFs } = require('../lib/refresh-fs-jobb');
            const jobbLog = (...a) => context.log(...a);
            if (timer?.isPastDue) jobbLog('refresh-fs-timer: forsinket kjøring');
            await kjorRefreshFs({ kilde: 'timer', log: jobbLog });
        }
    });
}

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
