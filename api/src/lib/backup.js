/**
 * Backup — bygg zip-eksport av alle tabeller + blob-containers.
 *
 * Struktur i zip:
 *   manifest.json                                — { versjon, tid, tabeller[], delteTabeller[], containers[] }
 *   tabeller/{TabellNavn}.json                   — array av entities
 *   delte-tabeller/{TabellNavn}.json             — tabeller fra den delte dev-kontoen.
 *                                                  Egen manifestnøkkel, og restore rører dem ikke.
 *   blobs/{container}/{filnavn}                  — binær-innhold
 *   blobs/{container}/_meta.json                 — liste over filnavn + storrelse + contentType
 *
 * Ytelse: zipen genereres som strøm, krypteres underveis og skrives i blokker
 * rett til blob. Verken den ferdige zipen, ciphertexten eller den krypterte
 * containeren finnes som egen kopi i minnet.
 *
 * Det som fortsatt skalerer med datamengden, er JSZip: innholdet i alle
 * blobbene holdes til zipen genereres — én gang datamengden. Det er samme tak
 * som restore har, siden restore.apneOgDekrypter laster hele zipen i minnet.
 * Skal det under, må begge sider legges om til et arkivformat som kan skrives
 * og leses sekvensielt.
 */
// Lat lasting, som med Azure-SDK-ene i storage.js: da kan logikktestene
// kjøre uten node_modules, og deploy-steget slipper npm ci.
let JSZipKlasse = null;
function jszip() {
    if (!JSZipKlasse) JSZipKlasse = require('jszip');
    return JSZipKlasse;
}
const { PassThrough } = require('stream');
const { tabellKlient, tabellKlientFra } = require('./storage');
const { containerKlient } = require('./blob');
const backupKrypto = require('./backup-krypto');

// Tabeller vi tar backup av. Utsendinger + Hendelser inkluderes for full
// gjenopprettelse; Hendelser filtreres til siste 90 dager for å begrense
// størrelse.
const TABELLER = [
    'Skjemadefinisjoner',
    'Skjemaer',
    'Rollemedlemskap',
    'Kryptonokler',
    'Utsendinger',
    'Postnumre',
    'CacheMetadata',
    'SystemInnstillinger',
    // Løpenummeret per skjematype. Uten den starter tellerne på 1 etter en
    // gjenoppretting, og nye skjemaer får ID-er som allerede finnes — en feil
    // som oppstår stille i etterkant og oppdages sent.
    'Teller',
    // Brukerskapte rapportdefinisjoner.
    'Rapporttyper',
    // OTP-er og Power BI-tokens (365 dagers levetid). Uten dem slutter alle
    // PB-rapporter å virke til noen utsteder tokens på nytt.
    'Tilgangskontroll',
    { navn: 'Hendelser', maksAlderDager: 90 }
];

// Bevisst utelatt: 'Teammedlemskap' er en cache som bygges opp igjen av
// team-flytene, og er stor. 'HelloTest' er testrester.

/**
 * Tabeller som bor på den delte dev-kontoen, ikke i miljøets eget lager.
 * De finnes derfor bare i én kopi, og ville ikke vært dekket av noen backup.
 *
 * De legges i zipen under `delte-tabeller/`, og står i manifestet under en
 * EGEN nøkkel — bevisst, slik at `restore` ikke rører dem. Lista deles av
 * pilot og prod, og en gjenoppretting av det ene miljøet skal ikke kunne
 * overskrive den andres oppgaveliste. Skal de tilbake, gjøres det manuelt.
 */
const DELTE_TABELLER = ['TodoPunkter', 'Nokkelkalender'];

// Blob-containere vi tar backup av
const BLOB_CONTAINERE = ['vedlegg', 'logoer'];

function tabellNavn(spec) {
    return typeof spec === 'string' ? spec : spec.navn;
}

async function eksporterTabell(spec, log, klient = null) {
    const navn = tabellNavn(spec);
    const maksAlder = spec.maksAlderDager;
    const t = klient || tabellKlient(navn);
    const rader = [];
    try {
        const grenseISO = maksAlder ? new Date(Date.now() - maksAlder * 24 * 3600 * 1000).toISOString() : null;
        for await (const e of t.listEntities()) {
            if (grenseISO && e.Tid && e.Tid < grenseISO) continue;
            // Fjern @odata-metadata og timestamp for renere JSON
            const kopi = {};
            for (const [k, v] of Object.entries(e)) {
                if (k.startsWith('@odata') || k === 'timestamp' || k === 'etag') continue;
                kopi[k] = v;
            }
            rader.push(kopi);
        }
        log(`backup: ${navn} — ${rader.length} rader`);
    } catch (e) {
        if (e.statusCode === 404) log(`backup: ${navn} — tabell finnes ikke (0 rader)`);
        else throw e;
    }
    return rader;
}

async function eksporterContainer(navn, zip, log, fremdrift = () => {}) {
    const c = containerKlient(navn);
    const meta = [];
    let totalBytes = 0;
    try {
        for await (const blob of c.listBlobsFlat()) {
            const b = c.getBlockBlobClient(blob.name);
            const buffer = await b.downloadToBuffer();
            // Vedlegg er stort sett PDF, JPEG og PNG — allerede komprimert.
            // DEFLATE over dem koster CPU uten å spare plass, så de legges inn
            // som de er. JSON-filene komprimeres fortsatt.
            zip.file(`blobs/${navn}/${blob.name}`, buffer, { compression: 'STORE' });
            if (meta.length % 25 === 0) {
                fremdrift(`container ${navn}: ${meta.length} blobs (${Math.round(totalBytes / 1024 / 1024)} MB)`);
            }
            meta.push({
                navn: blob.name,
                storrelse: buffer.length,
                contentType: blob.properties.contentType || null,
                sistEndret: blob.properties.lastModified ? new Date(blob.properties.lastModified).toISOString() : null
            });
            totalBytes += buffer.length;
        }
        zip.file(`blobs/${navn}/_meta.json`, JSON.stringify(meta, null, 2));
        log(`backup: container ${navn} — ${meta.length} blobs (${Math.round(totalBytes / 1024 / 1024 * 10) / 10} MB)`);
    } catch (e) {
        if (e.statusCode === 404) log(`backup: container ${navn} — finnes ikke (0 blobs)`);
        else throw e;
    }
    return { antall: meta.length, bytes: totalBytes };
}

// Blokkstørrelse ved opplasting. Stor nok til at 100+ MB blir få kall, liten
// nok til at minnebruken er en konstant og ikke følger datamengden.
const BLOKK_STORRELSE = 8 * 1024 * 1024;

/**
 * Sink som skriver den krypterte strømmen til en block blob.
 *
 * Auth-taggen ligger i hodet, men er ikke kjent før siste byte er kryptert.
 * Løsningen ligger i block blob-API-et: blokker kan stages i vilkårlig
 * rekkefølge, og det er commitBlockList som bestemmer rekkefølgen i fila.
 * Hodeblokken stages derfor til slutt og commites først. Da slipper vi å
 * endre containerformatet, og gamle backuper leses av samme restore-kode.
 */
function blokkSink(blob, blobHTTPHeaders) {
    // Blokk-ID-er må ha lik lengde og være unike. 0 er reservert til hodet.
    const id = (n) => Buffer.from(`blokk-${String(n).padStart(6, '0')}`).toString('base64');
    const ider = [];
    let nr = 0;
    return {
        async skriv(blokk) {
            const bid = id(++nr);
            await blob.stageBlock(bid, blokk, blokk.length);
            ider.push(bid);
        },
        async avslutt(hode) {
            const hodeId = id(0);
            await blob.stageBlock(hodeId, hode, hode.length);
            await blob.commitBlockList([hodeId, ...ider], { blobHTTPHeaders });
        }
    };
}

/**
 * Sink som samler alt i minnet. Brukes av last-ned-endepunktet, som må ha
 * hele fila som ett svar uansett.
 */
function bufferSink() {
    const deler = [];
    let ferdig = null;
    return {
        async skriv(blokk) { deler.push(blokk); },
        async avslutt(hode) { ferdig = Buffer.concat([hode, ...deler]); },
        hentResultat: () => ferdig
    };
}

/**
 * Les klartekststrømmen, krypter den underveis og skriv den ut i blokker.
 *
 * Minnebruken er én blokk om gangen pluss det strømmen selv holder — den
 * følger ikke datamengden. Blokkene sendes én etter én; parallell staging
 * ville spart tid, men til gjengjeld holdt flere blokker i minnet samtidig,
 * og det er nettopp det vi prøver å unngå.
 */
/**
 * JSZip-strømmen bygger på en eldre stream-implementasjon uten
 * Symbol.asyncIterator, og kan derfor ikke itereres med for await. Vi sender
 * den gjennom en PassThrough, som er en moderne strøm. Mottrykket består:
 * komprimeringen bremses mens en blokk lastes opp.
 */
function somModerneStrom(strom) {
    if (typeof strom?.[Symbol.asyncIterator] === 'function') return strom;
    const gjennom = new PassThrough();
    strom.on('error', (e) => gjennom.destroy(e));
    strom.pipe(gjennom);
    return gjennom;
}

async function skrivKryptertStrom(strom, sink, blokkStorrelse = BLOKK_STORRELSE) {
    const k = backupKrypto.startKryptering();
    let samlet = [];
    let samletBytes = 0;
    let klartekstBytes = 0;
    let kryptertBytes = k.hodeLengde;

    // Blokkene deles på nøyaktig blokkStorrelse, ikke på det strømmen
    // tilfeldigvis leverer. Uten det ville én stor del fra strømmen blitt
    // én stor blokk, og minnetaket fulgt innkommende delstørrelse.
    const tomBuffer = async (tving = false) => {
        if (samletBytes === 0) return;
        let rest = Buffer.concat(samlet, samletBytes);
        samlet = [];
        samletBytes = 0;
        while (rest.length >= blokkStorrelse) {
            const blokk = rest.subarray(0, blokkStorrelse);
            rest = rest.subarray(blokkStorrelse);
            kryptertBytes += blokk.length;
            await sink.skriv(blokk);
        }
        if (rest.length === 0) return;
        if (tving) {
            kryptertBytes += rest.length;
            await sink.skriv(rest);
        } else {
            samlet = [rest];
            samletBytes = rest.length;
        }
    };

    for await (const del of somModerneStrom(strom)) {
        klartekstBytes += del.length;
        const ct = k.oppdater(del);
        if (ct.length) { samlet.push(ct); samletBytes += ct.length; }
        if (samletBytes >= blokkStorrelse) await tomBuffer();
    }

    const { siste, hode } = k.avslutt();
    if (siste.length) { samlet.push(siste); samletBytes += siste.length; }
    await tomBuffer(true);
    await sink.avslutt(hode);

    return { klartekstBytes, kryptertBytes };
}

/**
 * Bygg zip-innholdet. Returnerer JSZip-objektet uten å generere fila.
 *
 * Her ligger den gjenstående minnebruken: JSZip holder innholdet i alle
 * blobbene til zipen genereres. Det er én gang datamengden, og samme tak som
 * restore har — `restore.apneOgDekrypter` laster hele zipen i minnet uansett.
 * Skal det under, må både backup og restore legges om til et arkivformat som
 * kan skrives og leses sekvensielt.
 */
async function byggZip(log, fremdrift) {
    const zip = new (jszip())();
    const tider = {};

    const manifest = {
        versjon: 1,
        tid: new Date().toISOString(),
        miljø: process.env.MILJO || 'ukjent',
        tabeller: [],
        delteTabeller: [],
        containers: []
    };

    const tabellStart = Date.now();
    for (const spec of TABELLER) {
        const navn = tabellNavn(spec);
        fremdrift(`leser tabell ${navn}`);
        const rader = await eksporterTabell(spec, log);
        zip.file(`tabeller/${navn}.json`, JSON.stringify(rader, null, 2));
        manifest.tabeller.push({ navn, antall: rader.length, maksAlderDager: spec.maksAlderDager || null });
    }
    tider.tabellerSek = Math.round((Date.now() - tabellStart) / 1000);

    // Delte tabeller: egen connection string, egen manifestnøkkel. Feiler
    // oppslaget — typisk en SAS som ikke dekker Table — skal ikke hele
    // backupen ryke for det. Miljøets egne data er viktigere.
    const deltCs = process.env.TODO_STORAGE_CONNECTION_STRING || '';
    if (deltCs) {
        for (const navn of DELTE_TABELLER) {
            fremdrift(`leser delt tabell ${navn}`);
            try {
                const klient = tabellKlientFra(deltCs, navn, 'TODO_STORAGE_CONNECTION_STRING');
                const rader = await eksporterTabell(navn, log, klient);
                zip.file(`delte-tabeller/${navn}.json`, JSON.stringify(rader, null, 2));
                manifest.delteTabeller.push({ navn, antall: rader.length });
            } catch (e) {
                log(`backup: delt tabell ${navn} feilet — ${e.message}`);
                manifest.delteTabeller.push({ navn, antall: null, feil: String(e.message).slice(0, 200) });
            }
        }
    } else {
        log('backup: TODO_STORAGE_CONNECTION_STRING ikke satt — delte tabeller hoppes over');
    }

    const blobStart = Date.now();
    for (const navn of BLOB_CONTAINERE) {
        fremdrift(`leser container ${navn}`);
        const res = await eksporterContainer(navn, zip, log, fremdrift);
        manifest.containers.push({ navn, ...res });
    }
    tider.blobberSek = Math.round((Date.now() - blobStart) / 1000);

    zip.file('manifest.json', JSON.stringify(manifest, null, 2));
    return { zip, manifest, tider };
}

/**
 * Bygg, krypter og skriv en komplett backup til en sink.
 *
 * Zipen genereres som strøm og krypteres underveis, så verken den ferdige
 * zipen, ciphertexten eller containeren finnes som egen kopi i minnet.
 */
async function byggOgKrypter(sink, log = () => {}, fremdrift = () => {}) {
    const start = Date.now();
    const { zip, manifest, tider } = await byggZip(log, fremdrift);

    fremdrift('komprimerer og krypterer');
    log('backup: genererer zip…');
    const zipStart = Date.now();

    let sistMeldt = 0;
    const strom = zip.generateNodeStream(
        { type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } },
        (status) => {
            // Meldes hvert tiende prosentpoeng — statusraden skrives til Table
            // Storage, og det er ingen grunn til å gjøre det hundre ganger.
            const p = Math.floor(status.percent / 10) * 10;
            if (p > sistMeldt) { sistMeldt = p; fremdrift(`komprimerer og krypterer (${p} %)`); }
        }
    );

    const { klartekstBytes, kryptertBytes } = await skrivKryptertStrom(strom, sink);
    tider.zipSek = Math.round((Date.now() - zipStart) / 1000);

    const varighetSek = Math.round((Date.now() - start) / 1000);
    const mb = (b) => Math.round(b / 1024 / 1024 * 10) / 10;
    log(`backup: ferdig — ${mb(klartekstBytes)} MB zip → ${mb(kryptertBytes)} MB kryptert `
        + `(${varighetSek}s: tabeller ${tider.tabellerSek}s, blobs ${tider.blobberSek}s, `
        + `komprimering+kryptering ${tider.zipSek}s)`);

    return {
        manifest,
        storrelseKlar: klartekstBytes,
        storrelseKryptert: kryptertBytes,
        varighetSekunder: varighetSek,
        tider
    };
}

/** Bygg backup direkte til en block blob. Minnebruken følger ikke filstørrelsen. */
async function byggOgKrypterTilBlob(blob, blobHTTPHeaders, log, fremdrift) {
    return byggOgKrypter(blokkSink(blob, blobHTTPHeaders), log, fremdrift);
}

// Power Automates HTTP-handling leser hele responsen inn i minnet, med et
// tak på 100 MiB (104857600). Backupen passerte det i prod 25.08.2026, og
// flyten døde med «Cannot write more bytes to the buffer». Fila i Azure er
// hel — det er kopieringen til OneDrive som må gjøres i biter.
//
// 64 MiB gir god margin til taket, og holder seg under OneDrive-koblingens
// egen grense for én fil.
const DEL_MAKS_BYTES = Math.max(1, Number(process.env.BACKUP_DEL_MAKS_MB) || 64) * 1024 * 1024;

/**
 * Del en backupfil i biter som hver kan hentes med én Range-forespørsel.
 *
 * Én del betyr én fil med uendret navn — små backuper oppfører seg som før.
 * Flere deler får selvforklarende navn (…fsbk.001av003), slik at det går an
 * å se i OneDrive om noe mangler. Delene settes sammen igjen med
 * `copy /b del1+del2 hel.fsbk` (Windows) eller `cat del* > hel.fsbk`.
 */
function byggDeler(filnavn, storrelseBytes, maks = DEL_MAKS_BYTES) {
    const total = Math.max(0, Number(storrelseBytes) || 0);
    // En tom fil er fortsatt én del — flyten skal ikke stå uten noe å hente.
    const antall = total === 0 ? 1 : Math.ceil(total / maks);
    const pad = (n) => String(n).padStart(3, "0");
    const deler = [];
    for (let nr = 1; nr <= antall; nr++) {
        const fra = (nr - 1) * maks;
        const til = Math.min(total, nr * maks) - 1;
        deler.push({
            nr,
            av: antall,
            filnavn: antall === 1 ? filnavn : `${filnavn}.${pad(nr)}av${pad(antall)}`,
            fra,
            til: Math.max(fra, til),
            bytes: Math.max(0, til - fra + 1),
            // Ferdig Range-header, så flyten slipper å regne selv.
            range: `bytes=${fra}-${Math.max(fra, til)}`
        });
    }
    return deler;
}

// Signaturen en zip-fil starter med. Et billig tillegg til tagg-sjekken:
// den sier at det faktisk er en zip vi har dekryptert, ikke bare noe som
// autentiserte riktig.
const ZIP_SIGNATUR = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/**
 * Verifiser en kryptert backup uten å gjenopprette noe.
 *
 * Leser fila i biter, dekrypterer den strømmende og kaster klarteksten
 * fortløpende. AES-GCM autentiserer hver eneste byte, så en vellykket
 * `avslutt()` er et bevis på at fila er komplett og uendret — og at
 * passphrasen er den rette. Minnebruken er én bit om gangen.
 *
 * @param {(fra:number, antall:number)=>Promise<Buffer>} lesBit
 * @param {number} total  Filas størrelse i bytes
 */
async function verifiserKryptertStrom({ lesBit, total }, passphrase, bitStorrelse = 8 * 1024 * 1024) {
    const hodeLengde = backupKrypto.HODE_LENGDE;
    if (!Number.isFinite(total) || total <= hodeLengde) {
        throw new Error(`Fila er ${total} bytes — for kort til å være en backup`);
    }
    const d = backupKrypto.startDekrypteringMed(passphrase, await lesBit(0, hodeLengde));

    let lest = hodeLengde;
    let klartekstBytes = 0;
    let forste = null;
    while (lest < total) {
        const antall = Math.min(bitStorrelse, total - lest);
        const ut = d.oppdater(await lesBit(lest, antall));
        if (forste === null && ut.length >= 4) forste = Buffer.from(ut.subarray(0, 4));
        klartekstBytes += ut.length;
        lest += antall;
    }
    // Kaster hvis taggen ikke stemmer — altså hvis én eneste byte mangler,
    // er endret eller kom i feil rekkefølge.
    const siste = d.avslutt();
    if (forste === null && siste.length >= 4) forste = Buffer.from(siste.subarray(0, 4));
    klartekstBytes += siste.length;

    return {
        kryptertBytes: total,
        klartekstBytes,
        zipSignatur: !!forste && forste.equals(ZIP_SIGNATUR)
    };
}

/** Bygg backup til en Buffer — for last-ned-endepunktet, som må svare med hele fila. */
async function byggOgKrypterTilBuffer(log, fremdrift) {
    const sink = bufferSink();
    const res = await byggOgKrypter(sink, log, fremdrift);
    return { ...res, buffer: sink.hentResultat() };
}

module.exports = {
    byggOgKrypterTilBlob, byggOgKrypterTilBuffer,
    byggZip, skrivKryptertStrom, blokkSink, bufferSink, byggDeler,
    verifiserKryptertStrom,
    TABELLER, DELTE_TABELLER, BLOB_CONTAINERE, BLOKK_STORRELSE, DEL_MAKS_BYTES
};
