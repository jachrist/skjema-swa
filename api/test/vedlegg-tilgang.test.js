/**
 * Vedlegg: hvem får lese og skrive — også når de ikke er innlogget.
 *
 * Fram til 04.11.2026 kjente vedleggsendepunktene bare innlogging (pluss
 * utsendingstokenet ved opplasting), frontend sendte ingen token-headere, og
 * nedlastingsruta krevde innlogging i SWA-rutene. En ekstern innsender kunne
 * derfor verken laste opp et vedlegg eller laste ned sitt eget. Og en
 * behandler som ikke var eier, fikk 403 på vedleggslenkene på saken hen
 * behandlet.
 *
 * Regelen bor i `avgjorTilgang` i functions/vedlegg.js. Testen kjører den
 * ekte funksjonen med stubbet lagring, for hver vei og begge handlinger, og
 * sjekker at frontend og SWA-rutene faktisk lar tokenet komme fram.
 *
 * Kjøres med:  node api/test/vedlegg-tilgang.test.js
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

process.env.OTP_HMAC_KEY = 'k'.repeat(40);
process.env.ADMIN_UPNS = 'admin@jccodevel.onmicrosoft.com';

// ---------- stubbet lagring, før vedlegg.js leses ----------
const SAKER = {
    // OTP-innsendt, til behandling
    '45/10': { Skjematype_id: '45', Skjema_id: '10', Skjema_status: 2, Innsender_Epost: 'ola@example.no', EksternInnsender: true,
        Behandling: [{ Steg: 1, Personer: ['beh@jccodevel.onmicrosoft.com'], Roller: [], Team: [], Beslutning: 0 }] },
    // sendt tilbake til samme innsender
    '45/11': { Skjematype_id: '45', Skjema_id: '11', Skjema_status: 3, Innsender_Epost: 'ola@example.no', EksternInnsender: true },
    // en annens sak
    '45/12': { Skjematype_id: '45', Skjema_id: '12', Skjema_status: 2, Innsender_Epost: 'kari@example.no', EksternInnsender: true },
    // svar på en utsending
    '45/13': { Skjematype_id: '45', Skjema_id: '13', Skjema_status: 2, Innsender_Epost: 'per@example.no', Utsending_BatchId: 'b1' }
};
const TYPER = { '45': { JSON: { Skjematype_id: '45', EksternTilgang: true } }, '46': { JSON: { Skjematype_id: '46' } } };

const forekomst = require('../src/lib/skjema-forekomst-storage');
const skjemaStorage = require('../src/lib/skjema-storage');
const tilgang = require('../src/lib/tilgang');
forekomst.hentSkjema = async (id, st) => SAKER[`${st}/${id}`] || null;
skjemaStorage.hentSkjematype = async (id) => TYPER[id] || null;
// Eier = eier@, publikum = alle innloggede. Lest av harTilgangTilSkjema.
tilgang.filtrerTyperPåTilgang = async (typer, upn, felt) =>
    felt === 'Eiere' ? (upn === 'eier@jccodevel.onmicrosoft.com' ? typer : []) : typer;

const ekteLoad = Module._load;
Module._load = function (forespurt, ...rest) {
    if (forespurt === '@azure/functions') return { app: { http() {}, timer() {} } };
    return ekteLoad.call(this, forespurt, ...rest);
};
let avgjorTilgang;
try { ({ _avgjorTilgang: avgjorTilgang } = require('../src/functions/vedlegg')); }
finally { Module._load = ekteLoad; }

const sakToken = require('../src/lib/sak-token');
const otpToken = require('../src/lib/otp-token');
const utsendingToken = require('../src/lib/utsending-token');

const req = (h = {}) => ({ headers: { get: (n) => h[n.toLowerCase()] ?? null } });
const innlogget = (upn) => req({ 'x-ms-client-principal': Buffer.from(JSON.stringify({ userDetails: upn, userRoles: ['authenticated'] })).toString('base64') });
const sak = (st, sid, m) => req({ 'x-sak-token': sakToken.utsted({ skjematypeId: st, skjemaId: sid, mottaker: m }) });
const otp = (m) => req({ 'x-otp-token': otpToken.utstedToken('epost', m) });
const uts = (m, st = '45') => req({ 'x-utsending-token': utsendingToken.utsted({ batchId: 'b1', mottaker: m, skjematypeId: st }) });

/** Utfallet som [ok, status] — status er 200 når det gikk. */
async function utfall(r, sid, handling, st = '45') {
    const svar = await avgjorTilgang(r, st, sid, handling);
    return [svar.ok, svar.ok ? 200 : svar.status];
}

(async () => {
    sjekk('vedlegg.js eksporterer regelen', typeof avgjorTilgang, 'function');

    // ---------- sak-lenke ----------
    sjekk('sak: lese egen sak', await utfall(sak('45', '10', 'ola@example.no'), '10', 'les'), [true, 200]);
    sjekk('sak: skrive mens den behandles avvises', await utfall(sak('45', '10', 'ola@example.no'), '10', 'skriv'), [false, 409]);
    sjekk('sak: skrive når den er sendt tilbake', await utfall(sak('45', '11', 'ola@example.no'), '11', 'skriv'), [true, 200]);
    sjekk('sak: token for annen sak avvises', await utfall(sak('45', '10', 'ola@example.no'), '11', 'les'), [false, 403]);

    // ---------- OTP ----------
    sjekk('OTP: lese egen sak', await utfall(otp('ola@example.no'), '10', 'les'), [true, 200]);
    sjekk('OTP: lese en annens sak avvises', await utfall(otp('ola@example.no'), '12', 'les'), [false, 403]);
    sjekk('OTP: laste opp før saken er lagret', await utfall(otp('ola@example.no'), '99', 'skriv'), [true, 200]);
    sjekk('OTP: lese en sak som ikke finnes avvises', await utfall(otp('ola@example.no'), '99', 'les'), [false, 403]);
    sjekk('OTP: skjematype uten ekstern tilgang avvises', await utfall(otp('ola@example.no'), '99', 'skriv', '46'), [false, 401]);

    // ---------- utsending ----------
    sjekk('utsending: lese eget svar', await utfall(uts('per@example.no'), '13', 'les'), [true, 200]);
    sjekk('utsending: laste opp før saken er lagret', await utfall(uts('per@example.no'), '99', 'skriv'), [true, 200]);
    // Før 04.11.2026 sjekket opplastingen bare skjematypen, ikke saken.
    sjekk('utsending: laste opp på en annens sak avvises', await utfall(uts('per@example.no'), '12', 'skriv'), [false, 403]);
    sjekk('utsending: token for annen skjematype avvises', await utfall(uts('per@example.no', '46'), '13', 'les'), [false, 401]);

    // ---------- innlogget ----------
    sjekk('innsender leser', await utfall(innlogget('kari@example.no'), '12', 'les'), [true, 200]);
    sjekk('eier skriver', await utfall(innlogget('eier@jccodevel.onmicrosoft.com'), '10', 'skriv'), [true, 200]);
    sjekk('admin skriver', await utfall(innlogget('admin@jccodevel.onmicrosoft.com'), '10', 'skriv'), [true, 200]);
    sjekk('behandler leser', await utfall(innlogget('beh@jccodevel.onmicrosoft.com'), '10', 'les'), [true, 200]);
    sjekk('behandler skriver ikke', await utfall(innlogget('beh@jccodevel.onmicrosoft.com'), '10', 'skriv'), [false, 403]);
    sjekk('utenforstående avvises', await utfall(innlogget('noen@jccodevel.onmicrosoft.com'), '10', 'les'), [false, 403]);
    sjekk('ingen innlogging, ingen token', await utfall(req(), '10', 'les'), [false, 401]);

    // ---------- alle fire endepunktene går gjennom regelen ----------
    const rot = path.join(__dirname, '..', '..');
    const les = (...p) => fs.readFileSync(path.join(rot, ...p), 'utf8');
    const kilde = les('api', 'src', 'functions', 'vedlegg.js');
    sjekk('fire endepunkter', (kilde.match(/app\.http\(/g) || []).length, 4);
    sjekk('fire kall til regelen', (kilde.match(/await avgjorTilgang\(request,/g) || []).length, 4);
    sjekk('ingen rute leser innloggingen selv', (kilde.match(/hentInnloggetUpn\(request\)/g) || []).length, 1);

    // ---------- tokenet kommer fram: frontend og SWA-rutene ----------
    const fr = les('frontend', 'js', 'felt-render.js');
    sjekk('opplasting sender API-klientens headere',
        /method: 'POST',\s*headers: api\.headere\(\),\s*body: formData/.test(fr), true);
    sjekk('sletting sender API-klientens headere', /method: 'DELETE',\s*headers: api\.headere\(\)/.test(fr), true);
    sjekk('nedlasting går via token når det finnes', /a\.addEventListener\('click', \(e\) => lastNedMedToken\(/.test(fr), true);
    sjekk('API-klienten gir headerne ut', /headere: \(\) => \(\{ \.\.\.defaultHeaders \}\)/.test(les('frontend', 'js', 'api-client.js')), true);

    for (const fil of ['staticwebapp.config.dev.json', 'staticwebapp.config.pilot.json', 'staticwebapp.config.prod.json']) {
        const ruter = JSON.parse(les(fil)).routes;
        const i = ruter.findIndex(r => r.route === '/api/vedlegg-fil/*');
        sjekk(`${fil}: nedlasting er anonym i gatewayen`, i > -1 && (ruter[i].allowedRoles || []).includes('anonymous'), true);
        sjekk(`${fil}: og står før /api/*`, i > -1 && i < ruter.findIndex(r => r.route === '/api/*'), true);
    }

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
})().catch(e => { console.log('FEIL  testen kastet:', e.message, e.stack); process.exit(1); });
