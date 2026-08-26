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
 *
 * De fleste kallerne bruker miljøets eget lager via `tabellKlient` /
 * `sikreTabell`. `*Fra`-variantene tar en connection string som argument, og
 * finnes for data som skal deles på tvers av tenanter — se `todo-storage.js`.
 * Delt nøkkel er eneste vei dit: Managed Identity virker ikke over tenantgrenser.
 */
const { TableClient } = require('@azure/data-tables');

const cs = process.env.STORAGE_CONNECTION_STRING;

const klienter = new Map();   // "connection string::tabellnavn" → TableClient
const opprettet = new Map();  // samme nøkkel → Promise (createTable, kjøres én gang)

function tabellKlientFra(connectionString, tabellNavn, varNavn = 'STORAGE_CONNECTION_STRING') {
    if (!connectionString) throw new Error(`${varNavn} env-var mangler`);
    const nokkel = `${connectionString}::${tabellNavn}`;
    let k = klienter.get(nokkel);
    if (!k) {
        k = TableClient.fromConnectionString(connectionString, tabellNavn);
        klienter.set(nokkel, k);
    }
    return k;
}

/**
 * Hent klient og sørg for at tabellen finnes. createTable kalles maks én gang
 * per tabell per prosess; feiler den (409 = fins fra før) svelges det, som før.
 */
async function sikreTabellFra(connectionString, tabellNavn, varNavn) {
    const k = tabellKlientFra(connectionString, tabellNavn, varNavn);
    const nokkel = `${connectionString}::${tabellNavn}`;
    if (!opprettet.has(nokkel)) {
        opprettet.set(nokkel, k.createTable().catch(() => { /* fins fra før */ }));
    }
    await opprettet.get(nokkel);
    return k;
}

function tabellKlient(tabellNavn) {
    return tabellKlientFra(cs, tabellNavn);
}

async function sikreTabell(tabellNavn) {
    return sikreTabellFra(cs, tabellNavn);
}

/**
 * Kontonavnet fra en connection string, til visning i UI. Gjør det mulig å se
 * hvilket lager et miljø faktisk snakker med uten å eksponere nøkkelen.
 */
function kontoNavnFra(connectionString) {
    const m = /(?:^|;)\s*AccountName=([^;]+)/i.exec(String(connectionString || ''));
    return m ? m[1].trim() : null;
}

module.exports = { tabellKlient, sikreTabell, tabellKlientFra, sikreTabellFra, kontoNavnFra };
