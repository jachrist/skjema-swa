/**
 * Signert verifikasjons-token som bevis på at (kanal, mottaker) er verifisert
 * via OTP. Ingen storage — HMAC-SHA256 selvvaliderende token.
 *
 * Format: <base64url(payload)>.<base64url(sig)>
 * Payload: { k: kanal, m: mottaker, exp: unix-ms-utløp }
 *
 * Levetid: 30 min (nok tid til å fullføre skjemainnsending etter verifisering).
 * Env: OTP_HMAC_KEY — HMAC-nøkkel (min 32 tegn).
 *
 * Bruk:
 *   const token = utstedToken('sms', '+4741234567');
 *   // ... send til frontend, som sender tilbake ved innsending
 *   const validering = valider(token);   // → { gyldig, kanal, mottaker }
 */
const crypto = require('crypto');

const TTL_MIN = 30;

function nokkel() {
    const k = process.env.OTP_HMAC_KEY;
    if (!k || k.length < 32) {
        throw new Error('OTP_HMAC_KEY mangler eller er for kort (min 32 tegn)');
    }
    return k;
}

function b64url(input) {
    return Buffer.from(input).toString('base64')
        .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(s) {
    const pad = 4 - (s.length % 4 || 4);
    return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad === 4 ? 0 : pad), 'base64');
}

function utstedToken(kanal, mottaker) {
    const payload = {
        k: kanal,
        m: String(mottaker || '').trim().toLowerCase(),
        exp: Date.now() + TTL_MIN * 60 * 1000
    };
    const p = b64url(JSON.stringify(payload));
    const sig = b64url(crypto.createHmac('sha256', nokkel()).update(p).digest());
    return `${p}.${sig}`;
}

/**
 * Valider token. Returnerer { gyldig, kanal?, mottaker?, melding? }.
 */
function valider(token) {
    if (!token || typeof token !== 'string' || token.indexOf('.') < 0) {
        return { gyldig: false, melding: 'Ugyldig token-format' };
    }
    const [p, sig] = token.split('.');
    let forventetSig;
    try {
        forventetSig = b64url(crypto.createHmac('sha256', nokkel()).update(p).digest());
    } catch (e) {
        return { gyldig: false, melding: e.message };
    }
    const a = Buffer.from(sig);
    const b = Buffer.from(forventetSig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return { gyldig: false, melding: 'Feil signatur' };
    }
    let payload;
    try {
        payload = JSON.parse(b64urlDecode(p).toString('utf8'));
    } catch {
        return { gyldig: false, melding: 'Ugyldig payload' };
    }
    if (!payload.exp || payload.exp < Date.now()) {
        return { gyldig: false, melding: 'Token utløpt' };
    }
    return { gyldig: true, kanal: payload.k, mottaker: payload.m, utloper: new Date(payload.exp).toISOString() };
}

module.exports = { utstedToken, valider, TTL_MIN };
