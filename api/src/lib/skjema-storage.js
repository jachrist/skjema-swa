/**
 * Storage-modul for Skjemadefinisjoner-tabellen.
 *
 * Tabellstruktur (samme som referanse-appen):
 *   Skjemadefinisjoner
 *     PartitionKey = "Def"
 *     RowKey       = <Skjematype_id>
 *     Egenskaper: Tittel, Oppdatert, JSON (hele definisjonen som string)
 *
 * Returnerer alltid struktur { id, navn, JSON: <parset objekt> } for kompatibilitet
 * med filtrerTyperPåTilgang og tilhørende logikk.
 */
const { tabellKlient, sikreTabell } = require('./storage');

const TABELL = 'Skjemadefinisjoner';
const PK = 'Def';

// Azure Table Storage tillater 64 KB per property (UTF-16 = 32K tegn max).
// Vi splitter JSON over flere properties: JSON, JSON2, JSON3, JSON4 → opptil 128K tegn.
// Ligger godt under bounds med bevisst margin (30K per chunk).
const CHUNK_STR = 30000;
const MAKS_CHUNKS = 8; // gir 240K tegn — mer enn nok for enhver realistisk skjematype

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

function entityTilSkjema(entity) {
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

async function hentAlleSkjematyper() {
    // Sørg for at tabellen finnes (idempotent, cachet per prosess)
    const tabell = await sikreTabell(TABELL);

    const typer = [];
    for await (const entity of tabell.listEntities()) {
        const data = entityTilSkjema(entity);
        typer.push({
            id: entity.rowKey,
            navn: entity.Tittel || data?.Skjema_navn || '',
            JSON: data
        });
    }
    return typer;
}

async function hentSkjematype(skjematypeId) {
    const tabell = tabellKlient(TABELL);
    try {
        const entity = await tabell.getEntity(PK, String(skjematypeId));
        const data = entityTilSkjema(entity);
        return data ? { id: entity.rowKey, navn: entity.Tittel || data.Skjema_navn || '', JSON: data } : null;
    } catch (e) {
        if (e.statusCode === 404) return null;
        throw e;
    }
}

async function lagreSkjematype(skjemaData) {
    const tabell = await sikreTabell(TABELL);

    const skjematypeId = String(skjemaData.Skjematype_id || '');
    if (!skjematypeId) throw new Error('Skjematype_id mangler');

    const jsonStreng = JSON.stringify(skjemaData);
    const chunks = splittJson(jsonStreng);
    if (chunks.length > MAKS_CHUNKS) {
        throw new Error(`Skjematypen er for stor (${jsonStreng.length} tegn, maks ${MAKS_CHUNKS * CHUNK_STR}). Reduser Skjemaforklaring, felttekster eller antall behandlingssteg.`);
    }

    const entity = {
        partitionKey: PK,
        rowKey: skjematypeId,
        Tittel: skjemaData.Skjema_navn || '',
        Oppdatert: new Date().toISOString(),
        JSON: chunks[0] || ''
    };
    for (let i = 1; i < chunks.length; i++) {
        entity[`JSON${i + 1}`] = chunks[i];
    }
    // Rydd bort tidligere chunks som ikke lenger er i bruk (Replace overskriver ikke ubrukte)
    for (let i = chunks.length + 1; i <= MAKS_CHUNKS; i++) {
        entity[`JSON${i}`] = null;
    }
    await tabell.upsertEntity(entity, 'Replace');
}

async function slettSkjematype(skjematypeId) {
    const tabell = tabellKlient(TABELL);
    try {
        await tabell.deleteEntity(PK, String(skjematypeId));
        return true;
    } catch (e) {
        if (e.statusCode === 404) return false;
        throw e;
    }
}

module.exports = {
    hentAlleSkjematyper,
    hentSkjematype,
    lagreSkjematype,
    slettSkjematype
};
