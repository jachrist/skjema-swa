/**
 * Storage-modul for Skjemaer-tabellen (innsendte og mellomlagrede skjemaer).
 *
 * Tabellstruktur (samme som referanse-appen):
 *   Skjemaer
 *     PartitionKey = <Skjematype_id>
 *     RowKey       = <Skjema_id>
 *     Egenskaper: Tittel, InnsenderEpost, Skjemastatus, Opprettet, Oppdatert, JSON
 */
const { tabellKlient } = require('./storage');

const TABELL = 'Skjemaer';

function entityTilSkjema(entity) {
    if (!entity) return null;
    if (!entity.JSON) return null;
    try {
        return JSON.parse(entity.JSON);
    } catch (_) {
        return null;
    }
}

async function hentSkjema(skjemaId, skjematypeId) {
    const tabell = tabellKlient(TABELL);
    try { await tabell.createTable(); } catch (_) { /* fins fra før */ }

    if (skjematypeId) {
        try {
            const entity = await tabell.getEntity(String(skjematypeId), String(skjemaId));
            return entityTilSkjema(entity);
        } catch (e) {
            if (e.statusCode === 404) return null;
            throw e;
        }
    }

    // Søk på tvers av partisjoner hvis skjematypeId mangler
    const { odata } = require('@azure/data-tables');
    const iter = tabell.listEntities({
        queryOptions: { filter: odata`RowKey eq ${String(skjemaId)}` }
    });
    for await (const entity of iter) {
        return entityTilSkjema(entity);
    }
    return null;
}

async function lagreSkjema(skjemaData, erNytt = false) {
    const tabell = tabellKlient(TABELL);
    try { await tabell.createTable(); } catch (_) { /* fins fra før */ }

    const skjematypeId = String(skjemaData.Skjematype_id || '0');
    const skjemaId = String(skjemaData.Skjema_id);
    if (!skjemaId) throw new Error('Skjema_id mangler');

    const naa = new Date().toISOString();
    // Skjøt inn tidsstempel i selve skjemadataen slik at det følger med ved
    // parsing (register-visning m.m. leser fra JSON).
    if (erNytt) skjemaData.Opprettet = naa;
    skjemaData.Sist_endret = naa;

    const entity = {
        partitionKey: skjematypeId,
        rowKey: skjemaId,
        Tittel: skjemaData.Skjema_navn || skjemaData.Overskrift || '',
        InnsenderEpost: skjemaData.Innsender_Epost || skjemaData.Innsender_epost || '',
        Skjemastatus: skjemaData.Skjema_status || 0,
        Oppdatert: naa,
        JSON: JSON.stringify(skjemaData)
    };
    if (erNytt) entity.Opprettet = naa;

    await tabell.upsertEntity(entity, 'Merge');
}

async function hentAlleSkjemaerForType(skjematypeId) {
    const tabell = tabellKlient(TABELL);
    try { await tabell.createTable(); } catch (_) { /* fins fra før */ }

    const { odata } = require('@azure/data-tables');
    const resultat = [];
    const iter = tabell.listEntities({
        queryOptions: { filter: odata`PartitionKey eq ${String(skjematypeId)}` }
    });
    for await (const entity of iter) {
        const data = entityTilSkjema(entity);
        if (data) resultat.push(data);
    }
    return resultat;
}

/**
 * Hent alle mellomlagrede skjemaer (status=1) der brukeren er innsender.
 * Én query mot Skjemaer-tabellen på tvers av partisjoner.
 */
async function hentMineMellomlagrede(upn) {
    if (!upn) return [];
    const tabell = tabellKlient(TABELL);
    try { await tabell.createTable(); } catch (_) { /* fins fra før */ }

    const { odata } = require('@azure/data-tables');
    const upnLower = String(upn).toLowerCase();
    const filter = odata`InnsenderEpost eq ${upnLower} and Skjemastatus eq ${1}`;

    const resultat = [];
    const iter = tabell.listEntities({ queryOptions: { filter } });
    for await (const entity of iter) {
        const data = entityTilSkjema(entity);
        if (!data) continue;
        resultat.push({
            Skjema_id: data.Skjema_id,
            Skjematype_id: data.Skjematype_id || entity.partitionKey,
            Sist_endret: data.Sist_endret || entity.Oppdatert || '',
            Opprettet: data.Opprettet || ''
        });
    }
    // Nyeste først
    resultat.sort((a, b) => (b.Sist_endret || '').localeCompare(a.Sist_endret || ''));
    return resultat;
}

async function slettSkjema(skjemaId, skjematypeId) {
    const tabell = tabellKlient(TABELL);
    try {
        await tabell.deleteEntity(String(skjematypeId), String(skjemaId));
        return true;
    } catch (e) {
        if (e.statusCode === 404) return false;
        throw e;
    }
}

module.exports = {
    hentSkjema,
    lagreSkjema,
    hentAlleSkjemaerForType,
    hentMineMellomlagrede,
    slettSkjema
};
