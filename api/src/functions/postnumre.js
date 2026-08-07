/**
 * Postnummer-endepunkter.
 *
 *   GET  /api/postnumre/sok?q=X&maks=10   — søk (postnr eller poststed)
 *   POST /api/postnumre/seed              — legger inn eksempeldata (admin)
 *   POST /api/postnumre/import            — importer full liste (admin) — TODO
 */
const { app } = require('@azure/functions');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');
const postnumreStorage = require('../lib/postnumre-storage');

app.http('postnumreSok', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'postnumre/sok',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        try {
            const q = request.query.get('q') || '';
            const maks = Math.min(parseInt(request.query.get('maks') || '10', 10) || 10, 50);
            const treff = await postnumreStorage.sokPostnumre(q, maks);
            return { jsonBody: treff };
        } catch (e) {
            context.log('postnumre/sok FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

// Et minimum sett postnumre for pilot. Erstattes senere med full Bring-import.
const EKSEMPEL_POSTNUMRE = [
    { Postnr: '0010', Poststed: 'OSLO', Kommune: 'Oslo' },
    { Postnr: '0150', Poststed: 'OSLO', Kommune: 'Oslo' },
    { Postnr: '0180', Poststed: 'OSLO', Kommune: 'Oslo' },
    { Postnr: '0250', Poststed: 'OSLO', Kommune: 'Oslo' },
    { Postnr: '0350', Poststed: 'OSLO', Kommune: 'Oslo' },
    { Postnr: '0450', Poststed: 'OSLO', Kommune: 'Oslo' },
    { Postnr: '0550', Poststed: 'OSLO', Kommune: 'Oslo' },
    { Postnr: '0850', Poststed: 'OSLO', Kommune: 'Oslo' },
    { Postnr: '1300', Poststed: 'SANDVIKA', Kommune: 'Bærum' },
    { Postnr: '1440', Poststed: 'DRØBAK', Kommune: 'Frogn' },
    { Postnr: '1750', Poststed: 'HALDEN', Kommune: 'Halden' },
    { Postnr: '2000', Poststed: 'LILLESTRØM', Kommune: 'Lillestrøm' },
    { Postnr: '2317', Poststed: 'HAMAR', Kommune: 'Hamar' },
    { Postnr: '3005', Poststed: 'DRAMMEN', Kommune: 'Drammen' },
    { Postnr: '3120', Poststed: 'TØNSBERG', Kommune: 'Tønsberg' },
    { Postnr: '4013', Poststed: 'STAVANGER', Kommune: 'Stavanger' },
    { Postnr: '4614', Poststed: 'KRISTIANSAND S', Kommune: 'Kristiansand' },
    { Postnr: '5003', Poststed: 'BERGEN', Kommune: 'Bergen' },
    { Postnr: '5020', Poststed: 'BERGEN', Kommune: 'Bergen' },
    { Postnr: '5231', Poststed: 'PARADIS', Kommune: 'Bergen' },
    { Postnr: '6002', Poststed: 'ÅLESUND', Kommune: 'Ålesund' },
    { Postnr: '7010', Poststed: 'TRONDHEIM', Kommune: 'Trondheim' },
    { Postnr: '7020', Poststed: 'TRONDHEIM', Kommune: 'Trondheim' },
    { Postnr: '8003', Poststed: 'BODØ', Kommune: 'Bodø' },
    { Postnr: '9008', Poststed: 'TROMSØ', Kommune: 'Tromsø' }
];

app.http('postnumreSeed', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'postnumre/seed',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        if (!erAdmin(upn)) return { status: 403, jsonBody: { status: 'avvist', melding: 'Krever admin-tilgang' } };
        try {
            await postnumreStorage.upsertBatch(EKSEMPEL_POSTNUMRE);
            context.log(`postnumre/seed: ${upn} seedet ${EKSEMPEL_POSTNUMRE.length} postnumre`);
            return { jsonBody: { status: 'ok', antall: EKSEMPEL_POSTNUMRE.length } };
        } catch (e) {
            context.log('postnumre/seed FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});
