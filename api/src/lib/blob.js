/**
 * Blob Storage-klient med Managed Identity.
 *
 * Krever at appens managed identity har rollen "Storage Blob Data Contributor"
 * på storage-kontoen.
 */
const { BlobServiceClient } = require('@azure/storage-blob');
const { DefaultAzureCredential } = require('@azure/identity');

const konto = process.env.STORAGE_ACCOUNT_NAME;
let service = null;

function serviceKlient() {
    if (!konto) throw new Error('STORAGE_ACCOUNT_NAME env-var mangler');
    if (!service) {
        service = new BlobServiceClient(
            `https://${konto}.blob.core.windows.net`,
            new DefaultAzureCredential()
        );
    }
    return service;
}

function containerKlient(containerNavn) {
    return serviceKlient().getContainerClient(containerNavn);
}

module.exports = { containerKlient, serviceKlient };
