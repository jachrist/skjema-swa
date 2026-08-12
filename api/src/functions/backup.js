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
const { BlobSASPermissions, generateBlobSASQueryParameters, StorageSharedKeyCredential } = require('@azure/storage-blob');

const BACKUP_CONTAINER = 'backups';
const SAS_GYLDIG_TIMER = 24; // PA-flyt bruker denne til å hente og laste opp

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

async function byggOgLagre(aktor, jobbLog) {
    // 1. Bygg zip
    const { buffer, manifest, varighetSekunder } = await backup.byggBackup(jobbLog);
    // 2. AES-krypter
    const kryptert = backupKrypto.krypterBuffer(buffer);
    jobbLog(`backup: kryptert (klartekst ${buffer.length} → container ${kryptert.length} bytes)`);
    // 3. Lagre i midlertidig blob
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
    return { filnavn, storrelseKryptert: kryptert.length, storrelseKlar: buffer.length, manifest, varighetSekunder };
}

app.http('backupKjor', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'backup/kjor',
    handler: async (request, context) => {
        const auth = schedulerEllerAdmin(request);
        if (!auth.ok) return { status: auth.status, jsonBody: { status: 'feil', melding: auth.melding } };

        const jobbLog = (...a) => context.log(...a);
        try {
            const res = await byggOgLagre(auth.upn, jobbLog);
            const sasUrl = lagSasUrl(res.filnavn);

            // Kall PA-flyt for opplasting til OneDrive
            const flytUrl = String(process.env.BACKUP_FLOW_URL || '').trim();
            const stiInnst = await innstillinger.hent('BackupOneDriveSti');
            const sti = stiInnst?.Verdi || '';
            let flytStatus = 'hoppet-over';
            let flytMelding = null;

            if (!flytUrl) {
                flytMelding = 'BACKUP_FLOW_URL ikke satt — backup ligger i blob-storage men er ikke opplastet til OneDrive';
                jobbLog(`backup/kjor: ${flytMelding}`);
            } else {
                try {
                    const resp = await fetch(flytUrl, {
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
                        })
                    });
                    if (resp.ok) { flytStatus = 'ok'; jobbLog(`backup/kjor: PA-flyt OK`); }
                    else {
                        flytStatus = 'feilet';
                        flytMelding = `PA-flyt returnerte ${resp.status}: ${(await resp.text()).slice(0, 200)}`;
                        jobbLog(`backup/kjor: ${flytMelding}`);
                    }
                } catch (e) {
                    flytStatus = 'feilet';
                    flytMelding = `PA-flyt-kall feilet: ${e.message}`;
                    jobbLog(`backup/kjor: ${flytMelding}`);
                }
            }

            hendelser.logg({
                Type: 'backup.kjort', Aktor: auth.upn,
                ObjektType: 'backup', ObjektId: res.filnavn,
                Melding: `Backup kjørt — ${Math.round(res.storrelseKryptert / 1024 / 1024 * 10) / 10} MB kryptert. PA-flyt: ${flytStatus}${flytMelding ? ' (' + flytMelding + ')' : ''}`,
                Detaljer: { ...res.manifest, storrelseBytes: res.storrelseKryptert, flytStatus, flytMelding }
            });

            return {
                jsonBody: {
                    status: 'ok',
                    filnavn: res.filnavn,
                    storrelseBytes: res.storrelseKryptert,
                    varighetSekunder: res.varighetSekunder,
                    manifest: res.manifest,
                    sasUrl,
                    sasUtloper: new Date(Date.now() + SAS_GYLDIG_TIMER * 3600 * 1000).toISOString(),
                    flytStatus, flytMelding, oneDriveSti: sti
                }
            };
        } catch (e) {
            context.log('backup/kjor FEIL:', e.message, e.stack);
            hendelser.logg({
                Type: 'backup.feil', Aktor: auth.upn,
                ObjektType: 'backup', ObjektId: '',
                Melding: `Backup feilet: ${e.message}`.slice(0, 500)
            });
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
