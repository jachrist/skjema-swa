/**
 * Hvor de to DELTE listene ligger — todo-lista og nøkkelkalenderen.
 *
 * Begge er forvalterens egne lister, ikke skjemadata. De skal følge personen
 * som drifter løsningen gjennom alle miljøer, så de ligger på én konto i
 * dev-tenanten, nådd med en SAS i `TODO_STORAGE_CONNECTION_STRING`. Delt
 * nøkkel er eneste vei dit: en managed identity virker ikke over
 * tenantgrenser.
 *
 * **Er den strengen ikke satt, faller begge tilbake til miljøets eget lager.**
 * Da er listene lokale for miljøet, som er riktig for et miljø som ikke skal
 * dele dem — og det er den eneste oppførselen som virker i dev, der det ikke
 * finnes noen tilkoblingsstreng å falle tilbake på.
 *
 * Fallbacken sto tidligere som `DELT_CS || process.env.STORAGE_CONNECTION_STRING`
 * i BEGGE filene, i to kopier, sammen med to identiske `lagerInfo()`. Med
 * managed identity svarte den kopien feil: uten en tilkoblingsstreng ble
 * fallbacken en tom streng, og listene feilet med at en variabel som med vilje
 * ikke er satt, mangler. Regelen bor derfor her, ett sted.
 */
const {
    sikreTabell, sikreTabellFra, glemOpprettelse, glemOpprettelseIMiljoet
} = require('./storage');
const { containerKlient, containerKlientFra } = require('./blob');
const { kontoNavnFra, miljoetsKonto } = require('./lagringsvalg');

const VAR = 'TODO_STORAGE_CONNECTION_STRING';

/**
 * Den delte strengen, lest ved hvert kall.
 *
 * Ikke ved modullast: da måtte en test tømme require-cachen for å prøve den
 * andre veien, og en test som krever det er en test folk slutter å skrive.
 */
function deltStreng(env = process.env) {
    // Navnet SKREVET UT, ikke `env[VAR]`. Scanneren i
    // `api/test/env-inventar.test.js` leter etter `env.NAVN` og
    // `process.env.NAVN`; leses verdien gjennom konstanten, forsvinner
    // variabelen fra inventaret — og en oversikt som ser komplett ut og ikke
    // er det, er verre enn ingen.
    return String(env.TODO_STORAGE_CONNECTION_STRING || '').trim();
}

/** Er listene delt med andre miljøer, eller lokale for dette? */
function erDelt(env = process.env) {
    return !!deltStreng(env);
}

/** Tabellen, opprettet hvis den ikke finnes — i det lageret som gjelder. */
async function sikreDeltTabell(tabellNavn) {
    const cs = deltStreng();
    return cs ? sikreTabellFra(cs, tabellNavn, VAR) : sikreTabell(tabellNavn);
}

/**
 * Glem at vi har forsøkt å opprette tabellen. Kalles når opprettelsen ble
 * avvist, slik at en rettet tilgang slår inn uten en kaldstart.
 */
function glemDeltOpprettelse(tabellNavn) {
    const cs = deltStreng();
    if (cs) glemOpprettelse(cs, tabellNavn);
    else glemOpprettelseIMiljoet(tabellNavn);
}

/** Blob-containeren for vedlegg — samme lager som tabellen. */
function deltContainer(containerNavn) {
    const cs = deltStreng();
    return cs ? containerKlientFra(cs, containerNavn, VAR) : containerKlient(containerNavn);
}

/** Kontoen listene faktisk ligger på. `null` betyr «vet ikke». */
function deltKonto() {
    const cs = deltStreng();
    return cs ? kontoNavnFra(cs) : miljoetsKonto();
}

/**
 * Det admin-panelet viser om lageret.
 *
 * `sammeSomMiljo` er en vakt: en SAS utstedt på feil lagringskonto er fullt
 * gyldig. Appen kobler til, oppretter tabellen og viser en tom liste uten en
 * eneste feilmelding. Peker den delte strengen på miljøets egen konto, er
 * lista ikke delt med noen — og det er nesten alltid en forveksling ved
 * utstedelsen.
 *
 * Den gjelder bare når en delt streng ER satt. Uten den er «samme som miljøet»
 * selve meningen, ikke en feil.
 */
function deltLagerInfo() {
    const delt = erDelt();
    const konto = deltKonto();
    const miljoKonto = miljoetsKonto();
    const sammeSomMiljo = !!(delt && konto && miljoKonto
        && konto.toLowerCase() === miljoKonto.toLowerCase());
    return { konto, delt, sammeSomMiljo, miljoKonto };
}

module.exports = {
    VAR, deltStreng, erDelt, sikreDeltTabell, glemDeltOpprettelse,
    deltContainer, deltKonto, deltLagerInfo
};
