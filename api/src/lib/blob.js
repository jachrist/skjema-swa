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

/**
 * Blob-klient mot en annen lagringskonto enn miljøets egen.
 *
 * Samme behov som tabellKlientFra i storage.js: todo-lista med vedlegg bor på
 * dev-tenanten, og Managed Identity virker ikke over tenantgrenser. Klientene
 * caches per connection string, ikke i én global som serviceKlient().
 */
const tjenester = new Map();

function serviceKlientFra(connectionString, varNavn = 'STORAGE_CONNECTION_STRING') {
    if (!connectionString) throw new Error(`${varNavn} env-var mangler`);
    let s = tjenester.get(connectionString);
    if (!s) {
        s = BlobServiceClient.fromConnectionString(connectionString);
        tjenester.set(connectionString, s);
    }
    return s;
}

function containerKlientFra(connectionString, containerNavn, varNavn) {
    return serviceKlientFra(connectionString, varNavn).getContainerClient(containerNavn);
}

module.exports = { containerKlient, serviceKlient, containerKlientFra, serviceKlientFra };
