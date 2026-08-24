/**
 * Table Storage-klient.
 *
 * SWA Managed Functions støtter ikke Managed Identity direkte i koden.
 * Vi bruker derfor connection string via env-var, hvor selve verdien ligger i
 * Key Vault og eksponeres til env-varen via `@Microsoft.KeyVault(...)`-referanse.
 * Da forlater aldri secretsen KV under koden — SWA-hosten løser referansen
 * ved oppstart (bruker sin egen MI mot KV).
 *
 * Både klientene og createTable-kallet caches per prosess: en tabell som
 * finnes fortsetter å finnes, så det er ingen grunn til å spørre om det på
 * nytt for hvert eneste oppslag. Uten cachen brukte hvert lille oppslag to
 * HTTP-rundturer i stedet for én.
 */
const { TableClient } = require('@azure/data-tables');

const cs = process.env.STORAGE_CONNECTION_STRING;

const klienter = new Map();   // tabellnavn → TableClient
const opprettet = new Map();  // tabellnavn → Promise (createTable, kjøres én gang)

function tabellKlient(tabellNavn) {
    if (!cs) throw new Error('STORAGE_CONNECTION_STRING env-var mangler');
    let k = klienter.get(tabellNavn);
    if (!k) {
        k = TableClient.fromConnectionString(cs, tabellNavn);
        klienter.set(tabellNavn, k);
    }
    return k;
}

/**
 * Hent klient og sørg for at tabellen finnes. createTable kalles maks én gang
 * per tabell per prosess; feiler den (409 = fins fra før) svelges det, som før.
 */
async function sikreTabell(tabellNavn) {
    const k = tabellKlient(tabellNavn);
    if (!opprettet.has(tabellNavn)) {
        opprettet.set(tabellNavn, k.createTable().catch(() => { /* fins fra før */ }));
    }
    await opprettet.get(tabellNavn);
    return k;
}

module.exports = { tabellKlient, sikreTabell };
