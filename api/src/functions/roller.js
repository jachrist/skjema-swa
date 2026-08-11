/**
 * Rolle-endepunkter.
 *
 *   GET  /api/roller/grupper                  — liste distinkte (Rolle, Omfang) med antall
 *   GET  /api/roller/innehavere?rolle=X       — hentInnehavere for en rolle-streng
 *   POST /api/roller/leggtil                  — admin: legg til innehaver
 *   POST /api/roller/fjern                    — admin: fjern innehaver
 *
 * Alle innloggede kan lese. Kun admin kan endre.
 */
const { app } = require('@azure/functions');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');
const rollerStorage = require('../lib/roller-storage');
const hendelser = require('../lib/hendelser-storage');

app.http('rollerGrupper', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'roller/grupper',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        try {
            return { jsonBody: await rollerStorage.hentAlleGrupper() };
        } catch (e) {
            context.log('roller/grupper FEIL:', e.message);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('rollerInnehavere', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'roller/innehavere',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        try {
            const rolle = request.query.get('rolle');
            if (!rolle) return { status: 400, jsonBody: { status: 'feil', melding: 'rolle-param mangler' } };
            return { jsonBody: await rollerStorage.hentInnehavere(rolle) };
        } catch (e) {
            context.log('roller/innehavere FEIL:', e.message);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('rollerLeggTil', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'roller/leggtil',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        if (!erAdmin(upn)) return { status: 403, jsonBody: { status: 'avvist', melding: 'Krever admin-tilgang' } };
        try {
            const body = await request.json();
            await rollerStorage.leggTilInnehaver(body);
            context.log(`roller: ${upn} la til ${body.UPN} som ${body.Rolle}${body.Omfang ? '(' + body.Omfang + ')' : ''}`);
            hendelser.logg({
                Type: 'rolle.leggtil', Aktor: upn,
                ObjektType: 'rolle', ObjektId: `${body.Rolle}${body.Omfang ? '(' + body.Omfang + ')' : ''}`,
                Melding: `La til ${body.UPN} i ${body.Rolle}${body.Omfang ? '(' + body.Omfang + ')' : ''}`,
                Detaljer: { rolle: body.Rolle, omfang: body.Omfang || '', upn: body.UPN }
            });
            return { jsonBody: { status: 'ok' } };
        } catch (e) {
            context.log('roller/leggtil FEIL:', e.message);
            return { status: 400, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('rollerSeed', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'roller/seed',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        if (!erAdmin(upn)) return { status: 403, jsonBody: { status: 'avvist', melding: 'Krever admin-tilgang' } };
        try {
            // Legger inn eksempler med admin sin UPN som innehaver — enkelt for demo
            const eksempler = [
                { Rolle: 'Emneansvarlig', Omfang: 'CBU2501', UPN: upn, FN: 'Test', EN: 'Innehaver' },
                { Rolle: 'Emneansvarlig', Omfang: 'CBU2502', UPN: upn, FN: 'Test', EN: 'Innehaver' },
                { Rolle: 'Sjef',           Omfang: 'Befalsskolen', UPN: upn, FN: 'Test', EN: 'Innehaver' },
                { Rolle: 'Administrativ godkjenner', Omfang: 'Fagstab', UPN: upn, FN: 'Test', EN: 'Innehaver' },
                { Rolle: 'Kvalitetsmedarbeider', Omfang: 'Kvalitetsarbeid', UPN: upn, FN: 'Test', EN: 'Innehaver' }
            ];
            for (const e of eksempler) await rollerStorage.leggTilInnehaver({ ...e, Kilde: 'seed' });
            context.log(`roller/seed: ${upn} seedet ${eksempler.length} eksempelroller`);
            return { jsonBody: { status: 'ok', antall: eksempler.length } };
        } catch (e) {
            context.log('roller/seed FEIL:', e.message);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('rollerFjern', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'roller/fjern',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        if (!erAdmin(upn)) return { status: 403, jsonBody: { status: 'avvist', melding: 'Krever admin-tilgang' } };
        try {
            const body = await request.json();
            const slettet = await rollerStorage.fjernInnehaver(body);
            if (!slettet) return { status: 404, jsonBody: { status: 'feil', melding: 'Fant ikke innehaver' } };
            context.log(`roller: ${upn} fjernet ${body.UPN} fra ${body.Rolle}${body.Omfang ? '(' + body.Omfang + ')' : ''}`);
            hendelser.logg({
                Type: 'rolle.fjern', Aktor: upn,
                ObjektType: 'rolle', ObjektId: `${body.Rolle}${body.Omfang ? '(' + body.Omfang + ')' : ''}`,
                Melding: `Fjernet ${body.UPN} fra ${body.Rolle}${body.Omfang ? '(' + body.Omfang + ')' : ''}`,
                Detaljer: { rolle: body.Rolle, omfang: body.Omfang || '', upn: body.UPN }
            });
            return { jsonBody: { status: 'ok' } };
        } catch (e) {
            context.log('roller/fjern FEIL:', e.message);
            return { status: 400, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});
