/**
 * Team-synkronisering fra rollegrupper (TODO 71).
 *
 *   GET  /api/team-synk            — status for alle grupper med team-kobling
 *   POST /api/team-synk            — kjør alle. Scheduler eller admin.
 *   POST /api/team-synk/{rolle}    — kjør én gruppe. { omfang, tillatFall }
 *   PUT  /api/team-synk/{rolle}    — sett kobling. { omfang, team, eierRolle }
 *
 * Kjøres daglig av .github/workflows/team-synk.yml, fordi SWA Managed
 * Functions ikke har timer-triggere.
 *
 * Flyten oppdaterer teamet DESTRUKTIVT. Reglene for når vi tør å kalle den
 * ligger i `lib/team-synk.js`, ikke her — de skal kunne prøves uten at
 * hverken tabell eller flyt finnes.
 */
const { app } = require('@azure/functions');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');
const gruppeStorage = require('../lib/rollegruppe-storage');
const teamSynk = require('../lib/team-synk');
const { synkroniserGruppe, kjorTeamSynk } = require('../lib/team-synk-jobb');
const { stotterTimere } = require('../lib/plattform');
const { jobbForId, jobbSchedule, meldTimer } = require('../lib/jobber');
const hendelser = require('../lib/hendelser-storage');

function avvis(status, melding) {
    return { status, jsonBody: { status: status === 403 ? 'avvist' : 'feil', melding } };
}

function admin(request) {
    const upn = hentInnloggetUpn(request);
    if (!upn) return { svar: avvis(401, 'Ikke innlogget') };
    if (!erAdmin(upn)) return { svar: avvis(403, 'Krever admin') };
    return { upn };
}

/**
 * Samme mønster som backup og postnumre: den daglige kjøringen har ingen
 * innlogget bruker, men en delt nøkkel fra GitHub Actions.
 */
function schedulerEllerAdmin(request) {
    const konfigurert = String(process.env.SCHEDULER_KEY || '').trim();
    const gitt = request.headers.get('x-scheduler-key');
    if (konfigurert && gitt === konfigurert) return { upn: 'scheduler' };
    return admin(request);
}

app.http('teamSynkStatus', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'team-synk',
    handler: async (request, context) => {
        const a = admin(request);
        if (a.svar) return a.svar;
        try {
            const alle = await gruppeStorage.hentAlle();
            return { jsonBody: { grupper: alle.filter(teamSynk.harTeam) } };
        } catch (e) {
            context.log('team-synk status FEIL:', e.message);
            return avvis(500, 'Kunne ikke hente status');
        }
    }
});

app.http('teamSynkSettTeam', {
    methods: ['PUT'],
    authLevel: 'anonymous',
    route: 'team-synk/{rolle}',
    handler: async (request, context) => {
        const a = admin(request);
        if (a.svar) return a.svar;
        try {
            const rolle = String(request.params.rolle || '');
            const body = await request.json().catch(() => ({}));
            const omfang = String(body?.omfang || '');
            const team = String(body?.team || '').trim();
            // undefined når klienten ikke sendte feltet — da skal den stå.
            const eierRolle = body?.eierRolle === undefined ? undefined : String(body.eierRolle || '').trim();
            if (!rolle) return avvis(400, 'Mangler rolle');

            await gruppeStorage.settTeam(rolle, omfang, team, eierRolle);
            context.log(`team-synk: ${a.upn} satte team="${team}" på ${rolle}(${omfang})`);
            try {
                await hendelser.logg({
                    Type: 'team.kobling', Aktor: a.upn,
                    ObjektType: 'rollegruppe', ObjektId: `${rolle}${omfang ? `(${omfang})` : ''}`,
                    Melding: (team ? `Koblet til team "${team}"` : 'Team-kobling fjernet')
                        + (eierRolle ? `, eier-rolle "${eierRolle}"` : '')
                });
            } catch (_) { /* logging skal ikke velte lagringen */ }
            return { jsonBody: { status: 'ok', team, eierRolle } };
        } catch (e) {
            context.log('team-synk sett-team FEIL:', e.message);
            return avvis(500, 'Kunne ikke lagre');
        }
    }
});

app.http('teamSynkEn', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'team-synk/{rolle}',
    handler: async (request, context) => {
        const a = schedulerEllerAdmin(request);
        if (a.svar) return a.svar;
        try {
            const rolle = String(request.params.rolle || '');
            const body = await request.json().catch(() => ({}));
            const omfang = String(body?.omfang || '');
            // «Kjør likevel» er en handling en administrator gjør bevisst
            // etter å ha sett avviket. Den daglige kjøringen skal aldri kunne
            // overstyre sperren — da ville den ikke vært en sperre.
            const tillatFall = body?.tillatFall === true && a.upn !== 'scheduler';

            const gruppe = await gruppeStorage.hent(rolle, omfang);
            if (!gruppe || !teamSynk.harTeam(gruppe)) {
                return avvis(404, 'Rollegruppen har ingen team-kobling');
            }
            const res = await synkroniserGruppe(gruppe, {
                tillatFall, aktor: a.upn, log: (m) => context.log(m)
            });
            return { jsonBody: res };
        } catch (e) {
            context.log('team-synk én FEIL:', e.message);
            return avvis(500, e.message || 'Synkronisering feilet');
        }
    }
});

app.http('teamSynkAlle', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'team-synk',
    handler: async (request, context) => {
        const a = schedulerEllerAdmin(request);
        if (a.svar) return a.svar;
        // Bokføringen bor i jobbmodulen, slik at timeren i dev og denne veien
        // gir admin-panelet SAMME bilde av samme kjøring.
        const res = await kjorTeamSynk({ kilde: a.upn, log: (m) => context.log(m) });
        if (res.kastet) return avvis(500, 'Synkronisering feilet');
        return {
            jsonBody: {
                status: res.utfall === 'ok' ? 'ok' : res.utfall,
                kjort: res.kjort, stoppet: res.stoppet, resultater: res.resultater
            }
        };
    }
});

// ==================== TIMER-TRIGGER (steg 5) ====================
//
// Samme vakt og samme form som de andre jobbene. Tidspunktet står i
// lib/jobber.js, og testen krever at det er cron-en i team-synk.yml med et
// sekundfelt foran.
//
// **FLYTEN OPPDATERER TEAMET DESTRUKTIVT**, og timeren sender derfor ALDRI
// `tillatFall`. Den overstyrer sperren mot store fall i medlemstall, og en
// overstyring uten at et menneske har sett tallet er nettopp det sperren
// finnes for å hindre. Veien dit går gjennom POST /api/team-synk/{rolle}.
if (stotterTimere()) {
    const jobbDef = jobbForId('team-synk');
    const valgt = jobbSchedule(jobbDef);
    if (valgt.avvist) console.warn(`team-synk-timer: avviste «${valgt.avvist}» — ${valgt.grunn}`);
    else if (valgt.kilde !== 'standard') console.log(`team-synk-timer: schedule fra ${valgt.kilde}: ${valgt.schedule}`);

    meldTimer('team-synk', 'teamSynkTimer', valgt.schedule);
    app.timer('teamSynkTimer', {
        schedule: valgt.schedule,
        handler: async (timer, context) => {
            const log = (m) => context.log(m);
            if (timer?.isPastDue) log('team-synk-timer: forsinket kjøring');
            await kjorTeamSynk({ kilde: 'timer', log });
        }
    });
}
