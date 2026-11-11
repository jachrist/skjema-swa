/**
 * Forventet behandlingstid — inngangene til fristjobben.
 *
 *   POST /api/behandlingsfrist/sjekk   — admin («Kjør nå») ELLER scheduler-nøkkel
 *   timer                              — der plattformen har timere (dev, prod v3)
 *
 * Jobben selv, med bokføringen, bor i lib/behandlingsfrist-jobb.js. Begge
 * inngangene kaller den samme funksjonen.
 *
 * Beslutningen kobles inn her, ikke i lib-en: den bor i functions/skjemaer.js,
 * og fristjobben skal treffe den SAMME beslutningen som en behandler. Merket
 * `SYSTEMBESLUTNING` er det som slipper den forbi behandlersjekken — og det
 * kan ikke komme over HTTP.
 *
 * Ingen cron-workflow: v2 og pilot skal legges ned, og jobben finnes bare der
 * timerne finnes.
 */
const { app } = require('@azure/functions');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');
const jobb = require('../lib/behandlingsfrist-jobb');
const { SYSTEMBESLUTNING } = require('../lib/behandling');
const { stotterTimere } = require('../lib/plattform');
const { jobbForId, jobbSchedule, meldTimer } = require('../lib/jobber');

/** Samme to veier inn som de andre jobbene: admin-cookie eller scheduler-nøkkel. */
function autorisert(request) {
    const nokkel = request.headers.get('x-scheduler-key');
    const konfigurert = process.env.SCHEDULER_KEY;
    if (nokkel && konfigurert && nokkel === konfigurert) return { ok: true, aktor: 'scheduler' };
    const upn = hentInnloggetUpn(request);
    if (upn && erAdmin(upn)) return { ok: true, aktor: upn };
    return { ok: false };
}

/** Beslutningen, kalt som systemet. */
function avgjorSomSystem(context) {
    return async ({ skjematypeId, skjemaId, steg, beslutning, kommentar }) => {
        const { lagreBeslutning } = require('./skjemaer');
        const request = {
            [SYSTEMBESLUTNING]: true,
            params: { skjematypeId: String(skjematypeId), skjemaId: String(skjemaId) },
            headers: { get: () => null },
            json: async () => ({ steg, beslutning, kommentar })
        };
        return await lagreBeslutning(request, context);
    };
}

app.http('behandlingsfristSjekk', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'behandlingsfrist/sjekk',
    handler: async (request, context) => {
        const auth = autorisert(request);
        if (!auth.ok) {
            return { status: 403, jsonBody: { status: 'avvist', melding: 'Krever admin eller service-key' } };
        }
        const log = (m) => context.log(m);
        const res = await jobb.kjorBehandlingsfrist({
            kilde: auth.aktor, log, deps: { avgjor: avgjorSomSystem(context) }
        });
        const status = res.utfall === 'ok' ? 200 : (res.utfall === 'delvis' ? 207 : 500);
        return { status, jsonBody: { status: res.utfall, melding: res.melding, ...(res.resultat || {}) } };
    }
});

if (stotterTimere()) {
    const jobbDef = jobbForId('behandlingsfrist');
    const valgt = jobbSchedule(jobbDef);
    if (valgt.avvist) console.warn(`behandlingsfrist-timer: avviste «${valgt.avvist}» — ${valgt.grunn}`);
    else if (valgt.kilde !== 'standard') console.log(`behandlingsfrist-timer: schedule fra ${valgt.kilde}: ${valgt.schedule}`);

    meldTimer('behandlingsfrist', 'behandlingsfristTimer', valgt.schedule);
    app.timer('behandlingsfristTimer', {
        schedule: valgt.schedule,
        handler: async (timer, context) => {
            const log = (m) => context.log(m);
            if (timer?.isPastDue) log('behandlingsfrist-timer: forsinket kjøring');
            await jobb.kjorBehandlingsfrist({ kilde: 'timer', log, deps: { avgjor: avgjorSomSystem(context) } });
        }
    });
}
