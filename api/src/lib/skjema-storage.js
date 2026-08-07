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
const { tabellKlient } = require('./storage');

const TABELL = 'Skjemadefinisjoner';
const PK = 'Def';

function entityTilSkjema(entity) {
    if (!entity) return null;
    let data = null;
    if (entity.JSON) {
        try { data = JSON.parse(entity.JSON); }
        catch (_) { data = null; }
    }
    if (data && !data.Fase) data.Fase = 'Produksjon';
    return data;
}

async function hentAlleSkjematyper() {
    const tabell = tabellKlient(TABELL);
    // Sørg for at tabellen finnes (idempotent)
    try { await tabell.createTable(); } catch (_) { /* fins fra før */ }

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
    const tabell = tabellKlient(TABELL);
    try { await tabell.createTable(); } catch (_) { /* fins fra før */ }

    const skjematypeId = String(skjemaData.Skjematype_id || '');
    if (!skjematypeId) throw new Error('Skjematype_id mangler');

    await tabell.upsertEntity({
        partitionKey: PK,
        rowKey: skjematypeId,
        Tittel: skjemaData.Skjema_navn || '',
        Oppdatert: new Date().toISOString(),
        JSON: JSON.stringify(skjemaData)
    }, 'Replace');
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
