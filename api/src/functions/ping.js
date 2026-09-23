const { app } = require('@azure/functions');

/**
 * GET /api/ping — helsecheck. Anonym.
 *
 * Svarer også med byggstempelet: hvilken commit API-et faktisk kjører.
 *
 * Det feltet kom 23.09.2026, etter en time brukt på å avgjøre om en rettelse
 * var ute i miljøet. Deploy-jobben var grønn, koden så riktig ut, og
 * API-svaret så gammelt ut — og ingenting kunne skille «ikke deployet» fra
 * «deployet, men feil». Sammenlign `commit` her med `BUILD.commit` i
 * /js/config.js: er de ulike, henger den ene etter.
 *
 * versjon.json skrives av scripts/build-config.js ved deploy og er derfor
 * ikke sjekket inn. Mangler den, kjører vi utenfor en deploy — og da er
 * 'ukjent' det ærlige svaret, ikke en gjetning.
 */
let bygg = { commit: 'ukjent' };
try {
    bygg = require('../versjon.json');
} catch (_) { /* ingen deploy har skrevet den */ }

app.http('ping', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'ping',
    handler: async (request, context) => {
        return {
            jsonBody: {
                status: 'ok',
                tid: new Date().toISOString(),
                miljø: process.env.MILJO || 'ukjent',
                bygg
            }
        };
    }
});
