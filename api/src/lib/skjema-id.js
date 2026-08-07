/**
 * Generer neste Skjema_id for en skjematype via optimistisk concurrency
 * (ETag) på Teller-tabellen. Speiler referanse-appens mønster.
 *
 * Tabellstruktur:
 *   Teller
 *     PartitionKey = "Teller"
 *     RowKey       = <Skjematype_id>
 *     Egenskaper: Nummer (int)
 *
 * Returnerer neste nummer som streng ("1", "2", ...).
 */
const { tabellKlient } = require('./storage');

const TABELL = 'Teller';
const PK = 'Teller';

async function genererSkjemaId(skjematypeId) {
    const tabell = tabellKlient(TABELL);
    try { await tabell.createTable(); } catch (_) { /* fins fra før */ }

    const rk = String(skjematypeId);

    for (let forsøk = 0; forsøk < 5; forsøk++) {
        let entity;
        try {
            entity = await tabell.getEntity(PK, rk);
        } catch (e) {
            if (e.statusCode === 404) {
                try {
                    await tabell.createEntity({ partitionKey: PK, rowKey: rk, Nummer: 1 });
                    return '1';
                } catch (createErr) {
                    if (createErr.statusCode === 409) continue;
                    throw createErr;
                }
            }
            throw e;
        }

        const nesteNummer = (entity.Nummer || 0) + 1;
        try {
            await tabell.updateEntity(
                { partitionKey: PK, rowKey: rk, Nummer: nesteNummer },
                'Replace',
                { etag: entity.etag }
            );
            return String(nesteNummer);
        } catch (e) {
            if (e.statusCode === 412) continue;
            throw e;
        }
    }
    throw new Error('Kunne ikke generere Skjema_id etter 5 forsøk (concurrency-konflikt)');
}

module.exports = { genererSkjemaId };
