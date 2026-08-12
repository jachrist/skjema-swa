/**
 * SystemInnstillinger — enkelt key/value-storage for admin-konfig som ikke
 * hører hjemme i env-vars (typisk fordi de skal kunne endres i UI uten
 * Azure Portal-tilgang).
 *
 * PK = 'Innstillinger', RK = kort nøkkel (f.eks. 'BackupOneDriveSti')
 * Egenskaper: Verdi (string), SistEndret, EndretAv
 */
const { tabellKlient } = require('./storage');

const TABELL = 'SystemInnstillinger';
const PK = 'Innstillinger';

async function tabell() {
    const t = tabellKlient(TABELL);
    try { await t.createTable(); } catch (_) { /* fins */ }
    return t;
}

async function hent(nokkel) {
    const t = await tabell();
    try {
        const e = await t.getEntity(PK, String(nokkel));
        return { Nokkel: e.rowKey, Verdi: e.Verdi || '', SistEndret: e.SistEndret || null, EndretAv: e.EndretAv || null };
    } catch (e) {
        if (e.statusCode === 404) return null;
        throw e;
    }
}

async function sett(nokkel, verdi, endretAv) {
    const t = await tabell();
    await t.upsertEntity({
        partitionKey: PK,
        rowKey: String(nokkel),
        Verdi: String(verdi ?? ''),
        SistEndret: new Date().toISOString(),
        EndretAv: String(endretAv || '')
    }, 'Replace');
}

async function listAlle() {
    const t = await tabell();
    const ut = [];
    for await (const e of t.listEntities()) {
        ut.push({ Nokkel: e.rowKey, Verdi: e.Verdi || '', SistEndret: e.SistEndret || null, EndretAv: e.EndretAv || null });
    }
    return ut.sort((a, b) => a.Nokkel.localeCompare(b.Nokkel));
}

async function slett(nokkel) {
    const t = await tabell();
    try { await t.deleteEntity(PK, String(nokkel)); return true; }
    catch (e) { if (e.statusCode === 404) return false; throw e; }
}

module.exports = { hent, sett, listAlle, slett };
