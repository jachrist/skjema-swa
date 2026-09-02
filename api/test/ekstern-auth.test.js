/**
 * Tester for rekkefølgen mellom OTP-token og SWA-cookie.
 *
 * Bakgrunn: ekstern-flyten sjekket OTP-tokenet bare når brukeren IKKE var
 * innlogget (`else if (!upn)`). Testet man flyten fra egen maskin — der man
 * som regel er innlogget i SWA-en — ble tokenet ignorert, og innsendingen
 * avvist med «Ingen tilgang til denne skjematypen».
 *
 * Feilen var usynlig for den den gjaldt: en ekte ekstern bruker har ingen
 * SWA-cookie og traff aldri problemet. Bare vi som testet gjorde det.
 *
 * Et OTP-token er et eksplisitt valg og skal derfor gå foran en cookie som
 * tilfeldigvis ligger i samme nettleser. Tokenet gir mindre tilgang enn en
 * innlogget sesjon, så prioriteringen utvider ingen rettigheter.
 *
 * Kjøres med:  node api/test/ekstern-auth.test.js
 */
let modul = null;
try { modul = require('../src/functions/skjemaer'); } catch (_) { /* hoppes over uten @azure/functions */ }

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

/** Minimal request-stubb — bare headers, som er alt reglene ser på. */
function req(headers = {}) {
    const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    return { headers: { get: (n) => h.get(String(n).toLowerCase()) ?? null } };
}

if (!modul?._harOtpToken) {
    console.log('(hopper over — @azure/functions ikke installert)');
    console.log('\n0 OK, 0 feil, 1 hoppet over');
    process.exit(0);
}
const { _harOtpToken: harOtpToken, _velgAuthvei: velgAuthvei } = modul;

// ---------- selve deteksjonen ----------
{
    sjekk('token til stede', harOtpToken(req({ 'x-otp-token': 'abc' })), true);
    sjekk('ingen headere', harOtpToken(req()), false);
    sjekk('tom verdi teller ikke', harOtpToken(req({ 'x-otp-token': '' })), false);
    // Headernavn er case-insensitive i HTTP.
    sjekk('store bokstaver', harOtpToken(req({ 'X-OTP-Token': 'abc' })), true);
}

// ---------- veivalget ----------
{
    const utsending = { 'x-utsending-token': 't' };
    const otp = { 'x-otp-token': 'o' };

    sjekk('utsending vinner over alt', velgAuthvei(req({ ...utsending, ...otp }), 'noen@fhs.no'), 'utsending');
    sjekk('utsending alene', velgAuthvei(req(utsending), null), 'utsending');

    // Kjernen: OTP går foran cookie.
    sjekk('OTP foran innlogget', velgAuthvei(req(otp), 'noen@fhs.no'), 'ekstern');
    sjekk('OTP uten innlogging', velgAuthvei(req(otp), null), 'ekstern');

    sjekk('innlogget uten token', velgAuthvei(req(), 'noen@fhs.no'), 'innlogget');
    sjekk('verken eller', velgAuthvei(req(), null), 'ekstern');
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
