const { app } = require('@azure/functions');

/**
 * GET /api/ping — helsecheck. Anonym.
 */
app.http('ping', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'ping',
    handler: async (request, context) => {
        return {
            jsonBody: {
                status: 'ok',
                tid: new Date().toISOString(),
                miljø: process.env.MILJO || 'ukjent'
            }
        };
    }
});
