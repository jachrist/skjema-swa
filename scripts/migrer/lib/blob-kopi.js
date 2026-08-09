/**
 * Blob-kopiering mellom to storage-konti.
 *
 * Bruker server-side copy via startCopyFromURL når kilde er offentlig eller
 * støtter SAS. Alternativt: download + upload (fallback, tyngre).
 *
 * For pilot-migrering bruker vi download+upload — enkleste vei uten å måtte
 * generere SAS-URL for hver blob. Ytelse er akseptabel for typiske
 * skjema-vedlegg (få MB per fil).
 */
const { BlobServiceClient } = require('@azure/storage-blob');

async function sikrContainer(client) {
    try { await client.createIfNotExists(); } catch (_) { /* ok */ }
}

/**
 * Kopier alle blobs i en container fra kilde til mål.
 * @returns {Promise<{lest, kopiert, hoppetOver, feil}>}
 */
async function kopierContainer({ containerNavn, kildeConn, malConn, dryRun, log }) {
    log(`\n=== Blob-container "${containerNavn}" ===`);

    const kilde = BlobServiceClient.fromConnectionString(kildeConn).getContainerClient(containerNavn);
    const mal = BlobServiceClient.fromConnectionString(malConn).getContainerClient(containerNavn);

    // Sjekk om kilde eksisterer
    const kildeFinnes = await kilde.exists();
    if (!kildeFinnes) {
        log(`  Kilde-container finnes ikke — hoppes over`);
        return { lest: 0, kopiert: 0, hoppetOver: 1, feil: 0 };
    }

    if (!dryRun) await sikrContainer(mal);

    let lest = 0;
    let kopiert = 0;
    let feil = 0;
    let totalBytes = 0;

    for await (const blob of kilde.listBlobsFlat({ includeMetadata: true })) {
        lest++;
        if (lest % 50 === 0) log(`  ...prosessert ${lest} blobs (${(totalBytes / 1024 / 1024).toFixed(1)} MB)`);

        if (dryRun) continue;

        try {
            const kildeBlob = kilde.getBlobClient(blob.name);
            const malBlob = mal.getBlockBlobClient(blob.name);
            const eks = await malBlob.exists();

            // Skip hvis eksisterer og har samme størrelse (rask idempotens-sjekk)
            if (eks) {
                const malProps = await malBlob.getProperties();
                if (malProps.contentLength === blob.properties.contentLength) {
                    // Antatt uendret — kunne sjekket etag men det er som regel unødvendig
                    kopiert++;
                    continue;
                }
            }

            // Download + upload
            const buffer = await kildeBlob.downloadToBuffer();
            await malBlob.upload(buffer, buffer.length, {
                blobHTTPHeaders: {
                    blobContentType: blob.properties.contentType || 'application/octet-stream',
                    blobContentDisposition: blob.properties.contentDisposition || undefined
                },
                metadata: blob.metadata || {}
            });
            kopiert++;
            totalBytes += buffer.length;
        } catch (e) {
            log(`  FEIL blob "${blob.name}": ${e.message}`);
            feil++;
        }
    }

    log(`  Ferdig: ${lest} lest, ${kopiert} kopiert, ${feil} feil (${(totalBytes / 1024 / 1024).toFixed(1)} MB overført)`);
    return { lest, kopiert, hoppetOver: 0, feil };
}

module.exports = { kopierContainer };
