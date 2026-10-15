/**
 * MI-token-diagnosen skal aldri gi fra seg tokenet.
 *
 * Endepunktet finnes for å svare på om koden får et managed identity-token,
 * og for hvilken ressurs. Et token er legitimasjon: lekker det ut av et
 * diagnoseendepunkt, har diagnosen gjort skade i stedet for nytte.
 *
 * Tre ting holdes fast:
 *
 *   **Tokenet returneres ikke.** Hverken helt eller i biter. Lengden er med,
 *   fordi den skiller «fikk noe» fra «fikk ingenting», og et tall kan ikke
 *   brukes til å kalle noe.
 *
 *   **Bare claims som identifiserer avsenderen vises.** aud, iss, appid,
 *   tid, oid, exp. Ikke hele nyttelasten — et token kan bære mer enn vi vet.
 *
 *   **Årsaken er alltid med når noe feiler.** «Det gikk galt» uten mer er
 *   umulig å skille fra «koden er ikke deployet», og det er nettopp det
 *   dette endepunktet skal avgjøre.
 *
 * Kjøres med:  node api/test/mi-diagnose.test.js
 */
const fs = require('fs');
const path = require('path');
const { hentEksport, utenKommentarer } = require('../../scripts/test-kilde.js');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const fil = path.join(__dirname, '..', 'src', 'functions', 'mi-diagnose.js');
const rå = fs.readFileSync(fil, 'utf8');
const kode = utenKommentarer(rå);
// claimsFra leser CLAIMS_VI_VISER, som er en konstant på modulnivå.
// hentEksport henter funksjoner, ikke konstanter, så den må med separat —
// ellers kaster funksjonen og testen måler feilhåndteringen i stedet for
// det den skal måle.
const KONST = rå.match(/const CLAIMS_VI_VISER = \[[^\]]*\];/)[0];
const claimsFra = new Function(`${KONST}\n${
    rå.slice(rå.indexOf('function claimsFra('),
             rå.indexOf('\n}', rå.indexOf('function claimsFra(')) + 2)
}\nreturn claimsFra;`)();

// Et JWT med både det vi vil vise og noe vi ikke vil vise.
const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const NYTTELAST = {
    aud: 'https://service.flow.microsoft.com/',
    iss: 'https://sts.windows.net/abc/',
    appid: '11111111-2222-3333-4444-555555555555',
    tid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    oid: '99999999-8888-7777-6666-555555555555',
    exp: 1792000000,
    // Dette skal IKKE med:
    idp: 'https://sts.windows.net/hemmelig/',
    xms_mirid: '/subscriptions/abc/resourceGroups/rg/providers/Microsoft.Web/sites/testfapp',
    uti: 'en-unik-token-id'
};
const TOKEN = `${b64({ alg: 'RS256' })}.${b64(NYTTELAST)}.signaturdelen-her`;

// ---------- bare de claimene vi har bestemt ----------
{
    const c = claimsFra(TOKEN);
    sjekk('viser aud', c.aud, NYTTELAST.aud);
    sjekk('viser appid', c.appid, NYTTELAST.appid);
    sjekk('viser oid', c.oid, NYTTELAST.oid);
    sjekk('viser ikke idp', 'idp' in c, false);
    sjekk('viser ikke xms_mirid', 'xms_mirid' in c, false);
    sjekk('viser ikke uti', 'uti' in c, false);
    // Hele settet, så en ny claim ikke kan snike seg inn uten at noen ser det.
    sjekk('nøyaktig dette settet', Object.keys(c).sort(),
        ['appid', 'aud', 'exp', 'iss', 'oid', 'tid']);
}

// ---------- signaturen skal aldri være med ----------
{
    const c = claimsFra(TOKEN);
    const tekst = JSON.stringify(c);
    sjekk('ingen signaturdel', tekst.includes('signaturdelen-her'), false);
    sjekk('ingen hel token-streng', tekst.includes(TOKEN), false);
}

// ---------- tåler søppel ----------
{
    for (const [navn, verdi] of Object.entries({
        'tom streng': '', 'null': null, 'ikke jwt': 'bare-en-streng',
        'bare to deler': 'aaa.bbb', 'ugyldig base64 i midten': 'aaa.%%%.ccc'
    })) {
        const c = claimsFra(verdi);
        sjekk(`${navn}: svarer med et objekt`, typeof c === 'object' && c !== null, true);
        if (!['bare to deler'].includes(navn)) {
            sjekk(`${navn}: sier hva som er galt`, typeof c.feil === 'string' && c.feil.length > 5, true);
        }
    }
}

// ---------- handleren: tokenet settes aldri i svaret ----------
//
// Leses som tekst, fordi handleren krever @azure/functions for å kjøre.
// Sjekken er grov, og det er med vilje: den skal fange at NOEN skriver
// tokenet inn i svaret, uansett hvordan de gjør det.
{
    sjekk('setter lengden, ikke tokenet', /svar\.tegnITokenet\s*=\s*t\.token\.length/.test(kode), true);
    // Tokenet skal ikke havne RÅTT i svaret. To former er lovlige:
    // `t.token.length` (et tall) og `claimsFra(t.token)` (et utvalg claims,
    // som denne testen allerede holder fast). Alt annet er en lekkasje.
    const LOVLIG = [/^t\.token\.length$/, /^claimsFra\(t\.token\)$/];
    const lekkasjer = [...kode.matchAll(/svar\.\w+\s*=\s*([^;]*\bt\.token\b[^;]*);/g)]
        .map(m => m[1].trim())
        .filter(h => !LOVLIG.some(re => re.test(h)));
    sjekk('ingen rå tilordning av t.token til svaret', lekkasjer, []);
    sjekk('ingen logging av tokenet', /context\.log[^\n]*t\.token/.test(kode), false);
}

// ---------- admin, og årsaken alltid med ----------
{
    sjekk('krever admin', /if \(!erAdmin\(upn\)\)/.test(kode), true);
    sjekk('403 uten admin', /status: 403/.test(kode), true);
    // Feilgrenen må sette en årsak. Uten den er svaret ubrukelig.
    sjekk('feilgrenen setter årsak', /svar\.feil = e\?\.message/.test(kode), true);
    sjekk('og ok=false', /svar\.ok = false/.test(kode), true);
}

// ---------- Power Automate er med i lista ----------
//
// Det er den ene ressursen forsøket handler om. Faller den ut, tester
// endepunktet noe annet enn det ble laget for.
{
    sjekk('Power Automate står i KJENTE',
        /https:\/\/service\.flow\.microsoft\.com\//.test(kode), true);
    sjekk('storage står der også',
        /https:\/\/storage\.azure\.com\//.test(kode), true);
}

// ---------- beskrivUrl: flyt-URL-en skal aldri ut ----------
//
// Trigger-URL-en til en Power Automate-flyt bærer signaturen i
// query-strengen. Ekkoes den fra et diagnoseendepunkt, har diagnosen gitt
// bort nøkkelen den skulle hjelpe oss å bli kvitt.
{
    const beskrivUrl = hentEksport(rå, 'beskrivUrl');
    const MED_SIG = 'https://prod-12.westeurope.logic.azure.com/workflows/abc/triggers/manual/paths/invoke'
        + '?api-version=2016-06-01&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=HEMMELIG-SIGNATUR-HER';

    const u = beskrivUrl(MED_SIG);
    sjekk('vertsnavn med', u.vertsnavn, 'prod-12.westeurope.logic.azure.com');
    sjekk('sti med', u.sti, '/workflows/abc/triggers/manual/paths/invoke');
    sjekk('ser signaturen', u.harSignatur, true);
    sjekk('teller parametere', u.antallParametere, 4);

    const tekst = JSON.stringify(u);
    sjekk('signaturverdien er ikke med', tekst.includes('HEMMELIG-SIGNATUR-HER'), false);
    sjekk('hele URL-en er ikke med', tekst.includes(MED_SIG), false);
    sjekk('ingen query-streng i det hele tatt', tekst.includes('api-version'), false);

    // Uten sig — det er nettopp denne forskjellen forsøket skal vise.
    const uten = beskrivUrl('https://prod-12.westeurope.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?api-version=2016-06-01');
    sjekk('uten signatur', uten.harSignatur, false);

    for (const søppel of ['', 'ikke en url', 'file:///etc/passwd/..']) {
        const r = beskrivUrl(søppel);
        sjekk(`${JSON.stringify(søppel)}: svarer med noe`, typeof r === 'object' && r !== null, true);
    }
    sjekk('ugyldig URL sier fra', typeof beskrivUrl('tull').feil === 'string', true);
}

// ---------- FLYTVAR: ingen vei til andre miljøvariabler ----------
//
// Uten dette mønsteret er flyt-prøven en vei til å lese hvilken som helst
// app setting. `?envVar=STORAGE_CONNECTION_STRING` ville vært det første
// noen prøvde.
{
    const m = rå.match(/const FLYTVAR = (\/.+\/);/);
    sjekk('FLYTVAR finnes', !!m, true);
    const FLYTVAR = new RegExp(m[1].slice(1, -1));

    for (const navn of ['PROVE_FLOW_URL', 'VARSLING_FLOW_URL', 'TEAM_SOK_EKSTERNT_FLOW_URL']) {
        sjekk(`slipper gjennom ${navn}`, FLYTVAR.test(navn), true);
    }
    // Alt det som IKKE skal kunne leses.
    for (const navn of ['STORAGE_CONNECTION_STRING', 'HASH_SALT', 'OTP_HMAC_KEY',
        'BACKUP_PASSPHRASE', 'FLOW_CALLBACK_KEY', 'ADMIN_UPNS', 'GRAPH_CLIENT_SECRET',
        'ANTHROPIC_API_KEY', 'PATH', 'flow_url', 'X_FLOW_URL_EKSTRA']) {
        sjekk(`stopper ${navn}`, FLYTVAR.test(navn), false);
    }
}

// ---------- tabellprøven ----------
{
    // Hver app.http-registrering i fila skal ha sin egen admin-vakt. «Minst
    // tre» sa ja uten å måle noe idet den fjerde kom til.
    sjekk('hver registrering har en admin-vakt',
        (kode.match(/if \(!erAdmin\(upn\)\)/g) || []).length,
        (kode.match(/app\.http\(/g) || []).length);
    // Skriving er opt-in. En diagnose som skriver i en ekte tabell uten at
    // noen ba om det, er ikke en diagnose.
    sjekk('skriving er opt-in', /const skriv = request\.query\.get\('skriv'\) === 'ja'/.test(kode), true);
    sjekk('leser uten skriving', /if \(!skriv\)/.test(kode), true);
    // Prøveraden må ryddes, og en mislykket rydding må SIES.
    sjekk('sletter prøveraden', /deleteEntity\('mi-prove'/.test(kode), true);
    sjekk('sier fra hvis ryddingen feiler', /ble IKKE slettet og må fjernes manuelt/.test(kode), true);
    // Innholdet i tabellen er persondata. Bare antallet skal ut.
    sjekk('rapporterer antall, ikke rader', /antallLest: funnet\.length/.test(kode), true);
    sjekk('ingen rader i svaret', /svar\.lese = \{ ok: true, antallLest/.test(kode), true);
}

// ---------- flytprøven ----------
{
    sjekk('URL-en hentes fra app settings, ikke fra kallet',
        /const url = process\.env\[navn\]/.test(kode), true);
    sjekk('navnet må matche FLYTVAR', /if \(!FLYTVAR\.test\(navn\)\)/.test(kode), true);
    // URL-en skal beskrives, aldri settes inn rå.
    sjekk('URL-en beskrives', /url: beskrivUrl\(url\)/.test(kode), true);
    // URL-en skal aldri stå rått i svaret — hverken som verdi i objektet
    // eller tilordnet etterpå.
    sjekk('ingen rå url som objektverdi', /(^|[^$])[:,{]\s*url\s*[,}]/.test(kode), false);
    sjekk('ingen rå url tilordnet svaret', /svar\.\w+\s*=\s*url\s*;/.test(kode), false);
    // Tokenet går i Authorization-headeren, aldri i svaret.
    sjekk('token i headeren', /Authorization: `Bearer \$\{token\}`/.test(kode), true);
    // Samme for tokenet. Legitimt er `{ ok, claims: claimsFra(token) }` og
    // bruken i Authorization-headeren — alt annet er en lekkasje.
    sjekk('ingen rått token som objektverdi', /(^|[^$])[:,{]\s*token\s*[,}]/.test(kode), false);
    sjekk('ingen rått token tilordnet svaret', /svar\.\w+\s*=\s*token\s*;/.test(kode), false);
    // Svaret fra flyten avkortes — den kan returnere hva som helst.
    sjekk('svaret avkortes', /svarUtdrag: String\(tekst\)\.slice\(0, 300\)/.test(kode), true);
}

// ---------- tokenkilde: skråstreken som avgjorde steg 7 ----------
//
// Power Automate sammenligner `aud` bokstavelig, og Microsofts egen
// dokumentasjon sier det rett ut: «Audience values must be an exact match,
// including trailing slashes.» SDK-en klipper skråstreken av underveis.
// Derfor finnes `tokenkilde=plattform`, og derfor måles det her.
{
    const tidspunkt = hentEksport(rå, 'tidspunkt');
    sjekk('tidspunkt: epoch-sekunder', tidspunkt(1700000000),
        new Date(1700000000 * 1000).toISOString());
    // Feltet skal ALLTID settes. JSON.stringify dropper undefined, og da er
    // «gikk galt» ikke til å skille fra «ikke deployet».
    sjekk('tidspunkt: tomt gir en verdi', tidspunkt(''), '(ikke oppgitt)');
    sjekk('tidspunkt: uleselig sier hva som kom',
        /^ukjent format: /.test(tidspunkt('hva som helst')), true);

    sjekk('to tokenkilder', /const TOKENKILDER = \['sdk', 'plattform'\];/.test(kode), true);
    sjekk('sdk er standard i begge prøvene',
        (kode.match(/request\.query\.get\('tokenkilde'\) \|\| 'sdk'/g) || []).length, 2);
    sjekk('ukjent tokenkilde avvises i begge',
        (kode.match(/if \(!TOKENKILDER\.includes\(kilde\)\)/g) || []).length, 2);

    // Hele poenget med den nye veien: ressursen går ORDRETT videre.
    sjekk('resource sendes ordrett',
        /u\.searchParams\.set\('resource', ressurs\)/.test(kode), true);
    sjekk('ingen normalisering av ressursen underveis',
        /ressurs\.replace\(/.test(kode), false);

    // IDENTITY_HEADER er legitimasjon på linje med tokenet.
    sjekk('nøkkelen går bare i headeren',
        /headers: \{ 'X-IDENTITY-HEADER': nokkel \}/.test(kode), true);
    // Den ene lovlige bruken er headeren over. Klippes den bort, skal det
    // ikke finnes noe annet sted nøkkelen settes inn i et objekt.
    const utenHeader = kode.replace(/headers: \{ 'X-IDENTITY-HEADER': nokkel \}/g, '');
    sjekk('nøkkelen havner ikke i svaret', /(^|[^$])[:,{]\s*nokkel\s*[,}]/.test(utenHeader), false);
    sjekk('nøkkelen tilordnes ikke svaret', /svar\.\w+\s*=\s*nokkel\s*;/.test(kode), false);
    sjekk('nøkkelen havner ikke i en feilmelding', /\$\{nokkel\}/.test(kode), false);
    sjekk('variablene er erklært ett sted',
        /const SATT_AV_PLATTFORMEN = \['IDENTITY_ENDPOINT', 'IDENTITY_HEADER'\];/.test(kode), true);
    sjekk('feilmeldingen bygges fra erklæringen, ikke skrevet av på nytt',
        /SATT_AV_PLATTFORMEN\.join\(/.test(kode), true);
}

// ---------- blobprøven ----------
//
// Den er ikke tabellprøven om igjen for en annen tjeneste. backup.js
// signerer en SAS med kontonøkkelen, og en managed identity har ingen
// nøkkel å signere med — delegeringen og SAS-kallet er derfor egne
// målinger, og de kan feile mens lesing og skriving er grønne.
{
    sjekk('fire prøver i fila', (kode.match(/app\.http\(/g) || []).length, 4);

    // Blobnavn ekkoes ikke: vedlegg er navngitt av innsendere, og et filnavn
    // kan være en personopplysning i seg selv.
    sjekk('leser antall, ikke navn',
        /for await \(const _ of containerKlient\.listBlobsFlat\(\)\)/.test(kode), true);
    sjekk('rapporterer antall blober', /svar\.lese = \{ ok: true, antallLest: antall \}/.test(kode), true);

    // Delegeringsnøkkelens `value` ER signeringshemmeligheten. Den som har
    // den kan lage gyldig SAS for alt identiteten rekker, til den utløper.
    sjekk('nøkkelen vises bare som lengde',
        /tegnINokkelen: String\(n\.value \|\| ''\)\.length/.test(kode), true);
    sjekk('ingen value som objektverdi', /(^|[^$])[:,{]\s*value\s*[,}]/.test(kode), false);
    // Og ingen nøkkel som HETER value. Den formen har ':' etter navnet, ikke
    // ',' eller '}', så sjekken over ser den ikke. `n.value` har punktum
    // foran, og er den lovlige bruken.
    sjekk('ingen value-felt i svaret', /(^|[^.\w])value\s*:/m.test(kode), false);
    sjekk('bare utvalgte felt fra nøkkelen',
        /for \(const felt of DELEGERING_VI_VISER\)/.test(kode), true);
    const felt = /const DELEGERING_VI_VISER = \[([\s\S]*?)\];/.exec(kode)[1];
    sjekk('value står ikke i det vi viser', /'value'/.test(felt), false);

    // SAS-en er legitimasjon: den som har lenken, har tilgangen.
    sjekk('ingen sas som objektverdi', /(^|[^$])[:,{]\s*sas\s*[,}]/.test(kode), false);
    sjekk('ingen sas tilordnet svaret', /svar\.\w+\s*=\s*sas\s*;/.test(kode), false);
    sjekk('sas brukes bare i kallet',
        /fetch\(`\$\{vert\}\/\$\{container\}\/\$\{encodeURIComponent\(blobNavn\)\}\?\$\{sas\}`\)/.test(kode), true);

    // Delegeringen kommer fra en ANNEN rolle enn lesingen, så den skal
    // prøves uansett hvordan lesingen gikk.
    sjekk('delegeringen prøves uansett lesing', /if \(svar\.lese\.ok\)/.test(kode), false);
    sjekk('sier hvilken rolle som mangler', /Storage Blob Delegator/.test(kode), true);

    // SAS-kallet skal bevise at innholdet kom tilbake, ikke bare at noe gjorde det.
    sjekk('sammenligner innholdet', /fikkRiktigInnhold: tekst === innhold/.test(kode), true);

    // Skriving er opt-in i begge prøvene, og prøvefilen ryddes.
    sjekk('skriving er opt-in begge steder',
        (kode.match(/request\.query\.get\('skriv'\) === 'ja'/g) || []).length, 2);
    sjekk('sletter prøveblobben', /await blobKlient\.delete\(\)/.test(kode), true);
    sjekk('begge prøvene sier fra hvis ryddingen feiler',
        (kode.match(/ble IKKE slettet og må fjernes manuelt/g) || []).length, 2);
}

// ---------- hentToken kjørt for ekte, med stubbede kilder ----------
//
// Den ekte funksjonen, ikke en kopi av regelen: det var nettopp en
// gjenoppfunnet returform som lot flere feil overleve her tidligere.
(async () => {
    const start = rå.indexOf('async function hentToken(');
    const kildeHentToken = rå.slice(start, rå.indexOf('\n}', start) + 2);
    const lag = (legitimasjon, tokenFraPlattformen) => new Function(
        'legitimasjon', 'tokenFraPlattformen', `${kildeHentToken}\nreturn hentToken;`
    )(legitimasjon, tokenFraPlattformen);

    // Hvilken vei som ble brukt REGISTRERES, den kastes ikke. En stub som
    // kaster gjør testen rød ved å krasje, og en krasj sier ikke hva som er
    // galt — den ser lik ut uansett hvilken regel som brøt.
    let plattformBrukt = false, sdkBrukt = false;
    const viaSdk = lag(
        () => { sdkBrukt = true; return { getToken: async () => ({ token: 'a.b.c', expiresOnTimestamp: 1700000000000 }) }; },
        async (r) => { plattformBrukt = true; return { token: 'x.y.z', utloper: '(ikke oppgitt)', scope: null, ressursSomBleSpurtOm: r }; }
    );
    const sdk = await viaSdk('https://service.flow.microsoft.com/', 'sdk');
    sjekk('sdk: scope er ressurs + .default', sdk.scope,
        'https://service.flow.microsoft.com/.default');
    // DETTE er avvisningen Power Automate ga: skråstreken er borte.
    sjekk('sdk: skråstreken forsvinner fra ressursen', sdk.ressursSomBleSpurtOm,
        'https://service.flow.microsoft.com');

    sjekk('sdk: plattformveien ble ikke brukt', plattformBrukt, false);

    let bedtOm = null;
    plattformBrukt = false; sdkBrukt = false;
    const viaPlattform = lag(
        () => { sdkBrukt = true; return { getToken: async () => ({ token: 'feil.vei.her', expiresOnTimestamp: 0 }) }; },
        async (r) => { plattformBrukt = true; bedtOm = r; return { token: 'x.y.z', utloper: '(ikke oppgitt)', scope: null, ressursSomBleSpurtOm: r }; }
    );
    const plattform = await viaPlattform('https://service.flow.microsoft.com/', 'plattform');
    sjekk('plattform: plattformveien ble faktisk brukt', plattformBrukt, true);
    sjekk('plattform: sdk-veien ble ikke brukt', sdkBrukt, false);
    sjekk('plattform: ressursen går ordrett videre', bedtOm,
        'https://service.flow.microsoft.com/');
    sjekk('plattform: skråstreken overlever', plattform.ressursSomBleSpurtOm,
        'https://service.flow.microsoft.com/');
    sjekk('plattform: ingen scope å snakke om', plattform.scope, null);

    // Den ekte tokenFraPlattformen, kjørt uten identiteten. Meldingen må
    // navngi BEGGE variablene — «det gikk galt» er ikke til å skille fra
    // «koden er ikke deployet», og det er nettopp det som skal avgjøres.
    const konst = rå.match(/const SATT_AV_PLATTFORMEN = \[[^\]]*\];/)[0];
    const fra = rå.indexOf('async function tokenFraPlattformen(');
    const tokenFraPlattformen = new Function(
        `${konst}\n${rå.slice(fra, rå.indexOf('\n}', fra) + 2)}\nreturn tokenFraPlattformen;`
    )();

    const før = { e: process.env.IDENTITY_ENDPOINT, h: process.env.IDENTITY_HEADER };
    delete process.env.IDENTITY_ENDPOINT;
    delete process.env.IDENTITY_HEADER;
    let melding = '(kastet ikke)';
    try { await tokenFraPlattformen('https://service.flow.microsoft.com/'); }
    catch (e) { melding = e.message; }
    if (før.e !== undefined) process.env.IDENTITY_ENDPOINT = før.e;
    if (før.h !== undefined) process.env.IDENTITY_HEADER = før.h;

    sjekk('uten identitet: meldingen navngir begge variablene',
        melding.includes('IDENTITY_ENDPOINT') && melding.includes('IDENTITY_HEADER'), true);
    sjekk('uten identitet: meldingen sier hva som er galt',
        /er ikke satt/.test(melding), true);

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
})();
