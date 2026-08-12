/**
 * AES-256-GCM-kryptering av backup-blob med passord fra BACKUP_PASSPHRASE.
 *
 * Container-format (binær):
 *   4 byte:  magic "FSBK"
 *   1 byte:  versjon (1)
 *   16 byte: PBKDF2-salt
 *   12 byte: IV
 *   16 byte: AES-GCM auth-tag
 *   resten:  ciphertext
 *
 * Nøkkel = PBKDF2-HMAC-SHA256(passphrase, salt, 200_000 iter, 32 byte).
 * Iterations valgt slik at brute-force av svake passphrases blir kostbar,
 * mens single-run legitim dekryptering tar < 500 ms.
 */
const crypto = require('crypto');

const MAGIC = Buffer.from('FSBK');
const VERSJON = 1;
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const PBKDF2_ITER = 200_000;

function envPassphrase() {
    const p = String(process.env.BACKUP_PASSPHRASE || '').trim();
    if (!p || p.length < 16) throw new Error('BACKUP_PASSPHRASE mangler eller er kortere enn 16 tegn');
    return p;
}

function utledNokkel(passphrase, salt) {
    return crypto.pbkdf2Sync(passphrase, salt, PBKDF2_ITER, KEY_LEN, 'sha256');
}

function krypterBufferMed(passphrase, klartekst) {
    const salt = crypto.randomBytes(SALT_LEN);
    const iv = crypto.randomBytes(IV_LEN);
    const nokkel = utledNokkel(passphrase, salt);
    const cipher = crypto.createCipheriv('aes-256-gcm', nokkel, iv);
    const ct = Buffer.concat([cipher.update(klartekst), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([MAGIC, Buffer.from([VERSJON]), salt, iv, tag, ct]);
}

function dekrypterBufferMed(passphrase, container) {
    if (!Buffer.isBuffer(container)) container = Buffer.from(container);
    const hodeLen = 4 + 1 + SALT_LEN + IV_LEN + TAG_LEN;
    if (container.length < hodeLen) throw new Error('For kort container');
    if (!container.subarray(0, 4).equals(MAGIC)) throw new Error('Ugyldig magic — ikke en FSBK-backup');
    const versjon = container[4];
    if (versjon !== VERSJON) throw new Error(`Ustøttet versjon: ${versjon}`);
    const salt = container.subarray(5, 5 + SALT_LEN);
    const iv = container.subarray(5 + SALT_LEN, 5 + SALT_LEN + IV_LEN);
    const tag = container.subarray(5 + SALT_LEN + IV_LEN, hodeLen);
    const ct = container.subarray(hodeLen);
    const nokkel = utledNokkel(passphrase, salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', nokkel, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// Convenience-wrappers som bruker env-passphrase
const krypterBuffer = (klartekst) => krypterBufferMed(envPassphrase(), klartekst);
const dekrypterBuffer = (container) => dekrypterBufferMed(envPassphrase(), container);

module.exports = { krypterBuffer, dekrypterBuffer, krypterBufferMed, dekrypterBufferMed, MAGIC };
