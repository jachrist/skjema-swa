/**
 * Restore — dekrypter og importer en .fsbk-backup.
 *
 * Prosess (destruktiv med erstattAlt=true):
 *   1. Verifiser magic/versjon + dekrypter
 *   2. Åpne zip, les manifest
 *   3. For hver tabell i manifest: wipe eksisterende rader, upsert alle fra backup
 *   4. For hver container i manifest: slett alle eksisterende blobs, upload alle fra backup
 *
 * Idempotens: samme backup kan restaureres flere ganger og gir samme
 * resultat. Delvis feil (f.eks. 3 av 5 tabeller fullført) etterlater
 * systemet i inkonsistent tilstand — restore MÅ kjøres på nytt.
 */
const JSZip = require('jszip');
const { tabellKlient, sikreTabell } = require('./storage');
const { containerKlient } = require('./blob');
const { dekrypterBufferMed } = require('./backup-krypto');

/**
 * Åpne + dekrypter en backup-fil. Returnerer { manifest, zip } uten å skrive noe.
 * Kan brukes til å vise en preview før faktisk restore.
 */
async function apneOgDekrypter(kryptertBuffer, passphrase) {
    const klartekst = dekrypterBufferMed(passphrase, kryptertBuffer);
    const zip = await JSZip.loadAsync(klartekst);
    const manifestFil = zip.file('manifest.json');
    if (!manifestFil) throw new Error('manifest.json mangler i zip — ikke en gyldig backup');
    const manifest = JSON.parse(await manifestFil.async('string'));
    return { manifest, zip };
}

async function wipeTabell(navn, log) {
    const t = tabellKlient(navn);
    let slettet = 0;
    try {
        for await (const e of t.listEntities({ queryOptions: { select: ['PartitionKey', 'RowKey'] } })) {
            try { await t.deleteEntity(e.partitionKey, e.rowKey); slettet++; }
            catch (err) { if (err.statusCode !== 404) throw err; }
        }
    } catch (e) {
        if (e.statusCode === 404) log(`restore: ${navn} fantes ikke, hopper over wipe`);
        else throw e;
    }
    if (slettet > 0) log(`restore: ${navn} — slettet ${slettet} eksisterende rader`);
    return slettet;
}

async function importerTabell(navn, rader, log) {
    if (rader.length === 0) return 0;
    const t = await sikreTabell(navn);
    let skrevet = 0;
    for (const r of rader) {
        if (!r.partitionKey && !r.PartitionKey) continue;
        // Backend-parser bruker små bokstaver ved lesing men Table Storage returnerer
        // partitionKey/rowKey — sørg for at begge er tilgjengelige.
        const entity = {
            ...r,
            partitionKey: r.partitionKey || r.PartitionKey,
            rowKey: r.rowKey || r.RowKey
        };
        await t.upsertEntity(entity, 'Replace');
        skrevet++;
    }
    log(`restore: ${navn} — skrev ${skrevet} rader`);
    return skrevet;
}

async function wipeContainer(navn, log) {
    const c = containerKlient(navn);
    let slettet = 0;
    try {
        for await (const blob of c.listBlobsFlat()) {
            await c.getBlockBlobClient(blob.name).deleteIfExists();
            slettet++;
        }
    } catch (e) {
        if (e.statusCode === 404) log(`restore: container ${navn} fantes ikke, hopper over wipe`);
        else throw e;
    }
    if (slettet > 0) log(`restore: container ${navn} — slettet ${slettet} blobs`);
    return slettet;
}

async function importerContainer(navn, zip, meta, log) {
    const c = containerKlient(navn);
    try { await c.createIfNotExists(); } catch (e) { if (e.statusCode !== 409) throw e; }
    let skrevet = 0;
    const prefiks = `blobs/${navn}/`;
    for (const m of meta) {
        const fil = zip.file(prefiks + m.navn);
        if (!fil) { log(`restore: mangler blob ${prefiks + m.navn} — hoppet over`); continue; }
        const buf = await fil.async('nodebuffer');
        await c.getBlockBlobClient(m.navn).uploadData(buf, {
            blobHTTPHeaders: { blobContentType: m.contentType || 'application/octet-stream' }
        });
        skrevet++;
    }
    log(`restore: container ${navn} — skrev ${skrevet} blobs`);
    return skrevet;
}

/**
 * Kjør full restore fra en allerede-åpnet backup.
 * @returns { tabeller: [{navn, slettet, skrevet}], containere: [{navn, slettet, skrevet}] }
 */
async function kjorRestore({ manifest, zip }, log = () => {}) {
    const start = Date.now();
    const resultat = { tabeller: [], containere: [] };

    for (const t of (manifest.tabeller || [])) {
        const fil = zip.file(`tabeller/${t.navn}.json`);
        if (!fil) { log(`restore: tabell/${t.navn}.json mangler — hoppet over`); continue; }
        const rader = JSON.parse(await fil.async('string'));
        const slettet = await wipeTabell(t.navn, log);
        const skrevet = await importerTabell(t.navn, rader, log);
        resultat.tabeller.push({ navn: t.navn, slettet, skrevet });
    }

    for (const c of (manifest.containers || [])) {
        const metaFil = zip.file(`blobs/${c.navn}/_meta.json`);
        const meta = metaFil ? JSON.parse(await metaFil.async('string')) : [];
        const slettet = await wipeContainer(c.navn, log);
        const skrevet = await importerContainer(c.navn, zip, meta, log);
        resultat.containere.push({ navn: c.navn, slettet, skrevet });
    }

    resultat.varighetSekunder = Math.round((Date.now() - start) / 1000);
    return resultat;
}

module.exports = { apneOgDekrypter, kjorRestore };
