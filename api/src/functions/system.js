/**
 * GET /api/system/info — admin-diagnostikk. Returnerer miljø-info uten
 * å eksponere secrets. Verdier som ikke er satt returneres som null.
 */
const { app } = require('@azure/functions');
const os = require('os');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');

// SWA-safe env-vars å vise. Aldri eksponer hemmeligheter — bare
// om de er satt eller ikke, evt. lengde/prefiks for identifisering.
const OFFENTLIGE_ENV = [
    'MILJO', 'SWA_URL', 'STORAGE_ACCOUNT_NAME', 'KEYVAULT_NAME',
    'FS_API_URL', 'FS_EIER_ORG_KODE', 'ADMIN_UPNS'
];
const HEMMELIGE_ENV = [
    'STORAGE_CONNECTION_STRING', 'TODO_STORAGE_CONNECTION_STRING',
    'AAD_CLIENT_ID', 'AAD_CLIENT_SECRET',
    'HASH_SALT', 'OTP_HMAC_KEY', 'FLOW_CALLBACK_KEY', 'SCHEDULER_KEY',
    'FS_API_USER', 'FS_API_PASSWORD',
    'VARSLING_FLOW_URL', 'OTP_FLOW_URL', 'SP_LISTE_FLOW_URL', 'PURRE_FLOW_URL'
];

function maskLengde(verdi) {
    if (!verdi) return { satt: false };
    return { satt: true, lengde: String(verdi).length };
}

app.http('systemInfo', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'system/info',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        if (!erAdmin(upn)) return { status: 403, jsonBody: { status: 'feil', melding: 'Krever admin' } };

        const offentlige = {};
        for (const k of OFFENTLIGE_ENV) offentlige[k] = process.env[k] || null;

        const hemmelige = {};
        for (const k of HEMMELIGE_ENV) hemmelige[k] = maskLengde(process.env[k]);

        return {
            jsonBody: {
                aktør: { upn, erAdmin: true },
                miljø: {
                    MILJO: process.env.MILJO || 'ukjent',
                    node: process.version,
                    plattform: `${os.type()} ${os.release()}`,
                    prosessorer: os.cpus().length,
                    minneMB: Math.round(os.totalmem() / 1024 / 1024),
                    uptime_sek: Math.round(process.uptime()),
                    servertid: new Date().toISOString()
                },
                offentligeEnv: offentlige,
                hemmeligeEnv: hemmelige,
                request: {
                    host: request.headers.get('host') || null,
                    xForwardedHost: request.headers.get('x-forwarded-host') || null,
                    xForwardedProto: request.headers.get('x-forwarded-proto') || null
                }
            }
        };
    }
});
