/**
 * Oppslagsliste-endepunkter — nedtrekksverdier bygget av innsendte skjemaer.
 *
 *   GET    /api/oppslaglister             — oppsett + status (admin)
 *   PUT    /api/oppslaglister             — lagre oppsettet (admin)
 *   POST   /api/oppslaglister/oppdater    — bygg listene (admin ELLER scheduler-nøkkel)
 *                                           ?liste=Navn  — bare én
 *                                           ?tort=1      — forhåndsvis, skriv ingenting
 *
 * Autentisering følger `refresh-fs.js`: admin via SWA-cookie for manuell
 * kjøring fra admin-panelet, eller `x-scheduler-key` for GitHub Actions cron,
 * som er headless og ikke har noen cookie.
 */
const { app } = require('@azure/functions');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');
const lagring = require('../lib/oppslagsliste-storage');
const jobb = require('../lib/oppslagsliste-jobb');
const hendelser = require('../lib/hendelser-storage');
const { stotterTimere } = require('../lib/plattform');
const { jobbForId, jobbSchedule, meldTimer } = require('../lib/jobber');

/** Samme to veier inn som refresh-fs: admin-cookie eller scheduler-nøkkel. */
function autorisert(request) {
    const nokkel = request.headers.get('x-scheduler-key');
    const konfigurert = process.env.SCHEDULER_KEY;
    if (nokkel && konfigurert && nokkel === konfigurert) return { ok: true, aktor: 'scheduler' };

    const upn = hentInnloggetUpn(request);
    if (upn && erAdmin(upn)) return { ok: true, aktor: upn };

    return { ok: false };
}

function kreverAdmin(request) {
    const upn = hentInnloggetUpn(request);
    if (!upn) return { svar: { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } } };
    if (!erAdmin(upn)) return { svar: { status: 403, jsonBody: { status: 'avvist', melding: 'Krever admin' } } };
    return { upn };
}

app.http('oppslaglisterHent', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'oppslaglister',
    handler: async (request, context) => {
        const { upn, svar } = kreverAdmin(request);
        if (svar) return svar;
        try {
            const [lister, status] = await Promise.all([
                lagring.hentOppsett((m) => context.log(m)),
                lagring.hentStatus()
            ]);
            return { jsonBody: { status: 'ok', lister, kjoringer: status, av: upn } };
        } catch (e) {
            context.log('oppslaglister GET FEIL:', e.message);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('oppslaglisterLagre', {
    methods: ['PUT'],
    authLevel: 'anonymous',
    route: 'oppslaglister',
    handler: async (request, context) => {
        const { upn, svar } = kreverAdmin(request);
        if (svar) return svar;
        try {
            const body = await request.json();
            const lister = await lagring.lagreOppsett(body?.Lister, upn);
            hendelser.logg({
                Type: 'oppslagsliste.oppsett', Aktor: upn,
                ObjektType: 'oppslagsliste', ObjektId: '',
                Melding: `Lagret oppsett for ${lister.length} oppslagsliste(r)`,
                Detaljer: { lister: lister.map(l => `${l.Navn} (skjematype ${l.Skjematype_id})`) }
            }).catch(() => {});
            return { jsonBody: { status: 'ok', lister } };
        } catch (e) {
            // Valideringsfeil skal sees av den som skrev oppsettet, ikke bare
            // i loggen. 400 og meldingen rett ut.
            context.log('oppslaglister PUT avvist:', e.message);
            return { status: 400, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('oppslaglisterOppdater', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'oppslaglister/oppdater',
    handler: async (request, context) => {
        const auth = autorisert(request);
        if (!auth.ok) {
            return { status: 403, jsonBody: { status: 'avvist', melding: 'Krever admin eller service-key' } };
        }
        const url = new URL(request.url);
        const bareNavn = url.searchParams.get('liste');
        const tørr = url.searchParams.get('tort') === '1';

        const log = (m) => context.log(`oppslagsliste: ${m}`);

        // TØRRKJØRING BOKFØRES IKKE. Forhåndsvisningen skriver ingenting, og
        // en statusrad etter en forhåndsvisning ville vært en påstand om data
        // som aldri ble skrevet. Den veien går derfor rett på byggAlle.
        if (tørr) {
            try {
                const res = await jobb.byggAlle({ bareNavn, tørr: true, log });
                return { status: 200, jsonBody: { status: 'ok', ...res } };
            } catch (e) {
                context.log('oppslaglister forhåndsvisning FEIL:', e.message);
                return { status: 400, jsonBody: { status: 'feil', melding: e.message } };
            }
        }

        // Bokføringen — statusraden og hendelsen — skjer inne i jobben, slik
        // at timeren i dev og HTTP-veien her gir admin-panelet det SAMME
        // bildet av den samme kjøringen. Se lib/oppslagsliste-jobb.js.
        const res = await jobb.kjorOppslagslister({ kilde: auth.aktor, bareNavn, log });
        if (res.kastet) {
            return { status: 400, jsonBody: { status: 'feil', melding: res.melding } };
        }
        // Feil i én liste gir 207: jobben gjorde noe, men ikke alt. En
        // 200 ville gjort at cron-jobben så grønn ut med en død liste.
        const status = res.utfall === 'ok' ? 200 : (res.utfall === 'delvis' ? 207 : 500);
        return {
            status,
            jsonBody: { status: res.utfall === 'ok' ? 'ok' : 'delvis', ...res.resultat }
        };
    }
});

// ==================== TIMER-TRIGGER (steg 5) ====================
//
// Samme vakt, samme form og samme begrunnelse som i postnumre.js og
// refresh-fs.js: vakten står rundt REGISTRERINGEN, og tidspunktet bor i
// lib/jobber.js. Testen krever at det er cron-en i refresh-oppslagsliste.yml
// med et sekundfelt foran.
//
// Timeren kjører ALDRI tørt: en forhåndsvisning uten noen som ser på er
// bortkastet arbeid, og den ville ikke skrevet noe uansett.
if (stotterTimere()) {
    const jobbDef = jobbForId('oppslaglister');
    const valgt = jobbSchedule(jobbDef);
    if (valgt.avvist) console.warn(`oppslaglister-timer: avviste «${valgt.avvist}» — ${valgt.grunn}`);
    else if (valgt.kilde !== 'standard') console.log(`oppslaglister-timer: schedule fra ${valgt.kilde}: ${valgt.schedule}`);

    // Meld fra om at registreringen SKJEDDE, slik at Jobber-fanen kan si
    // forskjell på «ingen timer er registrert» og «registrert, men fyrer
    // ikke». De to krever helt ulik feilsøking.
    meldTimer('oppslaglister', 'oppslaglisterTimer', valgt.schedule);
    app.timer('oppslaglisterTimer', {
        schedule: valgt.schedule,
        handler: async (timer, context) => {
            const log = (m) => context.log(`oppslagsliste: ${m}`);
            if (timer?.isPastDue) log('oppslaglister-timer: forsinket kjøring');
            await jobb.kjorOppslagslister({ kilde: 'timer', log });
        }
    });
}
