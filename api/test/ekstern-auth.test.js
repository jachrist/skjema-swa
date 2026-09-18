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
 * Reglene lå i `functions/skjemaer.js` til 18.09.2026, og testen måtte laste
 * hele funksjonsfila for å nå dem. Uten `@azure/functions` hoppet den over seg
 * selv og meldte «0 OK, 0 feil» — altså grønt, uten å ha testet noe. Nå ligger
 * reglene i `lib/ekstern-auth.js` og testes uten pakker.
 *
 * Kjøres med:  node api/test/ekstern-auth.test.js
 */
const modul = require('../src/lib/ekstern-auth');

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

const { harOtpToken, velgAuthvei } = modul;

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
