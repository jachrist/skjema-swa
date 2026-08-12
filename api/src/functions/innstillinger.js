/**
 * SystemInnstillinger — admin-only key/value konfig som lagres i storage
 * (i motsetning til env-vars som må endres i Azure Portal).
 *
 *   GET  /api/innstillinger              — list alle (admin)
 *   GET  /api/innstillinger/{nokkel}     — hent én (admin)
 *   POST /api/innstillinger              — upsert { Nokkel, Verdi } (admin)
 *   DELETE /api/innstillinger/{nokkel}   — slett (admin)
 */
const { app } = require('@azure/functions');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');
const innstillinger = require('../lib/innstillinger-storage');
const hendelser = require('../lib/hendelser-storage');

function admin(request) {
    const upn = hentInnloggetUpn(request);
    if (!upn) return { ok: false, status: 401, melding: 'Ikke innlogget' };
    if (!erAdmin(upn)) return { ok: false, status: 403, melding: 'Krever admin' };
    return { ok: true, upn };
}

app.http('innstillingerList', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'innstillinger',
    handler: async (request, context) => {
        const a = admin(request);
        if (!a.ok) return { status: a.status, jsonBody: { status: 'feil', melding: a.melding } };
        try {
            return { jsonBody: await innstillinger.listAlle() };
        } catch (e) {
            context.log('innstillinger GET FEIL:', e.message);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('innstillingerHent', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'innstillinger/{nokkel}',
    handler: async (request, context) => {
        const a = admin(request);
        if (!a.ok) return { status: a.status, jsonBody: { status: 'feil', melding: a.melding } };
        try {
            const res = await innstillinger.hent(request.params.nokkel);
            if (!res) return { status: 404, jsonBody: { status: 'feil', melding: 'Ikke funnet' } };
            return { jsonBody: res };
        } catch (e) {
            context.log('innstillinger GET-en FEIL:', e.message);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('innstillingerSett', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'innstillinger',
    handler: async (request, context) => {
        const a = admin(request);
        if (!a.ok) return { status: a.status, jsonBody: { status: 'feil', melding: a.melding } };
        try {
            const body = await request.json();
            const nokkel = String(body?.Nokkel || '').trim();
            if (!nokkel) return { status: 400, jsonBody: { status: 'feil', melding: 'Nokkel mangler' } };
            await innstillinger.sett(nokkel, body.Verdi ?? '', a.upn);
            hendelser.logg({
                Type: 'innstilling.sett', Aktor: a.upn,
                ObjektType: 'innstilling', ObjektId: nokkel,
                Melding: `Satte innstilling "${nokkel}"`
            });
            return { jsonBody: { status: 'ok' } };
        } catch (e) {
            context.log('innstillinger POST FEIL:', e.message);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('innstillingerSlett', {
    methods: ['DELETE'],
    authLevel: 'anonymous',
    route: 'innstillinger/{nokkel}',
    handler: async (request, context) => {
        const a = admin(request);
        if (!a.ok) return { status: a.status, jsonBody: { status: 'feil', melding: a.melding } };
        try {
            const slettet = await innstillinger.slett(request.params.nokkel);
            if (!slettet) return { status: 404, jsonBody: { status: 'feil', melding: 'Ikke funnet' } };
            hendelser.logg({
                Type: 'innstilling.slett', Aktor: a.upn,
                ObjektType: 'innstilling', ObjektId: request.params.nokkel,
                Melding: `Slettet innstilling "${request.params.nokkel}"`
            });
            return { jsonBody: { status: 'ok' } };
        } catch (e) {
            context.log('innstillinger DELETE FEIL:', e.message);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});
