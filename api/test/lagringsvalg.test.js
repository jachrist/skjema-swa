/**
 * ÉN regel for hvilken legitimasjon lagringen bruker — og den skal ha ETT sted.
 *
 * `storage.js` og `blob.js` snakker med samme lagringskonto. Velger de ulikt,
 * virker halve appen: tabelloppslag går gjennom mens blob-oppslag feiler, i
 * samme prosess, mot samme konto. Det er den tilbakevendende feilklassen i
 * dette repoet — samme regel i to eksemplarer som svarer ulikt — og den bor nå
 * i `lib/lagringsvalg.js`.
 *
 * Testen gjør tre ting:
 *
 *   **Leser regelen.** Alle fire utfallene av `lagringsvalg()`, mot den ekte
 *   funksjonen.
 *
 *   **Kjører BEGGE modulene.** For hvert miljøoppsett kalles de ekte
 *   `tabellKlient()` og `containerKlient()` med stubbede SDK-er, og svaret
 *   sammenlignes. Det er ikke nok å lese kildene: en kopi av regelen kan være
 *   skrevet med andre ord og likevel være en kopi.
 *
 *   **Krever at ingen av dem bestemmer selv.** Leser en av dem
 *   `STORAGE_ACCOUNT_NAME` eller `STORAGE_CONNECTION_STRING` fra miljøet på
 *   egen hånd, er kopien tilbake — og da er den over igjen om seks måneder.
 *
 * Kjøres med:  node api/test/lagringsvalg.test.js
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

// ---------- stubbede SDK-er ----------
//
// Testene skal kunne kjøre uten node_modules, og vi vil dessuten se HVA som
// ble bygget — ikke bare at det ikke kastet. `Module._load` byttes ut, slik at
// `require('@azure/...')` inne i modulene treffer disse.
const kall = [];

class Legitimasjon {
    constructor(opts) { this.opts = opts; }
}

class TabellKlient {
    constructor(url, tabell, legitimasjon) {
        this.vei = 'identitet';
        this.url = url;
        this.tabell = tabell;
        this.legitimasjon = legitimasjon;
        kall.push({ hva: 'tabell', vei: 'identitet', url, tabell });
    }
    static fromConnectionString(cs, tabell) {
        const k = Object.create(TabellKlient.prototype);
        k.vei = 'streng';
        k.cs = cs;
        k.tabell = tabell;
        kall.push({ hva: 'tabell', vei: 'streng', cs, tabell });
        return k;
    }
    async createTable() { /* som i Azure: 409 hvis den fins */ }
    listEntities() { return { [Symbol.asyncIterator]: async function* () {} }; }
}

class BlobTjeneste {
    constructor(url, legitimasjon) {
        this.vei = 'identitet';
        this.url = url;
        this.legitimasjon = legitimasjon;
        kall.push({ hva: 'blob', vei: 'identitet', url });
    }
    static fromConnectionString(cs) {
        const t = Object.create(BlobTjeneste.prototype);
        t.vei = 'streng';
        t.cs = cs;
        kall.push({ hva: 'blob', vei: 'streng', cs });
        return t;
    }
    getContainerClient(navn) { return { navn, tjeneste: this }; }
}

const STUBBER = {
    '@azure/data-tables': { TableClient: TabellKlient, odata: (...a) => a.join('') },
    '@azure/storage-blob': { BlobServiceClient: BlobTjeneste },
    '@azure/identity': { DefaultAzureCredential: Legitimasjon },
    // system.js registrerer rutene sine ved import. Samme stubb som i
    // api/test/system-miljo.test.js.
    '@azure/functions': { app: { http() { } } }
};
const ekteLast = Module._load;
Module._load = function (forespurt, ...rest) {
    if (Object.prototype.hasOwnProperty.call(STUBBER, forespurt)) return STUBBER[forespurt];
    return ekteLast.call(this, forespurt, ...rest);
};

const rot = path.join(__dirname, '..', '..');
const lv = require('../src/lib/lagringsvalg');
const storage = require('../src/lib/storage');
const blob = require('../src/lib/blob');

const KONTO = 'stskjema3dev';
const KLIENTID = '11111111-2222-3333-4444-555555555555';
// En streng som ser ut som en ekte. Nøkkelen er oppdiktet; poenget er at den
// er gjenkjennelig, slik at lekkasjesjekken under kan lete etter den.
const STRENG = `DefaultEndpointsProtocol=https;AccountName=${KONTO};AccountKey=OPPDIKTET+NOKKEL==;EndpointSuffix=core.windows.net`;

// ---------- 1. regelen ----------
{
    sjekk('streng satt → streng',
        lv.lagringsvalg({ STORAGE_CONNECTION_STRING: STRENG }).maate, 'tilkoblingsstreng');

    // Begge satt: strengen vinner. Det er den viktigste retningen i hele
    // filen. Pilot og prod har BEGGE verdiene i inventaret, og ville byttet
    // til en identitet som ikke finnes der i samme øyeblikk dette ble merget.
    sjekk('begge satt → strengen vinner',
        lv.lagringsvalg({ STORAGE_CONNECTION_STRING: STRENG, STORAGE_ACCOUNT_NAME: KONTO }).maate,
        'tilkoblingsstreng');

    sjekk('bare konto → managed identity',
        lv.lagringsvalg({ STORAGE_ACCOUNT_NAME: KONTO }).maate, 'managed-identity');
    sjekk('ingen av dem → ukonfigurert',
        lv.lagringsvalg({}).maate, 'ukonfigurert');

    // Tom og blank skal være det samme som ikke satt. En app setting som er
    // «slettet» i portalen blir ofte stående som en tom streng.
    sjekk('tom streng teller ikke som satt',
        lv.lagringsvalg({ STORAGE_CONNECTION_STRING: '   ', STORAGE_ACCOUNT_NAME: KONTO }).maate,
        'managed-identity');
    sjekk('tomt kontonavn teller ikke som satt',
        lv.lagringsvalg({ STORAGE_ACCOUNT_NAME: '  ' }).maate, 'ukonfigurert');
    sjekk('kontonavnet trimmes',
        lv.lagringsvalg({ STORAGE_ACCOUNT_NAME: ` ${KONTO}\n` }).konto, KONTO);

    // Den nærliggende tastefeilen: hele tilkoblingsstrengen limt inn i
    // kontonavnet. Uten denne sjekken havner nøkkelen i et vertsnavn.
    const rot = lv.lagringsvalg({ STORAGE_ACCOUNT_NAME: STRENG });
    sjekk('en tilkoblingsstreng i kontonavnet er ikke et kontonavn', rot.maate, 'ukonfigurert');
    sjekk('og årsaken sier hva som er galt', /lovlig kontonavn/.test(rot.grunn), true);
    sjekk('og nøkkelen gjentas ikke i årsaken', /OPPDIKTET/.test(rot.grunn), false);
    sjekk('STOR BOKSTAV er ikke et lovlig kontonavn',
        lv.lagringsvalg({ STORAGE_ACCOUNT_NAME: 'StSkjema3Dev' }).maate, 'ukonfigurert');
    sjekk('for kort er ikke et lovlig kontonavn',
        lv.lagringsvalg({ STORAGE_ACCOUNT_NAME: 'st' }).maate, 'ukonfigurert');

    // Alle fire feltene settes alltid. JSON.stringify dropper undefined, og en
    // nøkkel som kan forsvinne kan ikke feilsøkes.
    for (const env of [{ STORAGE_CONNECTION_STRING: STRENG }, { STORAGE_ACCOUNT_NAME: KONTO }, {}]) {
        sjekk(`alle felt er med (${Object.keys(env)[0] || 'tomt miljø'})`,
            Object.keys(lv.lagringsvalg(env)).sort(), ['grunn', 'klientId', 'konto', 'maate']);
    }
    sjekk('maaten er alltid en av de erklærte',
        [{ STORAGE_CONNECTION_STRING: STRENG }, { STORAGE_ACCOUNT_NAME: KONTO }, {}]
            .every(e => lv.MAATER.includes(lv.lagringsvalg(e).maate)), true);

    // Årsaken skal navngi variabelen, ikke bare konstatere at noe mangler.
    const ingen = lv.lagringsvalg({});
    sjekk('årsaken navngir begge veiene',
        /STORAGE_CONNECTION_STRING/.test(ingen.grunn) && /STORAGE_ACCOUNT_NAME/.test(ingen.grunn), true);

    // Mangler AZURE_CLIENT_ID på MI-veien, sier årsaken hva det betyr. Det er
    // nøyaktig feilen som kostet flere runder 16.10.2026: user-assigned
    // identitet uten clientId gir «Unable to load the proper Managed Identity».
    sjekk('MI uten clientId sier hva som mangler',
        /AZURE_CLIENT_ID/.test(lv.lagringsvalg({ STORAGE_ACCOUNT_NAME: KONTO }).grunn), true);
    sjekk('MI med clientId sier ikke at den mangler',
        /AZURE_CLIENT_ID/.test(lv.lagringsvalg({ STORAGE_ACCOUNT_NAME: KONTO, AZURE_CLIENT_ID: KLIENTID }).grunn),
        false);
    sjekk('og clientId følger med i valget',
        lv.lagringsvalg({ STORAGE_ACCOUNT_NAME: KONTO, AZURE_CLIENT_ID: KLIENTID }).klientId, KLIENTID);
}

// ---------- 2. valget lekker ikke nøkkelen ----------
//
// `lagring: lagringsvalg()` står i svaret fra /api/system/info. Kom
// tilkoblingsstrengen med i objektet, ville en delt nøkkel ligget i et
// admin-svar — og ingen hadde sett det, fordi feltet ville hett noe fornuftig.
{
    for (const env of [
        { STORAGE_CONNECTION_STRING: STRENG },
        { STORAGE_CONNECTION_STRING: STRENG, STORAGE_ACCOUNT_NAME: KONTO },
        { STORAGE_ACCOUNT_NAME: STRENG }
    ]) {
        const t = JSON.stringify(lv.lagringsvalg(env));
        sjekk('valget inneholder ikke nøkkelen', /OPPDIKTET/.test(t), false);
        sjekk('valget inneholder ikke AccountKey', /AccountKey/.test(t), false);
    }
    // Strengen hentes med et eget, tydelig navngitt kall — den finnes, den er
    // bare ikke med i valget.
    sjekk('tilkoblingsstreng() gir strengen',
        lv.tilkoblingsstreng({ STORAGE_CONNECTION_STRING: STRENG }), STRENG);
}

// ---------- 3. endepunktet ----------
{
    sjekk('tabellendepunkt', lv.endepunkt('tabell', KONTO), `https://${KONTO}.table.core.windows.net`);
    sjekk('blobendepunkt', lv.endepunkt('blob', KONTO), `https://${KONTO}.blob.core.windows.net`);
    const kastet = (f) => { try { f(); return false; } catch (_) { return true; } };
    sjekk('ukjent tjeneste kaster', kastet(() => lv.endepunkt('kø', KONTO)), true);
    sjekk('ugyldig kontonavn kaster', kastet(() => lv.endepunkt('blob', 'St Or')), true);
    sjekk('tomt kontonavn kaster', kastet(() => lv.endepunkt('blob', '')), true);
    // Samme regel som i valget — ikke en egen kopi av «hva er et kontonavn».
    sjekk('en tilkoblingsstreng som kontonavn kaster', kastet(() => lv.endepunkt('blob', STRENG)), true);
    // Og verdien gjentas ikke i meldingen. Er den gale verdien en
    // tilkoblingsstreng, står nøkkelen ellers i en exception — og i loggen.
    let melding = '';
    try { lv.endepunkt('blob', STRENG); } catch (e) { melding = e.message; }
    sjekk('og nøkkelen står ikke i meldingen', /OPPDIKTET|AccountKey/.test(melding), false);
    sjekk('men lengden gjør det, så verdien kan kjennes igjen', /\b\d+ tegn\b/.test(melding), true);
}

// ---------- 4. begge modulene svarer likt ----------
//
// De EKTE funksjonene kjøres, mot stubbede SDK-er. Dette er sjekken som ikke
// kan narres av at en kopi av regelen er skrevet med andre ord.
function medMiljo(env, f) {
    const foer = {};
    for (const n of ['STORAGE_CONNECTION_STRING', 'STORAGE_ACCOUNT_NAME', 'AZURE_CLIENT_ID']) {
        foer[n] = process.env[n];
        if (env[n] === undefined) delete process.env[n];
        else process.env[n] = env[n];
    }
    try { return f(); } finally {
        for (const [n, v] of Object.entries(foer)) {
            if (v === undefined) delete process.env[n];
            else process.env[n] = v;
        }
    }
}

/** Hvilken vei hver av de to modulene faktisk gikk, for ett miljøoppsett. */
function veier(env) {
    return medMiljo(env, () => {
        const ut = {};
        try { ut.tabell = storage.tabellKlient(`T${Math.random().toString(36).slice(2, 8)}`).vei; }
        catch (e) { ut.tabell = `kastet: ${e.message}`; }
        try { ut.blob = blob.serviceKlient().vei; }
        catch (e) { ut.blob = `kastet: ${e.message}`; }
        return ut;
    });
}

{
    sjekk('streng: begge går på delt nøkkel',
        veier({ STORAGE_CONNECTION_STRING: STRENG }), { tabell: 'streng', blob: 'streng' });

    sjekk('begge satt: begge går på delt nøkkel',
        veier({ STORAGE_CONNECTION_STRING: STRENG, STORAGE_ACCOUNT_NAME: KONTO }),
        { tabell: 'streng', blob: 'streng' });

    sjekk('bare konto: begge går på identitet',
        veier({ STORAGE_ACCOUNT_NAME: KONTO, AZURE_CLIENT_ID: KLIENTID }),
        { tabell: 'identitet', blob: 'identitet' });

    // Ukonfigurert: begge skal kaste, og feilmeldingen skal navngi BEGGE
    // veiene. «STORAGE_CONNECTION_STRING env-var mangler» var riktig så lenge
    // det fanst én vei; i dev ville den sendt feilsøkingen i gal retning.
    const tomt = veier({});
    sjekk('ukonfigurert: tabell kaster', /^kastet: /.test(tomt.tabell), true);
    sjekk('ukonfigurert: blob kaster', /^kastet: /.test(tomt.blob), true);
    sjekk('ukonfigurert: samme melding fra begge', tomt.tabell, tomt.blob);
    sjekk('ukonfigurert: meldingen navngir begge veiene',
        /STORAGE_CONNECTION_STRING/.test(tomt.tabell) && /STORAGE_ACCOUNT_NAME/.test(tomt.tabell), true);

    // Og den feilmerkede verdien: en tilkoblingsstreng i kontonavnet skal
    // stoppes FØR den havner i et vertsnavn, i begge modulene.
    const rart = veier({ STORAGE_ACCOUNT_NAME: STRENG });
    sjekk('ugyldig kontonavn: tabell kaster', /^kastet: /.test(rart.tabell), true);
    sjekk('ugyldig kontonavn: blob kaster', /^kastet: /.test(rart.blob), true);
    sjekk('ugyldig kontonavn: ingen nøkkel i meldingen',
        /OPPDIKTET/.test(rart.tabell + rart.blob), false);

    // ---- samme identitet, samme konto ----
    kall.length = 0;
    medMiljo({ STORAGE_ACCOUNT_NAME: KONTO, AZURE_CLIENT_ID: KLIENTID }, () => {
        const t = storage.tabellKlient('Skjemaer');
        const b = blob.serviceKlient();
        sjekk('tabellen peker på kontoen', t.url, `https://${KONTO}.table.core.windows.net`);
        sjekk('bloben peker på SAMME konto', b.url, `https://${KONTO}.blob.core.windows.net`);
        // Samme objekt, ikke bare samme verdi: legitimasjonen caches i den
        // delte modulen. Er de ulike instanser, har hver modul laget sin egen —
        // og da er det to steder som kan drive fra hverandre igjen.
        sjekk('og begge bruker SAMME legitimasjonsobjekt', t.legitimasjon === b.legitimasjon, true);
        sjekk('clientId sendes med', t.legitimasjon.opts, { managedIdentityClientId: KLIENTID });
    });

    // Uten clientId skal SDK-en kalles uten opts — ikke med en tom streng,
    // som @azure/identity tolker som «en identitet som heter tomt».
    medMiljo({ STORAGE_ACCOUNT_NAME: 'stannenkonto' }, () => {
        sjekk('uten clientId: ingen opts',
            storage.tabellKlient('Skjemaer').legitimasjon.opts, undefined);
    });
}

// ---------- 5. `*Fra`-variantene følger ikke miljøets valg ----------
//
// De peker på en konto i en ANNEN tenant (todo-lista med vedlegg), der en
// managed identity ikke kan få rolle. Delt nøkkel er eneste vei dit, også når
// miljøet selv har gått over til identitet.
{
    medMiljo({ STORAGE_ACCOUNT_NAME: KONTO, AZURE_CLIENT_ID: KLIENTID }, () => {
        sjekk('tabellKlientFra bruker strengen den får',
            storage.tabellKlientFra(STRENG, 'Todo').vei, 'streng');
        sjekk('containerKlientFra bruker strengen den får',
            blob.containerKlientFra(STRENG, 'vedlegg').tjeneste.vei, 'streng');
    });
    const kastet = (f) => { try { f(); return null; } catch (e) { return e.message; } };
    sjekk('tabellKlientFra uten streng navngir variabelen den fikk',
        kastet(() => storage.tabellKlientFra('', 'Todo', 'TODO_STORAGE_CONNECTION_STRING')),
        'TODO_STORAGE_CONNECTION_STRING env-var mangler');
    sjekk('serviceKlientFra uten streng navngir variabelen den fikk',
        kastet(() => blob.serviceKlientFra('', 'TODO_STORAGE_CONNECTION_STRING')),
        'TODO_STORAGE_CONNECTION_STRING env-var mangler');
}

// ---------- 6. regelen finnes bare ETT sted ----------
{
    const les = (p) => fs.readFileSync(path.join(rot, p), 'utf8')
        // Kommentarlinjer kastes: de NEVNER variabelnavnene med vilje, og en
        // forklaring er ikke et oppslag.
        .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

    for (const fil of ['api/src/lib/storage.js', 'api/src/lib/blob.js']) {
        const kode = les(fil);
        sjekk(`${fil} spør den delte regelen`, /require\('\.\/lagringsvalg'\)/.test(kode), true);
        // Ingen egen lesing av de to variablene som BESTEMMER veien.
        sjekk(`${fil} leser ikke STORAGE_CONNECTION_STRING selv`,
            /env\.STORAGE_CONNECTION_STRING/.test(kode), false);
        sjekk(`${fil} leser ikke STORAGE_ACCOUNT_NAME selv`,
            /env\.STORAGE_ACCOUNT_NAME/.test(kode), false);
        sjekk(`${fil} bygger ikke sitt eget vertsnavn`,
            /core\.windows\.net/.test(kode), false);
        sjekk(`${fil} lager ikke sin egen legitimasjon`,
            /DefaultAzureCredential/.test(kode), false);
        // Og ikke sitt eget cachenøkkelformat. To strengformater som skal være
        // like, er to som kan bli ulike.
        sjekk(`${fil} bruker den delte cachenøkkelen`, /miNokkel\(/.test(kode), true);
        sjekk(`${fil} skriver ikke formatet selv`, /`mi:\$\{/.test(kode), false);
    }

    // Og mi-prøvene: de finnes for å måle den EKTE veien. Bygger de sin egen
    // URL eller sin egen legitimasjon, kan de bli grønne mens lagringen er rød.
    const prove = les('api/src/functions/mi-diagnose.js');
    sjekk('mi-prøvene bruker den delte modulen',
        /require\('\.\.\/lib\/lagringsvalg'\)/.test(prove), true);
    sjekk('mi-prøvene bygger ikke sitt eget vertsnavn for lagring',
        /\.(table|blob)\.core\.windows\.net/.test(prove), false);
    sjekk('mi-prøvene lager ikke sin egen legitimasjon',
        /new DefaultAzureCredential/.test(prove), false);

    // Kontonavn-regelen er ETT regexp. Står mønsteret skrevet ut et annet sted
    // i api/src, er det en kopi — og kopien er den som godtar noe den andre
    // avviser.
    const kopier = [];
    const gå = (katalog) => {
        for (const n of fs.readdirSync(katalog, { withFileTypes: true })) {
            const p = path.join(katalog, n.name);
            if (n.isDirectory()) { gå(p); continue; }
            if (!n.name.endsWith('.js')) continue;
            if (p.endsWith(path.join('lib', 'lagringsvalg.js'))) continue;
            const t = fs.readFileSync(p, 'utf8');
            if (/\[a-z0-9\]\{3,24\}/.test(t)) kopier.push(path.relative(rot, p));
        }
    };
    gå(path.join(rot, 'api', 'src'));
    sjekk('kontonavn-mønsteret står bare i lagringsvalg.js', kopier.sort(), []);
}

// ---------- 7. inventaret er enig med koden ----------
//
// Koden leser nå STORAGE_ACCOUNT_NAME. Står den fortsatt som «leses ikke av
// koden» i helsesjekkens unntaksliste, er unntaket en løgn — og
// env-inventar.test.js slutter å kreve at den finnes i miljøfilene.
{
    const system = require('../src/functions/system.js');
    sjekk('STORAGE_ACCOUNT_NAME er ikke lenger erklært som ulest',
        system._VIST_UTEN_AT_KODEN_LESER.includes('STORAGE_ACCOUNT_NAME'), false);

    // Og helsesjekken viser valget fra REGELEN, ikke en egen oppsummering
    // bygget av hvilke env-varer som er satt. En slik oppsummering er den
    // fjerde kopien, og den som ville vist «delt nøkkel» mens lagringen gikk
    // på identitet.
    const kilde = fs.readFileSync(path.join(rot, 'api', 'src', 'functions', 'system.js'), 'utf8');
    sjekk('helsesjekken viser valget fra regelen', /lagring: lagringsvalg\(\)/.test(kilde), true);
}

// ---------- 8. eksempelet for lokal kjøring peker ikke på et ekte lager ----------
//
// `STORAGE_ACCOUNT_NAME` har stått i eksempelfila i lang tid, med pilotens
// konto som verdi — den vises i helsesjekken og var ufarlig da koden ikke
// leste den. Nå leser den den: var strengen usatt, ville en lokal kjøring
// valgt managed identity, og `DefaultAzureCredential` ville falt tilbake på
// utviklerens egen `az login` mot pilotens lager. En lokal kjøring som skriver
// i et ekte miljø er den slags uhell man ikke oppdager før etterpå.
{
    const eks = JSON.parse(fs.readFileSync(path.join(rot, 'api', 'local.settings.example.json'), 'utf8'));
    const valg = lv.lagringsvalg(eks.Values || {});
    sjekk('eksempelfila velger tilkoblingsstreng', valg.maate, 'tilkoblingsstreng');
    sjekk('og strengen er emulatoren, ikke et ekte lager',
        lv.tilkoblingsstreng(eks.Values || {}), 'UseDevelopmentStorage=true');
    // Og begrunnelsen står i fila, slik at den ikke fjernes som overflødig.
    sjekk('fella er forklart i fila',
        /lagringsvalg\.js/.test(eks._kommentar || ''), true);
}

// ---------- kontonavnet: ett svar, uansett vei inn ----------
//
// `lagringsvalg().konto` er det admin-panelet VISER. `miljoetsKonto()` er det
// koden spør når den trenger å vite hvilken konto som er vår. To kilder til
// samme opplysning — og til 19.10.2026 var de uenige: på tilkoblingsstreng
// svarte visningen `null` mens `miljoetsKonto()` leste navnet ut av strengen.
//
// Prisen var en formiddag. En tom LU-kolonne ble feilsøkt i en tabell som
// tilhørte en HELT ANNEN lagringskonto, fordi ingenting i appen kunne si
// hvilken konto den selv leste fra — og det miljøet som ikke kunne si det,
// var nettopp det som går på tilkoblingsstreng.
//
// Her leses BEGGE, i begge modusene, og de skal svare likt.
{
    const tilfeller = [
        ['tilkoblingsstreng', { STORAGE_CONNECTION_STRING: STRENG }],
        ['managed identity', { STORAGE_ACCOUNT_NAME: KONTO, AZURE_CLIENT_ID: 'klient-id' }],
        ['bare konto', { STORAGE_ACCOUNT_NAME: KONTO }]
    ];
    for (const [navn, env] of tilfeller) {
        const vist = lv.lagringsvalg(env).konto;
        const brukt = lv.miljoetsKonto(env);
        sjekk(`${navn}: visningen og oppslaget gir samme konto`, vist, brukt);
        sjekk(`${navn}: og det er et kontonavn`, vist, KONTO);
    }

    // Ukonfigurert skal gi null begge veier — ikke tomt navn, ikke «ukjent».
    sjekk('ukonfigurert: visningen gir null', lv.lagringsvalg({}).konto, null);
    sjekk('ukonfigurert: oppslaget gir null', lv.miljoetsKonto({}), null);

    // En SAS-basert streng har ingen AccountName. Navnet skal likevel fram,
    // lest ut av vertsnavnet — ellers står panelet tomt akkurat der det
    // trengs mest.
    const sas = 'BlobEndpoint=https://stskjema3prod.blob.core.windows.net/;SharedAccessSignature=sv=2024-11-04&sig=OPPDIKTET';
    sjekk('SAS-streng: kontonavnet leses ut av vertsnavnet',
        lv.lagringsvalg({ STORAGE_CONNECTION_STRING: sas }).konto, 'stskjema3prod');

    // Og det viktigste: NØKKELEN skal aldri ut. Kontonavnet er ikke en
    // hemmelighet; nøkkelen i samme streng er det.
    const vist = JSON.stringify(lv.lagringsvalg({ STORAGE_CONNECTION_STRING: STRENG }));
    sjekk('det finnes en nøkkel å lekke i strengen', STRENG.includes('OPPDIKTET+NOKKEL=='), true);
    sjekk('og den står ikke i det som vises', vist.includes('OPPDIKTET'), false);
    sjekk('heller ikke hele strengen', vist.includes('DefaultEndpointsProtocol'), false);
}

Module._load = ekteLast;
console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
