/**
 * Hent og parse Bring sitt postnummerregister.
 *
 * Fila ligger som ANSI (Windows-1252) tab-separert tekstfil med kolonnene:
 *   Postnr  Poststed  Kommunenr  Kommunenavn  Kategori
 *
 * Ingen header-rad. Portert fra legacy azure-function-skjema/src/masterdata.
 */
const postnumreStorage = require('./postnumre-storage');

const BRING_URL = 'https://www.bring.no/tjenester/adressetjenester/postnummer/_/attachment/download/' +
    '7f0186f6-cf90-4657-8b5b-70707abeb789:62b42f1b8274a60db4bba965e64c7cf2c43143e9/' +
    'Postnummerregister-ansi.txt';

async function hentBringFil(log = () => {}) {
    log(`bring-postnummer: henter ${BRING_URL}`);
    const resp = await fetch(BRING_URL);
    if (!resp.ok) throw new Error(`Bring returnerte HTTP ${resp.status} ${resp.statusText}`);
    const buffer = await resp.arrayBuffer();
    const tekst = new TextDecoder('windows-1252').decode(new Uint8Array(buffer));
    log(`bring-postnummer: lastet ${buffer.byteLength} bytes (${tekst.length} tegn)`);
    return tekst;
}

function parseBringTekst(tekst) {
    const linjer = tekst.split(/\r?\n/);
    const rader = [];
    let avvist = 0;
    for (const linje of linjer) {
        if (!linje.trim()) continue;
        const felter = linje.split('\t');
        if (felter.length < 4) { avvist++; continue; }
        const postnr = felter[0].trim();
        if (!/^\d{4}$/.test(postnr)) { avvist++; continue; }
        rader.push({
            Postnr: postnr,
            Poststed: (felter[1] || '').trim(),
            Kommune: (felter[3] || '').trim()
        });
    }
    return { rader, avvist };
}

/**
 * Hovedfunksjon: hent → parse → import med erstattAlt=true.
 * Kaster hvis parsingen gir 0 rader (så vi ikke tømmer tabellen ved feil respons).
 */
async function oppdaterFraBring(log = () => {}) {
    const start = Date.now();
    const tekst = await hentBringFil(log);
    const { rader, avvist } = parseBringTekst(tekst);
    log(`bring-postnummer: parset ${rader.length} rader (${avvist} avvist)`);
    if (rader.length === 0) {
        throw new Error('Ingen gyldige rader i Bring-fila — avbryter for å ikke tømme tabellen');
    }
    const res = await postnumreStorage.importerAlle(rader, { erstattAlt: true, log });
    const varighetSek = Math.round((Date.now() - start) / 1000);
    log(`bring-postnummer: import ferdig — ${res.antallSkrevet} skrevet, ${res.antallSlettet} slettet, ${res.antallAvvist} avvist (${varighetSek}s)`);
    return {
        hentet: rader.length,
        parseAvvist: avvist,
        antallSkrevet: res.antallSkrevet,
        antallSlettet: res.antallSlettet,
        antallAvvist: res.antallAvvist,
        varighetSekunder: varighetSek
    };
}

module.exports = { oppdaterFraBring, parseBringTekst, hentBringFil, BRING_URL };
