/**
 * Vedlegg-lagring i Blob Storage.
 *
 * Container: 'vedlegg'
 * Blob-navn: '<skjematypeId>/<skjemaId>/<filnavn>'
 *
 * Metadata på hver blob: originalt filnavn (før sanering), content-type,
 * opplaster-upn, upload-tid.
 *
 * Filnavn saneres for '/', '\', '..' og andre suspekte tegn før lagring.
 */
const { containerKlient } = require('./blob');

const CONTAINER = 'vedlegg';

function saneretFilnavn(navn) {
    const s = String(navn || '').trim();
    if (!s) throw new Error('Filnavn mangler');
    // Fjern path-separators og null-bytes; behold Unicode-navn (æøå osv.)
    const rensa = s.replace(/[/\\\x00]/g, '_').replace(/\.\./g, '_');
    if (rensa.length > 200) return rensa.slice(0, 200);
    return rensa;
}

function blobNavn(skjematypeId, skjemaId, filnavn) {
    return `${String(skjematypeId)}/${String(skjemaId)}/${saneretFilnavn(filnavn)}`;
}

async function opplastVedlegg({ skjematypeId, skjemaId, filnavn, contentType, buffer, opplasterUpn }) {
    const container = containerKlient(CONTAINER);
    await container.createIfNotExists();

    const navn = blobNavn(skjematypeId, skjemaId, filnavn);
    const blob = container.getBlockBlobClient(navn);
    await blob.upload(buffer, buffer.length, {
        blobHTTPHeaders: {
            blobContentType: contentType || 'application/octet-stream',
            blobContentDisposition: `attachment; filename="${saneretFilnavn(filnavn)}"`
        },
        metadata: {
            originalfilnavn: encodeURIComponent(filnavn),
            opplaster: encodeURIComponent(opplasterUpn || ''),
            upload_tid: new Date().toISOString()
        }
    });
    return { filnavn: saneretFilnavn(filnavn), storrelse: buffer.length };
}

async function listVedlegg(skjematypeId, skjemaId) {
    const container = containerKlient(CONTAINER);
    try { await container.createIfNotExists(); } catch (_) { /* ignorer */ }

    const prefix = `${String(skjematypeId)}/${String(skjemaId)}/`;
    const filer = [];
    for await (const blob of container.listBlobsFlat({ prefix, includeMetadata: true })) {
        const kortNavn = blob.name.substring(prefix.length);
        filer.push({
            filnavn: kortNavn,
            storrelse: blob.properties.contentLength || 0,
            content_type: blob.properties.contentType || 'application/octet-stream',
            sist_endret: blob.properties.lastModified?.toISOString?.() || null
        });
    }
    filer.sort((a, b) => a.filnavn.localeCompare(b.filnavn, 'nb'));
    return filer;
}

async function hentVedleggStream(skjematypeId, skjemaId, filnavn) {
    const container = containerKlient(CONTAINER);
    const navn = blobNavn(skjematypeId, skjemaId, filnavn);
    const blob = container.getBlobClient(navn);
    const eksisterer = await blob.exists();
    if (!eksisterer) return null;
    const props = await blob.getProperties();
    const buffer = await blob.downloadToBuffer();
    return {
        buffer,
        contentType: props.contentType || 'application/octet-stream',
        storrelse: buffer.length,
        filnavn: saneretFilnavn(filnavn)
    };
}

async function slettVedlegg(skjematypeId, skjemaId, filnavn) {
    const container = containerKlient(CONTAINER);
    const navn = blobNavn(skjematypeId, skjemaId, filnavn);
    const blob = container.getBlobClient(navn);
    const res = await blob.deleteIfExists();
    return res.succeeded === true;
}

async function slettAlleVedleggForSkjema(skjematypeId, skjemaId) {
    const container = containerKlient(CONTAINER);
    const prefix = `${String(skjematypeId)}/${String(skjemaId)}/`;
    let antall = 0;
    for await (const blob of container.listBlobsFlat({ prefix })) {
        try {
            await container.getBlobClient(blob.name).deleteIfExists();
            antall++;
        } catch (_) { /* ignorer enkelt-feil */ }
    }
    return antall;
}

module.exports = {
    opplastVedlegg,
    listVedlegg,
    hentVedleggStream,
    slettVedlegg,
    slettAlleVedleggForSkjema,
    saneretFilnavn
};
