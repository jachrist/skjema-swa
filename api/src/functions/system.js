/**
 * GET /api/system/info — admin-diagnostikk. Returnerer miljø-info uten
 * å eksponere secrets. Verdier som ikke er satt returneres som null.
 */
const { app } = require('@azure/functions');
const os = require('os');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');
const { lagringsvalg } = require('../lib/lagringsvalg');

// SWA-safe env-vars å vise. Aldri eksponer hemmeligheter — bare
// om de er satt eller ikke, evt. lengde/prefiks for identifisering.
const OFFENTLIGE_ENV = [
    'MILJO', 'SWA_URL', 'STORAGE_ACCOUNT_NAME', 'KEYVAULT_NAME',
    // VISES I SIN HELHET, med vilje. En clientId er en offentlig
    // identifikator, ikke en hemmelighet — og en managed identity har TRE
    // GUID-er som ligner. Å maskere den til «lengde: 36» ville skjult
    // nøyaktig verdien hvis forveksling koster mest tid (se 8g). Endepunktet
    // krever admin.
    'AZURE_CLIENT_ID',
    'FS_API_URL', 'FS_EIER_ORG_KODE', 'ADMIN_UPNS',
    // Hvor backupen lastes opp. Ikke hemmelig, og det som oftest er feil
    // konfigurert når kopien ikke dukker opp der noen leter etter den.
    'BACKUP_SHAREPOINT_SITE', 'BACKUP_SHAREPOINT_BIBLIOTEK', 'BACKUP_SHAREPOINT_MAPPE',
    // Knapper med default i koden. De er ikke hemmelige, og de forklarer
    // oppførsel som ellers ser ut som en feil: et miljø der ingen varsler
    // sendes, eller der purringen har sluttet.
    'VARSLING_DEAKTIVERT', 'ANTHROPIC_MODELL', 'BACKUP_DEL_MAKS_MB',
    'PURRE_MAKS_DAGER', 'PURRE_MIN_DAGER_MELLOM'
];
/**
 * Vist i helsesjekken, men IKKE lest av api/src.
 *
 * De brukes av PLATTFORMEN, ikke av koden vår: auth-innstillingene leses av
 * `staticwebapp.config.<miljø>.json`. Uten dem ville helsesjekken tiet om at
 * innloggingen er feilkonfigurert — og det er det verste tilfellet å ikke få
 * vite om.
 *
 * `STORAGE_ACCOUNT_NAME` sto her til 16.10.2026, med «står for orienteringens
 * skyld» som begrunnelse. Nå LESER koden den: `lagringsvalg.js` velger
 * managed identity på den når tilkoblingsstrengen ikke er satt. Et unntak som
 * ikke lenger er et unntak er en løgn med lav halveringstid — testen under
 * fanger begge retninger.
 *
 * Lista er erklært fordi `api/test/env-inventar.test.js` ellers krever at alt
 * helsesjekken viser også leses av koden. Et unntak uten begrunnelse er et
 * hull; et unntak med begrunnelse er en beslutning.
 */
const VIST_UTEN_AT_KODEN_LESER = ['AAD_CLIENT_ID', 'AAD_CLIENT_SECRET'];

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
    // BACKUP_PASSPHRASE sto IKKE her til 12.10.2026, og det var den dyreste
    // utelatelsen: er den ikke satt, er hver backup ulesbar — og
    // helsesjekken sa ingenting. Den er nettopp en man vil oppdage før man
    // trenger backupen.
    'BACKUP_PASSPHRASE', 'ANTHROPIC_API_KEY',
    'VARSLING_FLOW_URL', 'OTP_FLOW_URL', 'SP_LISTE_FLOW_URL',
    'BACKUP_FLOW_URL', 'TEAM_SOK_EKSTERNT_FLOW_URL', 'TEAM_LAST_MEDLEMMER_FLOW_URL',
    // Samme to som manglet i inventaret og i keyvault-secrets.md. Tre lister,
    // samme hull — se api/test/env-inventar.test.js.
    'DIAGNOSE_FLOW_URL', 'TEAM_FLOW_URL'
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
    // Prod bruker sertifikat fra Key Vault. Dev har ikke hemmeligheten HER:
    // API-et er en egen Function App, og SWA-ens auth-innstillinger ligger på
    // SWA-en. Se AAD_CLIENT_ID rett under.
    AAD_CLIENT_SECRET: {
        miljoer: ['pilot', 'lokal'],
        merknad: 'Prod bruker sertifikat fra Key Vault. I dev ligger verdien på '
            + 'SWA-en, ikke på Function App-en — tom verdi er riktig begge steder.'
    },
    // EN KOPI HER VILLE VÆRT VERRE ENN INGEN.
    //
    // I pilot og prod kjører API-et inne i SWA-en, så denne env-varen ER den
    // verdien innloggingen bruker, og helsesjekken bekrefter at auth er
    // konfigurert. I dev er API-et en egen ressurs: SWA-ens auth-innstillinger
    // er ikke synlige herfra.
    //
    // Settes den likevel på Function App-en, rapporterer helsesjekken en kopi
    // ingen bruker — og en kopi som har drevet fra originalen ser nøyaktig ut
    // som en som ikke har det. 16.10.2026 sto MI-ens clientId der, og
    // innloggingen virket fint, fordi SWA-en hadde sin egen riktige verdi.
    AAD_CLIENT_ID: {
        miljoer: ['pilot', 'prod', 'lokal'],
        merknad: 'I dev leser SWA-en denne fra SINE egne app settings. En kopi på '
            + 'Function App-en er ikke i bruk og kan drive fra originalen — '
            + 'tom verdi er riktig her.'
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

// `development` sto her til 15.10.2026, som alias for pilot. Da `dev` ble et
// ekte miljø, ville det navnet pekt på feil sted — og det er den samme fellen
// aliaset selv ble laget for å unngå, speilvendt. Det er fjernet også i
// scripts/build-config.js; et alias som bare finnes ett av stedene, er verre
// enn ingen.

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
const KJENTE_MILJOER = new Set(['dev', 'pilot', 'prod', 'lokal']);

/**
 * Miljøer der PLATTFORMEN løser `@Microsoft.KeyVault(...)`-referanser.
 *
 * SWA Managed Functions gjør det ikke — prøvd i pilot 12.10.2026, appen fikk
 * referansestrengen på 109 tegn. En frittstående Function App gjør det —
 * prøvd 14.10.2026, se 8d i `docs/BESLUTNING-EGEN-FUNCTION-APP.md`.
 *
 * Forskjellen gjør at SAMME symptom har to ulike årsaker, og dermed to ulike
 * råd. Uten dette skillet ga helsesjekken i dev 16.10.2026 et råd som var
 * aktivt feil — «lim inn verdien som klartekst» — mens referansene der
 * faktisk virket og det som manglet var én secret i vaulten. Et råd som
 * sender feilsøkingen i gal retning er verre enn ingen melding.
 *
 * Lista utvides i steg 6, når pilot og prod også kjører på Function Apps.
 */
const LØSER_KEYVAULT_REFERANSER = new Set(['dev']);

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

/**
 * Hvorfor en Key Vault-referanse står uløst — og det avhenger av miljøet.
 *
 * Et ukjent miljønavn får BEGGE årsakene, ikke den ene gjettet. Samme regel
 * som KJENTE_MILJOER over: vi vet ikke nok til å peke én vei, og et feil råd
 * koster mer enn et vagt.
 */
function uloestReferanse() {
    const her = miljonavn();
    if (LØSER_KEYVAULT_REFERANSER.has(her)) {
        return 'Key Vault-referanse ble ikke løst. Plattformen her LØSER dem, så '
            + 'årsaken er en annen: secreten finnes ikke i vaulten, identiteten mangler '
            + 'Key Vault Secrets User, eller keyVaultReferenceIdentity er ikke satt på appen.';
    }
    if (KJENTE_MILJOER.has(her)) {
        return 'Key Vault-referanse i en app-setting — SWA Managed Functions løser dem ikke. '
            + 'Lim inn verdien som klartekst i SWA Configuration. Rolletildeling hjelper ikke.';
    }
    return 'Key Vault-referanse ble ikke løst, og miljøet er ukjent. To mulige årsaker: '
        + 'plattformen løser dem ikke (SWA Managed Functions), eller den gjør det og '
        + 'secreten/tilgangen mangler (Function App).';
}

function maskLengde(verdi) {
    if (!verdi) return { satt: false };
    const s = String(verdi);
    // En Key Vault-referanse står igjen som selve referansestrengen. Da er
    // varen «satt», men verdien er ubrukelig — og symptomet er en 401 langt
    // unna årsaken.
    //
    // Meldingen ba tidligere om å «sjekke at SWA-ens managed identity har
    // Key Vault Secrets User». Det er en blindvei: SWA Managed Functions
    // løser IKKE @Microsoft.KeyVault-referanser i app settings, uansett
    // rolletildeling. Prøvd i pilot 12.10.2026 på TEAM_SOK_EKSTERNT_FLOW_URL:
    // appen fikk referansestrengen på 109 tegn.
    if (/^@Microsoft\.KeyVault\(/i.test(s.trim())) {
        return { satt: true, lengde: s.length, feil: uloestReferanse() };
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
                // HVILKEN VEI LAGRINGEN GÅR, fra regelen selv — ikke gjettet
                // ut av hvilke env-varer som er satt. To veier inn til samme
                // konto betyr at «storage svarer ikke» har to helt ulike
                // feilsøkinger, og den som leser helsesjekken skal ikke måtte
                // utlede hvilken. `lagringsvalg()` tar aldri med
                // tilkoblingsstrengen, så dette er trygt å vise.
                lagring: lagringsvalg(),
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
module.exports = { _medForventning: medForventning, _KUN_I_MILJO: KUN_I_MILJO, _miljonavn: miljonavn,
    _VIST_UTEN_AT_KODEN_LESER: VIST_UTEN_AT_KODEN_LESER,
    _maskLengde: maskLengde, _uloestReferanse: uloestReferanse,
    _LØSER_KEYVAULT_REFERANSER: LØSER_KEYVAULT_REFERANSER };
