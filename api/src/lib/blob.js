/**
 * Blob Storage-klient.
 *
 * Se kommentar i storage.js — samme grunn til at vi bruker connection string
 * via KV-referanse i stedet for Managed Identity direkte i koden.
 */
// Samme grunn som i storage.js: lat lasting holder modulen importerbar
// uten node_modules, slik at logikktester kan kjøre uten npm ci.
let BlobServiceClient = null;
function blobKlientKlasse() {
    if (!BlobServiceClient) ({ BlobServiceClient } = require('@azure/storage-blob'));
    return BlobServiceClient;
}

const cs = process.env.STORAGE_CONNECTION_STRING;
let service = null;

function serviceKlient() {
    if (!cs) throw new Error('STORAGE_CONNECTION_STRING env-var mangler');
    if (!service) {
        service = blobKlientKlasse().fromConnectionString(cs);
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
        s = blobKlientKlasse().fromConnectionString(connectionString);
        tjenester.set(connectionString, s);
    }
    return s;
}

function containerKlientFra(connectionString, containerNavn, varNavn) {
    return serviceKlientFra(connectionString, varNavn).getContainerClient(containerNavn);
}

module.exports = { containerKlient, serviceKlient, containerKlientFra, serviceKlientFra };
