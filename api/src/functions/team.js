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
    // Trim også den innkommende — PA legger lett på linjeskift når verdien
    // kommer fra en variabel eller Compose.
    const gitt = String(request.headers.get('x-flow-key') || '').trim();

    if (gitt) {
        if (!konfigurert) return { ok: false, grunn: 'FLOW_CALLBACK_KEY er ikke satt på serveren' };
        // Hash før sammenligning: da er lengdene alltid like, og timingSafeEqual
        // kan brukes uten å kreve at nøklene er like lange på forhånd.
        const a = crypto.createHash('sha256').update(gitt).digest();
        const b = crypto.createHash('sha256').update(konfigurert).digest();
        if (crypto.timingSafeEqual(a, b)) return { ok: true, kilde: 'flyt' };
        return { ok: false, grunn: 'x-flow-key stemmer ikke med FLOW_CALLBACK_KEY' };
    }

    const upn = hentInnloggetUpn(request);
    if (upn && erAdmin(upn)) return { ok: true, kilde: upn };
    return { ok: false, grunn: upn ? 'Krever admin' : 'Mangler x-flow-key, og ingen innlogget bruker' };
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
        if (!auth.ok) return { status: 401, jsonBody: { status: 'feil', melding: auth.grunn || 'Krever admin eller x-flow-key' } };
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
 * Kall en PA-flyt og gi et svar som sier hva som faktisk skjedde.
 *
 * SWA-gatewayen kutter forbindelsen etter ~45 sekunder. En flyt som bruker
 * lengre tid ga tidligere 502 fra gatewayen — uten kropp, uten logglinje, og
 * uten noe som skilte «flyten svarte ikke» fra «flyten svarte med en feil».
 * Vi avbryter derfor selv i god tid før, og skiller kildene i svaret:
 *
 *   kilde: 'pa-flyt' — flyten svarte, men med feil status eller ikke-JSON
 *   kilde: 'proxy'   — vi nådde ikke fram, eller ga opp å vente (504)
 *
 * Vertsnavnet tas med fordi det skiller en flyt i riktig miljø fra en som
 * fortsatt peker på dev. Signaturen i query-strengen logges aldri.
 */
const FLYT_TIMEOUT_MS = 35000;

function flytVertsnavn(flytUrl) {
    try { return new URL(flytUrl).hostname; } catch (_) { return 'ugyldig-url'; }
}

async function kallFlyt(navn, flytUrl, payload, context) {
    const start = Date.now();
    const vertsnavn = flytVertsnavn(flytUrl);
    const avbryt = new AbortController();
    const timer = setTimeout(() => avbryt.abort(), FLYT_TIMEOUT_MS);
    try {
        const resp = await fetch(flytUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: avbryt.signal
        });
        const tekst = await resp.text().catch(() => '');
        const ms = Date.now() - start;

        if (!resp.ok) {
            context.log(`${navn}: PA-flyt (${vertsnavn}) svarte HTTP ${resp.status} etter ${ms} ms — ${tekst.slice(0, 300)}`);
            return { ok: false, svar: { status: resp.status, jsonBody: {
                status: 'feil', kilde: 'pa-flyt', vertsnavn, ms,
                melding: `PA-flyten svarte HTTP ${resp.status}`,
                detaljer: tekst.slice(0, 500)
            } } };
        }

        try {
            const data = tekst ? JSON.parse(tekst) : null;
            context.log(`${navn}: PA-flyt (${vertsnavn}) OK etter ${ms} ms, ${tekst.length} tegn`);
            return { ok: true, data, ms };
        } catch (_) {
            // En flyt uten Response-handling svarer 202 med tom kropp, og en
            // som feiler i selve triggeren kan svare HTML. Begge deler ser ut
            // som suksess på statuskoden, så innholdet må vises fram.
            context.log(`${navn}: PA-flyt (${vertsnavn}) svarte ${resp.status} med ikke-JSON etter ${ms} ms — ${tekst.slice(0, 300)}`);
            return { ok: false, svar: { status: 502, jsonBody: {
                status: 'feil', kilde: 'pa-flyt', vertsnavn, ms,
                melding: tekst.trim()
                    ? 'PA-flyten svarte med noe annet enn JSON — mangler den en Response-handling?'
                    : 'PA-flyten svarte med tom kropp — mangler den en Response-handling?',
                detaljer: tekst.slice(0, 500)
            } } };
        }
    } catch (e) {
        const ms = Date.now() - start;
        const avbrutt = e.name === 'AbortError';
        context.log(`${navn}: ${avbrutt ? 'TIMEOUT' : 'FEIL'} mot PA-flyt (${vertsnavn}) etter ${ms} ms — ${e.message}`);
        return { ok: false, svar: { status: avbrutt ? 504 : 502, jsonBody: {
            status: 'feil', kilde: 'proxy', vertsnavn, ms,
            melding: avbrutt
                ? `PA-flyten svarte ikke innen ${FLYT_TIMEOUT_MS / 1000} sekunder. Sjekk kjørehistorikken i flyten — kjører den fortsatt, må den svare raskere enn SWA-gatewayen tåler.`
                : `Fikk ikke kontakt med PA-flyten: ${e.message}`
        } } };
    } finally {
        clearTimeout(timer);
    }
}

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
            const res = await kallFlyt('team/sok-eksternt', flytUrl, { sok }, context);
            if (!res.ok) return res.svar;
            const treff = res.data;
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

            const res0 = await kallFlyt('team/last-medlemmer', flytUrl, { teamId, teamNavn }, context);
            if (!res0.ok) return res0.svar;
            // erstattTeam pakker selv ut { value: [...] } / { Medlemmer: [...] }
            const medlemmer = res0.data || {};

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
