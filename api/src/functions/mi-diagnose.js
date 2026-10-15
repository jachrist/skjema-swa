const { app } = require('@azure/functions');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');

/**
 * GET /api/diagnose/mi-token?ressurs=<audience>[&tokenkilde=sdk|plattform] — admin.
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

// SDK-ene lastes først ved kall, samme grunn som i storage.js: testene skal
// kunne kjøre uten node_modules.
let DefaultAzureCredential = null;
function legitimasjon() {
    if (!DefaultAzureCredential) {
        ({ DefaultAzureCredential } = require('@azure/identity'));
    }
    return new DefaultAzureCredential();
}

let TableClient = null;
function tabellKlasse() {
    if (!TableClient) ({ TableClient } = require('@azure/data-tables'));
    return TableClient;
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

/**
 * Lovlige verdier for `tokenkilde`.
 *
 * `sdk`       — DefaultAzureCredential.getToken(«<ressurs>/.default»).
 * `plattform` — App Service sitt eget identity-endepunkt, med `resource`
 *               ORDRETT slik den ble oppgitt.
 */
const TOKENKILDER = ['sdk', 'plattform'];

/**
 * Env-variabler PLATTFORMEN setter, ikke vi.
 *
 * App Service og Functions setter disse to når en managed identity er slått
 * på. De står ikke i SWA Configuration, de står ikke i Key Vault, og ingen
 * skal lime inn en verdi for dem noe sted.
 *
 * Erklæringen står her, i koden som leser dem, og
 * `api/test/env-inventar.test.js` leser den herfra. Uten den ville
 * inventartesten krevd at de ble ført opp i `config/env.*.json` som app
 * settings — og da ville inventaret påstått at noen må sette dem. Et
 * inventar som ser komplett ut og ikke er riktig, er verre enn ingen.
 *
 * `IDENTITY_HEADER` er legitimasjon. Den leses her og går bare i
 * `X-IDENTITY-HEADER`-headeren — aldri til et svar, aldri til en feilmelding.
 */
const SATT_AV_PLATTFORMEN = ['IDENTITY_ENDPOINT', 'IDENTITY_HEADER'];

/**
 * Hvorfor `plattform` finnes ved siden av SDK-en: SKRÅSTREKEN.
 *
 * `getToken` tar et *scope* — «<ressurs>/.default» — og på App Service
 * oversetter SDK-en det til plattformens `resource`-parameter ved å klippe
 * av «/.default». Da forsvinner en avsluttende skråstrek i ressursen, og
 * `aud` i tokenet blir `https://service.flow.microsoft.com`.
 *
 * Power Automate krever `https://service.flow.microsoft.com/` — MED
 * skråstrek. Microsofts dokumentasjon sier det rett ut: «Audience values
 * must be an exact match, including trailing slashes.» Det er en bokstavelig
 * strengsammenligning, og den feiler på ett tegn.
 *
 * Plattformens endepunkt tar `resource` ordrett, og det er hele poenget med
 * denne veien. Svaret bærer `ressursSomBleSpurtOm` nettopp for at det skal
 * være synlig hvilken av dem som faktisk ble sendt.
 *
 * `IDENTITY_HEADER` er en hemmelighet og skal ALDRI ut herfra.
 */
async function tokenFraPlattformen(ressurs) {
    const endepunkt = process.env.IDENTITY_ENDPOINT;
    const nokkel = process.env.IDENTITY_HEADER;
    if (!endepunkt || !nokkel) {
        // Begge settes av plattformen når en managed identity er på. Mangler
        // de, er det identiteten som mangler — ikke tilgangen. Forskjellen
        // er verdt en egen melding.
        throw new Error(`${SATT_AV_PLATTFORMEN.join(' / ')} er ikke satt — `
            + 'ingen managed identity på denne verten');
    }
    const u = new URL(endepunkt);
    u.searchParams.set('api-version', '2019-08-01');
    u.searchParams.set('resource', ressurs);

    const res = await fetch(u, { headers: { 'X-IDENTITY-HEADER': nokkel } });
    const tekst = await res.text();
    if (!res.ok) {
        throw new Error(`identity-endepunktet svarte ${res.status}: ${String(tekst).slice(0, 200)}`);
    }
    let data;
    try {
        data = JSON.parse(tekst);
    } catch (e) {
        throw new Error(`identity-endepunktet ga ikke JSON: ${e.message}`);
    }
    if (!data.access_token) throw new Error('identity-endepunktet ga ingen access_token');
    return {
        token: data.access_token,
        utloper: tidspunkt(data.expires_on),
        scope: null,
        // Plattformen ekkoer ressursen den forsto. Står skråstreken her,
        // overlevde den hele veien.
        ressursSomBleSpurtOm: data.resource ?? '(ikke oppgitt av plattformen)'
    };
}

/**
 * `expires_on` kommer som epoch-sekunder fra noen verter og som dato fra
 * andre. Feltet skal uansett settes, med årsaken i seg hvis det ikke kunne
 * tolkes — en nøkkel som forsvinner kan ikke feilsøkes.
 */
function tidspunkt(verdi) {
    if (verdi === undefined || verdi === null || verdi === '') return '(ikke oppgitt)';
    const tall = Number(verdi);
    if (Number.isFinite(tall)) return new Date(tall * 1000).toISOString();
    const d = new Date(String(verdi));
    return Number.isNaN(d.getTime()) ? `ukjent format: ${verdi}` : d.toISOString();
}

/** Ett sted som vet hvordan et token hentes, for begge prøvene. */
async function hentToken(ressurs, kilde) {
    if (kilde === 'plattform') return tokenFraPlattformen(ressurs);

    // `scope` er audience + «/.default» for en applikasjonsidentitet.
    const scope = ressurs.endsWith('/') ? `${ressurs}.default` : `${ressurs}/.default`;
    const t = await legitimasjon().getToken(scope);
    if (!t || !t.token) return null;
    return {
        token: t.token,
        utloper: t.expiresOnTimestamp ? new Date(t.expiresOnTimestamp).toISOString() : '(ikke oppgitt)',
        scope,
        // Dette er strengen SDK-en faktisk sender videre som `resource` —
        // scopet uten «/.default». Skråstreken er borte her.
        ressursSomBleSpurtOm: scope.replace(/\/\.default$/, '')
    };
}

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
        const kilde = (request.query.get('tokenkilde') || 'sdk').trim();
        if (!TOKENKILDER.includes(kilde)) {
            return { status: 400, jsonBody: { status: 'feil',
                melding: `tokenkilde må være en av: ${TOKENKILDER.join(', ')}` } };
        }
        const svar = {
            ressurs,
            tokenkilde: kilde,
            betydning: KJENTE[ressurs] || '(ikke en av de kjente ressursene)',
            kjenteRessurser: Object.keys(KJENTE)
        };

        try {
            const t = await hentToken(ressurs, kilde);
            if (!t) {
                svar.ok = false;
                svar.feil = 'tokenkilden returnerte ingenting — ingen feil, men heller ingen token';
                return { jsonBody: svar };
            }
            svar.ok = true;
            svar.scope = t.scope;
            svar.ressursSomBleSpurtOm = t.ressursSomBleSpurtOm;
            svar.tegnITokenet = t.token.length;   // lengden, ikke tokenet
            svar.utloper = t.utloper;
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

/**
 * Hvilke app settings flyt-prøven får lese.
 *
 * UTEN denne begrensningen er endepunktet en vei til å lese hvilken som helst
 * miljøvariabel — `?envVar=STORAGE_CONNECTION_STRING` ville vært det første
 * noen prøvde. Mønsteret slipper bare gjennom navn som ser ut som en
 * flyt-URL, og det er alle vi faktisk trenger å prøve.
 */
const FLYTVAR = /^[A-Z0-9_]+_FLOW_URL$/;

/**
 * En URL beskrevet uten å røpe den.
 *
 * Trigger-URL-en til en Power Automate-flyt bærer signaturen i
 * query-strengen. Den skal aldri ut av et diagnoseendepunkt — heller ikke
 * maskert, heller ikke delvis. Vertsnavn og sti er nok til å se at man
 * prøver mot riktig flyt, og `harSignatur` er nettopp det forsøket skal
 * måle: forsvinner `sig=` når flyten krever Entra?
 */
function beskrivUrl(verdi) {
    try {
        const u = new URL(String(verdi));
        return {
            vertsnavn: u.hostname,
            sti: u.pathname,
            harSignatur: u.searchParams.has('sig'),
            antallParametere: [...u.searchParams.keys()].length
        };
    } catch (e) {
        return { feil: `ikke en gyldig URL: ${e.message}` };
    }
}

/**
 * GET /api/diagnose/mi-tabell?konto=<navn>&tabell=<navn>[&skriv=ja] — admin.
 *
 * Steg 3 i `docs/BESLUTNING-EGEN-FUNCTION-APP.md`: kan koden lese og skrive
 * Table Storage med managed identity i stedet for en connection string?
 *
 * At identiteten FÅR et token er alt vist. Dette er neste spørsmål, og det
 * er et annet: gir rolletildelingen faktisk tilgang?
 *
 * Leser som standard. `skriv=ja` skriver EN rad under PartitionKey
 * `mi-prove` og sletter den igjen, og rapporterer hvert steg for seg — en
 * skriving som lykkes mens slettingen feiler, skal ikke se ut som en
 * vellykket prøve.
 */
app.http('miTabellDiagnose', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'diagnose/mi-tabell',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!erAdmin(upn)) {
            return { status: 403, jsonBody: { status: 'feil', melding: 'Krever admin' } };
        }

        const konto = (request.query.get('konto') || '').trim();
        const tabell = (request.query.get('tabell') || '').trim();
        const skriv = request.query.get('skriv') === 'ja';
        if (!/^[a-z0-9]{3,24}$/.test(konto) || !/^[A-Za-z][A-Za-z0-9]{2,62}$/.test(tabell)) {
            return { status: 400, jsonBody: {
                status: 'feil',
                melding: 'konto og tabell må oppgis. konto: 3-24 små bokstaver/tall. tabell: bokstav først, så bokstaver og tall.'
            } };
        }

        const svar = { konto, tabell, skrivingPrøvd: skriv };
        let klient;
        try {
            klient = new (tabellKlasse())(`https://${konto}.table.core.windows.net`, tabell, legitimasjon());
        } catch (e) {
            svar.lese = { ok: false, feil: e?.message || String(e) };
            return { jsonBody: svar };
        }

        // ---- lesing ----
        try {
            const funnet = [];
            // Tre rader holder. Vi er ute etter om kallet slipper gjennom,
            // ikke etter innholdet — og innholdet er persondata.
            for await (const rad of klient.listEntities({ queryOptions: { select: ['PartitionKey', 'RowKey'] } })) {
                funnet.push(rad.partitionKey);
                if (funnet.length >= 3) break;
            }
            svar.lese = { ok: true, antallLest: funnet.length };
        } catch (e) {
            svar.lese = { ok: false, feil: e?.message || String(e), statuskode: e?.statusCode ?? null };
        }

        if (!skriv) {
            svar.merknad = 'Bare lest. Legg til &skriv=ja for å prøve skriving — den skriver og sletter én rad under PartitionKey mi-prove.';
            return { jsonBody: svar };
        }

        // ---- skriving, og opprydding ----
        const rowKey = `prove-${Date.now()}`;
        try {
            await klient.createEntity({ partitionKey: 'mi-prove', rowKey, Merknad: 'MI-diagnose, kan slettes' });
            svar.skrive = { ok: true, rowKey };
        } catch (e) {
            svar.skrive = { ok: false, feil: e?.message || String(e), statuskode: e?.statusCode ?? null };
            return { jsonBody: svar };
        }
        try {
            await klient.deleteEntity('mi-prove', rowKey);
            svar.rydding = { ok: true };
        } catch (e) {
            // Dette MÅ rapporteres. En prøverad som blir liggende igjen i en
            // ekte tabell er noe noen må rydde for hånd, og da skal de vite
            // hvilken.
            svar.rydding = { ok: false, feil: e?.message || String(e),
                merknad: `Raden mi-prove/${rowKey} ble IKKE slettet og må fjernes manuelt.` };
        }
        return { jsonBody: svar };
    }
});

/**
 * GET /api/diagnose/mi-flyt?envVar=<NAVN>[&ressurs=][&tokenkilde=sdk|plattform] — admin.
 *
 * Steg 7: godtar en Power Automate-flyt et managed identity-token i stedet
 * for SAS-signaturen i URL-en?
 *
 * URL-en hentes fra en app setting, ikke fra kallet. Et endepunkt som kaller
 * en vilkårlig URL med appens egen identitet er en SSRF-primitiv, og det
 * skal ikke finnes — heller ikke i en prøveapp. Målmengden er derfor
 * nøyaktig de flytene noen alt har konfigurert på appen, og bare navn som
 * matcher `FLYTVAR`.
 *
 * **URL-en ekkoes aldri.** Svaret har vertsnavn, sti, og om den fortsatt
 * bærer `sig=` — det siste er selve målet med forsøket.
 */
app.http('miFlytDiagnose', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'diagnose/mi-flyt',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!erAdmin(upn)) {
            return { status: 403, jsonBody: { status: 'feil', melding: 'Krever admin' } };
        }

        const navn = (request.query.get('envVar') || '').trim();
        if (!FLYTVAR.test(navn)) {
            return { status: 400, jsonBody: {
                status: 'feil',
                melding: 'envVar må være navnet på en app setting som slutter på _FLOW_URL.',
                mønster: String(FLYTVAR)
            } };
        }
        const url = process.env[navn];
        if (!url) {
            return { status: 404, jsonBody: { status: 'feil', melding: `App settingen ${navn} er ikke satt.` } };
        }

        const svar = { envVar: navn, url: beskrivUrl(url) };
        if (svar.url.feil) return { status: 400, jsonBody: svar };

        const ressurs = request.query.get('ressurs') || 'https://service.flow.microsoft.com/';
        const kilde = (request.query.get('tokenkilde') || 'sdk').trim();
        if (!TOKENKILDER.includes(kilde)) {
            return { status: 400, jsonBody: { status: 'feil',
                melding: `tokenkilde må være en av: ${TOKENKILDER.join(', ')}` } };
        }
        svar.ressurs = ressurs;
        svar.tokenkilde = kilde;

        let token;
        try {
            const t = await hentToken(ressurs, kilde);
            if (!t) {
                svar.token = { ok: false, feil: 'tokenkilden returnerte ingenting' };
                return { jsonBody: svar };
            }
            token = t.token;
            svar.scope = t.scope;
            svar.ressursSomBleSpurtOm = t.ressursSomBleSpurtOm;
            svar.token = { ok: true, claims: claimsFra(token) };
        } catch (e) {
            svar.token = { ok: false, feil: e?.message || String(e) };
            return { jsonBody: svar };
        }

        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ kilde: 'mi-diagnose', tid: new Date().toISOString() })
            });
            const tekst = await res.text();
            svar.kall = {
                statuskode: res.status,
                ok: res.ok,
                // Avkortet: svaret fra en flyt kan inneholde hva som helst,
                // og dette er en diagnose, ikke en klient.
                svarUtdrag: String(tekst).slice(0, 300)
            };
        } catch (e) {
            svar.kall = { ok: false, feil: e?.message || String(e) };
        }
        return { jsonBody: svar };
    }
});

module.exports = { claimsFra, beskrivUrl, tidspunkt, CLAIMS_VI_VISER, KJENTE, FLYTVAR,
    TOKENKILDER, SATT_AV_PLATTFORMEN };
