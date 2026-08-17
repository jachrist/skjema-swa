/**
 * Storage-modul for Rapporttyper-tabellen.
 *
 * Egen tabell for å ikke røre Skjemadefinisjoner. Samme mønster som
 * skjema-storage: Fase='Produksjon' som default, JSON-splitting hvis
 * definisjonen skulle bli stor (usannsynlig for tabell-rapporter, men
 * mønsteret følger skjema).
 *
 * Tabellstruktur:
 *   Rapporttyper
 *     PartitionKey = "Def"
 *     RowKey       = <Rapporttype_id>
 *     Egenskaper: Tittel, Oppdatert, JSON, JSON2..JSON4
 */
const { tabellKlient } = require('./storage');

const TABELL = 'Rapporttyper';
const PK = 'Def';

const CHUNK_STR = 30000;
const MAKS_CHUNKS = 4;

function splittJson(streng) {
    const chunks = [];
    for (let i = 0; i < streng.length; i += CHUNK_STR) {
        chunks.push(streng.slice(i, i + CHUNK_STR));
    }
    return chunks;
}

function samleJson(entity) {
    if (!entity) return '';
    let s = String(entity.JSON || '');
    for (let i = 2; i <= MAKS_CHUNKS; i++) {
        const c = entity[`JSON${i}`];
        if (c === undefined || c === null || c === '') break;
        s += String(c);
    }
    return s;
}

function entityTilRapport(entity) {
    if (!entity) return null;
    let data = null;
    const streng = samleJson(entity);
    if (streng) {
        try { data = JSON.parse(streng); }
        catch (_) { data = null; }
    }
    if (data && !data.Fase) data.Fase = 'Produksjon';
    return data;
}

async function hentAlleRapporttyper() {
    const tabell = tabellKlient(TABELL);
    try { await tabell.createTable(); } catch (_) { /* fins fra før */ }
    const typer = [];
    for await (const entity of tabell.listEntities()) {
        const data = entityTilRapport(entity);
        typer.push({
            id: entity.rowKey,
            navn: entity.Tittel || data?.Rapport_navn || '',
            JSON: data
        });
    }
    return typer;
}

async function hentRapporttype(rapporttypeId) {
    const tabell = tabellKlient(TABELL);
    try {
        const entity = await tabell.getEntity(PK, String(rapporttypeId));
        const data = entityTilRapport(entity);
        return data ? { id: entity.rowKey, navn: entity.Tittel || data.Rapport_navn || '', JSON: data } : null;
    } catch (e) {
        if (e.statusCode === 404) return null;
        throw e;
    }
}

async function lagreRapporttype(data) {
    const tabell = tabellKlient(TABELL);
    try { await tabell.createTable(); } catch (_) { /* fins fra før */ }

    const rapporttypeId = String(data.Rapporttype_id || '');
    if (!rapporttypeId) throw new Error('Rapporttype_id mangler');

    const jsonStreng = JSON.stringify(data);
    const chunks = splittJson(jsonStreng);
    if (chunks.length > MAKS_CHUNKS) {
        throw new Error(`Rapporttypen er for stor (${jsonStreng.length} tegn). Reduser antall kolonner/filtre.`);
    }

    const entity = {
        partitionKey: PK,
        rowKey: rapporttypeId,
        Tittel: data.Rapport_navn || '',
        Oppdatert: new Date().toISOString(),
        JSON: chunks[0] || ''
    };
    for (let i = 1; i < chunks.length; i++) {
        entity[`JSON${i + 1}`] = chunks[i];
    }
    for (let i = chunks.length + 1; i <= MAKS_CHUNKS; i++) {
        entity[`JSON${i}`] = null;
    }
    await tabell.upsertEntity(entity, 'Replace');
}

async function slettRapporttype(rapporttypeId) {
    const tabell = tabellKlient(TABELL);
    try {
        await tabell.deleteEntity(PK, String(rapporttypeId));
        return true;
    } catch (e) {
        if (e.statusCode === 404) return false;
        throw e;
    }
}

module.exports = {
    hentAlleRapporttyper,
    hentRapporttype,
    lagreRapporttype,
    slettRapporttype
};
