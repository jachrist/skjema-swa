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

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
