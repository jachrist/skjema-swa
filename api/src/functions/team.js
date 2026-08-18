/**
 * Team-endepunkter.
 *
 *   GET  /api/cache/teammedlemskap/team-navn      — list alle kjente team (auth)
 *   GET  /api/cache/teammedlemskap/{team}/medlemmer — list medlemmer (auth)
 *   POST /api/cache/teammedlemskap                — batch-erstatt (admin eller x-flow-key)
 *                                                   Kalles av PA-cron/lazy-load-flyter
 *   DELETE /api/cache/teammedlemskap/{team}       — slett hele teamet (admin)
 *
 *   POST /api/team/sok-eksternt                   — proxy foran TEAM_SOK_EKSTERNT_FLOW_URL
 *   POST /api/team/last-medlemmer                 — proxy foran TEAM_LAST_MEDLEMMER_FLOW_URL,
 *                                                   cacher resultatet i Teammedlemskap
 */
const { app } = require('@azure/functions');
const crypto = require('crypto');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');
const teamStorage = require('../lib/team-storage');
const hendelser = require('../lib/hendelser-storage');

function autorisert(request) {
    // Både innlogget bruker OG (PA-flyt med x-flow-key) tillates
    const konfigurert = String(process.env.FLOW_CALLBACK_KEY || '').trim();
    const gitt = request.headers.get('x-flow-key') || '';
    if (konfigurert && gitt.length === konfigurert.length) {
        try {
            if (crypto.timingSafeEqual(Buffer.from(gitt), Buffer.from(konfigurert))) {
                return { ok: true, kilde: 'flyt' };
            }
        } catch (_) {}
    }
    const upn = hentInnloggetUpn(request);
    if (upn && erAdmin(upn)) return { ok: true, kilde: upn };
    return { ok: false };
}

app.http('teamNavnList', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'cache/teammedlemskap/team-navn',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        try {
            return { jsonBody: await teamStorage.hentAlleTeamNavn() };
        } catch (e) {
            context.log('team/navn FEIL:', e.message);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('teamMedlemmerHent', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'cache/teammedlemskap/{team}/medlemmer',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        try {
            return { jsonBody: await teamStorage.hentMedlemmer(request.params.team) };
        } catch (e) {
            context.log('team/medlemmer FEIL:', e.message);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('teamErstatt', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'cache/teammedlemskap',
    handler: async (request, context) => {
        const auth = autorisert(request);
        if (!auth.ok) return { status: 401, jsonBody: { status: 'feil', melding: 'Krever admin eller x-flow-key' } };
        try {
            const body = await request.json();
            let grupper;
            if (Array.isArray(body)) grupper = body;
            else if (body && Array.isArray(body.grupper)) grupper = body.grupper;
            else if (body && body.Team) grupper = [body];
            else return { status: 400, jsonBody: { status: 'feil', melding: 'Forventet { Team, Medlemmer } eller array' } };

            const res = await teamStorage.erstattBatch(grupper);
            hendelser.logg({
                Type: 'team.oppdatert', Aktor: auth.kilde,
                ObjektType: 'team', ObjektId: (res.resultater[0]?.Team || '(batch)'),
                Melding: `Oppdaterte ${res.antallTeam} team`,
                Detaljer: res
            });
            return { jsonBody: { status: 'ok', ...res } };
        } catch (e) {
            context.log('team/erstatt FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('teamSlett', {
    methods: ['DELETE'],
    authLevel: 'anonymous',
    route: 'cache/teammedlemskap/{team}',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        if (!erAdmin(upn)) return { status: 403, jsonBody: { status: 'feil', melding: 'Krever admin' } };
        try {
            const slettet = await teamStorage.slettTeam(request.params.team);
            hendelser.logg({
                Type: 'team.slett', Aktor: upn,
                ObjektType: 'team', ObjektId: request.params.team,
                Melding: `Slettet team "${request.params.team}" (${slettet} medlemskap fjernet)`
            });
            return { jsonBody: { status: 'ok', antallSlettet: slettet } };
        } catch (e) {
            context.log('team/slett FEIL:', e.message);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

/**
 * POST /api/team/sok-eksternt — tynn proxy foran TEAM_SOK_EKSTERNT_FLOW_URL.
 * PA-flyten søker i Graph og returnerer matchende team.
 */
app.http('teamSokEksternt', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'team/sok-eksternt',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        const flytUrl = String(process.env.TEAM_SOK_EKSTERNT_FLOW_URL || '').trim();
        if (!flytUrl) return { status: 503, jsonBody: { status: 'feil', melding: 'TEAM_SOK_EKSTERNT_FLOW_URL ikke satt' } };
        try {
            const body = await request.json();
            const sok = String(body?.sok || '').trim();
            if (!sok) return { status: 400, jsonBody: { status: 'feil', melding: 'Forventet { sok: string }' } };
            const resp = await fetch(flytUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sok })
            });
            if (!resp.ok) {
                const tekst = await resp.text().catch(() => '');
                return { status: resp.status, jsonBody: { status: 'feil', melding: `PA-flyt HTTP ${resp.status}`, detaljer: tekst.slice(0, 500) } };
            }
            const treff = await resp.json();
            return { jsonBody: Array.isArray(treff) ? treff : (treff?.treff || []) };
        } catch (e) {
            context.log('team/sok-eksternt FEIL:', e.message);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

/**
 * POST /api/team/last-medlemmer — henter medlemmer fra PA-flyt og cacher.
 * Body: { teamId?, teamNavn }
 */
app.http('teamLastMedlemmer', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'team/last-medlemmer',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        const flytUrl = String(process.env.TEAM_LAST_MEDLEMMER_FLOW_URL || '').trim();
        if (!flytUrl) return { status: 503, jsonBody: { status: 'feil', melding: 'TEAM_LAST_MEDLEMMER_FLOW_URL ikke satt' } };
        try {
            const body = await request.json();
            const teamId = String(body?.teamId || '').trim();
            const teamNavn = String(body?.teamNavn || '').trim();
            if (!teamId && !teamNavn) return { status: 400, jsonBody: { status: 'feil', melding: 'Forventet { teamId, teamNavn }' } };

            const resp = await fetch(flytUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ teamId, teamNavn })
            });
            if (!resp.ok) {
                const tekst = await resp.text().catch(() => '');
                return { status: resp.status, jsonBody: { status: 'feil', melding: `PA-flyt HTTP ${resp.status}`, detaljer: tekst.slice(0, 500) } };
            }
            const flytSvar = await resp.json().catch(() => ({}));
            // erstattTeam pakker selv ut { value: [...] } / { Medlemmer: [...] }
            const medlemmer = flytSvar;

            const res = await teamStorage.erstattTeam(teamNavn, medlemmer, { append: false });
            hendelser.logg({
                Type: 'team.lazy-lastet', Aktor: upn,
                ObjektType: 'team', ObjektId: teamNavn,
                Melding: `Lastet ${res.antallMedlemmer} medlemmer for team "${teamNavn}" (lazy-cache)`,
                Detaljer: { teamId, teamNavn }
            });
            return { jsonBody: { status: 'ok', ...res } };
        } catch (e) {
            context.log('team/last-medlemmer FEIL:', e.message);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});
