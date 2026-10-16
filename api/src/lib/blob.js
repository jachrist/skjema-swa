/**
 * Blob Storage-klient.
 *
 * Samme to veier inn som i `storage.js` — delt nøkkel eller managed identity —
 * og SAMME VALG: det tas i `lagringsvalg.js`, ikke her. Står regelen to
 * steder, kan et blob-oppslag velge annerledes enn et tabelloppslag mot samme
 * konto i samme prosess, og symptomet er at halve appen virker.
 */
// Samme grunn som i storage.js: lat lasting holder modulen importerbar
// uten node_modules, slik at logikktester kan kjøre uten npm ci.
let BlobServiceClient = null;
function blobKlientKlasse() {
    if (!BlobServiceClient) ({ BlobServiceClient } = require('@azure/storage-blob'));
    return BlobServiceClient;
}

const {
    lagringsvalg, tilkoblingsstreng, endepunkt, legitimasjon, miNokkel, STRENG_VAR
} = require('./lagringsvalg');

// Nøkkelen identifiserer LAGERET: connection stringen selv for delt nøkkel,
// `miNokkel(valg)` for managed identity — samme hjelper som storage.js bruker.
// Dette var tidligere én global `service` pluss ett kart; to måter å cache på
// i samme fil er én for mange.
const tjenester = new Map();

function tjenesteI(nokkel, lag) {
    let s = tjenester.get(nokkel);
    if (!s) {
        s = lag();
        tjenester.set(nokkel, s);
    }
    return s;
}

/**
 * Blob-tjenesten for miljøets eget lager.
 *
 * Feilmeldingen navngir hvilken av de to veiene som mangler sin verdi — se
 * `miljoetsLager()` i storage.js, samme begrunnelse.
 */
function serviceKlient() {
    const valg = lagringsvalg();
    if (valg.maate === 'tilkoblingsstreng') return serviceKlientFra(tilkoblingsstreng());
    if (valg.maate === 'managed-identity') {
        const url = endepunkt('blob', valg.konto);
        return tjenesteI(miNokkel(valg), () => new (blobKlientKlasse())(url, legitimasjon(valg.klientId)));
    }
    throw new Error(`Lagring er ikke konfigurert: ${valg.grunn}`);
}

function containerKlient(containerNavn) {
    return serviceKlient().getContainerClient(containerNavn);
}

/**
 * Blob-klient mot en annen lagringskonto enn miljøets egen.
 *
 * Samme behov som tabellKlientFra i storage.js: todo-lista med vedlegg bor på
 * dev-tenanten, og Managed Identity virker ikke over tenantgrenser. Denne
 * veien går derfor alltid på delt nøkkel, uansett hva miljøet selv bruker.
 */
function serviceKlientFra(connectionString, varNavn = STRENG_VAR) {
    if (!connectionString) throw new Error(`${varNavn} env-var mangler`);
    return tjenesteI(connectionString, () => blobKlientKlasse().fromConnectionString(connectionString));
}

function containerKlientFra(connectionString, containerNavn, varNavn) {
    return serviceKlientFra(connectionString, varNavn).getContainerClient(containerNavn);
}

module.exports = { containerKlient, serviceKlient, containerKlientFra, serviceKlientFra };
