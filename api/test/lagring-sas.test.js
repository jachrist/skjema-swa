/**
 * Del 2 av steg 3: SAS-signering og «hvilken konto er vår egen» — begge veier.
 *
 * To ting hadde bare én vei, og begge gikk gjennom tilkoblingsstrengen:
 *
 *   **SAS-URL-en til en backupfil.** `functions/backup.js` rev kontonøkkelen
 *   ut av `STORAGE_CONNECTION_STRING` og signerte lokalt. Med managed identity
 *   finnes ingen nøkkel å signere med; da må Azure utstede en user delegation
 *   key først. Signeringen bor nå i `lib/blob.js`, som kjenner begge veiene.
 *
 *   **«Er dette vår egen lagringskonto?»** Tre vakter spør om det, og alle tre
 *   leste tilkoblingsstrengen direkte — og ble dermed STILLE SLÅTT AV i et
 *   miljø som går på identitet. Svaret kommer nå fra `miljoetsKonto()`, som
 *   følger samme valg som legitimasjonen.
 *
 * Testen kjører de ekte funksjonene mot stubbede SDK-er. Den sjekker ikke at
 * signaturen er kryptografisk riktig — det kan bare Azure svare på, og
 * `/api/diagnose/mi-blob?skriv=ja` gjorde det i dev 16.10.2026. Den sjekker at
 * RIKTIG legitimasjon, riktig konto og riktig utløp går inn i signeringen, at
 * delegeringsnøkkelen hentes én gang og ikke én gang per blob, og at ingen av
 * de to reglene har fått en kopi.
 *
 * Kjøres med:  node api/test/lagring-sas.test.js
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
const sasKall = [];
const delegeringsKall = [];

class Legitimasjon {
    constructor(opts) { this.opts = opts; }
}
class DeltNokkel {
    constructor(konto, nokkel) { this.konto = konto; this.nokkel = nokkel; }
}

let nr = 0;
// Hvor lenge den stubbede tjenesten later som nøkkelen varer. Settes av testen
// som sjekker fornyelse.
let delegeringVarerMs = null;

class BlobTjeneste {
    constructor(url) { this.vei = 'identitet'; this.url = url; }
    static fromConnectionString(cs) {
        const t = Object.create(BlobTjeneste.prototype);
        t.vei = 'streng';
        t.cs = cs;
        return t;
    }
    getContainerClient(navn) { return { navn, tjeneste: this }; }
    async getUserDelegationKey(starter, utloper) {
        delegeringsKall.push({ starter, utloper, url: this.url });
        const slutt = delegeringVarerMs === null
            ? utloper
            : new Date(Date.now() + delegeringVarerMs);
        return {
            value: 'OPPDIKTET-DELEGERINGSNOKKEL',
            signedObjectId: 'oid',
            signedExpiresOn: slutt.toISOString(),
            nr: ++nr
        };
    }
}

class TabellKlient {
    constructor(url, tabell) { this.vei = 'identitet'; this.url = url; this.tabell = tabell; }
    static fromConnectionString(cs, tabell) {
        const k = Object.create(TabellKlient.prototype);
        k.vei = 'streng'; k.cs = cs; k.tabell = tabell;
        return k;
    }
    async createTable() { }
}

const STUBBER = {
    '@azure/data-tables': { TableClient: TabellKlient, odata: (...a) => a.join('') },
    '@azure/storage-blob': {
        BlobServiceClient: BlobTjeneste,
        StorageSharedKeyCredential: DeltNokkel,
        BlobSASPermissions: { parse: (s) => ({ tilgang: s }) },
        generateBlobSASQueryParameters: (verdier, legitimasjon, konto) => {
            sasKall.push({ verdier, legitimasjon, konto });
            return { toString: () => 'SIGNATUR' };
        }
    },
    '@azure/identity': { DefaultAzureCredential: Legitimasjon }
};
const ekteLast = Module._load;
Module._load = function (forespurt, ...rest) {
    if (Object.prototype.hasOwnProperty.call(STUBBER, forespurt)) return STUBBER[forespurt];
    return ekteLast.call(this, forespurt, ...rest);
};

const rot = path.join(__dirname, '..', '..');
const lv = require('../src/lib/lagringsvalg');
const blob = require('../src/lib/blob');
const dl = require('../src/lib/delt-lager');
// De to listene som BRUKER den delte regelen. Begge eksponerer `lagerInfo()`
// til admin-panelet, og formen der er en kontrakt mot frontend.
const todo = require('../src/lib/todo-storage');
const kalender = require('../src/lib/nokkelkalender-storage');

const KONTO = 'stskjema3dev';
const PILOTKONTO = 'stfhsskjemapilot';
const KLIENTID = '11111111-2222-3333-4444-555555555555';
const NOKKEL = 'OPPDIKTET+KONTONOKKEL==';
const STRENG = `DefaultEndpointsProtocol=https;AccountName=${PILOTKONTO};AccountKey=${NOKKEL};EndpointSuffix=core.windows.net`;
const DELT_STRENG = 'BlobEndpoint=https://stdelt.blob.core.windows.net/;'
    + 'TableEndpoint=https://stdelt.table.core.windows.net/;'
    + 'SharedAccessSignature=sv=2022&sig=OPPDIKTET';

const VARER = ['STORAGE_CONNECTION_STRING', 'STORAGE_ACCOUNT_NAME', 'AZURE_CLIENT_ID',
    'TODO_STORAGE_CONNECTION_STRING'];

async function medMiljo(env, f) {
    const foer = {};
    for (const n of VARER) {
        foer[n] = process.env[n];
        if (env[n] === undefined) delete process.env[n];
        else process.env[n] = env[n];
    }
    blob._glemDelegering();
    sasKall.length = 0;
    delegeringsKall.length = 0;
    delegeringVarerMs = null;
    try { return await f(); } finally {
        for (const [n, v] of Object.entries(foer)) {
            if (v === undefined) delete process.env[n];
            else process.env[n] = v;
        }
    }
}

const kastet = (f) => { try { f(); return null; } catch (e) { return e.message; } };
async function kastetAsync(f) {
    try { await f(); return null; } catch (e) { return e.message; }
}

/**
 * Kjør noe som skal lykkes, og gjør en feil om til en RAPPORTERT feil.
 *
 * Uten dette river en regresjon i lagervalget hele testfila med seg: den
 * kaster ut av main(), og de gjenstående sjekkene blir aldri kjørt. En test
 * som dør av det første problemet forteller mindre enn en som rapporterer det
 * og går videre.
 */
async function skalVirke(navn, f) {
    try { return await f(); } catch (e) {
        feil++;
        console.log(`FEIL  ${navn}\n      kastet    ${e.message}`);
        return null;
    }
}

async function main() {

// ---------- 1. «vår egen konto» følger samme valg som legitimasjonen ----------
{
    sjekk('streng: navnet leses ut av strengen',
        lv.miljoetsKonto({ STORAGE_CONNECTION_STRING: STRENG }), PILOTKONTO);

    // DEN VIKTIGE RETNINGEN. Pilot har et kontonavn i inventaret som ikke
    // nødvendigvis er det strengen peker på. Går miljøet på strengen, er det
    // strengen som sier hvor dataene ligger — et inventarnavn som har drevet
    // ville pekt admin-panelet på et lager vi ikke snakker med.
    sjekk('begge satt, og uenige: strengen avgjør',
        lv.miljoetsKonto({ STORAGE_CONNECTION_STRING: STRENG, STORAGE_ACCOUNT_NAME: 'stnoeannet' }),
        PILOTKONTO);

    sjekk('identitet: navnet er STORAGE_ACCOUNT_NAME',
        lv.miljoetsKonto({ STORAGE_ACCOUNT_NAME: KONTO }), KONTO);
    sjekk('ukonfigurert: vet ikke', lv.miljoetsKonto({}), null);
    // En SAS-basert streng har ingen AccountName — navnet må ut av vertsnavnet.
    sjekk('SAS-streng: navnet leses ut av vertsnavnet',
        lv.miljoetsKonto({ STORAGE_CONNECTION_STRING: DELT_STRENG }), 'stdelt');
    // Og et ugyldig kontonavn er «vet ikke», ikke et navn vi later som finnes.
    sjekk('ugyldig kontonavn: vet ikke',
        lv.miljoetsKonto({ STORAGE_ACCOUNT_NAME: STRENG }), null);

    // Samme svar som lagringsvalg() peker på, i alle retninger.
    for (const env of [
        { STORAGE_CONNECTION_STRING: STRENG },
        { STORAGE_CONNECTION_STRING: STRENG, STORAGE_ACCOUNT_NAME: KONTO },
        { STORAGE_ACCOUNT_NAME: KONTO },
        {}
    ]) {
        const valg = lv.lagringsvalg(env);
        const forventet = valg.maate === 'managed-identity' ? valg.konto
            : valg.maate === 'tilkoblingsstreng' ? lv.kontoNavnFra(env.STORAGE_CONNECTION_STRING)
                : null;
        sjekk(`kontoen følger valget (${valg.maate})`, lv.miljoetsKonto(env), forventet);
    }
}

// ---------- 2. kontonøkkelen ut av strengen ----------
{
    sjekk('konto og nøkkel leses ut', lv.kontonokkelFra(STRENG),
        { konto: PILOTKONTO, nokkel: NOKKEL });
    // En SAS-streng har ingen AccountKey. Da kan ingen SAS signeres med delt
    // nøkkel, og det skal sies — ikke gis en signatur av halve opplysninger.
    const m = kastet(() => lv.kontonokkelFra(DELT_STRENG));
    sjekk('uten AccountKey kaster den', !!m, true);
    sjekk('og nøkkelen gjentas ikke i meldingen', /OPPDIKTET/.test(m || ''), false);
    sjekk('uten AccountName kaster den også',
        !!kastet(() => lv.kontonokkelFra(`AccountKey=${NOKKEL}`)), true);
}

// ---------- 3. SAS på delt nøkkel ----------
await medMiljo({ STORAGE_CONNECTION_STRING: STRENG }, async () => {
    const u = await blob.sasUrl('backups', 'pilot-backup-2026.fsbk');
    sjekk('ingen delegering hentes på strengveien', delegeringsKall.length, 0);
    sjekk('ett signeringskall', sasKall.length, 1);
    const k = sasKall[0];
    sjekk('signert med delt nøkkel', k.legitimasjon instanceof DeltNokkel, true);
    sjekk('med kontoen fra strengen', k.legitimasjon.konto, PILOTKONTO);
    sjekk('og nøkkelen fra strengen', k.legitimasjon.nokkel, NOKKEL);
    // Tredje argument er BARE for delegeringsveien. Står det et kontonavn der
    // på strengveien, velger SDK-en en annen signeringsvariant.
    sjekk('uten kontonavn som tredje argument', k.konto, undefined);
    sjekk('bare lesetilgang', k.verdier.permissions, { tilgang: 'r' });
    sjekk('riktig container', k.verdier.containerName, 'backups');
    sjekk('riktig blob', k.verdier.blobName, 'pilot-backup-2026.fsbk');
    sjekk('https', k.verdier.protocol, 'https');
    // 24 timer, og starten litt bakover for klokkeslark.
    const timer = (k.verdier.expiresOn - k.verdier.startsOn) / 3600000;
    sjekk('varer et døgn pluss slarken', Math.round(timer * 100) / 100, 24.08);
    sjekk('starter i fortiden', k.verdier.startsOn < new Date(), true);

    sjekk('URL-en peker på kontoen fra strengen',
        u, `https://${PILOTKONTO}.blob.core.windows.net/backups/pilot-backup-2026.fsbk?SIGNATUR`);
});

// ---------- 4. SAS på managed identity ----------
await medMiljo({ STORAGE_ACCOUNT_NAME: KONTO, AZURE_CLIENT_ID: KLIENTID }, async () => {
    const u = await blob.sasUrl('backups', 'dev-backup-2026.fsbk');
    sjekk('delegeringsnøkkel hentes', delegeringsKall.length, 1);
    sjekk('fra tjenesten på vår egen konto',
        delegeringsKall[0].url, `https://${KONTO}.blob.core.windows.net`);
    // Nøkkelen må dekke SAS-ens utløp. Utløper den først, blir SAS-en ugyldig
    // i stillhet — URL-en ser riktig ut og avvises.
    sjekk('og varer lenger enn SAS-en',
        delegeringsKall[0].utloper > sasKall[0].verdier.expiresOn, true);

    const k = sasKall[0];
    sjekk('signert med delegeringsnøkkelen', k.legitimasjon.value, 'OPPDIKTET-DELEGERINGSNOKKEL');
    sjekk('ikke med en delt nøkkel', k.legitimasjon instanceof DeltNokkel, false);
    // Delegeringsveien KREVER kontonavnet som tredje argument. Uten det kan
    // SDK-en ikke bygge signaturen, og feilen kommer først fra Azure.
    sjekk('kontonavnet er med som tredje argument', k.konto, KONTO);
    sjekk('bare lesetilgang', k.verdier.permissions, { tilgang: 'r' });
    sjekk('URL-en peker på vår egen konto',
        u, `https://${KONTO}.blob.core.windows.net/backups/dev-backup-2026.fsbk?SIGNATUR`);
});

// ---------- 5. delegeringsnøkkelen hentes én gang, ikke én gang per blob ----------
//
// `/api/backup/liste` lager én SAS per fil. Ett nettverkskall per fil ville
// gjort en liste på femti filer til femti rundturer.
await medMiljo({ STORAGE_ACCOUNT_NAME: KONTO, AZURE_CLIENT_ID: KLIENTID }, async () => {
    for (let i = 0; i < 5; i++) await blob.sasUrl('backups', `fil-${i}.fsbk`);
    sjekk('fem SAS-er', sasKall.length, 5);
    sjekk('én delegeringsnøkkel', delegeringsKall.length, 1);
    sjekk('og alle fem signert med den samme',
        new Set(sasKall.map(k => k.legitimasjon.nr)).size, 1);
});

// ---------- 6. ...men fornyes når den ikke lenger dekker utløpet ----------
await medMiljo({ STORAGE_ACCOUNT_NAME: KONTO, AZURE_CLIENT_ID: KLIENTID }, async () => {
    // Tjenesten later som nøkkelen bare varer et kvarter. SAS-en skal vare et
    // døgn, så den cachede nøkkelen kan ikke gjenbrukes.
    delegeringVarerMs = 15 * 60 * 1000;
    await blob.sasUrl('backups', 'en.fsbk');
    await blob.sasUrl('backups', 'to.fsbk');
    sjekk('nøkkelen hentes på nytt når den er for kort', delegeringsKall.length, 2);
    sjekk('og de to SAS-ene har hver sin nøkkel',
        new Set(sasKall.map(k => k.legitimasjon.nr)).size, 2);
});

// ---------- 6b. ...og er knyttet til KONTOEN den ble utstedt av ----------
//
// Nøkkelen er utstedt av én konto til én identitet. Ligger den i én global
// variabel, signerer neste konto med forrige kontos nøkkel: URL-en ser riktig
// ut og avvises av tjenesten. Cachen tømmes IKKE mellom de to her — det er
// nettopp det som avslører en global.
await medMiljo({ STORAGE_ACCOUNT_NAME: KONTO, AZURE_CLIENT_ID: KLIENTID }, async () => {
    await blob.sasUrl('backups', 'en.fsbk');
    process.env.STORAGE_ACCOUNT_NAME = 'stannenkonto';
    await blob.sasUrl('backups', 'to.fsbk');
    sjekk('ny konto gir ny delegeringsnøkkel', delegeringsKall.length, 2);
    sjekk('hentet fra hver sin konto',
        delegeringsKall.map(k => k.url),
        [`https://${KONTO}.blob.core.windows.net`, 'https://stannenkonto.blob.core.windows.net']);
    sjekk('og de to SAS-ene har hver sin nøkkel',
        new Set(sasKall.map(k => k.legitimasjon.nr)).size, 2);
    sjekk('signert for hver sin konto', sasKall.map(k => k.konto), [KONTO, 'stannenkonto']);
});

// ---------- 7. ukonfigurert ----------
await medMiljo({}, async () => {
    const m = await kastetAsync(() => blob.sasUrl('backups', 'en.fsbk'));
    sjekk('ukonfigurert: kaster', !!m, true);
    sjekk('og navngir begge veiene',
        /STORAGE_CONNECTION_STRING/.test(m || '') && /STORAGE_ACCOUNT_NAME/.test(m || ''), true);
    sjekk('og ingen signatur ble laget', sasKall.length, 0);
});

// ---------- 8. de delte listene ----------
//
// Todo-lista og nøkkelkalenderen ligger på en konto i en annen tenant, nådd
// med SAS. Er strengen ikke satt, skal de falle tilbake til miljøets eget
// lager — og den fallbacken var `DELT_CS || process.env.STORAGE_CONNECTION_STRING`,
// som blir en TOM STRENG i et miljø som går på identitet. Da feilet lista med
// at en variabel som med vilje ikke er satt, mangler.
{
    await medMiljo({ TODO_STORAGE_CONNECTION_STRING: DELT_STRENG, STORAGE_ACCOUNT_NAME: KONTO },
        async () => {
            sjekk('delt streng satt: lista er delt', dl.erDelt(), true);
            sjekk('og ligger på den delte kontoen', dl.deltKonto(), 'stdelt');
            const t = await skalVirke('tabellen nås med den delte strengen',
                () => dl.sikreDeltTabell('TodoPunkter'));
            sjekk('tabellen nås med delt nøkkel', t?.vei, 'streng');
            const c = await skalVirke('containeren nås med den delte strengen',
                () => dl.deltContainer('todo-vedlegg'));
            sjekk('containeren også', c?.tjeneste?.vei, 'streng');
            sjekk('lagerinfo', dl.deltLagerInfo(),
                { konto: 'stdelt', delt: true, sammeSomMiljo: false, miljoKonto: KONTO });
        });

    // Uten delt streng, på identitetsveien: dette er tilfellet som var brutt.
    await medMiljo({ STORAGE_ACCOUNT_NAME: KONTO, AZURE_CLIENT_ID: KLIENTID }, async () => {
        sjekk('ingen delt streng: lista er ikke delt', dl.erDelt(), false);
        sjekk('og ligger på miljøets egen konto', dl.deltKonto(), KONTO);
        const t = await skalVirke('tabellen nås uten en delt streng',
            () => dl.sikreDeltTabell('TodoPunkter'));
        sjekk('tabellen nås med identitet', t?.vei, 'identitet');
        sjekk('og på riktig konto', t?.url, `https://${KONTO}.table.core.windows.net`);
        const c = await skalVirke('containeren nås uten en delt streng',
            () => dl.deltContainer('todo-vedlegg'));
        sjekk('containeren også', c?.tjeneste?.vei, 'identitet');
        // «Samme som miljøet» er meningen her, ikke en feil — vakten gjelder
        // bare når en delt streng ER satt.
        sjekk('lagerinfo', dl.deltLagerInfo(),
            { konto: KONTO, delt: false, sammeSomMiljo: false, miljoKonto: KONTO });
        // Og glemmingen skal ikke kaste: den må finne lagernøkkelen for
        // identitetsveien, som kalleren ikke har.
        sjekk('glemming virker uten en streng å nøkle på',
            kastet(() => dl.glemDeltOpprettelse('TodoPunkter')), null);
    });

    // Uten delt streng, på strengveien: uendret oppførsel for pilot og prod.
    await medMiljo({ STORAGE_CONNECTION_STRING: STRENG }, async () => {
        const t = await skalVirke('tabellen nås i pilot uten en delt streng',
            () => dl.sikreDeltTabell('TodoPunkter'));
        sjekk('pilot uten delt streng: delt nøkkel som før', t?.vei, 'streng');
        sjekk('og på egen konto', dl.deltKonto(), PILOTKONTO);
    });

    // VAKTEN. Peker den delte SAS-en på miljøets egen konto, er lista ikke
    // delt med noen — nesten alltid en forveksling ved utstedelsen. Den var
    // stille slått av på identitetsveien, fordi den leste strengen.
    await medMiljo({
        TODO_STORAGE_CONNECTION_STRING: `BlobEndpoint=https://${KONTO}.blob.core.windows.net/;SharedAccessSignature=sv=2022`,
        STORAGE_ACCOUNT_NAME: KONTO
    }, async () => {
        sjekk('vakten slår til på identitetsveien', dl.deltLagerInfo().sammeSomMiljo, true);
    });
    await medMiljo({
        TODO_STORAGE_CONNECTION_STRING: `BlobEndpoint=https://${PILOTKONTO}.blob.core.windows.net/;SharedAccessSignature=sv=2022`,
        STORAGE_CONNECTION_STRING: STRENG
    }, async () => {
        sjekk('og på strengveien, som før', dl.deltLagerInfo().sammeSomMiljo, true);
    });
    // Store og små bokstaver er samme konto.
    await medMiljo({
        TODO_STORAGE_CONNECTION_STRING: `BlobEndpoint=https://${KONTO.toUpperCase()}.blob.core.windows.net/;SharedAccessSignature=sv=2022`,
        STORAGE_ACCOUNT_NAME: KONTO
    }, async () => {
        sjekk('og bryr seg ikke om bokstavstørrelse', dl.deltLagerInfo().sammeSomMiljo, true);
    });
}

// ---------- 8b. formen admin-panelet leser ----------
//
// `frontend/admin.html` leser `sammeSomMiljo` og `konto` i to visninger.
// Nøkkelkalenderen legger på `miljo`; todo-lista gjør det ikke. Begge formene
// er en kontrakt, og refaktoreringen over flyttet dem.
await medMiljo({ TODO_STORAGE_CONNECTION_STRING: DELT_STRENG, STORAGE_ACCOUNT_NAME: KONTO },
    async () => {
        sjekk('todo-lista: samme form som før', Object.keys(todo.lagerInfo()).sort(),
            ['delt', 'konto', 'miljoKonto', 'sammeSomMiljo']);
        sjekk('nøkkelkalenderen: samme form pluss miljø',
            Object.keys(kalender.lagerInfo()).sort(),
            ['delt', 'konto', 'miljo', 'miljoKonto', 'sammeSomMiljo']);
        sjekk('og begge svarer det samme om lageret',
            { ...kalender.lagerInfo(), miljo: undefined },
            { ...todo.lagerInfo(), miljo: undefined });
        sjekk('kontoen er den delte', todo.lagerInfo().konto, 'stdelt');
    });

// ---------- 9. begge reglene finnes bare ETT sted ----------
{
    const les = (p) => fs.readFileSync(path.join(rot, p), 'utf8')
        .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

    const gå = (katalog, ut = []) => {
        for (const n of fs.readdirSync(katalog, { withFileTypes: true })) {
            const p = path.join(katalog, n.name);
            if (n.isDirectory()) gå(p, ut);
            else if (n.name.endsWith('.js')) ut.push(path.relative(rot, p));
        }
        return ut;
    };
    const filer = gå(path.join(rot, 'api', 'src'));
    sjekk('fant kildefilene', filer.length > 20, true);

    // ---- «vår egen konto» ----
    //
    // Ingen skal lese tilkoblingsstrengen for å finne ut hvilken konto som er
    // vår. Det er nøyaktig det de tre vaktene gjorde, og derfor sluttet de å
    // virke uten å si fra.
    const egenStreng = filer.filter(f => f !== path.join('api', 'src', 'lib', 'lagringsvalg.js')
        && /(process\.)?env\.STORAGE_CONNECTION_STRING/.test(les(f)));
    sjekk('bare lagringsvalg.js leser STORAGE_CONNECTION_STRING', egenStreng.sort(), []);
    sjekk('ingen leser kontoen vår ut av env-strengen',
        filer.filter(f => /kontoNavnFra\(\s*(process\.)?env\./.test(les(f))).sort(), []);

    // kontoNavnFra er fortsatt riktig for en streng noen HAR GITT oss — den
    // eksterne backupen. De to stedene er erklært her.
    const KONTO_NAVN_FRA_LOV = [
        path.join('api', 'src', 'lib', 'lagringsvalg.js'),   // der den bor
        path.join('api', 'src', 'lib', 'delt-lager.js'),     // den delte SAS-en
        path.join('api', 'src', 'functions', 'backup.js')    // ekstern streng fra skjemaet
    ];
    sjekk('kontoNavnFra brukes bare der det er erklært',
        filer.filter(f => /\bkontoNavnFra\b/.test(les(f)) && !KONTO_NAVN_FRA_LOV.includes(f)).sort(),
        []);

    // ---- SAS-signeringen ----
    //
    // mi-diagnose.js er det ene unntaket, og med vilje: prøven signerer mot
    // en konto den får som parameter, for å kunne måle en konto appen ikke
    // selv bruker. Den er erklært her, ikke glemt.
    const SAS_LOV = [
        path.join('api', 'src', 'lib', 'blob.js'),
        path.join('api', 'src', 'functions', 'mi-diagnose.js')
    ];
    sjekk('bare blob.js og prøven signerer en SAS',
        filer.filter(f => /generateBlobSASQueryParameters|StorageSharedKeyCredential/.test(les(f))
            && !SAS_LOV.includes(f)).sort(), []);

    // Og backup.js, som eide signeringen til 16.10.2026, gjør det ikke lenger.
    const bkp = les(path.join('api', 'src', 'functions', 'backup.js'));
    // Kontonøkkelen rives ikke ut noe sted her lenger. (`AccountKey` står
    // fortsatt i fila, i regexen som MASKERER den ut av feilmeldinger — den
    // skal bli.)
    sjekk('backup.js parser ikke kontonøkkelen', /hentKontoOgNokkel|kontonokkelFra/.test(bkp), false);
    sjekk('men maskeringen av den i feilmeldinger står igjen',
        /AccountKey\)=\[\^;\]\*/.test(bkp), true);
    sjekk('backup.js bygger ikke sitt eget vertsnavn', /core\.windows\.net/.test(bkp), false);
    sjekk('backup.js spør lib/blob.js om SAS-en', /sasUrl/.test(bkp), true);
    // `sasUrl` er async nå. Et glemt await gir «[object Promise]» i et JSON-svar
    // — en lenke som ser ut som en feil i Azure.
    sjekk('og venter på svaret hver gang',
        (bkp.match(/\blagSasUrl\(/g) || []).length,
        (bkp.match(/await lagSasUrl\(|return blobSasUrl\(/g) || []).length);

    // ---- den delte lista ----
    for (const fil of [path.join('api', 'src', 'lib', 'todo-storage.js'),
        path.join('api', 'src', 'lib', 'nokkelkalender-storage.js')]) {
        const kode = les(fil);
        sjekk(`${fil} spør delt-lager`, /require\('\.\/delt-lager'\)/.test(kode), true);
        sjekk(`${fil} regner ikke ut sammeSomMiljo selv`, /sammeSomMiljo\s*=/.test(kode), false);
        // Fallbacken var `DELT_CS || process.env.STORAGE_CONNECTION_STRING`,
        // og den trengte disse fire for å virke. Går en av dem inn igjen her,
        // er kopien tilbake. (At miljøets egen streng ikke leses noe sted
        // utenfor lagringsvalg.js, sjekkes samlet over.)
        for (const navn of ['sikreTabellFra', 'containerKlientFra', 'glemOpprettelse',
            'glemOpprettelseIMiljoet']) {
            sjekk(`${fil} velger ikke lager selv (${navn})`,
                new RegExp(`\\b${navn}\\(`).test(kode), false);
        }
    }
}

// ---------- 10. inventaret ----------
{
    // Den delte strengen leses nå bare i delt-lager.js. Leses den gjennom
    // konstanten `VAR`, forsvinner den fra inventaret — se env-inventar.test.js.
    const dlKilde = fs.readFileSync(path.join(rot, 'api', 'src', 'lib', 'delt-lager.js'), 'utf8');
    sjekk('delt-lager.js leser navnet skrevet ut',
        /env\.TODO_STORAGE_CONNECTION_STRING/.test(dlKilde), true);
}

}

main().then(() => {
    Module._load = ekteLast;
    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
}).catch((e) => {
    console.log('TESTEN KRASJET:', e.stack);
    process.exit(1);
});
