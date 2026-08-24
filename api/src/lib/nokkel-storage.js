/**
 * Kryptonokler-tabell — én nøkkel per skjematype.
 *   PartitionKey = 'Nokkel'
 *   RowKey       = <skjematypeId>
 *   Nokkel       = base64-encoded 32-byte AES-256-nøkkel
 *
 * Nøkkelen er den ENESTE kopien — det finnes ingen backup-mekanisme.
 * Admin/eier må selv ta en kopi og lagre trygt utenfor systemet hvis
 * nøkkelen skal kunne gjenskapes ved rekryptering.
 */
const { tabellKlient, sikreTabell } = require('./storage');

const TABELL = 'Kryptonokler';
const PK = 'Nokkel';

async function tabell() {
    const t = await sikreTabell(TABELL);
    return t;
}

/**
 * Hent nøkkel for skjematype. Returnerer base64-streng eller null.
 */
async function hentNokkel(skjematypeId) {
    const t = await tabell();
    try {
        const e = await t.getEntity(PK, String(skjematypeId));
        return String(e.Nokkel || '') || null;
    } catch (e) {
        if (e.statusCode === 404) return null;
        throw e;
    }
}

/**
 * Lagre nøkkel for skjematype. Overskriver eksisterende.
 */
async function lagreNokkel(skjematypeId, nokkelBase64) {
    if (!skjematypeId) throw new Error('skjematypeId mangler');
    if (!nokkelBase64) throw new Error('nokkel mangler');
    const t = await tabell();
    await t.upsertEntity({
        partitionKey: PK,
        rowKey: String(skjematypeId),
        Nokkel: String(nokkelBase64),
        SistOppdatert: new Date().toISOString()
    }, 'Replace');
}

/**
 * Slett nøkkel. Bruk med forsiktighet — mister krypterte skjemaer permanent.
 */
async function slettNokkel(skjematypeId) {
    const t = await tabell();
    try {
        await t.deleteEntity(PK, String(skjematypeId));
        return true;
    } catch (e) {
        if (e.statusCode === 404) return false;
        throw e;
    }
}

module.exports = { hentNokkel, lagreNokkel, slettNokkel };
