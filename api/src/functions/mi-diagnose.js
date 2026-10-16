const { app } = require('@azure/functions');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');
// Tokenveien og erklæringen av plattformvariablene bor i lib-en, sammen med
// den ekte bruken i lib/flyt-auth.js. Prøven skal måle den veien, ikke sin egen.
const { tokenFraPlattformen, SATT_AV_PLATTFORMEN } = require('../lib/plattform-token');

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

// Identiteten og endepunktet kommer fra den SAMME modulen som storage.js og
// blob.js bruker. Det er hele poenget med prøvene: bygger de sin egen URL og
// sin egen legitimasjon, kan de bli grønne mens den ekte veien er rød — og da
// måler de seg selv. `lagringsvalg.js` laster SDK-ene lat, samme grunn som
// her: testene skal kunne kjøre uten node_modules.
const { legitimasjon, endepunkt, KONTONAVN } = require('../lib/lagringsvalg');

/**
 * Hvilken identitet prøven skal bruke — ÉTT sted, for alle fire endepunktene.
 *
 * `?klientId=` overstyrer `AZURE_CLIENT_ID`. Det er hele poenget: uten en
 * overstyring kan «identiteten virker ikke» ikke skilles fra «app settingen
 * er feil», og 16.10.2026 brukte vi flere runder på nettopp den forskjellen.
 *
 * Formatet valideres fordi verdien går inn i en URL mot identity-endepunktet.
 * En GUID er en GUID; alt annet avvises før det kommer dit.
 */
const KLIENTID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function klientIdFra(request) {
    const fra = (request.query.get('klientId') || '').trim();
    if (fra) return KLIENTID.test(fra) ? fra : null;
    const env = String(process.env.AZURE_CLIENT_ID || '').trim();
    return env && KLIENTID.test(env) ? env : '';
}

let TableClient = null;
function tabellKlasse() {
    if (!TableClient) ({ TableClient } = require('@azure/data-tables'));
    return TableClient;
}

let blobSdk = null;
function blobPakke() {
    if (!blobSdk) blobSdk = require('@azure/storage-blob');
    return blobSdk;
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

/** Ett sted som vet hvordan et token hentes, for begge prøvene. */
async function hentToken(ressurs, kilde, klientId) {
    if (kilde === 'plattform') return tokenFraPlattformen(ressurs, klientId);

    // `scope` er audience + «/.default» for en applikasjonsidentitet.
    const scope = ressurs.endsWith('/') ? `${ressurs}.default` : `${ressurs}/.default`;
    const t = await legitimasjon(klientId).getToken(scope);
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
        const klientId = klientIdFra(request);
        if (klientId === null) {
            return { status: 400, jsonBody: { status: 'feil',
                melding: 'klientId må være en GUID' } };
        }
        const svar = {
            ressurs,
            tokenkilde: kilde,
            // Ikke hemmelig: en clientId er en offentlig identifikator. Og
            // uten den i svaret er «hvilken identitet ble egentlig brukt» et
            // spørsmål ingen kan svare på etterpå.
            klientIdBrukt: klientId || '(ingen — SDK-en leter etter system-assigned)',
            betydning: KJENTE[ressurs] || '(ikke en av de kjente ressursene)',
            kjenteRessurser: Object.keys(KJENTE)
        };

        try {
            const t = await hentToken(ressurs, kilde, klientId);
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
        if (!KONTONAVN.test(konto) || !/^[A-Za-z][A-Za-z0-9]{2,62}$/.test(tabell)) {
            return { status: 400, jsonBody: {
                status: 'feil',
                melding: 'konto og tabell må oppgis. konto: 3-24 små bokstaver/tall. tabell: bokstav først, så bokstaver og tall.'
            } };
        }

        const klientId = klientIdFra(request);
        if (klientId === null) {
            return { status: 400, jsonBody: { status: 'feil',
                melding: 'klientId må være en GUID' } };
        }
        const svar = { konto, tabell, skrivingPrøvd: skriv, klientIdBrukt: klientId || '(ingen)' };
        let klient;
        try {
            klient = new (tabellKlasse())(endepunkt('tabell', konto), tabell, legitimasjon(klientId));
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
        const klientId = klientIdFra(request);
        if (klientId === null) {
            return { status: 400, jsonBody: { status: 'feil',
                melding: 'klientId må være en GUID' } };
        }
        svar.ressurs = ressurs;
        svar.tokenkilde = kilde;
        svar.klientIdBrukt = klientId || '(ingen)';

        let token;
        try {
            const t = await hentToken(ressurs, kilde, klientId);
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

/**
 * Claims i en user delegation key som IDENTIFISERER — ikke signerer.
 *
 * Nøkkelens `value` er selve signeringshemmeligheten: den som har den, kan
 * lage en gyldig SAS for hva som helst identiteten har tilgang til, helt til
 * nøkkelen utløper. Den skal aldri ut herfra, like lite som et token.
 *
 * Resten sier hvem som fikk nøkkelen og hvor lenge den varer, og det er
 * nettopp det prøven skal vise.
 */
const DELEGERING_VI_VISER = ['signedObjectId', 'signedTenantId', 'signedService',
    'signedVersion', 'signedStartsOn', 'signedExpiresOn'];

/**
 * GET /api/diagnose/mi-blob?konto=<navn>&container=<navn>[&skriv=ja] — admin.
 *
 * Steg 3 for blob, og det er en annen prøve enn tabellen — ikke bare samme
 * spørsmål om en annen tjeneste.
 *
 * `backup.js` lager en SAS-URL ved å rive kontonøkkelen ut av
 * `STORAGE_CONNECTION_STRING` og signere med en `StorageSharedKeyCredential`.
 * En managed identity kan ikke bygge en slik — det finnes ingen nøkkel å
 * signere med. MI-veien er `getUserDelegationKey()`, som krever rollen
 * `Storage Blob Delegator` i tillegg til datarollene.
 *
 * Derfor måler denne fire ting hver for seg, og rapporterer dem hver for
 * seg: lesing, skriving, delegering, og et SAS-kall som faktisk henter
 * blobben. Det siste er det eneste som svarer på om `backup.js` kan legges
 * om — de tre første kan være grønne mens det fjerde ikke er det.
 *
 * Blobnavn ekkoes ikke. Vedlegg er navngitt av innsendere, og et filnavn kan
 * være en personopplysning i seg selv. Bare ANTALLET leses ut. Unntaket er
 * prøveblobben vi lager selv: den navngis hvis oppryddingen feiler, for da
 * må noen fjerne den for hånd.
 */
app.http('miBlobDiagnose', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'diagnose/mi-blob',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!erAdmin(upn)) {
            return { status: 403, jsonBody: { status: 'feil', melding: 'Krever admin' } };
        }

        const konto = (request.query.get('konto') || '').trim();
        const container = (request.query.get('container') || '').trim();
        const skriv = request.query.get('skriv') === 'ja';
        if (!KONTONAVN.test(konto) || !/^[a-z0-9][a-z0-9-]{2,62}$/.test(container)) {
            return { status: 400, jsonBody: {
                status: 'feil',
                melding: 'konto og container må oppgis. konto: 3-24 små bokstaver/tall. '
                    + 'container: små bokstaver, tall og bindestrek.'
            } };
        }

        const klientId = klientIdFra(request);
        if (klientId === null) {
            return { status: 400, jsonBody: { status: 'feil',
                melding: 'klientId må være en GUID' } };
        }
        const svar = { konto, container, skrivingPrøvd: skriv, klientIdBrukt: klientId || '(ingen)' };
        const vert = endepunkt('blob', konto);
        let tjeneste, containerKlient;
        try {
            const { BlobServiceClient } = blobPakke();
            tjeneste = new BlobServiceClient(vert, legitimasjon(klientId));
            containerKlient = tjeneste.getContainerClient(container);
        } catch (e) {
            svar.lese = { ok: false, feil: e?.message || String(e) };
            return { jsonBody: svar };
        }

        // ---- 1. lesing ----
        try {
            let antall = 0;
            for await (const _ of containerKlient.listBlobsFlat()) {
                antall++;
                if (antall >= 3) break;
            }
            svar.lese = { ok: true, antallLest: antall };
        } catch (e) {
            svar.lese = { ok: false, feil: e?.message || String(e), statuskode: e?.statusCode ?? null };
        }

        // ---- 2. delegering ----
        //
        // Denne kan lykkes uten at lesingen gjør det, og omvendt: de kommer
        // fra hver sin rolle. Derfor prøves den uansett utfall over.
        const nå = new Date();
        const utløp = new Date(nå.getTime() + 60 * 60 * 1000);
        let delegeringsnokkel = null;
        try {
            const n = await tjeneste.getUserDelegationKey(new Date(nå.getTime() - 5 * 60 * 1000), utløp);
            delegeringsnokkel = n;
            const vist = {};
            for (const felt of DELEGERING_VI_VISER) if (n[felt] !== undefined) vist[felt] = n[felt];
            svar.delegering = {
                ok: true,
                // Lengden, ikke nøkkelen. Samme regel som for tokenet.
                tegnINokkelen: String(n.value || '').length,
                nokkel: vist
            };
        } catch (e) {
            svar.delegering = {
                ok: false,
                feil: e?.message || String(e),
                statuskode: e?.statusCode ?? null,
                merknad: 'Krever rollen Storage Blob Delegator. Uten den kan backup.js '
                    + 'ikke lage SAS-URL med managed identity.'
            };
        }

        if (!skriv) {
            svar.merknad = 'Bare lest og prøvd delegering. Legg til &skriv=ja for å prøve '
                + 'skriving og et ekte SAS-kall — den laster opp og sletter én blob.';
            return { jsonBody: svar };
        }

        // ---- 3. skriving ----
        const blobNavn = `mi-prove-${Date.now()}.txt`;
        const innhold = 'MI-diagnose, kan slettes';
        let blobKlient;
        try {
            blobKlient = containerKlient.getBlockBlobClient(blobNavn);
            await blobKlient.upload(innhold, Buffer.byteLength(innhold));
            svar.skrive = { ok: true, blobNavn };
        } catch (e) {
            svar.skrive = { ok: false, feil: e?.message || String(e), statuskode: e?.statusCode ?? null };
            return { jsonBody: svar };
        }

        // ---- 4. SAS-kallet — det som avgjør om backup.js kan legges om ----
        if (delegeringsnokkel) {
            try {
                const { generateBlobSASQueryParameters, BlobSASPermissions } = blobPakke();
                const sas = generateBlobSASQueryParameters({
                    containerName: container,
                    blobName: blobNavn,
                    permissions: BlobSASPermissions.parse('r'),
                    startsOn: new Date(nå.getTime() - 5 * 60 * 1000),
                    expiresOn: utløp,
                    protocol: 'https'
                }, delegeringsnokkel, konto).toString();

                // URL-en bygges, brukes og forlater aldri funksjonen. En SAS
                // er legitimasjon: den som har lenken, har tilgangen.
                const res = await fetch(`${vert}/${container}/${encodeURIComponent(blobNavn)}?${sas}`);
                const tekst = await res.text();
                svar.sasKall = {
                    ok: res.ok,
                    statuskode: res.status,
                    // Vi skrev innholdet selv, så det kan sammenlignes trygt.
                    fikkRiktigInnhold: tekst === innhold
                };
            } catch (e) {
                svar.sasKall = { ok: false, feil: e?.message || String(e) };
            }
        } else {
            svar.sasKall = { ok: false, feil: 'ingen delegeringsnøkkel — se delegering over' };
        }

        // ---- 5. opprydding ----
        try {
            await blobKlient.delete();
            svar.rydding = { ok: true };
        } catch (e) {
            // Må rapporteres, og blobben må navngis: en prøvefil som blir
            // liggende i en ekte container er noe noen skal fjerne.
            svar.rydding = { ok: false, feil: e?.message || String(e),
                merknad: `Blobben ${container}/${blobNavn} ble IKKE slettet og må fjernes manuelt.` };
        }
        return { jsonBody: svar };
    }
});

module.exports = { claimsFra, beskrivUrl, klientIdFra, CLAIMS_VI_VISER, KJENTE, FLYTVAR,
    TOKENKILDER, SATT_AV_PLATTFORMEN, DELEGERING_VI_VISER, KLIENTID };
