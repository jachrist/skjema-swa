/**
 * Team-synkronisering fra rollegrupper (TODO 71).
 *
 *   GET  /api/team-synk            — status for alle grupper med team-kobling
 *   POST /api/team-synk            — kjør alle. Scheduler eller admin.
 *   POST /api/team-synk/{rolle}    — kjør én gruppe. { omfang, tillatFall }
 *   PUT  /api/team-synk/{rolle}    — sett team-koblingen. { omfang, team }
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
const rollerStorage = require('../lib/roller-storage');
const gruppeStorage = require('../lib/rollegruppe-storage');
const teamSynk = require('../lib/team-synk');
const { kallTeamSynkFlyt, miljo } = require('../lib/flyt-kaller');
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

/**
 * Kjør synkroniseringen for én gruppe.
 *
 * Returnerer alltid et resultatobjekt, aldri et kast: kalleren kjører mange
 * grupper etter hverandre, og én gruppe som feiler skal ikke ta med seg
 * resten.
 */
async function synkroniserGruppe(gruppe, { tillatFall = false, aktor = 'scheduler', log = () => {} }) {
    const { Rolle, Omfang, Team } = gruppe;
    const merkelapp = `${Rolle}${Omfang ? `(${Omfang})` : ''}`;

    const rolleStreng = Omfang ? `${Rolle}(${Omfang})` : Rolle;
    const innehavere = await rollerStorage.hentInnehavere(rolleStreng);
    const upner = teamSynk.upnListe(innehavere);

    const dom = teamSynk.vurderSynk({
        antallNaa: upner.length,
        forrigeAntall: gruppe.SisteAntall,
        tillatFall
    });

    if (!dom.ok) {
        log(`team-synk: ${merkelapp} STOPPET (${dom.grunn}) — ${dom.melding}`);
        await gruppeStorage.settResultat(Rolle, Omfang, { status: 'stoppet', melding: dom.melding });
        try {
            await hendelser.logg({
                Type: 'team.synk.stoppet', Aktor: aktor,
                ObjektType: 'rollegruppe', ObjektId: merkelapp,
                Melding: `${dom.grunn}: ${dom.melding}`
            });
        } catch (_) { /* logging skal ikke velte kjøringen */ }
        return { rolle: Rolle, omfang: Omfang, team: Team, status: 'stoppet', grunn: dom.grunn, antall: upner.length, melding: dom.melding };
    }

    const payload = teamSynk.byggPayload({
        rolle: Rolle, omfang: Omfang, team: Team, upner, miljo: miljo()
    });
    const res = await kallTeamSynkFlyt(payload, log);

    // `SisteAntall` oppdateres bare ved 'ok' — se rollegruppe-storage.js for
    // hvorfor en stoppet kjøring ikke får flytte grunnlaget for fall-sperren.
    await gruppeStorage.settResultat(Rolle, Omfang, {
        status: res.status === 'ok' ? 'ok' : res.status,
        melding: res.melding || dom.grunn,
        antall: upner.length
    });
    try {
        await hendelser.logg({
            Type: res.status === 'ok' ? 'team.synk.ok' : 'team.synk.feil', Aktor: aktor,
            ObjektType: 'rollegruppe', ObjektId: merkelapp,
            Melding: `${upner.length} medlemmer → "${Team}" (${res.status}${dom.grunn === 'stort-fall-overstyrt' ? ', fall overstyrt' : ''})`
        });
    } catch (_) { /* logging skal ikke velte kjøringen */ }

    return {
        rolle: Rolle, omfang: Omfang, team: Team,
        status: res.status, grunn: dom.grunn, antall: upner.length,
        melding: res.melding || ''
    };
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
            if (!rolle) return avvis(400, 'Mangler rolle');

            await gruppeStorage.settTeam(rolle, omfang, team);
            context.log(`team-synk: ${a.upn} satte team="${team}" på ${rolle}(${omfang})`);
            try {
                await hendelser.logg({
                    Type: 'team.kobling', Aktor: a.upn,
                    ObjektType: 'rollegruppe', ObjektId: `${rolle}${omfang ? `(${omfang})` : ''}`,
                    Melding: team ? `Koblet til team "${team}"` : 'Team-kobling fjernet'
                });
            } catch (_) { /* logging skal ikke velte lagringen */ }
            return { jsonBody: { status: 'ok', team } };
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
        try {
            const grupper = (await gruppeStorage.hentAlle()).filter(teamSynk.harTeam);
            if (grupper.length === 0) {
                return { jsonBody: { status: 'ok', kjort: 0, resultater: [] } };
            }
            const resultater = [];
            for (const g of grupper) {
                try {
                    resultater.push(await synkroniserGruppe(g, {
                        aktor: a.upn, log: (m) => context.log(m)
                    }));
                } catch (e) {
                    // Én gruppe som feiler skal ikke stoppe de andre.
                    context.log(`team-synk: ${g.Rolle}(${g.Omfang}) kastet — ${e.message}`);
                    resultater.push({ rolle: g.Rolle, omfang: g.Omfang, status: 'feil', melding: e.message });
                }
            }
            const stoppet = resultater.filter(r => r.status === 'stoppet').length;
            context.log(`team-synk: ${resultater.length} grupper, ${stoppet} stoppet`);
            return { jsonBody: { status: 'ok', kjort: resultater.length, stoppet, resultater } };
        } catch (e) {
            context.log('team-synk alle FEIL:', e.message);
            return avvis(500, 'Synkronisering feilet');
        }
    }
});
