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
let blobSdk = null;
function blobPakke() {
    if (!blobSdk) blobSdk = require('@azure/storage-blob');
    return blobSdk;
}
function blobKlientKlasse() {
    return blobPakke().BlobServiceClient;
}

const {
    lagringsvalg, tilkoblingsstreng, endepunkt, legitimasjon, miNokkel,
    kontonokkelFra, STRENG_VAR
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

// ==================== SAS-URL ====================
//
// En lesbar lenke til én blob, med utløp. Backup-nedlastingen og
// opplastingsflyten bruker den.
//
// To veier, som resten av fila, og de er IKKE symmetriske:
//
//   **delt nøkkel** — `StorageSharedKeyCredential` signerer lokalt. Ingen
//   nettverkskall, og kontonøkkelen må rives ut av tilkoblingsstrengen.
//
//   **managed identity** — det finnes ingen nøkkel å signere med. Azure
//   utsteder i stedet en *user delegation key* over nettet
//   (`getUserDelegationKey`), som krever rollen `Storage Blob Delegator` i
//   TILLEGG til datarollene. Den har sin egen levetid, og signeringen er
//   lokal etterpå.
//
// Målt i dev 16.10.2026 med `/api/diagnose/mi-blob?skriv=ja`: delegering,
// signering og et ekte HTTP-kall på den ferdige URL-en, alle grønne. Formen
// under er den samme som prøven brukte.

/** SAS-en varer så lenge, om ikke annet er sagt. Flyten henter og laster opp. */
const SAS_TIMER_STANDARD = 24;

/**
 * Litt klokkeslark bakover. En SAS som starter «nå» avvises av og til fordi
 * klokkene ikke er helt enige.
 */
const START_SLARK_MS = 5 * 60 * 1000;

/**
 * Delegeringsnøkkelen hentes over nettet, så den caches. Den dekker HELE
 * kontoen, ikke én blob, så én nøkkel holder for en hel fil-liste — uten
 * dette ble det ett nettverkskall per blob i `/api/backup/liste`.
 *
 * Cachet PER LAGER, ikke i én global. En nøkkel er utstedt av én konto til én
 * identitet, og en nøkkel fra forrige konto ville signert en SAS som ser
 * riktig ut og avvises av tjenesten.
 *
 * Den gjenbrukes bare så lenge den dekker utløpet som spørres om. En nøkkel
 * som utløper før SAS-en gjør den ugyldig i stillhet.
 */
const delegeringer = new Map();
const DELEGERING_MARGIN_MS = 60 * 60 * 1000;

async function delegeringsnokkel(tjeneste, lagerNokkel, utloper) {
    const har = delegeringer.get(lagerNokkel);
    if (har && new Date(har.signedExpiresOn) > utloper) return har;
    const ny = await tjeneste.getUserDelegationKey(
        new Date(Date.now() - START_SLARK_MS),
        new Date(utloper.getTime() + DELEGERING_MARGIN_MS)
    );
    delegeringer.set(lagerNokkel, ny);
    return ny;
}

/** Bare for test: glem de cachede nøklene. */
function glemDelegering() {
    delegeringer.clear();
}

/**
 * Lesbar SAS-URL til én blob i miljøets eget lager.
 *
 * **Returverdien er legitimasjon.** Den som har lenken har tilgangen, uten å
 * være innlogget — derfor skal den ikke logges, ikke stå i en feilmelding og
 * ikke i en e-post.
 */
async function sasUrl(containerNavn, blobNavn, { timer = SAS_TIMER_STANDARD } = {}) {
    const valg = lagringsvalg();
    const { generateBlobSASQueryParameters, BlobSASPermissions } = blobPakke();
    const starter = new Date(Date.now() - START_SLARK_MS);
    const utloper = new Date(Date.now() + timer * 3600 * 1000);
    const verdier = {
        containerName: containerNavn,
        blobName: blobNavn,
        permissions: BlobSASPermissions.parse('r'),
        startsOn: starter,
        expiresOn: utloper,
        protocol: 'https'
    };

    let konto, sas;
    if (valg.maate === 'tilkoblingsstreng') {
        const { StorageSharedKeyCredential } = blobPakke();
        const kn = kontonokkelFra(tilkoblingsstreng());
        konto = kn.konto;
        sas = generateBlobSASQueryParameters(
            verdier, new StorageSharedKeyCredential(kn.konto, kn.nokkel)
        ).toString();
    } else if (valg.maate === 'managed-identity') {
        konto = valg.konto;
        const nokkel = await delegeringsnokkel(serviceKlient(), miNokkel(valg), utloper);
        sas = generateBlobSASQueryParameters(verdier, nokkel, konto).toString();
    } else {
        throw new Error(`Lagring er ikke konfigurert: ${valg.grunn}`);
    }

    const vert = endepunkt('blob', konto);
    return `${vert}/${containerNavn}/${encodeURIComponent(blobNavn)}?${sas}`;
}

module.exports = {
    containerKlient, serviceKlient, containerKlientFra, serviceKlientFra,
    sasUrl, _glemDelegering: glemDelegering
};
