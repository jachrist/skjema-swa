/**
 * Table Storage-klient.
 *
 * To veier inn til lagringen — delt nøkkel eller managed identity — og VALGET
 * MELLOM DEM STÅR IKKE HER. Det står i `lagringsvalg.js`, ett sted, og
 * `blob.js` spør samme regel. Se kommentaren der for hvorfor rekkefølgen er
 * som den er, og `docs/BESLUTNING-EGEN-FUNCTION-APP.md` for veien videre.
 *
 * Både klientene og createTable-kallet caches per prosess: en tabell som
 * finnes fortsetter å finnes, så det er ingen grunn til å spørre om det på
 * nytt for hvert eneste oppslag. Uten cachen brukte hvert lille oppslag to
 * HTTP-rundturer i stedet for én.
 *
 * De fleste kallerne bruker miljøets eget lager via `tabellKlient` /
 * `sikreTabell`. `*Fra`-variantene tar en connection string som argument, og
 * finnes for data som skal deles på tvers av tenanter — se `todo-storage.js`.
 * Delt nøkkel er eneste vei dit: Managed Identity virker ikke over
 * tenantgrenser, og de variantene følger derfor ikke miljøets valg.
 */
// SDK-en lastes først ved første tabelloppslag. Da kan de rene
// logikktestene kjøre uten node_modules, og CI slipper å installere
// avhengigheter bare for å validere dem.
let TableClient = null;
function tableKlientKlasse() {
    if (!TableClient) ({ TableClient } = require('@azure/data-tables'));
    return TableClient;
}

const {
    lagringsvalg, tilkoblingsstreng, endepunkt, legitimasjon, miNokkel, STRENG_VAR
} = require('./lagringsvalg');

const klienter = new Map();   // "lagernøkkel::tabellnavn" → TableClient
const opprettet = new Map();  // samme nøkkel → Promise (createTable, kjøres én gang)

/**
 * Et «lager» er paret (nøkkel for cachen, hvordan en klient bygges).
 *
 * Nøkkelen identifiserer LAGERET, ikke tabellen — se `miNokkel()` i
 * `lagringsvalg.js`, som `blob.js` bruker til det samme.
 */
function lagerFraStreng(connectionString, varNavn = STRENG_VAR) {
    if (!connectionString) throw new Error(`${varNavn} env-var mangler`);
    return {
        nokkel: connectionString,
        klient: (tabellNavn) => tableKlientKlasse().fromConnectionString(connectionString, tabellNavn)
    };
}

function lagerFraIdentitet(valg) {
    const url = endepunkt('tabell', valg.konto);
    return {
        nokkel: miNokkel(valg),
        klient: (tabellNavn) => new (tableKlientKlasse())(url, tabellNavn, legitimasjon(valg.klientId))
    };
}

/**
 * Miljøets eget lager, etter regelen i `lagringsvalg.js`.
 *
 * Er lagringen ukonfigurert, sier feilmeldingen HVILKEN av de to veiene som
 * mangler sin verdi. «STORAGE_CONNECTION_STRING env-var mangler» var riktig
 * så lenge det bare fanst én vei; nå ville den sendt feilsøkingen i gal
 * retning i dev.
 */
function miljoetsLager() {
    const valg = lagringsvalg();
    if (valg.maate === 'tilkoblingsstreng') return lagerFraStreng(tilkoblingsstreng());
    if (valg.maate === 'managed-identity') return lagerFraIdentitet(valg);
    throw new Error(`Lagring er ikke konfigurert: ${valg.grunn}`);
}

function klientI(lager, tabellNavn) {
    const nokkel = `${lager.nokkel}::${tabellNavn}`;
    let k = klienter.get(nokkel);
    if (!k) {
        k = lager.klient(tabellNavn);
        klienter.set(nokkel, k);
    }
    return k;
}

/**
 * Hent klient og sørg for at tabellen finnes. createTable kalles maks én gang
 * per tabell per prosess; feiler den (409 = fins fra før) svelges det, som før.
 */
async function sikreI(lager, tabellNavn) {
    const k = klientI(lager, tabellNavn);
    const nokkel = `${lager.nokkel}::${tabellNavn}`;
    if (!opprettet.has(nokkel)) {
        opprettet.set(nokkel, k.createTable().catch(() => { /* fins fra før */ }));
    }
    await opprettet.get(nokkel);
    return k;
}

function tabellKlientFra(connectionString, tabellNavn, varNavn) {
    return klientI(lagerFraStreng(connectionString, varNavn), tabellNavn);
}

async function sikreTabellFra(connectionString, tabellNavn, varNavn) {
    return sikreI(lagerFraStreng(connectionString, varNavn), tabellNavn);
}

/**
 * `odata`-hjelperen fra SDK-en, lastet lat.
 *
 * Den brukes som tagget mal — odata`PartitionKey eq ${x}` — og er den eneste
 * grunnen til at seks lagringsmoduler ellers måtte importere @azure/data-tables
 * på toppnivå. Med denne kan hele lib-mappa importeres uten node_modules, slik
 * testene og deploy-steget forutsetter.
 */
function odata(...args) {
    return require('@azure/data-tables').odata(...args);
}

function tabellKlient(tabellNavn) {
    return klientI(miljoetsLager(), tabellNavn);
}

async function sikreTabell(tabellNavn) {
    return sikreI(miljoetsLager(), tabellNavn);
}

/**
 * Glem at vi har forsøkt å opprette tabellen, slik at neste `sikreTabell*`
 * prøver på nytt. Trengs når opprettelsen ble avvist: uten dette ville en
 * rettet tilgang først slå inn ved neste kaldstart.
 *
 * Første argument er LAGERNØKKELEN — connection stringen for `*Fra`-veien,
 * som er den eneste som bruker dette i dag.
 */
function glemOpprettelse(lagerNokkel, tabellNavn) {
    opprettet.delete(`${lagerNokkel}::${tabellNavn}`);
}

/**
 * Samme, for miljøets eget lager. Da er lagernøkkelen ikke noe kalleren har —
 * den avhenger av hvilken vei `lagringsvalg()` valgte.
 */
function glemOpprettelseIMiljoet(tabellNavn) {
    glemOpprettelse(miljoetsLager().nokkel, tabellNavn);
}

// `kontoNavnFra` lå her til 16.10.2026. Den bor nå i `lagringsvalg.js`, ved
// siden av `miljoetsKonto()` — spørsmålet «hvilken konto er dette» har to
// svar avhengig av hvilken vei miljøet går, og de to svarene skal ikke ligge
// i hver sin modul.

module.exports = {
    tabellKlient, sikreTabell,
    tabellKlientFra, sikreTabellFra,
    glemOpprettelse, glemOpprettelseIMiljoet, odata
};
