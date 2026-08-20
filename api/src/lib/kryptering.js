/**
 * Kryptering (AES-256-GCM) + anonymisering av skjemasvar.
 *
 * Portert fra legacy azure-function-skjema/src/kryptering.js.
 *
 * Ciphertext-format: "<iv-hex>:<tag-hex>:<ciphertext-base64>"
 * Krypteringsomfang på skjematype (Skjematype.Krypteres):
 *   'Nei'   — ingen kryptering
 *   'Svar'  — per-felt-svar krypteres, metadata i klartekst
 *   'Alt'   — hele skjemaet krypteres som én blob
 *
 * Anonymisering: Innsender_Epost erstattes med "anonym-<12-hex>" hvor hex er
 * SHA-256(salt + normalisert epost). Innsender_Navn settes til "Anonymisert".
 */

const crypto = require('crypto');

function krypterStreng(tekst, nokkelBuffer) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', nokkelBuffer, iv);
    const encrypted = Buffer.concat([cipher.update(tekst, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('base64')}`;
}

function dekrypterStreng(kryptertStreng, nokkelBuffer) {
    const [ivHex, tagHex, ciphertextBase64] = kryptertStreng.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const ciphertext = Buffer.from(ciphertextBase64, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', nokkelBuffer, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function krypterKompaktSvar(skjema, nokkelBuffer) {
    const kopi = JSON.parse(JSON.stringify(skjema));
    if (!Array.isArray(kopi.Svar)) return kopi;
    for (const svar of kopi.Svar) {
        if (svar.sva && Array.isArray(svar.sva) && svar.sva.length > 0) {
            svar.sva = krypterStreng(JSON.stringify(svar.sva), nokkelBuffer);
        }
        // Visningsteksten er like sensitiv som verdien — den inneholder navn.
        if (svar.svt && Array.isArray(svar.svt) && svar.svt.length > 0) {
            svar.svt = krypterStreng(JSON.stringify(svar.svt), nokkelBuffer);
        }
    }
    kopi.Kryptert = true;
    return kopi;
}

function krypterFulltSvar(skjema, nokkelBuffer) {
    const kopi = JSON.parse(JSON.stringify(skjema));
    for (const seksjon of (kopi.Seksjoner || [])) {
        for (const felt of (seksjon.Felter || [])) {
            if (felt.Svar && Array.isArray(felt.Svar) && felt.Svar.length > 0) {
                felt.Svar = krypterStreng(JSON.stringify(felt.Svar), nokkelBuffer);
            }
            if (felt.SvarTekst && Array.isArray(felt.SvarTekst) && felt.SvarTekst.length > 0) {
                felt.SvarTekst = krypterStreng(JSON.stringify(felt.SvarTekst), nokkelBuffer);
            }
        }
    }
    kopi.Kryptert = true;
    return kopi;
}

function krypterHeleSkjemaet(skjema, nokkelBuffer) {
    const kryptert = krypterStreng(JSON.stringify(skjema), nokkelBuffer);
    return {
        Skjema_id: skjema.Skjema_id,
        Skjematype_id: skjema.Skjematype_id,
        Kryptert: kryptert
    };
}

function dekrypterFulltSvar(skjema, nokkelBuffer) {
    const kopi = JSON.parse(JSON.stringify(skjema));
    for (const seksjon of (kopi.Seksjoner || [])) {
        for (const felt of (seksjon.Felter || [])) {
            if (typeof felt.Svar === 'string' && felt.Svar.includes(':')) {
                try {
                    felt.Svar = JSON.parse(dekrypterStreng(felt.Svar, nokkelBuffer));
                } catch (_) { /* la stå kryptert hvis dekryptering feiler */ }
            }
            if (typeof felt.SvarTekst === 'string' && felt.SvarTekst.includes(':')) {
                try {
                    felt.SvarTekst = JSON.parse(dekrypterStreng(felt.SvarTekst, nokkelBuffer));
                } catch (_) { /* la stå kryptert */ }
            }
        }
    }
    delete kopi.Kryptert;
    return kopi;
}

function dekrypterKompaktSvar(skjema, nokkelBuffer) {
    const kopi = JSON.parse(JSON.stringify(skjema));
    if (!Array.isArray(kopi.Svar)) return kopi;
    for (const svar of kopi.Svar) {
        if (typeof svar.sva === 'string' && svar.sva.includes(':')) {
            try {
                svar.sva = JSON.parse(dekrypterStreng(svar.sva, nokkelBuffer));
            } catch (_) { /* la stå kryptert */ }
        }
        if (typeof svar.svt === 'string' && svar.svt.includes(':')) {
            try {
                svar.svt = JSON.parse(dekrypterStreng(svar.svt, nokkelBuffer));
            } catch (_) { /* la stå kryptert */ }
        }
    }
    delete kopi.Kryptert;
    return kopi;
}

function dekrypterHeleSkjemaet(skjema, nokkelBuffer) {
    if (!skjema?.Kryptert) return skjema;
    return JSON.parse(dekrypterStreng(skjema.Kryptert, nokkelBuffer));
}

/**
 * Krypter skjema basert på omfang.
 * @param {Object} skjema
 * @param {Buffer|string} nokkel  — Buffer eller base64-streng
 * @param {'Svar'|'Alt'} omfang
 */
function krypterSkjema(skjema, nokkel, omfang) {
    const buf = Buffer.isBuffer(nokkel) ? nokkel : Buffer.from(String(nokkel), 'base64');
    if (omfang === 'Alt') return krypterHeleSkjemaet(skjema, buf);
    if (Array.isArray(skjema.Svar)) return krypterKompaktSvar(skjema, buf);
    return krypterFulltSvar(skjema, buf);
}

/**
 * Dekrypter skjema — detekterer format automatisk (Alt-blob vs per-felt-Svar).
 */
function dekrypterSkjema(skjema, nokkel) {
    const buf = Buffer.isBuffer(nokkel) ? nokkel : Buffer.from(String(nokkel), 'base64');
    if (skjema?.Kryptert && typeof skjema.Kryptert === 'string') {
        return dekrypterHeleSkjemaet(skjema, buf);
    }
    if (Array.isArray(skjema?.Svar)) return dekrypterKompaktSvar(skjema, buf);
    return dekrypterFulltSvar(skjema, buf);
}

/**
 * Anonymiser innsender-info. Salt gis via env HASH_SALT.
 * SHA-256(salt+normalisert epost), første 12 hex-tegn brukes som suffix.
 * Deterministisk pr salt — samme innsender → samme pseudonym på tvers av skjemaer.
 */
function anonymiserInnsender(skjema, salt) {
    const kopi = JSON.parse(JSON.stringify(skjema));
    const epost = kopi.Innsender_Epost || kopi.Innsender_epost || '';
    if (!epost) return kopi;
    const normalisert = String(epost).trim().toLowerCase();
    const data = salt ? String(salt) + normalisert : normalisert;
    const hash = crypto.createHash('sha256').update(data, 'utf8').digest('hex').substring(0, 12);
    kopi.Innsender_Epost = `anonym-${hash}`;
    kopi.Innsender_epost = `anonym-${hash}`;
    if (kopi.Innsender_Navn) kopi.Innsender_Navn = 'Anonymisert';
    if (kopi.Innsender) kopi.Innsender = 'Anonymisert';
    kopi.Anonymisert = true;
    return kopi;
}

/**
 * Generer en 256-bit nøkkel som base64-streng.
 */
function genererNokkel() {
    return crypto.randomBytes(32).toString('base64');
}

module.exports = {
    krypterStreng,
    dekrypterStreng,
    krypterSkjema,
    dekrypterSkjema,
    anonymiserInnsender,
    genererNokkel
};
