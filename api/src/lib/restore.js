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
// Lat lasting, som med Azure-SDK-ene i storage.js: da kan logikktestene
// kjøre uten node_modules, og deploy-steget slipper npm ci.
let JSZipKlasse = null;
function jszip() {
    if (!JSZipKlasse) JSZipKlasse = require('jszip');
    return JSZipKlasse;
}
// Via modulobjektet, ikke destrukturert — se samme begrunnelse i backup.js.
const storage = require('./storage');
const blobLager = require('./blob');
const { dekrypterBufferMed } = require('./backup-krypto');

/**
 * Åpne + dekrypter en backup-fil. Returnerer { manifest, zip } uten å skrive noe.
 * Kan brukes til å vise en preview før faktisk restore.
 */
async function apneOgDekrypter(kryptertBuffer, passphrase) {
    const klartekst = dekrypterBufferMed(passphrase, kryptertBuffer);
    const zip = await jszip().loadAsync(klartekst);
    const manifestFil = zip.file('manifest.json');
    if (!manifestFil) throw new Error('manifest.json mangler i zip — ikke en gyldig backup');
    const manifest = JSON.parse(await manifestFil.async('string'));
    return { manifest, zip };
}

async function wipeTabell(navn, log) {
    const t = storage.tabellKlient(navn);
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
    const t = await storage.sikreTabell(navn);
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
    const c = blobLager.containerKlient(navn);
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
    const c = blobLager.containerKlient(navn);
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
 * Kjør restore fra en allerede-åpnet backup.
 *
 * To modus, styrt av manifestet:
 *
 *   full  — som før: hver tabell og container i manifestet tømmes før den
 *           skrives på nytt.
 *   delta — containerne tømmes IKKE. En deltafil inneholder bare blobbene som
 *           kom til siden forrige fulle backup; tømmer vi først, sletter vi
 *           alt det deltaet ikke inneholder. Det er den farligste enkeltfellen
 *           i hele opplegget, og derfor leses modus fra manifestet, ikke fra
 *           et valg noen må huske å sette.
 *
 * Tabellene eksporteres i sin helhet også i et delta, så der er tøm-og-skriv
 * riktig i begge modus. Tabeller som ikke er med i manifestet (f.eks.
 * Postnumre i et delta) røres ikke — løkka går bare over det manifestet har.
 *
 * @returns { modus, tabeller: [{navn, slettet, skrevet}], containere: [...] }
 */
async function kjorRestore({ manifest, zip }, log = () => {}) {
    const start = Date.now();
    const modus = manifest.modus === 'delta' ? 'delta' : 'full';
    const resultat = { modus, tabeller: [], containere: [] };

    if (modus === 'delta') {
        log(`restore: DELTA basert på ${manifest.basertPa || 'ukjent full backup'} — `
            + `containere fylles på, ingenting slettes. Gjenopprett den fulle først.`);
    }

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
        const slettet = modus === 'delta' ? 0 : await wipeContainer(c.navn, log);
        const skrevet = await importerContainer(c.navn, zip, meta, log);
        resultat.containere.push({ navn: c.navn, slettet, skrevet });
    }

    resultat.varighetSekunder = Math.round((Date.now() - start) / 1000);
    return resultat;
}

module.exports = { apneOgDekrypter, kjorRestore };
