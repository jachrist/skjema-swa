/**
 * HMAC-signert utsending-token. Bindes til (batch, mottaker, skjematype).
 * Ingen prefilled i token — den ligger i Utsendinger-tabellen (kan være stor).
 *
 * Format: <base64url(payload)>.<base64url(sig)>
 * Payload: { bid, m, st, jti, exp }
 *
 * Levetid default: 90 dager (studenter/mottakere skal ha lang tid).
 * Env: OTP_HMAC_KEY — HMAC-nøkkel (gjenbrukes fra OTP for enkelhet).
 */
const crypto = require('crypto');

const DEFAULT_DAGER = 90;

function nokkel() {
    const k = process.env.OTP_HMAC_KEY;
    if (!k || k.length < 32) throw new Error('OTP_HMAC_KEY mangler eller er for kort (min 32 tegn)');
    return k;
}
function b64url(input) {
    return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64urlDecode(s) {
    const pad = 4 - (s.length % 4 || 4);
    return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad === 4 ? 0 : pad), 'base64');
}

function utsted({ batchId, mottaker, skjematypeId, jti, dagerGyldig }) {
    const payload = {
        bid: String(batchId || ''),
        m: String(mottaker || '').trim().toLowerCase(),
        st: String(skjematypeId || ''),
        jti: String(jti || crypto.randomBytes(8).toString('hex')),
        exp: Date.now() + (Number(dagerGyldig) || DEFAULT_DAGER) * 24 * 60 * 60 * 1000
    };
    const p = b64url(JSON.stringify(payload));
    const sig = b64url(crypto.createHmac('sha256', nokkel()).update(p).digest());
    return `${p}.${sig}`;
}

function valider(token) {
    if (!token || typeof token !== 'string' || token.indexOf('.') < 0) {
        return { gyldig: false, melding: 'Ugyldig token-format' };
    }
    const [p, sig] = token.split('.');
    let forventet;
    try { forventet = b64url(crypto.createHmac('sha256', nokkel()).update(p).digest()); }
    catch (e) { return { gyldig: false, melding: e.message }; }
    const a = Buffer.from(sig), b = Buffer.from(forventet);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return { gyldig: false, melding: 'Feil signatur' };
    }
    let payload;
    try { payload = JSON.parse(b64urlDecode(p).toString('utf8')); }
    catch { return { gyldig: false, melding: 'Ugyldig payload' }; }
    if (!payload.exp || payload.exp < Date.now()) return { gyldig: false, melding: 'Token utløpt' };
    return {
        gyldig: true,
        batchId: payload.bid, mottaker: payload.m, skjematypeId: payload.st,
        jti: payload.jti, utloper: new Date(payload.exp).toISOString()
    };
}

module.exports = { utsted, valider, DEFAULT_DAGER };
