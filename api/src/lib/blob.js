/**
 * Blob Storage-klient.
 *
 * Se kommentar i storage.js — samme grunn til at vi bruker connection string
 * via KV-referanse i stedet for Managed Identity direkte i koden.
 */
const { BlobServiceClient } = require('@azure/storage-blob');

const cs = process.env.STORAGE_CONNECTION_STRING;
let service = null;

function serviceKlient() {
    if (!cs) throw new Error('STORAGE_CONNECTION_STRING env-var mangler');
    if (!service) {
        service = BlobServiceClient.fromConnectionString(cs);
    }
    return service;
}

function containerKlient(containerNavn) {
    return serviceKlient().getContainerClient(containerNavn);
}

module.exports = { containerKlient, serviceKlient };
