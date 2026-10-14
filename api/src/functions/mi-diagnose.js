const { app } = require('@azure/functions');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');

/**
 * GET /api/diagnose/mi-token?ressurs=<audience> — admin.
 *
 * Svarer på om koden får et managed identity-token, og for hvilken ressurs.
 *
 * To spørsmål avhenger av det, og begge var åpne til 14.10.2026:
 *
 *   **Får koden en MI-token i det hele tatt?** SWA Managed Functions
 *   eksponerer ingen, så `lib/keyvault.js` er død kode og all lagring går via
 *   connection string. Virker det på en Function App, er steg 3 i
 *   `docs/BESLUTNING-EGEN-FUNCTION-APP.md` mulig — storage uten delt nøkkel.
 *
 *   **Kan den få et token for Power Automate?** Da kan flytene kreve Entra i
 *   stedet for SAS-signaturen i URL-en, og hele «lenken er en hemmelighet»-
 *   kategorien forsvinner (svakhet 9.1 i overleveringsdokumentet). Kildene
 *   beskriver app-registrering med client credentials, ikke MI, så dette må
 *   prøves — ikke antas.
 *
 * **Tokenet returneres ALDRI.** Endepunktet svarer på om det kom, når det
 * utløper, og hvilke claims som identifiserer avsenderen — aud, appid, tid,
 * oid. Det er nok til å se at riktig identitet fikk riktig audience, og for
 * lite til å kunne brukes av noen som leser svaret.
 *
 * Diagnoseverktøy. Rives sammen med resten hvis forslaget legges bort.
 */

// SDK-en lastes først ved kall, samme grunn som i storage.js: testene skal
// kunne kjøre uten node_modules.
let DefaultAzureCredential = null;
function legitimasjon() {
    if (!DefaultAzureCredential) {
        ({ DefaultAzureCredential } = require('@azure/identity'));
    }
    return new DefaultAzureCredential();
}

/** Claims som identifiserer AVSENDEREN. Ingen av dem er en hemmelighet. */
const CLAIMS_VI_VISER = ['aud', 'iss', 'appid', 'tid', 'oid', 'exp'];

/**
 * Les claims ut av et JWT uten å verifisere signaturen.
 *
 * Verifisering er unødvendig her: tokenet er nettopp hentet fra plattformens
 * eget identity-endepunkt, og vi bruker det ikke til å gi tilgang til noe.
 * Vi ser bare på hvem det ble utstedt til.
 */
function claimsFra(token) {
    const deler = String(token || '').split('.');
    if (deler.length < 2) return { feil: 'ikke et JWT' };
    try {
        const rå = Buffer.from(deler[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        const alle = JSON.parse(rå);
        const ut = {};
        for (const n of CLAIMS_VI_VISER) if (alle[n] !== undefined) ut[n] = alle[n];
        return ut;
    } catch (e) {
        return { feil: `kunne ikke leses: ${e.message}` };
    }
}

/**
 * Ressurser det er verdt å prøve, med hva et svar betyr.
 *
 * Audience-verdiene er de Azure selv bruker. `https://service.flow.microsoft.com/`
 * er Power Automate; de andre er med fordi de svarer på om MI virker i det
 * hele tatt, og et nei der betyr noe helt annet enn et nei på Flow.
 */
const KJENTE = {
    'https://storage.azure.com/': 'Table og Blob Storage — grunnlaget for steg 3',
    'https://vault.azure.net/': 'Key Vault, hvis koden skal slå opp selv i stedet for via app settings',
    'https://graph.microsoft.com/': 'Microsoft Graph — e-post og SharePoint uten klienthemmelighet',
    'https://service.flow.microsoft.com/': 'Power Automate — flyter med Entra-auth i stedet for SAS i URL-en',
    'https://management.azure.com/': 'ARM. Svarer MI her og ingen andre steder, er det tilgang og ikke token som mangler'
};

app.http('miTokenDiagnose', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'diagnose/mi-token',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!erAdmin(upn)) {
            return { status: 403, jsonBody: { status: 'feil', melding: 'Krever admin' } };
        }

        const ressurs = request.query.get('ressurs') || 'https://storage.azure.com/';
        const svar = {
            ressurs,
            betydning: KJENTE[ressurs] || '(ikke en av de kjente ressursene)',
            kjenteRessurser: Object.keys(KJENTE)
        };

        try {
            // `scope` er audience + «/.default» for en applikasjonsidentitet.
            const scope = ressurs.endsWith('/') ? `${ressurs}.default` : `${ressurs}/.default`;
            const t = await legitimasjon().getToken(scope);
            if (!t || !t.token) {
                svar.ok = false;
                svar.feil = 'getToken returnerte ingenting — ingen feil, men heller ingen token';
                return { jsonBody: svar };
            }
            svar.ok = true;
            svar.scope = scope;
            svar.tegnITokenet = t.token.length;   // lengden, ikke tokenet
            svar.utloper = t.expiresOnTimestamp ? new Date(t.expiresOnTimestamp).toISOString() : null;
            svar.claims = claimsFra(t.token);
        } catch (e) {
            // Årsaken MÅ med. «Det gikk galt» uten mer er umulig å skille fra
            // «koden er ikke deployet», og det er nettopp det denne skal svare på.
            svar.ok = false;
            svar.feil = e?.message || String(e);
            svar.feiltype = e?.name || null;
        }
        return { jsonBody: svar };
    }
});

module.exports = { claimsFra, CLAIMS_VI_VISER, KJENTE };
