/**
 * Utsendinger-tabell — track hvem som fikk lenke, om de har svart, og
 * når de eventuelt sist ble purret.
 *
 * PK = BatchId (streng, satt av kaller — f.eks. sender-skjema-id)
 * RK = Mottaker (lowercase upn eller epost)
 * Egenskaper:
 *   SkjematypeId, Jti, Opprettet, KanalHint,
 *   Prefilled (JSON-streng: { "sek-felt": [verdi(er)] }),
 *   SvarSkjemaId (tom hvis ubesvart), SvarTid (ISO),
 *   SistPurret (ISO), SenderSkjemaId, OpprettetAv
 */
const { tabellKlient, sikreTabell } = require('./storage');
const { odata } = require('@azure/data-tables');

const TABELL = 'Utsendinger';

async function tabell() {
    const t = await sikreTabell(TABELL);
    return t;
}

function rk(mottaker) {
    return String(mottaker || '').trim().toLowerCase();
}

async function opprett({ batchId, mottaker, skjematypeId, jti, prefilled, kanalHint, senderSkjemaId, opprettetAv }) {
    const t = await tabell();
    await t.upsertEntity({
        partitionKey: String(batchId),
        rowKey: rk(mottaker),
        SkjematypeId: String(skjematypeId),
        Jti: String(jti),
        Opprettet: new Date().toISOString(),
        KanalHint: String(kanalHint || 'epost'),
        Prefilled: prefilled ? JSON.stringify(prefilled).substring(0, 30000) : '',
        SvarSkjemaId: '',
        SvarTid: '',
        SistPurret: '',
        SenderSkjemaId: String(senderSkjemaId || ''),
        OpprettetAv: String(opprettetAv || '')
    }, 'Replace');
}

async function hent(batchId, mottaker) {
    const t = await tabell();
    try {
        const e = await t.getEntity(String(batchId), rk(mottaker));
        return {
            BatchId: e.partitionKey, Mottaker: e.rowKey,
            SkjematypeId: e.SkjematypeId, Jti: e.Jti, Opprettet: e.Opprettet,
            KanalHint: e.KanalHint,
            Prefilled: e.Prefilled ? tryParseJson(e.Prefilled) : null,
            SvarSkjemaId: e.SvarSkjemaId || '', SvarTid: e.SvarTid || '',
            SistPurret: e.SistPurret || '',
            SenderSkjemaId: e.SenderSkjemaId || '', OpprettetAv: e.OpprettetAv || ''
        };
    } catch (e) {
        if (e.statusCode === 404) return null;
        throw e;
    }
}

async function markerBesvart(batchId, mottaker, svarSkjemaId) {
    const t = await tabell();
    try {
        await t.updateEntity({
            partitionKey: String(batchId),
            rowKey: rk(mottaker),
            SvarSkjemaId: String(svarSkjemaId),
            SvarTid: new Date().toISOString()
        }, 'Merge');
        return true;
    } catch (e) {
        if (e.statusCode === 404) return false;
        throw e;
    }
}

async function markerPurret(batchId, mottaker) {
    const t = await tabell();
    try {
        await t.updateEntity({
            partitionKey: String(batchId),
            rowKey: rk(mottaker),
            SistPurret: new Date().toISOString()
        }, 'Merge');
    } catch (_) { /* stille */ }
}

async function listBatch(batchId) {
    const t = await tabell();
    const ut = [];
    const filter = odata`PartitionKey eq ${String(batchId)}`;
    for await (const e of t.listEntities({ queryOptions: { filter } })) {
        ut.push({
            BatchId: e.partitionKey, Mottaker: e.rowKey,
            SkjematypeId: e.SkjematypeId, Jti: e.Jti, Opprettet: e.Opprettet,
            KanalHint: e.KanalHint,
            SvarSkjemaId: e.SvarSkjemaId || '', SvarTid: e.SvarTid || '',
            SistPurret: e.SistPurret || '',
            SenderSkjemaId: e.SenderSkjemaId || '', OpprettetAv: e.OpprettetAv || ''
        });
    }
    return ut.sort((a, b) => a.Mottaker.localeCompare(b.Mottaker));
}

/**
 * List ubesvarte utsendinger over hele tabellen, opprettet før grenseDato.
 * Brukes av purre-cron. Filtrerer bort de som ble purret nylig (< minDagerMellomPurring).
 */
async function listUbesvarte({ maksDagerSidenOpprettet = 14, minDagerSidenPurring = 3 } = {}) {
    const t = await tabell();
    const nå = Date.now();
    const opprettetGrense = new Date(nå - maksDagerSidenOpprettet * 24 * 3600 * 1000).toISOString();
    const purreGrense = new Date(nå - minDagerSidenPurring * 24 * 3600 * 1000).toISOString();
    const ut = [];
    for await (const e of t.listEntities()) {
        if (e.SvarSkjemaId) continue;
        if (e.Opprettet < opprettetGrense) continue; // for gammelt, gi opp
        if (e.SistPurret && e.SistPurret > purreGrense) continue; // purret nylig
        ut.push({
            BatchId: e.partitionKey, Mottaker: e.rowKey,
            SkjematypeId: e.SkjematypeId, Jti: e.Jti, Opprettet: e.Opprettet,
            KanalHint: e.KanalHint,
            SenderSkjemaId: e.SenderSkjemaId || '', OpprettetAv: e.OpprettetAv || ''
        });
    }
    return ut;
}

function tryParseJson(s) { try { return JSON.parse(s); } catch { return null; } }

module.exports = { opprett, hent, markerBesvart, markerPurret, listBatch, listUbesvarte };
