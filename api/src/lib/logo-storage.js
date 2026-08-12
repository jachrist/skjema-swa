/**
 * Logo-storage — flat blob-container med bilder som brukes i skjema-headere.
 *
 * Container: `logoer`.
 * Blob-navn = filnavn (bruker sørger for unikhet).
 * Content-Type settes ved opplasting basert på filending.
 *
 * URL for visning: /api/logo/{filnavn} (serveres bytes direkte, ingen auth).
 */
const { containerKlient } = require('./blob');

const CONTAINER = 'logoer';
const MIME_PER_EXT = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    ico: 'image/x-icon'
};
const TILLATTE_EXT = Object.keys(MIME_PER_EXT);

async function container() {
    const c = containerKlient(CONTAINER);
    try { await c.createIfNotExists({ access: 'blob' }); } catch (_) { /* fins */ }
    return c;
}

function mimeFor(filnavn) {
    const ext = String(filnavn || '').split('.').pop().toLowerCase();
    return MIME_PER_EXT[ext] || 'application/octet-stream';
}

function erGyldigFiltype(filnavn) {
    const ext = String(filnavn || '').split('.').pop().toLowerCase();
    return TILLATTE_EXT.includes(ext);
}

async function listAlle() {
    const c = await container();
    const ut = [];
    for await (const blob of c.listBlobsFlat()) {
        ut.push({
            navn: blob.name,
            storrelse: blob.properties.contentLength,
            contentType: blob.properties.contentType,
            sistEndret: blob.properties.lastModified ? new Date(blob.properties.lastModified).toISOString() : null
        });
    }
    return ut.sort((a, b) => a.navn.localeCompare(b.navn, 'nb'));
}

async function opplast(filnavn, buffer) {
    if (!erGyldigFiltype(filnavn)) throw new Error(`Ugyldig filtype (tillatte: ${TILLATTE_EXT.join(', ')})`);
    const c = await container();
    const blob = c.getBlockBlobClient(filnavn);
    await blob.uploadData(buffer, {
        blobHTTPHeaders: {
            blobContentType: mimeFor(filnavn),
            blobCacheControl: 'public, max-age=31536000'
        }
    });
    return { navn: filnavn, storrelse: buffer.length, contentType: mimeFor(filnavn) };
}

async function slett(filnavn) {
    const c = await container();
    const blob = c.getBlockBlobClient(filnavn);
    const res = await blob.deleteIfExists();
    return res.succeeded;
}

async function hent(filnavn) {
    const c = await container();
    const blob = c.getBlockBlobClient(filnavn);
    try {
        const props = await blob.getProperties();
        const buffer = await blob.downloadToBuffer();
        return { buffer, contentType: props.contentType || mimeFor(filnavn) };
    } catch (e) {
        if (e.statusCode === 404) return null;
        throw e;
    }
}

module.exports = { listAlle, opplast, slett, hent, erGyldigFiltype, TILLATTE_EXT, mimeFor };
