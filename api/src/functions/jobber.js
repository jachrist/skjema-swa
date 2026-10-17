/**
 * GET /api/jobber — oversikt over bakgrunnsjobbene. Admin.
 *
 * Svarer på tre spørsmål som i dag krever tre ulike steder å lete: HVA som
 * trigger jobben i DETTE miljøet, NÅR den kjører, og hvordan det gikk sist.
 *
 * Trigger og tidspunkt kommer ferdig avgjort fra `lib/jobber.js`, og statusen
 * fra den samme leseren som `/api/postnumre/status` bruker. Panelet tolker
 * ingenting selv: regnet det ut «kjører på timer» av at MILJO=dev, ville det
 * svart feil den dagen lista i `lib/plattform.js` endres — og det er en
 * oversikt som er aktivt feil, som er verre enn ingen.
 *
 * **LESEENDEPUNKT.** Det finnes ingen vei herfra til å ENDRE en schedule, med
 * vilje: en lagret schedule blir en andre kilde ved siden av git, og Azure
 * leser `schedule` ved registrering — en lagret verdi ville ikke tatt effekt
 * før en omstart, og panelet ville vist en plan som ikke kjører. Se 8m i
 * `docs/BESLUTNING-EGEN-FUNCTION-APP.md`. «Kjør nå» går mot jobbens egen
 * HTTP-rute, som er den samme GitHub Actions kaller.
 */
const { app } = require('@azure/functions');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');
const { jobbOversikt, lesStatusrad } = require('../lib/jobber');
const { miljonavn } = require('../lib/plattform');

app.http('jobberListe', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'jobber',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        if (!erAdmin(upn)) return { status: 403, jsonBody: { status: 'feil', melding: 'Krever admin' } };

        const jobber = [];
        for (const jobb of jobbOversikt()) {
            // Feiler lesningen av én statusrad, skal de andre jobbene
            // fortsatt vises — og årsaken skal stå i raden det gjelder.
            // «Ingen jobber» og «storage svarte ikke» ser ellers likt ut.
            let siste = null;
            let statusFeil = null;
            try {
                siste = await lesStatusrad(jobb.statusrad);
            } catch (e) {
                statusFeil = String(e.message || e);
                context.log(`jobber: kunne ikke lese statusraden for ${jobb.id}: ${statusFeil}`);
            }
            jobber.push({ ...jobb, siste, statusFeil });
        }

        return {
            jsonBody: {
                miljø: miljonavn() || 'ukjent',
                // Hvorfor triggeren er som den er. Står det «timer» uten
                // dette, er det ikke mulig å se om pilot mangler en timer ved
                // en feil eller fordi plattformen der ikke har dem.
                merknad: jobber.some(j => j.trigger === 'timer')
                    ? 'Plattformen her kjører timer-triggere. Schedulen leses ved registrering, '
                        + 'så en endret app-setting slår inn ved neste omstart av appen.'
                    : 'Plattformen her kjører IKKE timer-triggere (SWA Managed Functions). '
                        + 'Jobbene trigges av cron i GitHub Actions, mot HTTP-rutene med SCHEDULER_KEY.',
                jobber
            }
        };
    }
});
