/**
 * Sak-token: lenka en EKSTERN innsender får i e-post om sin egen sak.
 *
 * Meldt 04.11.2026: eksterne fikk lenker i kvitteringen, i beslutnings-
 * varselet og i samtalevarselet som forutsatte innlogging. De har ingen
 * Entra-konto. OTP-tokenet de verifiserte seg med lever i 30 minutter, og
 * utsendingslenka er brukt opp i det svaret sendes inn. Lenka i e-posten
 * førte dermed til en innloggingsside de ikke kommer forbi.
 *
 * Tokenet er bundet til ÉN sak og ÉN adresse:
 *
 *   { typ: 'sak', st, sid, m, exp }
 *
 * Det gir det innsenderen ville hatt innlogget — lese saken, samtalen og
 * PDF-en, og rette den ved ompuss — og ingenting mer: ikke en annen sak, ikke
 * en ny innsending. Hvem som er innsender, sjekkes mot saken hver gang
 * (`autentiserSak` i ekstern-auth.js), ikke bare mot tokenet.
 *
 * Nøkkelen er OTP_HMAC_KEY, som OTP- og utsendingstokenet. Signaturen tas
 * derfor over `sak.<payload>`, ikke over payloaden alene: uten det prefikset
 * ville en signatur laget for én tokentype stemme for en annen, og et
 * utsendingstoken kunne vært lagt fram som sak-token. Prefikset er
 * domeneskillet; `typ` i payloaden er bare for den som leser den.
 *
 * Utstedes på nytt for hver e-post, så levetiden regnes fra siste varsel.
 */
const crypto = require('crypto');

const DEFAULT_DAGER = 180;
const DOMENE = 'sak.';

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
function signer(p) {
    return b64url(crypto.createHmac('sha256', nokkel()).update(DOMENE + p).digest());
}

function utsted({ skjematypeId, skjemaId, mottaker, dagerGyldig }) {
    const payload = {
        typ: 'sak',
        st: String(skjematypeId || ''),
        sid: String(skjemaId || ''),
        m: String(mottaker || '').trim().toLowerCase(),
        exp: Date.now() + (Number(dagerGyldig) || DEFAULT_DAGER) * 24 * 60 * 60 * 1000
    };
    if (!payload.st || !payload.sid || !payload.m) {
        throw new Error('Sak-token krever skjematype, skjema og mottaker');
    }
    const p = b64url(JSON.stringify(payload));
    return `${p}.${signer(p)}`;
}

function valider(token) {
    if (!token || typeof token !== 'string' || token.indexOf('.') < 0) {
        return { gyldig: false, melding: 'Ugyldig lenke' };
    }
    const [p, sig] = token.split('.');
    let forventet;
    try { forventet = signer(p); }
    catch (e) { return { gyldig: false, melding: e.message }; }
    const a = Buffer.from(String(sig || '')), b = Buffer.from(forventet);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return { gyldig: false, melding: 'Ugyldig lenke' };
    }
    let payload;
    try { payload = JSON.parse(b64urlDecode(p).toString('utf8')); }
    catch { return { gyldig: false, melding: 'Ugyldig lenke' }; }
    if (payload.typ !== 'sak' || !payload.st || !payload.sid || !payload.m) {
        return { gyldig: false, melding: 'Ugyldig lenke' };
    }
    if (!payload.exp || payload.exp < Date.now()) {
        return { gyldig: false, melding: 'Lenken er utløpt. Åpne den nyeste e-posten om saken.' };
    }
    return {
        gyldig: true,
        skjematypeId: payload.st, skjemaId: payload.sid, mottaker: payload.m,
        utloper: new Date(payload.exp).toISOString()
    };
}

module.exports = { utsted, valider, DEFAULT_DAGER };
