/**
 * Logo-endepunkter.
 *
 *   GET  /api/logoer                 — list alle (authenticated). Editor + admin.
 *   POST /api/logoer                 — last opp (admin). multipart/form-data med 'fil'.
 *   DELETE /api/logoer/{filnavn}     — slett (admin).
 *   GET  /api/logo/{filnavn}         — server bilde-bytes (anonymous — brukes i skjema-headere).
 */
const { app } = require('@azure/functions');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');
const logoStorage = require('../lib/logo-storage');
const hendelser = require('../lib/hendelser-storage');

const MAX_LOGO_STORRELSE = 2 * 1024 * 1024; // 2 MB

app.http('logoerList', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'logoer',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        try {
            const liste = await logoStorage.listAlle();
            return { jsonBody: liste.map(l => ({ ...l, url: `/api/logo/${encodeURIComponent(l.navn)}` })) };
        } catch (e) {
            context.log('logoer GET FEIL:', e.message);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('logoerOpplast', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'logoer',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        if (!erAdmin(upn)) return { status: 403, jsonBody: { status: 'feil', melding: 'Krever admin' } };

        try {
            const formData = await request.formData();
            const fil = formData.get('fil');
            if (!fil || typeof fil === 'string') {
                return { status: 400, jsonBody: { status: 'feil', melding: 'Ingen fil sendt (må hete "fil")' } };
            }
            if (!logoStorage.erGyldigFiltype(fil.name)) {
                return { status: 400, jsonBody: { status: 'feil', melding: `Ugyldig filtype (tillatte: ${logoStorage.TILLATTE_EXT.join(', ')})` } };
            }
            const buffer = Buffer.from(await fil.arrayBuffer());
            if (buffer.length > MAX_LOGO_STORRELSE) {
                return { status: 413, jsonBody: { status: 'feil', melding: `For stor (maks ${MAX_LOGO_STORRELSE / 1024 / 1024} MB)` } };
            }
            const res = await logoStorage.opplast(fil.name, buffer);
            context.log(`logoer: ${upn} lastet opp "${fil.name}" (${buffer.length} bytes)`);
            hendelser.logg({
                Type: 'logo.opplast', Aktor: upn,
                ObjektType: 'logo', ObjektId: fil.name,
                Melding: `Lastet opp logo "${fil.name}" (${buffer.length} bytes)`
            });
            return { jsonBody: { status: 'ok', ...res, url: `/api/logo/${encodeURIComponent(fil.name)}` } };
        } catch (e) {
            context.log('logoer POST FEIL:', e.message);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('logoerSlett', {
    methods: ['DELETE'],
    authLevel: 'anonymous',
    route: 'logoer/{filnavn}',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        if (!erAdmin(upn)) return { status: 403, jsonBody: { status: 'feil', melding: 'Krever admin' } };

        try {
            const filnavn = request.params.filnavn;
            const slettet = await logoStorage.slett(filnavn);
            if (!slettet) return { status: 404, jsonBody: { status: 'feil', melding: 'Logo ikke funnet' } };
            context.log(`logoer: ${upn} slettet "${filnavn}"`);
            hendelser.logg({
                Type: 'logo.slett', Aktor: upn,
                ObjektType: 'logo', ObjektId: filnavn,
                Melding: `Slettet logo "${filnavn}"`
            });
            return { jsonBody: { status: 'ok' } };
        } catch (e) {
            context.log('logoer DELETE FEIL:', e.message);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('logoHent', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'logo/{filnavn}',
    handler: async (request, context) => {
        try {
            const res = await logoStorage.hent(request.params.filnavn);
            if (!res) return { status: 404, body: 'Not found' };
            return {
                body: res.buffer,
                headers: {
                    'Content-Type': res.contentType,
                    'Cache-Control': 'public, max-age=31536000'
                }
            };
        } catch (e) {
            context.log('logo GET FEIL:', e.message);
            return { status: 500, body: 'Feil ved henting av logo' };
        }
    }
});
