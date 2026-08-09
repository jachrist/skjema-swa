/**
 * PB-token-lagring (Tilgangskontroll-tabell).
 *
 * Struktur (samme skjema som legacy for framtidig deling):
 *   PartitionKey = upn (lowercase)
 *   RowKey       = guid (crypto.randomUUID)
 *   Egenskaper: SkjematypeId, Tilgangstype ('pb-eier'), IssuedUTC, ExpiresUTC,
 *               Used, SingleUse (false for PB), Side
 *
 * TTL: 365 dager for pb-eier (matcher legacy).
 * Brukes av /api/pb-token (opprett) og /api/power-bi (validering).
 */
const crypto = require('crypto');
const { tabellKlient } = require('./storage');

const TABELL = 'Tilgangskontroll';
const TTL_DAGER_PB = 365;

async function tabell() {
    const t = tabellKlient(TABELL);
    try { await t.createTable(); } catch (_) { /* fins fra før */ }
    return t;
}

/**
 * Opprett et PB-token for gitt upn + skjematype. Returnerer { guid, utloper }.
 */
async function opprettPbToken({ upn, skjematypeId }) {
    if (!upn || !skjematypeId) throw new Error('upn og skjematypeId er påkrevd');
    const t = await tabell();
    const guid = crypto.randomUUID();
    const nu = new Date();
    const utloper = new Date(nu.getTime() + TTL_DAGER_PB * 24 * 60 * 60 * 1000);
    await t.upsertEntity({
        partitionKey: String(upn).toLowerCase(),
        rowKey: guid,
        SkjematypeId: String(skjematypeId),
        Tilgangstype: 'pb-eier',
        IssuedUTC: nu.toISOString(),
        ExpiresUTC: utloper.toISOString(),
        Used: false,
        SingleUse: false,
        Side: 'datauttrekk.html'
    }, 'Replace');
    return { guid, utloper: utloper.toISOString() };
}

/**
 * Valider PB-token — sjekker at raden finnes, ikke er utløpt, og at
 * SkjematypeId matcher forventet verdi.
 * @returns {Promise<{gyldig:boolean, melding?:string, entity?:object}>}
 */
async function validerPbToken({ upn, guid, skjematypeId }) {
    if (!upn || !guid) return { gyldig: false, melding: 'Mangler upn eller guid' };
    const t = await tabell();
    try {
        const e = await t.getEntity(String(upn).toLowerCase(), String(guid));
        if (e.Tilgangstype !== 'pb-eier') return { gyldig: false, melding: 'Feil tilgangstype' };
        if (skjematypeId && String(e.SkjematypeId) !== String(skjematypeId)) {
            return { gyldig: false, melding: 'Skjematype-ID matcher ikke token' };
        }
        const naa = new Date().toISOString();
        if (e.ExpiresUTC && e.ExpiresUTC < naa) return { gyldig: false, melding: 'Token utløpt' };
        return { gyldig: true, entity: e };
    } catch (err) {
        if (err.statusCode === 404) return { gyldig: false, melding: 'Token ikke funnet' };
        throw err;
    }
}

module.exports = {
    opprettPbToken,
    validerPbToken,
    TTL_DAGER_PB
};
