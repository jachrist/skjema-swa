/**
 * Entra-token på utgående flyt-kall — steg 7.
 *
 * Signaturen i flyt-URL-en (`sig=`) gjør ADRESSEN til legitimasjonen: den som
 * har lenken kan kalle flyten, og siden e-postteksten bygges av felter i
 * payloaden betyr det en melding som ser ut til å komme fra skjemasystemet.
 * Derfor kan URL-en ikke stå i en e-post, en sak eller en logg — svakhet 9.1
 * i overleveringsdokumentet.
 *
 * Krever flyten et Entra-token i stedet, forsvinner hele den kategorien.
 * Det ble bevist 15.10.2026 og tatt i bruk 16.10.2026.
 *
 * Fire ting holdes fast:
 *
 *   **Standard er uendret.** Uten `FLYT_AUTH` ser kallet ut nøyaktig som før.
 *   Pilot og prod har ingen managed identity, og et deploy av dette skal ikke
 *   merkes der.
 *
 *   **Skråstreken bakerst i ressursen.** Power Automate sammenligner `aud`
 *   bokstavelig. Uten den svarer flyten `MisMatchingOAuthClaims` — målt.
 *
 *   **Feilen forteller hva som gikk galt.** Er modusen entra og tokenet ikke
 *   kan hentes, skal kallet IKKE gå uten header. Da ville «vi har ingen
 *   identitet» ikke vært til å skille fra «flyten avviste oss».
 *
 *   **Ingen bygger sine egne flyt-headere.** `ekstern-flyt.js` gjorde det, og
 *   manglet derfor både `x-flow-key` og tokenet.
 *
 * Kjøres med:  node api/test/flyt-auth.test.js
 */
const fs = require('fs');
const path = require('path');
const { utenKommentarer } = require('../../scripts/test-kilde.js');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const rot = path.join(__dirname, '..', '..');
const les = (...p) => fs.readFileSync(path.join(rot, ...p), 'utf8');

const auth = require('../src/lib/flyt-auth');
const flytKaller = require('../src/lib/flyt-kaller');

const KLIENTID = '11111111-2222-3333-4444-555555555555';
const VARER = ['FLYT_AUTH', 'AZURE_CLIENT_ID', 'IDENTITY_ENDPOINT', 'IDENTITY_HEADER',
    'FLOW_CALLBACK_KEY'];

// Identity-endepunktet stubbes med en fetch vi styrer. Da kan vi se nøyaktig
// hva som ble spurt om — det er den ene detaljen hele steg 7 sto på.
let kall = [];
let svarMed = null;
const ekteFetch = globalThis.fetch;
function stubbFetch(fn) {
    globalThis.fetch = fn;
}
function standardSvar(utloperOm = 3600) {
    return async (u, opts) => {
        kall.push({ url: String(u), opts });
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({
                access_token: 'ETT.OPPDIKTET.TOKEN',
                expires_on: String(Math.floor(Date.now() / 1000) + utloperOm),
                resource: new URL(String(u)).searchParams.get('resource')
            })
        };
    };
}

async function medMiljo(env, f) {
    const foer = {};
    for (const n of VARER) {
        foer[n] = process.env[n];
        if (env[n] === undefined) delete process.env[n];
        else process.env[n] = env[n];
    }
    auth._glemToken();
    kall = [];
    stubbFetch(svarMed || standardSvar());
    try { return await f(); } finally {
        for (const [n, v] of Object.entries(foer)) {
            if (v === undefined) delete process.env[n];
            else process.env[n] = v;
        }
        globalThis.fetch = ekteFetch;
        auth._glemToken();
    }
}

const MI = {
    FLYT_AUTH: 'entra',
    AZURE_CLIENT_ID: KLIENTID,
    IDENTITY_ENDPOINT: 'https://eksempel.invalid/msi/token',
    IDENTITY_HEADER: 'HEMMELIG-IDENTITY-HEADER'
};

async function main() {

// ---------- 1. modusen ----------
{
    sjekk('usatt → sas', auth.flytAuthModus({}).modus, 'sas');
    sjekk('entra → entra', auth.flytAuthModus({ FLYT_AUTH: 'entra' }).modus, 'entra');
    sjekk('sas → sas', auth.flytAuthModus({ FLYT_AUTH: 'sas' }).modus, 'sas');
    sjekk('ENTRA med mellomrom → entra', auth.flytAuthModus({ FLYT_AUTH: '  ENTRA \n' }).modus, 'entra');
    // En tastefeil skal gi dagens oppførsel, ikke et token til en flyt som
    // ikke venter det — og den skal SIES, ikke ties i hjel.
    const rart = auth.flytAuthModus({ FLYT_AUTH: 'entraa' });
    sjekk('ukjent verdi → sas', rart.modus, 'sas');
    sjekk('og årsaken sier at verdien er ukjent', /noe annet enn/.test(rart.grunn), true);
    sjekk('modusen er alltid en av de erklærte',
        [{}, { FLYT_AUTH: 'entra' }, { FLYT_AUTH: 'sas' }, { FLYT_AUTH: 'tull' }]
            .every(e => auth.MODUS.includes(auth.flytAuthModus(e).modus)), true);
    // Begge feltene alltid satt — en nøkkel som kan forsvinne kan ikke feilsøkes.
    sjekk('alltid modus og grunn', Object.keys(auth.flytAuthModus({})).sort(), ['grunn', 'modus']);
}

// ---------- 2. SKRÅSTREKEN ----------
{
    sjekk('ressursen har skråstrek bakerst', auth.FLYT_RESSURS,
        'https://service.flow.microsoft.com/');
    // Ikke bare konstanten: det som faktisk sendes.
    await medMiljo(MI, async () => {
        await auth.flytAutorisasjon();
        sjekk('ett identity-kall', kall.length, 1);
        const u = new URL(kall[0].url);
        sjekk('resource går ordrett med', u.searchParams.get('resource'),
            'https://service.flow.microsoft.com/');
        // User-assigned identitet må navngis, også når det bare finnes én.
        sjekk('client_id er med', u.searchParams.get('client_id'), KLIENTID);
        sjekk('api-version er satt', !!u.searchParams.get('api-version'), true);
        sjekk('nøkkelen går i headeren',
            kall[0].opts.headers['X-IDENTITY-HEADER'], 'HEMMELIG-IDENTITY-HEADER');
    });
    // Uten AZURE_CLIENT_ID skal parameteren ikke være der i det hele tatt.
    await medMiljo({ ...MI, AZURE_CLIENT_ID: undefined }, async () => {
        await auth.flytAutorisasjon();
        sjekk('ingen client_id når ingen er valgt',
            new URL(kall[0].url).searchParams.has('client_id'), false);
    });
}

// ---------- 3. headeren ----------
{
    await medMiljo({ ...MI, FLOW_CALLBACK_KEY: 'delt-nokkel' }, async () => {
        const h = await flytKaller.flytHeadere();
        sjekk('Bearer settes', h.Authorization, 'Bearer ETT.OPPDIKTET.TOKEN');
        // De to sperrene er uavhengige, og begge skal være der.
        sjekk('x-flow-key er fortsatt med', h['x-flow-key'], 'delt-nokkel');
        sjekk('content-type er fortsatt med', h['Content-Type'], 'application/json');
    });

    // sas: ingen Authorization, og INGEN tokenhenting i det hele tatt.
    await medMiljo({ ...MI, FLYT_AUTH: undefined, FLOW_CALLBACK_KEY: 'delt-nokkel' }, async () => {
        const h = await flytKaller.flytHeadere();
        sjekk('sas: ingen Authorization', 'Authorization' in h, false);
        sjekk('sas: identity-endepunktet kalles ikke', kall.length, 0);
        sjekk('sas: ser ut som før', h, { 'Content-Type': 'application/json', 'x-flow-key': 'delt-nokkel' });
    });

    // Tokenet skal ALDRI havne i noe annet enn Authorization-headeren.
    await medMiljo(MI, async () => {
        const h = await flytKaller.flytHeadere();
        const utenAuth = { ...h };
        delete utenAuth.Authorization;
        sjekk('tokenet står ingen andre steder',
            /OPPDIKTET/.test(JSON.stringify(utenAuth)), false);
        // Og identity-nøkkelen går aldri videre til flyten.
        sjekk('identity-nøkkelen går ikke videre',
            /HEMMELIG-IDENTITY-HEADER/.test(JSON.stringify(h)), false);
    });
}

// ---------- 4. tokenet caches, men ikke for evig ----------
{
    await medMiljo(MI, async () => {
        for (let i = 0; i < 5; i++) await flytKaller.flytHeadere();
        sjekk('ett identity-kall for fem flyt-kall', kall.length, 1);
    });

    // Et token som utløper om to minutter skal hentes på nytt — det kan ellers
    // rekke å dø mellom cachen og flytens validering.
    svarMed = standardSvar(120);
    await medMiljo(MI, async () => {
        await flytKaller.flytHeadere();
        await flytKaller.flytHeadere();
        sjekk('kort levetid gir nytt kall', kall.length, 2);
    });
    svarMed = null;
}

// ---------- 5. feilen forteller hva som gikk galt ----------
{
    // Ingen managed identity: IDENTITY_ENDPOINT er ikke satt. Det er pilot og
    // prod i dag, og det er den feilen man vil se forskjell på.
    await medMiljo({ FLYT_AUTH: 'entra' }, async () => {
        let melding = '(kastet ikke)';
        try { await flytKaller.flytHeadere(); } catch (e) { melding = e.message; }
        sjekk('uten identitet: kastes det', melding !== '(kastet ikke)', true);
        sjekk('og modusen navngis', /FLYT_AUTH=entra/.test(melding), true);
        sjekk('og årsaken følger med', /IDENTITY_ENDPOINT/.test(melding), true);
    });

    // Endepunktet svarer, men uten token.
    svarMed = async (u) => {
        kall.push({ url: String(u) });
        return { ok: true, status: 200, text: async () => JSON.stringify({ noe: 'annet' }) };
    };
    await medMiljo(MI, async () => {
        let melding = '(kastet ikke)';
        try { await flytKaller.flytHeadere(); } catch (e) { melding = e.message; }
        sjekk('uten access_token: kastes det', melding !== '(kastet ikke)', true);
        sjekk('og sier hva som manglet', /access_token/.test(melding), true);
    });
    svarMed = null;

    // Og kallet går IKKE videre uten header. Den ekte veien: kallVarslingFlyt
    // skal gi status 'feil' med årsaken, ikke en 401 fra flyten.
    await medMiljo({ FLYT_AUTH: 'entra', VARSLING_FLOW_URL: undefined }, async () => {
        const foer = process.env.VARSLING_FLOW_URL;
        process.env.VARSLING_FLOW_URL = 'https://eksempel.invalid/flyt';
        let sendt = false;
        stubbFetch(async (u) => {
            if (String(u).includes('/flyt')) { sendt = true; return { ok: true, status: 200, json: async () => ({}) }; }
            throw new Error('IDENTITY_ENDPOINT / IDENTITY_HEADER er ikke satt');
        });
        try {
            const res = await flytKaller.kallVarslingFlyt({ mottakere: [{ epost: 'a@b.no' }] });
            sjekk('flyten kalles ikke uten token', sendt, false);
            sjekk('og status er feil', res.status, 'feil');
            sjekk('med årsaken i meldingen', /FLYT_AUTH=entra/.test(res.melding || ''), true);
        } finally {
            if (foer === undefined) delete process.env.VARSLING_FLOW_URL;
            else process.env.VARSLING_FLOW_URL = foer;
        }
    });
}

// ---------- 6. ingen bygger sine egne flyt-headere ----------
{
    const filer = [];
    const gå = (...deler) => {
        const katalog = path.join(rot, ...deler);
        for (const n of fs.readdirSync(katalog, { withFileTypes: true })) {
            if (n.isDirectory()) { gå(...deler, n.name); continue; }
            if (n.name.endsWith('.js')) filer.push([...deler, n.name].join(path.sep));
        }
    };
    gå('api', 'src');

    // `mi-flyt`-prøven er det ene unntaket, og med vilje: den sender et token
    // for en ressurs den får som PARAMETER, nettopp for å kunne måle at feil
    // audience avvises. Den kan derfor ikke bruke den ferdige headeren — da
    // ville den målt seg selv. Erklært her, ikke glemt.
    const PROVEN = path.join('api', 'src', 'functions', 'mi-diagnose.js');

    // HÅNDSKREVNE JSON-HEADERE PÅ ET UTGÅENDE KALL.
    //
    // Første utgave av denne sjekken lette etter `FLOW_URL` i fila først, og
    // var derfor blind for nøyaktig den fila den ble skrevet for:
    // `ekstern-flyt.js` får adressen som ARGUMENT, fra `Flyt_url` på steget,
    // og nevner ingen env-var. Mutasjonen som satte de håndskrevne headerne
    // tilbake der, ga grønt.
    //
    // Derfor er default nå snudd: ENHVER håndskreven `Content-Type:
    // application/json` i api/src er mistenkt, og de som ikke er flyt-kall er
    // ERKLÆRT under, med hvorfor. Et nytt flyt-kall som kopierer formen blir
    // fanget, uansett hvor adressen kommer fra.
    const IKKE_FLYTKALL = {
        [path.join('api', 'src', 'lib', 'graph-opplast.js')]:
            'Microsoft Graph, med eget token fra en app-registrering.',
        [path.join('api', 'src', 'lib', 'fs-client.js')]:
            'Felles Studentsystem over GraphQL, med Basic auth.',
        [path.join('api', 'src', 'functions', 'ai-analyser.js')]:
            'Anthropic API, med egen API-nøkkel.',
        [PROVEN]:
            'mi-flyt-prøven. Sender et token for en ressurs den får som '
            + 'parameter, nettopp for å måle at feil audience avvises — den kan '
            + 'derfor ikke bruke den ferdige headeren uten å måle seg selv.'
    };
    // Tåler at `Content-Type` ikke står først i objektet: `graph-opplast.js`
    // setter `Authorization` foran. En sjekk som bare så på første felt ville
    // vært blind for halvparten av formene — og en erklært fil som ikke lenger
    // treffer, ser ut som en rest.
    const HANDSKREVET = /headers:\s*\{[\s\S]{0,200}?'Content-Type':\s*'application\/json'/;
    const egne = filer.filter(rel => !(rel in IKKE_FLYTKALL))
        .filter(rel => HANDSKREVET.test(utenKommentarer(les(rel))));
    sjekk('ingen håndskrevne flyt-headere', egne.sort(), []);

    // Og erklæringene skal ikke samle støv.
    const doede = Object.keys(IKKE_FLYTKALL)
        .filter(rel => !HANDSKREVET.test(utenKommentarer(les(rel))));
    sjekk('ingen død oppføring blant de erklærte', doede.sort(), []);

    // Hver fil som kaller en flyt bruker den delte funksjonen. Her er
    // `ekstern-flyt.js` med, fordi den importerer fra flyt-kaller.
    const utenDelt = filer.filter(rel => {
        if (rel === PROVEN) return false;
        const kode = utenKommentarer(les(rel));
        if (!/await fetch\(/.test(kode)) return false;
        if (!/_FLOW_URL/.test(kode) && !/require\('\.\/flyt-kaller'\)/.test(kode)) return false;
        return !/flytHeadere\(\)/.test(kode);
    });
    sjekk('hver flyt-kaller bruker flytHeadere()', utenDelt.sort(), []);

    // Unntaket skal ikke bli et gjemmested: bygger prøven ikke lenger sin egen
    // header, er fritaket en rest, og da skal det bort.
    sjekk('unntaket for prøven er fortsatt i bruk',
        /headers: \{ 'Content-Type': 'application\/json', Authorization: `Bearer \$\{token\}` \}/
            .test(utenKommentarer(les(PROVEN))), true);

    // `flytHeadere()` er async nå. Et glemt `await` gir en Promise som
    // `fetch` serialiserer til ingenting — altså et kall uten noen headere
    // i det hele tatt, og 401 uten spor av årsak.
    const glemtAwait = filer.filter(rel =>
        /headers:\s*flytHeadere\(\)/.test(utenKommentarer(les(rel))));
    sjekk('ingen glemt await på flytHeadere()', glemtAwait.sort(), []);

    // Tokenveien finnes ett sted. Prøven og den ekte bruken skal måle det
    // samme — bygger prøven sin egen, kan den bli grønn mens kallene er røde.
    const egenToken = filer
        .filter(rel => rel !== path.join('api', 'src', 'lib', 'plattform-token.js'))
        .filter(rel => /IDENTITY_ENDPOINT/.test(utenKommentarer(les(rel))));
    sjekk('bare plattform-token.js leser identity-endepunktet', egenToken.sort(), []);
}

// ---------- 7. helsesjekken viser modusen ----------
{
    const sys = utenKommentarer(les('api', 'src', 'functions', 'system.js'));
    sjekk('helsesjekken viser modusen fra regelen', /flytAuth: flytAuthModus\(\)/.test(sys), true);
    sjekk('og FLYT_AUTH står i den offentlige lista', /'FLYT_AUTH'/.test(sys), true);
}

}

main().then(() => {
    globalThis.fetch = ekteFetch;
    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
}).catch((e) => { console.log('TESTEN KRASJET:', e.stack); process.exit(1); });
