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
    'FS_API_URL', 'FS_EIER_ORG_KODE', 'ADMIN_UPNS',
    // Hvor backupen lastes opp. Ikke hemmelig, og det som oftest er feil
    // konfigurert når kopien ikke dukker opp der noen leter etter den.
    'BACKUP_SHAREPOINT_SITE', 'BACKUP_SHAREPOINT_BIBLIOTEK', 'BACKUP_SHAREPOINT_MAPPE'
];
const HEMMELIGE_ENV = [
    'STORAGE_CONNECTION_STRING', 'TODO_STORAGE_CONNECTION_STRING',
    'AAD_CLIENT_ID', 'AAD_CLIENT_SECRET',
    'HASH_SALT', 'OTP_HMAC_KEY', 'FLOW_CALLBACK_KEY', 'SCHEDULER_KEY',
    'FS_API_USER', 'FS_API_PASSWORD',
    'GRAPH_TENANT_ID', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET',
    // UTSENDING_FLOW_URL og PURRE_FLOW_URL sto her til 10.09.2026. Ingen av
    // dem var satt i noe miljø, så helsesjekken meldte en mangel hver gang
    // uten at noen handlet på den — og en alarm ingen handler på slutter å
    // virke. Utsending og purring går nå gjennom VARSLING_FLOW_URL.
    'VARSLING_FLOW_URL', 'OTP_FLOW_URL', 'SP_LISTE_FLOW_URL',
    'BACKUP_FLOW_URL', 'TEAM_SOK_EKSTERNT_FLOW_URL', 'TEAM_LAST_MEDLEMMER_FLOW_URL'
];

/**
 * Variabler som bare hører hjemme i noen miljøer.
 *
 * Uten dette leses en tom verdi som en mangel uansett hvor man står, og den
 * som forvalter løsningen bruker tid på å lete etter noe som ikke skal finnes.
 *
 * `AAD_CLIENT_SECRET` er tilfellet i dag: pilot autentiserer med en
 * klienthemmelighet i en app-setting, mens prod bruker sertifikat via
 * `clientSecretCertificateKeyVaultReference` mot Key Vault. I prod er en tom
 * verdi altså riktig — og en satt verdi er dokumentasjonsgjeld, ikke noe som
 * brukes.
 */
const KUN_I_MILJO = {
    AAD_CLIENT_SECRET: {
        miljoer: ['pilot', 'development', 'lokal'],
        merknad: 'Prod bruker sertifikat fra Key Vault i stedet — tom verdi er riktig her.'
    }
};

/**
 * Normaliser MILJO til ett navn per miljø.
 *
 * `production` er det GAMLE navnet på pilot — ikke et annet ord for prod.
 * `config/env.pilot.json` setter `MILJO=production` den dag i dag, og
 * `scripts/build-config.js` gjør den samme oversettelsen ved bygg
 * («alias production → pilot»). Prod setter `MILJO=prod`.
 *
 * Skillet er ikke kosmetisk. Leses `production` som prod, arver pilot prodens
 * unntak — og en manglende `AAD_CLIENT_SECRET`, som tar ned innloggingen helt,
 * meldes da som «forventet tom her» i det ene miljøet som faktisk trenger den.
 * Det er nøyaktig feilen KUN_I_MILJO er laget for å unngå, speilvendt.
 *
 * Et ukjent navn sendes uendret videre, og medForventning() behandler det som
 * «vet ikke» — se KJENTE_MILJOER der.
 */
const MILJO_ALIAS = { production: 'pilot' };

/**
 * Miljøene vi kjenner. Et navn utenfor denne mengden er «vet ikke», ikke
 * «gjelder ikke».
 *
 * `KUN_I_MILJO.miljoer` er en positivliste: står miljøet ikke der, blir en tom
 * verdi friskmeldt. Det er riktig for prod, som vi vet ikke trenger
 * `AAD_CLIENT_SECRET` — men det var også grunnen til at `production` arvet
 * prodens unntak, og det ville gjort det samme for et hvilket som helst nytt
 * miljønavn. En hemmelighet som mangler i et miljø vi ikke kjenner skal meldes,
 * ikke ties i hjel.
 */
const KJENTE_MILJOER = new Set(['pilot', 'prod', 'development', 'lokal']);

function miljonavn() {
    const raatt = String(process.env.MILJO || '').trim().toLowerCase();
    return MILJO_ALIAS[raatt] || raatt;
}

/**
 * Beriker en env-rapport med hvilke miljøer variabelen gjelder for.
 * `gjelderHer: false` sier at tom verdi er forventet, ikke en feil.
 */
function medForventning(navn, info) {
    const regel = KUN_I_MILJO[navn];
    if (!regel) return info;
    const her = miljonavn();
    // Ukjent miljø — tomt ELLER et navn vi ikke kjenner: vi vet ikke nok til å
    // påstå at en tom verdi er riktig, og lar den stå som en mangel.
    const gjelderHer = KJENTE_MILJOER.has(her) ? regel.miljoer.includes(her) : true;
    if (gjelderHer) return info;
    return { ...info, gjelderHer: false, merknad: regel.merknad };
}

function maskLengde(verdi) {
    if (!verdi) return { satt: false };
    const s = String(verdi);
    // En Key Vault-referanse som ikke ble løst står igjen som selve
    // referansestrengen. Da er varen «satt», men verdien er ubrukelig — og
    // symptomet er en 401 langt unna årsaken. Si det heller her.
    if (/^@Microsoft\.KeyVault\(/i.test(s.trim())) {
        return { satt: true, lengde: s.length, feil: 'uløst Key Vault-referanse — sjekk at SWA-ens managed identity har «Key Vault Secrets User», og at hemmelighetsnavnet stemmer' };
    }
    return { satt: true, lengde: s.length };
}

/**
 * Flyt-URLer: vertsnavnet er ikke hemmelig, og er det som skiller en flyt i
 * riktig miljø fra en som fortsatt peker på dev. Signaturen ligger i
 * query-strengen og tas aldri med. En verdi som ikke lar seg parse som URL
 * er som regel en Key Vault-referanse som ikke ble løst.
 */
function maskFlytUrl(verdi) {
    const info = maskLengde(verdi);
    if (!info.satt) return info;
    try {
        const u = new URL(String(verdi));
        return { ...info, vertsnavn: u.hostname, sti: u.pathname };
    } catch (_) {
        return { ...info, vertsnavn: null, feil: 'ikke en gyldig URL — uløst Key Vault-referanse?' };
    }
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
        for (const k of HEMMELIGE_ENV) {
            const info = k.endsWith('_FLOW_URL') ? maskFlytUrl(process.env[k]) : maskLengde(process.env[k]);
            hemmelige[k] = medForventning(k, info);
        }

        return {
            jsonBody: {
                aktør: { upn, erAdmin: true },
                miljø: {
                    MILJO: process.env.MILJO || 'ukjent',
                    // Hvilket miljø helsesjekken under REGNER dette som.
                    // «production» er pilot; se miljonavn().
                    normalisert: miljonavn() || 'ukjent',
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

// Eksporteres for test. Miljøskillet er lett å reversere ved en opprydding,
// og feilen det gir er stille: en tom verdi leses som en mangel.
module.exports = { _medForventning: medForventning, _KUN_I_MILJO: KUN_I_MILJO, _miljonavn: miljonavn };
