/**
 * Storage-modul for Postnumre-tabellen.
 *
 * Tabellstruktur (samme mønster som referanse-app):
 *   Postnumre
 *     PartitionKey = første siffer av postnr (partisjonering på 10 grupper)
 *     RowKey       = fullt postnummer (4 siffer)
 *     Egenskaper: Postnr, Poststed, Kommune
 */
const { tabellKlient } = require('./storage');
const { odata } = require('@azure/data-tables');

const TABELL = 'Postnumre';

async function hentPostnummer(postnr) {
    const nr = String(postnr || '').trim().padStart(4, '0');
    if (!/^\d{4}$/.test(nr)) return null;
    const tabell = tabellKlient(TABELL);
    try { await tabell.createTable(); } catch (_) { /* fins fra før */ }
    try {
        const row = await tabell.getEntity(nr[0], nr);
        return { Postnr: nr, Poststed: row.Poststed || '', Kommune: row.Kommune || '' };
    } catch (e) {
        if (e.statusCode === 404) return null;
        throw e;
    }
}

/**
 * Søk postnumre. Detekterer søketype:
 *   - Starter med siffer → prefix-søk på postnr (partisjonert)
 *   - Ellers → substring-søk på poststed (full scan, case-insensitiv)
 *
 * Returnerer maks `maks` treff, sortert på postnr ved tallsøk, på poststed ellers.
 */
async function sokPostnumre(query, maks = 10) {
    const q = String(query || '').trim();
    if (!q) return [];
    const tabell = tabellKlient(TABELL);
    try { await tabell.createTable(); } catch (_) { /* fins fra før */ }

    const erTallsøk = /^\d/.test(q);
    const rader = [];

    if (erTallsøk) {
        // Prefix-søk på RowKey — partisjonert på første siffer for effektivitet
        const pk = q[0];
        const filter = odata`PartitionKey eq ${pk} and RowKey ge ${q} and RowKey lt ${q + '￿'}`;
        const iter = tabell.listEntities({ queryOptions: { filter } });
        for await (const row of iter) {
            rader.push({ Postnr: row.rowKey, Poststed: row.Poststed || '', Kommune: row.Kommune || '' });
            if (rader.length >= maks) break;
        }
        rader.sort((a, b) => a.Postnr.localeCompare(b.Postnr));
    } else {
        // Substring-søk på poststed — må skanne, men vi begrenser tidlig
        const qLow = q.toLowerCase();
        const iter = tabell.listEntities();
        for await (const row of iter) {
            if ((row.Poststed || '').toLowerCase().includes(qLow)) {
                rader.push({ Postnr: row.rowKey, Poststed: row.Poststed, Kommune: row.Kommune || '' });
                if (rader.length >= maks * 3) break; // hent litt ekstra for sortering
            }
        }
        // Sorter alfabetisk på poststed, deretter postnr
        rader.sort((a, b) => a.Poststed.localeCompare(b.Poststed, 'nb') || a.Postnr.localeCompare(b.Postnr));
        rader.splice(maks);
    }
    return rader;
}

async function upsertBatch(rader) {
    const tabell = tabellKlient(TABELL);
    try { await tabell.createTable(); } catch (_) { /* fins fra før */ }
    // Grupperes per PK for submitTransaction — men her går vi enkel-upsert for pilot
    for (const rad of rader) {
        const nr = String(rad.Postnr).trim().padStart(4, '0');
        await tabell.upsertEntity({
            partitionKey: nr[0],
            rowKey: nr,
            Postnr: nr,
            Poststed: rad.Poststed || '',
            Kommune: rad.Kommune || ''
        }, 'Replace');
    }
}

module.exports = { hentPostnummer, sokPostnumre, upsertBatch };
