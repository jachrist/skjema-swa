/**
 * Backup — bygg zip-eksport av alle tabeller + blob-containers.
 *
 * Struktur i zip:
 *   manifest.json                                — { versjon, tid, tabeller[], containers[] }
 *   tabeller/{TabellNavn}.json                   — array av entities
 *   blobs/{container}/{filnavn}                  — binær-innhold
 *   blobs/{container}/_meta.json                 — liste over filnavn + storrelse + contentType
 *
 * Ytelse: alt in-memory. Fint for pilot (< 200 MB). For større deploy må
 * det skrives streaming til midlertidig blob i stedet.
 */
const JSZip = require('jszip');
const { tabellKlient } = require('./storage');
const { containerKlient } = require('./blob');

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
    { navn: 'Hendelser', maksAlderDager: 90 }
];

// Blob-containere vi tar backup av
const BLOB_CONTAINERE = ['vedlegg', 'logoer'];

function tabellNavn(spec) {
    return typeof spec === 'string' ? spec : spec.navn;
}

async function eksporterTabell(spec, log) {
    const navn = tabellNavn(spec);
    const maksAlder = spec.maksAlderDager;
    const t = tabellKlient(navn);
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

async function eksporterContainer(navn, zip, log) {
    const c = containerKlient(navn);
    const meta = [];
    let totalBytes = 0;
    try {
        for await (const blob of c.listBlobsFlat()) {
            const b = c.getBlockBlobClient(blob.name);
            const buffer = await b.downloadToBuffer();
            zip.file(`blobs/${navn}/${blob.name}`, buffer);
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

/**
 * Bygg komplett backup-zip. Returnerer Buffer med zip-innhold.
 *
 * @param {(msg: string) => void} log
 * @returns {Promise<{ buffer: Buffer, manifest: object }>}
 */
async function byggBackup(log = () => {}) {
    const start = Date.now();
    const zip = new JSZip();

    const manifest = {
        versjon: 1,
        tid: new Date().toISOString(),
        miljø: process.env.MILJO || 'ukjent',
        tabeller: [],
        containers: []
    };

    // Tabeller
    for (const spec of TABELLER) {
        const navn = tabellNavn(spec);
        const rader = await eksporterTabell(spec, log);
        zip.file(`tabeller/${navn}.json`, JSON.stringify(rader, null, 2));
        manifest.tabeller.push({ navn, antall: rader.length, maksAlderDager: spec.maksAlderDager || null });
    }

    // Blob-containere
    for (const navn of BLOB_CONTAINERE) {
        const res = await eksporterContainer(navn, zip, log);
        manifest.containers.push({ navn, ...res });
    }

    zip.file('manifest.json', JSON.stringify(manifest, null, 2));

    log(`backup: genererer zip…`);
    const buffer = await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 }
    });
    const varighetSek = Math.round((Date.now() - start) / 1000);
    log(`backup: zip ferdig — ${Math.round(buffer.length / 1024 / 1024 * 10) / 10} MB (${varighetSek}s)`);
    return { buffer, manifest, varighetSekunder: varighetSek };
}

module.exports = { byggBackup, TABELLER, BLOB_CONTAINERE };
