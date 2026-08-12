/**
 * Table Storage-kopiering mellom to konti.
 *
 * Iterer alle entiteter i kilde-tabellen og upsert til mål-tabellen med
 * bevart PartitionKey/RowKey. Idempotent — kan kjøres flere ganger.
 *
 * Batch-strategi: grupperer per PK og deler i chunks av 100 (Azure-krav
 * for submitTransaction).
 */
const { TableClient } = require('@azure/data-tables');

async function sikrTabell(client) {
    try { await client.createTable(); } catch (e) {
        if (e.statusCode !== 409) throw e;
    }
}

/**
 * Kopier en tabell fra kilde til mål.
 * @param {Object} opts
 * @param {string} opts.tabellNavn   — tabellnavn hvis samme i kilde og mål
 * @param {string} [opts.kildeNavn]  — override: kildens tabellnavn (f.eks. legacy Skjemaresultater)
 * @param {string} [opts.malNavn]    — override: målets tabellnavn (f.eks. SWA Skjemaer)
 * @returns {Promise<{lest, upsertet, hoppetOver, feil}>}
 */
async function kopierTabell({ tabellNavn, kildeNavn, malNavn, kildeConn, malConn, dryRun, log }) {
    const knavn = kildeNavn || tabellNavn;
    const mnavn = malNavn || tabellNavn;
    const etikett = knavn === mnavn ? knavn : `${knavn} → ${mnavn}`;
    log(`\n=== ${etikett} ===`);

    const kilde = TableClient.fromConnectionString(kildeConn, knavn);
    const mal = TableClient.fromConnectionString(malConn, mnavn);

    if (!dryRun) await sikrTabell(mal);

    // Les alle entiteter, grupper per PK
    const perPk = new Map();
    let lest = 0;
    try {
        for await (const e of kilde.listEntities()) {
            lest++;
            const kopi = { ...e };
            // Fjern OData-metadata som ikke skal skrives tilbake
            delete kopi.etag;
            delete kopi.timestamp;
            if (!perPk.has(kopi.partitionKey)) perPk.set(kopi.partitionKey, []);
            perPk.get(kopi.partitionKey).push(kopi);
            if (lest % 500 === 0) log(`  ...lest ${lest} entiteter`);
        }
    } catch (e) {
        if (e.statusCode === 404) {
            log(`  Kilde-tabell finnes ikke — hoppes over`);
            return { lest: 0, upsertet: 0, hoppetOver: 1, feil: 0 };
        }
        throw e;
    }
    log(`  Totalt lest: ${lest} entiteter i ${perPk.size} partisjoner`);

    if (dryRun) {
        log(`  DRY-RUN: ville skrevet ${lest} entiteter til ${mnavn}`);
        return { lest, upsertet: 0, hoppetOver: 0, feil: 0 };
    }

    // Upsert per partisjon i batcher av 100
    let upsertet = 0;
    let feil = 0;
    for (const [pk, entiteter] of perPk) {
        for (let i = 0; i < entiteter.length; i += 100) {
            const chunk = entiteter.slice(i, i + 100);
            try {
                if (chunk.length === 1) {
                    await mal.upsertEntity(chunk[0], 'Replace');
                } else {
                    const actions = chunk.map(e => ['upsert', e, 'Replace']);
                    await mal.submitTransaction(actions);
                }
                upsertet += chunk.length;
            } catch (e) {
                log(`  FEIL i PK="${pk}" chunk ${i}: ${e.message}`);
                feil += chunk.length;
                // Prøv én-og-én for denne chunken (kan være enkelt-entitet med problem)
                for (const ent of chunk) {
                    try {
                        await mal.upsertEntity(ent, 'Replace');
                        upsertet++;
                        feil--;
                    } catch (indv) {
                        log(`    - kunne ikke skrive PK="${pk}" RK="${ent.rowKey}": ${indv.message}`);
                    }
                }
            }
        }
    }
    log(`  Ferdig: ${upsertet} upsertet, ${feil} feil`);
    return { lest, upsertet, hoppetOver: 0, feil };
}

module.exports = { kopierTabell };
