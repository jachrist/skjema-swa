/**
 * Table Storage-klient med Managed Identity.
 *
 * DefaultAzureCredential prøver kredensialene i denne rekkefølgen:
 *   1. Environment variables (ikke aktuelt for oss)
 *   2. Managed Identity (i sky)
 *   3. Azure CLI (lokal utvikling — kjør `az login`)
 *
 * Krever at appens managed identity har rollen "Storage Table Data Contributor"
 * på storage-kontoen.
 */
const { TableClient } = require('@azure/data-tables');
const { DefaultAzureCredential } = require('@azure/identity');

const konto = process.env.STORAGE_ACCOUNT_NAME;
let kreditt = null;

function credential() {
    if (!kreditt) kreditt = new DefaultAzureCredential();
    return kreditt;
}

function tabellKlient(tabellNavn) {
    if (!konto) throw new Error('STORAGE_ACCOUNT_NAME env-var mangler');
    return new TableClient(
        `https://${konto}.table.core.windows.net`,
        tabellNavn,
        credential()
    );
}

module.exports = { tabellKlient };
