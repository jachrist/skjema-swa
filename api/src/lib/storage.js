/**
 * Table Storage-klient.
 *
 * SWA Managed Functions støtter ikke Managed Identity direkte i koden.
 * Vi bruker derfor connection string via env-var, hvor selve verdien ligger i
 * Key Vault og eksponeres til env-varen via `@Microsoft.KeyVault(...)`-referanse.
 * Da forlater aldri secretsen KV under koden — SWA-hosten løser referansen
 * ved oppstart (bruker sin egen MI mot KV).
 */
const { TableClient } = require('@azure/data-tables');

const cs = process.env.STORAGE_CONNECTION_STRING;

function tabellKlient(tabellNavn) {
    if (!cs) throw new Error('STORAGE_CONNECTION_STRING env-var mangler');
    return TableClient.fromConnectionString(cs, tabellNavn);
}

module.exports = { tabellKlient };
