/**
 * Storage-modul for Postnumre-tabellen.
 *
 * Tabellstruktur (samme mønster som referanse-app):
 *   Postnumre
 *     PartitionKey = første siffer av postnr (partisjonering på 10 grupper)
 *     RowKey       = fullt postnummer (4 siffer)
 *     Egenskaper: Postnr, Poststed, Kommune
 */
const { tabellKlient, sikreTabell } = require('./storage');
const { odata } = require('@azure/data-tables');

const TABELL = 'Postnumre';

async function hentPostnummer(postnr) {
    const nr = String(postnr || '').trim().padStart(4, '0');
    if (!/^\d{4}$/.test(nr)) return null;
    const tabell = await sikreTabell(TABELL);
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
    const tabell = await sikreTabell(TABELL);

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
    const tabell = await sikreTabell(TABELL);
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

/**
 * Import av en full postnummer-liste. Med erstattAlt=true slettes alle
 * eksisterende rader som IKKE finnes i det nye settet (så sammenslåtte/
 * utgåtte postnumre forsvinner). Bulk-upsert av alle i nye settet.
 *
 * Ytelse: sekvensielle kall — ~5000 rader tar 30-60 s. Akseptert siden
 * jobben kjører 2×/år.
 */
async function importerAlle(rader, { erstattAlt = false, log = () => {} } = {}) {
    const tabell = await sikreTabell(TABELL);

    // Normaliser + dedupliser input
    const nye = new Map();
    let avvist = 0;
    for (const r of rader) {
        const nr = String(r.Postnr || r.postnr || '').trim().padStart(4, '0');
        if (!/^\d{4}$/.test(nr)) { avvist++; continue; }
        nye.set(nr, {
            partitionKey: nr[0],
            rowKey: nr,
            Postnr: nr,
            Poststed: r.Poststed || r.poststed || '',
            Kommune: r.Kommune || r.kommune || ''
        });
    }

    let slettet = 0;
    if (erstattAlt) {
        log(`importerAlle: sjekker eksisterende for sletting…`);
        for await (const e of tabell.listEntities({ queryOptions: { select: ['PartitionKey', 'RowKey'] } })) {
            if (!nye.has(e.rowKey)) {
                try { await tabell.deleteEntity(e.partitionKey, e.rowKey); slettet++; }
                catch (_) { /* stille — kan være allerede borte */ }
            }
        }
        log(`importerAlle: slettet ${slettet} utgåtte`);
    }

    let skrevet = 0;
    log(`importerAlle: upserter ${nye.size} rader…`);
    for (const entity of nye.values()) {
        await tabell.upsertEntity(entity, 'Replace');
        skrevet++;
        if (skrevet % 500 === 0) log(`importerAlle: ${skrevet}/${nye.size}…`);
    }
    return { antallSkrevet: skrevet, antallSlettet: slettet, antallAvvist: avvist };
}

async function hentAntall() {
    const tabell = tabellKlient(TABELL);
    let antall = 0;
    try {
        for await (const _ of tabell.listEntities({ queryOptions: { select: ['PartitionKey'] } })) antall++;
    } catch (e) {
        if (e.statusCode === 404) return 0;
        throw e;
    }
    return antall;
}

module.exports = { hentPostnummer, sokPostnumre, upsertBatch, importerAlle, hentAntall };
