/**
 * Gevinstoppfølging — nullpunktstatus.
 *
 *   GET /api/gevinst/nullpunkt-status
 *     Auth: innlogget. Hvilke skjematyper som har registrert nullpunkt.
 *     Brukes av skjemaoversikten til å merke de som mangler, og av editoren
 *     når en skjematype settes i produksjon.
 *
 * Én spørring dekker hele oversikten. Alternativet — å sjekke per skjematype —
 * ville gitt én tabellskanning per rad i lista.
 */
const { app } = require('@azure/functions');
const { hentInnloggetUpn } = require('../lib/auth');
const gevinstSjekk = require('../lib/gevinst-sjekk');

app.http('gevinstNullpunktStatus', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'gevinst/nullpunkt-status',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        try {
            const res = await gevinstSjekk.hentDekkede();
            return { jsonBody: res };
        } catch (e) {
            context.log('gevinst/nullpunkt-status FEIL:', e.message);
            // Merkingen er en påminnelse, ikke en tilgangskontroll. Feiler den,
            // skal oversikten fortsatt komme opp — bare uten merker.
            return { jsonBody: { konfigurert: false, baselineTypeId: null, dekkede: [], feil: e.message } };
        }
    }
});
