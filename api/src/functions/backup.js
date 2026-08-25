/**
 * Backup-endepunkter.
 *
 *   POST /api/backup/kjor
 *     Auth: x-scheduler-key eller admin.
 *     Bygger komplett backup (tabeller + blobs), AES-krypterer, lagrer i
 *     midlertidig blob-container 'backups', kaller BACKUP_FLOW_URL (PA-flyt)
 *     med { url, filnavn, sti } så PA laster opp til OneDrive.
 *
 *   POST /api/backup/last-ned
 *     Auth: admin. Bygger backup og returnerer AES-kryptert zip inline
 *     (Content-Type: application/octet-stream). For ad-hoc lokal lagring.
 *
 *   GET  /api/backup/liste
 *     Auth: admin. Historikk fra 'backups'-blob-container med SAS-URL per fil.
 */
const { app } = require('@azure/functions');
const crypto = require('crypto');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');
const backup = require('../lib/backup');
const backupKrypto = require('../lib/backup-krypto');
const restore = require('../lib/restore');
const innstillinger = require('../lib/innstillinger-storage');
const hendelser = require('../lib/hendelser-storage');
const { containerKlient, serviceKlient } = require('../lib/blob');
const { tabellKlient } = require('../lib/storage');
const { BlobSASPermissions, generateBlobSASQueryParameters, StorageSharedKeyCredential } = require('@azure/storage-blob');

const BACKUP_CONTAINER = 'backups';
const SAS_GYLDIG_TIMER = 24; // PA-flyt bruker denne til å hente og laste opp

// Statusrad i CacheMetadata, samme mønster som refresh-fs bruker.
const STATUS_PK = 'Meta';
const STATUS_RK = 'Backup';

// Taket på hvor lenge vi venter på PA-flyten. En HTTP-trigget flyt svarer
// normalt 202 med én gang; svarer den ikke, har den en Response-handling til
// slutt og holder forbindelsen åpen gjennom hele OneDrive-opplastingen.
const FLYT_TIMEOUT_MS = 4 * 60 * 1000;

async function settStatus(felter) {
    try {
        const t = tabellKlient('CacheMetadata');
        await t.upsertEntity({ partitionKey: STATUS_PK, rowKey: STATUS_RK, ...felter }, 'Merge');
    } catch (_) { /* statusraden er ikke kritisk for selve backupen */ }
}

function admin(request) {
    const upn = hentInnloggetUpn(request);
    if (!upn) return { ok: false, status: 401, melding: 'Ikke innlogget' };
    if (!erAdmin(upn)) return { ok: false, status: 403, melding: 'Krever admin' };
    return { ok: true, upn };
}

function schedulerEllerAdmin(request) {
    const konfigurert = String(process.env.SCHEDULER_KEY || '').trim();
    const gitt = request.headers.get('x-scheduler-key');
    if (konfigurert && gitt === konfigurert) return { ok: true, upn: 'scheduler' };
    return admin(request);
}

async function backupContainer() {
    const c = containerKlient(BACKUP_CONTAINER);
    try { await c.createIfNotExists(); } catch (e) { if (e.statusCode !== 409) throw e; }
    return c;
}

/**
 * Parse Storage-connection-string for å hente konto-navn og delt nøkkel,
 * som trengs for å generere SAS. SWA Managed Functions kan bruke MI, men
 * bytter til connection-string-parsing for enkelhet.
 */
function hentKontoOgNokkel() {
    const cs = process.env.STORAGE_CONNECTION_STRING || '';
    const kv = {};
    for (const del of cs.split(';')) {
        const idx = del.indexOf('=');
        if (idx < 0) continue;
        kv[del.substring(0, idx).trim()] = del.substring(idx + 1).trim();
    }
    const konto = kv.AccountName;
    const key = kv.AccountKey;
    if (!konto || !key) throw new Error('STORAGE_CONNECTION_STRING mangler AccountName eller AccountKey');
    return { konto, key };
}

function lagSasUrl(blobNavn) {
    const { konto, key } = hentKontoOgNokkel();
    const cred = new StorageSharedKeyCredential(konto, key);
    const sas = generateBlobSASQueryParameters({
        containerName: BACKUP_CONTAINER,
        blobName: blobNavn,
        permissions: BlobSASPermissions.parse('r'),
        startsOn: new Date(Date.now() - 5 * 60 * 1000),
        expiresOn: new Date(Date.now() + SAS_GYLDIG_TIMER * 3600 * 1000),
        protocol: 'https'
    }, cred).toString();
    return `https://${konto}.blob.core.windows.net/${BACKUP_CONTAINER}/${encodeURIComponent(blobNavn)}?${sas}`;
}

async function byggOgLagre(aktor, jobbLog, fremdrift = () => {}) {
    // 1. Bygg zip
    const { buffer, manifest, varighetSekunder, tider } = await backup.byggBackup(jobbLog, fremdrift);
    // 2. AES-krypter
    fremdrift('krypterer');
    const kryptert = backupKrypto.krypterBuffer(buffer);
    jobbLog(`backup: kryptert (klartekst ${buffer.length} → container ${kryptert.length} bytes)`);
    // 3. Lagre i midlertidig blob
    fremdrift('laster opp til blob-storage');
    const stempel = new Date().toISOString().replace(/[:.]/g, '-');
    const miljø = (process.env.MILJO || 'ukjent').replace(/[^a-z0-9]/gi, '');
    const filnavn = `${miljø}-backup-${stempel}.fsbk`;
    const c = await backupContainer();
    const blob = c.getBlockBlobClient(filnavn);
    await blob.uploadData(kryptert, {
        blobHTTPHeaders: { blobContentType: 'application/octet-stream' },
        metadata: {
            miljo: process.env.MILJO || 'ukjent',
            opprettet: new Date().toISOString(),
            opprettet_av: aktor,
            klartekst_bytes: String(buffer.length),
            varighet_sek: String(varighetSekunder)
        }
    });
    return { filnavn, storrelseKryptert: kryptert.length, storrelseKlar: buffer.length, manifest, varighetSekunder, tider };
}

/**
 * Ber PA-flyten hente backupen fra SAS-URL-en og legge den i OneDrive.
 * Returnerer { flytStatus, flytMelding } — kaster aldri.
 */
async function kallBackupFlyt(res, sasUrl, sti, jobbLog) {
    const flytUrl = String(process.env.BACKUP_FLOW_URL || '').trim();
    if (!flytUrl) {
        const melding = 'BACKUP_FLOW_URL ikke satt — backup ligger i blob-storage men er ikke opplastet til OneDrive';
        jobbLog(`backup/kjor: ${melding}`);
        return { flytStatus: 'hoppet-over', flytMelding: melding };
    }
    try {
        const respons = await fetch(flytUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                handling: 'lagreBackup',
                filnavn: res.filnavn,
                sti,
                url: sasUrl,
                storrelseBytes: res.storrelseKryptert,
                miljø: process.env.MILJO || 'ukjent',
                tid: new Date().toISOString()
            }),
            signal: AbortSignal.timeout(FLYT_TIMEOUT_MS)
        });
        if (respons.ok) {
            jobbLog('backup/kjor: PA-flyt OK');
            return { flytStatus: 'ok', flytMelding: null };
        }
        const melding = `PA-flyt returnerte ${respons.status}: ${(await respons.text().catch(() => '')).slice(0, 200)}`;
        jobbLog(`backup/kjor: ${melding}`);
        return { flytStatus: 'feilet', flytMelding: melding };
    } catch (e) {
        const tidsavbrudd = e.name === 'TimeoutError' || e.name === 'AbortError';
        const melding = tidsavbrudd
            ? `PA-flyten svarte ikke innen ${FLYT_TIMEOUT_MS / 1000}s. Filen ligger i blob-storage, og flyten kan fortsatt fullføre opplastingen. Har flyten en Response-handling til slutt, holder den forbindelsen åpen hele veien — fjern den, så kvitterer flyten med én gang.`
            : `PA-flyt-kall feilet: ${e.message}`;
        jobbLog(`backup/kjor: ${melding}`);
        return { flytStatus: 'feilet', flytMelding: melding };
    }
}

/**
 * Hele backupjobben. Kjøres uten await fra handleren — bygging av zip,
 * kryptering og opplasting tar lengre tid enn de ~45 sekundene SWA-gatewayen
 * holder en forbindelse åpen, så svaret må sendes før jobben er ferdig.
 * Framdrift leses fra statusraden i CacheMetadata.
 */
async function kjorBackupJobb(aktor, jobbLog) {
    // Hjerteslag: hvert steg stempler statusraden, slik at admin-panelet kan
    // skille «jobber fortsatt» fra «døde stille». En bakgrunnsjobb som blir
    // drept av minnetak eller instansresirkulering rekker ikke å sette Status,
    // og da er det bare tidsstempelet som avslører det.
    const fremdrift = (steg) => {
        jobbLog(`backup: ${steg}`);
        settStatus({ Steg: steg, SistOppdatert: new Date().toISOString() });
    };

    try {
        const res = await byggOgLagre(aktor, jobbLog, fremdrift);
        const sasUrl = lagSasUrl(res.filnavn);
        const stiInnst = await innstillinger.hent('BackupOneDriveSti');
        const sti = stiInnst?.Verdi || '';
        const { flytStatus, flytMelding } = await kallBackupFlyt(res, sasUrl, sti, jobbLog);

        await settStatus({
            Status: flytStatus === 'feilet' ? 'feil' : 'ok',
            Ferdig: new Date().toISOString(),
            SistOppdatert: new Date().toISOString(),
            Steg: 'ferdig',
            Filnavn: res.filnavn,
            StorrelseBytes: res.storrelseKryptert,
            VarighetSekunder: res.varighetSekunder,
            Tider: JSON.stringify(res.tider || {}),
            FlytStatus: flytStatus,
            OneDriveSti: sti,
            SistFeil: flytMelding || ''
        });

        hendelser.logg({
            Type: 'backup.kjort', Aktor: aktor,
            ObjektType: 'backup', ObjektId: res.filnavn,
            Melding: `Backup kjørt — ${Math.round(res.storrelseKryptert / 1024 / 1024 * 10) / 10} MB kryptert. PA-flyt: ${flytStatus}${flytMelding ? ' (' + flytMelding + ')' : ''}`,
            Detaljer: { ...res.manifest, storrelseBytes: res.storrelseKryptert, flytStatus, flytMelding }
        });
    } catch (e) {
        jobbLog(`backup/kjor FEIL: ${e.message}`);
        await settStatus({
            Status: 'feil',
            Ferdig: new Date().toISOString(),
            SistOppdatert: new Date().toISOString(),
            SistFeil: String(e.message || e).slice(0, 500)
        });
        hendelser.logg({
            Type: 'backup.feil', Aktor: aktor,
            ObjektType: 'backup', ObjektId: '',
            Melding: `Backup feilet: ${e.message}`.slice(0, 500)
        });
    }
}

app.http('backupKjor', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'backup/kjor',
    handler: async (request, context) => {
        const auth = schedulerEllerAdmin(request);
        if (!auth.ok) return { status: auth.status, jsonBody: { status: 'feil', melding: auth.melding } };

        const startTid = new Date().toISOString();
        await settStatus({
            Status: 'kjører', Startet: startTid, Kilde: auth.upn,
            SistOppdatert: startTid, Steg: 'starter',
            Ferdig: '', Filnavn: '', FlytStatus: '', SistFeil: '', Tider: ''
        });

        const jobbLog = (...a) => context.log(...a);
        jobbLog(`backup/kjor: trigget av ${auth.upn} (fire-and-forget)`);
        kjorBackupJobb(auth.upn, jobbLog).catch(e => jobbLog(`backup/kjor: uventet feil i bakgrunnsjobb — ${e.message}`));

        return {
            status: 202,
            jsonBody: {
                status: 'startet',
                startet: startTid,
                melding: 'Backupen kjører i bakgrunnen. Følg med på /api/backup/status.'
            }
        };
    }
});

app.http('backupStatus', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'backup/status',
    handler: async (request, context) => {
        const a = admin(request);
        if (!a.ok) return { status: a.status, jsonBody: { status: 'feil', melding: a.melding } };
        try {
            const t = tabellKlient('CacheMetadata');
            const rad = await t.getEntity(STATUS_PK, STATUS_RK);
            return {
                jsonBody: {
                    status: rad.Status || 'ukjent',
                    startet: rad.Startet || null,
                    steg: rad.Steg || null,
                    sistOppdatert: rad.SistOppdatert || null,
                    tider: rad.Tider ? JSON.parse(rad.Tider) : null,
                    ferdig: rad.Ferdig || null,
                    kilde: rad.Kilde || null,
                    filnavn: rad.Filnavn || null,
                    storrelseBytes: rad.StorrelseBytes ?? null,
                    varighetSekunder: rad.VarighetSekunder ?? null,
                    flytStatus: rad.FlytStatus || null,
                    oneDriveSti: rad.OneDriveSti || null,
                    sistFeil: rad.SistFeil || null
                }
            };
        } catch (e) {
            if (e.statusCode === 404) return { jsonBody: { status: 'aldri-kjørt' } };
            context.log('backup/status FEIL:', e.message);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('backupLastNed', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'backup/last-ned',
    handler: async (request, context) => {
        const a = admin(request);
        if (!a.ok) return { status: a.status, jsonBody: { status: 'feil', melding: a.melding } };
        const jobbLog = (...m) => context.log(...m);
        try {
            const { buffer, manifest, varighetSekunder } = await backup.byggBackup(jobbLog);
            const kryptert = backupKrypto.krypterBuffer(buffer);
            const stempel = new Date().toISOString().replace(/[:.]/g, '-');
            const miljø = (process.env.MILJO || 'ukjent').replace(/[^a-z0-9]/gi, '');
            const filnavn = `${miljø}-backup-${stempel}.fsbk`;
            hendelser.logg({
                Type: 'backup.last-ned', Aktor: a.upn,
                ObjektType: 'backup', ObjektId: filnavn,
                Melding: `Last-ned backup — ${Math.round(kryptert.length / 1024 / 1024 * 10) / 10} MB (${varighetSekunder}s)`
            });
            return {
                body: kryptert,
                headers: {
                    'Content-Type': 'application/octet-stream',
                    'Content-Disposition': `attachment; filename="${filnavn}"`,
                    'X-Manifest': JSON.stringify(manifest).replace(/[^\x20-\x7e]/g, '?').slice(0, 4000)
                }
            };
        } catch (e) {
            context.log('backup/last-ned FEIL:', e.message);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

/**
 * POST /api/backup/verifiser
 * Admin, multipart/form-data:
 *   fil         — .fsbk-fil
 *   passphrase? — override env BACKUP_PASSPHRASE (nyttig for migrering
 *                 mellom miljøer med ulik passphrase)
 * Dekrypterer + åpner zip + leser manifest. INGEN skrivinger. Returnerer
 * manifest så admin kan bekrefte innhold før den kjører restore.
 */
app.http('backupVerifiser', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'backup/verifiser',
    handler: async (request, context) => {
        const a = admin(request);
        if (!a.ok) return { status: a.status, jsonBody: { status: 'feil', melding: a.melding } };
        try {
            const fd = await request.formData();
            const fil = fd.get('fil');
            if (!fil || typeof fil === 'string') {
                return { status: 400, jsonBody: { status: 'feil', melding: 'Ingen fil sendt (må hete "fil")' } };
            }
            const passphrase = String(fd.get('passphrase') || '').trim() || (process.env.BACKUP_PASSPHRASE || '').trim();
            if (!passphrase || passphrase.length < 16) {
                return { status: 400, jsonBody: { status: 'feil', melding: 'Passphrase mangler eller er kortere enn 16 tegn' } };
            }
            const buf = Buffer.from(await fil.arrayBuffer());
            const { manifest } = await restore.apneOgDekrypter(buf, passphrase);
            return {
                jsonBody: {
                    status: 'ok',
                    filnavn: fil.name,
                    storrelseBytes: buf.length,
                    manifest,
                    passphraseKilde: fd.get('passphrase') ? 'form' : 'env'
                }
            };
        } catch (e) {
            context.log('backup/verifiser FEIL:', e.message);
            return { status: 400, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

/**
 * POST /api/backup/restore
 * Admin, multipart/form-data:
 *   fil          — .fsbk-fil
 *   passphrase?  — override env BACKUP_PASSPHRASE
 *   bekreftelse  — må være strengen "RESTORE" for at operasjonen skal kjøre
 *
 * DESTRUKTIVT: wiper alle tabeller + blob-containere i manifest, deretter
 * upsert alle fra backup. Delvis feil etterlater systemet i inkonsistent
 * tilstand — kjør på nytt.
 */
app.http('backupRestore', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'backup/restore',
    handler: async (request, context) => {
        const a = admin(request);
        if (!a.ok) return { status: a.status, jsonBody: { status: 'feil', melding: a.melding } };
        const jobbLog = (...m) => context.log(...m);
        try {
            const fd = await request.formData();
            const bekreftelse = String(fd.get('bekreftelse') || '').trim();
            if (bekreftelse !== 'RESTORE') {
                return { status: 400, jsonBody: { status: 'feil', melding: 'bekreftelse må være strengen "RESTORE"' } };
            }
            const fil = fd.get('fil');
            if (!fil || typeof fil === 'string') {
                return { status: 400, jsonBody: { status: 'feil', melding: 'Ingen fil sendt' } };
            }
            const passphrase = String(fd.get('passphrase') || '').trim() || (process.env.BACKUP_PASSPHRASE || '').trim();
            if (!passphrase || passphrase.length < 16) {
                return { status: 400, jsonBody: { status: 'feil', melding: 'Passphrase mangler eller for kort' } };
            }
            const buf = Buffer.from(await fil.arrayBuffer());
            jobbLog(`restore: mottok ${fil.name} (${buf.length} bytes) fra ${a.upn}`);
            const apnet = await restore.apneOgDekrypter(buf, passphrase);
            jobbLog(`restore: manifest ok — ${apnet.manifest.tabeller?.length || 0} tabeller, ${apnet.manifest.containers?.length || 0} containere`);

            const res = await restore.kjorRestore(apnet, jobbLog);

            hendelser.logg({
                Type: 'restore.kjort', Aktor: a.upn,
                ObjektType: 'backup', ObjektId: fil.name,
                Melding: `Restore fullført — ${res.tabeller.length} tabeller, ${res.containere.length} containere (${res.varighetSekunder}s)`,
                Detaljer: { ...res, backupTid: apnet.manifest.tid, backupMiljo: apnet.manifest.miljø }
            });

            return {
                jsonBody: {
                    status: 'ok',
                    filnavn: fil.name,
                    varighetSekunder: res.varighetSekunder,
                    manifest: apnet.manifest,
                    resultat: res
                }
            };
        } catch (e) {
            context.log('backup/restore FEIL:', e.message, e.stack);
            hendelser.logg({
                Type: 'restore.feil', Aktor: a.upn,
                ObjektType: 'backup', ObjektId: '',
                Melding: `Restore feilet: ${e.message}`.slice(0, 500)
            });
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('backupListe', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'backup/liste',
    handler: async (request, context) => {
        const a = admin(request);
        if (!a.ok) return { status: a.status, jsonBody: { status: 'feil', melding: a.melding } };
        try {
            const c = await backupContainer();
            const liste = [];
            for await (const blob of c.listBlobsFlat({ includeMetadata: true })) {
                liste.push({
                    filnavn: blob.name,
                    storrelseBytes: blob.properties.contentLength,
                    opprettet: blob.properties.lastModified ? new Date(blob.properties.lastModified).toISOString() : null,
                    opprettetAv: blob.metadata?.opprettet_av || null,
                    klartekstBytes: blob.metadata?.klartekst_bytes ? Number(blob.metadata.klartekst_bytes) : null,
                    varighetSek: blob.metadata?.varighet_sek ? Number(blob.metadata.varighet_sek) : null,
                    sasUrl: lagSasUrl(blob.name)
                });
            }
            liste.sort((a, b) => (b.opprettet || '').localeCompare(a.opprettet || ''));
            return { jsonBody: liste };
        } catch (e) {
            context.log('backup/liste FEIL:', e.message);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});
