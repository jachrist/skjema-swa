/**
 * Rollekilde for Static Web Apps.
 *
 *   POST /api/roller-swa   →  { "roles": ["admin"] }
 *
 * SWA kaller dette endepunktet én gang ved innlogging, og legger rollene det
 * svarer med inn i brukerens principal. Det er DE rollene `allowedRoles` i
 * staticwebapp.config.json sjekker mot — ikke ADMIN_UPNS, og ikke rollene våre
 * i Rollemedlemskap-tabellen.
 *
 * Uten denne har ingen rollen «admin», og ruter som krever den er stengt for
 * alle. Det var nettopp det som skjedde da konfigurasjonen endelig trådte i
 * kraft 02.09.2026: /admin.html ble utilgjengelig også for administratorer.
 *
 * Kilden til sannhet er fortsatt ADMIN_UPNS, den samme env-varen `erAdmin()`
 * bruker i handlerne. Da kan de to lagene ikke komme i utakt.
 *
 * Kalles server-til-server av SWA-plattformen, ikke fra nettleseren, og må
 * derfor være anonym i ruteoppsettet. Payloaden er formet av plattformen:
 *   { identityProvider, userId, userDetails, claims: [{ typ, val }] }
 */
const { app } = require('@azure/functions');
const { erAdmin } = require('../lib/auth');

/**
 * Rollene en bruker skal ha, ut fra det SWA forteller om identiteten.
 *
 * Eksportert for test — dette er sikkerhetsrelevant logikk, og den skal ikke
 * kunne endres uten at noe sier fra.
 */
function rollerFor(bruker) {
    const upn = String(bruker?.userDetails || '').trim();
    if (!upn) return [];
    return erAdmin(upn) ? ['admin'] : [];
}

app.http('rollerSwa', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'roller-swa',
    handler: async (request, context) => {
        try {
            const bruker = await request.json();
            const roller = rollerFor(bruker);
            // Én linje per kall, også når svaret er tomt.
            //
            // Til 15.09.2026 ble bare treff logget. Da sto det ingenting i
            // loggen når noen ikke fikk rollen — og «ingen linje» kunne bety
            // både at kallet aldri kom fram og at det kom fram uten treff. Det
            // er to helt ulike feil: den ene ligger i konfigurasjonen, den
            // andre i ADMIN_UPNS.
            //
            // Kostnaden er én linje per innlogging. Den dagen rollen mangler,
            // er det denne linjen som sier hvilken av de to det er.
            context.log(
                `roller-swa: ${bruker?.userDetails || '(ingen userDetails)'}`
                + ` → ${roller.length > 0 ? roller.join(', ') : 'ingen roller'}`
            );
            return { jsonBody: { roles: roller } };
        } catch (e) {
            // Feiler dette, logger SWA brukeren inn uten ekstra roller. Det er
            // riktig retning å feile i: ingen får mer tilgang enn de skal.
            context.log('roller-swa FEIL:', e.message);
            return { jsonBody: { roles: [] } };
        }
    }
});

module.exports = { _rollerFor: rollerFor };
