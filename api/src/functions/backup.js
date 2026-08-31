/**
 * Backup-endepunkter.
 *
 *   POST /api/backup/kjor
 *     Auth: x-scheduler-key eller admin. Svarer 202 med én gang og kjører
 *     jobben videre i bakgrunnen — bygging, kryptering og opplasting tar
 *     lengre tid enn SWA-gatewayen holder en forbindelse åpen.
 *     Bygger komplett backup (tabeller + blobs), AES-krypterer, lagrer i
 *     midlertidig blob-container 'backups', kaller BACKUP_FLOW_URL (PA-flyt)
 *     så PA laster opp til OneDrive.
 *
 *     Payload til flyten:
 *       { handling, filnavn, sti, url, storrelseBytes, antallDeler, deler[],
 *         miljø, tid, kvitteringUrl }
 *
 *     `deler` er en deleplan. Power Automates HTTP-handling leser hele
 *     responsen inn i minnet med et tak på 100 MiB, og backupen passerte det
 *     31.08.2026. Flyten skal derfor gå gjennom `deler`, hente én del om
 *     gangen fra `url` med headeren `Range: <del.range>`, og lagre hver del
 *     som `del.filnavn`. Er det bare én del, er filnavnet uendret og flyten
 *     oppfører seg som før.
 *
 *     Kvittering sendes ÉN gang, når alle delene er lastet opp, med det
 *     opprinnelige `filnavn` og summen av delenes størrelse — ellers slår
 *     størrelsessjekken i vurderKvittering ut.
 *
 *   GET  /api/backup/status
 *     Auth: admin. Framdrift og resultat for siste kjøring, fra statusraden
 *     Meta/Backup i CacheMetadata.
 *
 *   POST /api/backup/kvittering
 *     Auth: x-flow-key. PA-flyten melder tilbake om fila faktisk landet i
 *     OneDrive, og hvor stor den ble. Se handleren for hvorfor dette trengs.
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
const graphOpplast = require('../lib/graph-opplast');
const restore = require('../lib/restore');
const innstillinger = require('../lib/innstillinger-storage');
const hendelser = require('../lib/hendelser-storage');
const { containerKlient, serviceKlient } = require('../lib/blob');
const { tabellKlient, kontoNavnFra } = require('../lib/storage');
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

async function byggOgLagre(aktor, jobbLog, fremdrift = () => {}, opsjoner = {}) {
    const erDelta = opsjoner.modus === 'delta';
    const stempel = new Date().toISOString().replace(/[:.]/g, '-');
    const miljø = (process.env.MILJO || 'ukjent').replace(/[^a-z0-9]/gi, '');
    // Ulikt ord i filnavnet, ikke bare i manifestet: da kan Azures
    // lifecycle-regler skille på prefiks og gi deltaene kortere levetid enn
    // de fulle, og et blikk i fillista sier hva som er hva.
    const filnavn = `${miljø}-${erDelta ? 'delta' : 'backup'}-${stempel}.fsbk`;
    const c = await backupContainer();
    const blob = c.getBlockBlobClient(filnavn);

    // Bygging, kryptering og opplasting er én strøm: zipen genereres
    // fortløpende, krypteres underveis og skrives i blokker rett til blobben.
    // Ingen kopi av den ferdige fila finnes i minnet.
    const res = await backup.byggOgKrypterTilBlob(
        blob,
        { blobContentType: 'application/octet-stream' },
        jobbLog,
        fremdrift,
        opsjoner
    );

    // Metadata settes etter commit — størrelse og varighet er ikke kjent
    // før siste blokk er skrevet.
    await blob.setMetadata({
        miljo: process.env.MILJO || 'ukjent',
        modus: erDelta ? 'delta' : 'full',
        opprettet: new Date().toISOString(),
        opprettet_av: aktor,
        klartekst_bytes: String(res.storrelseKlar),
        varighet_sek: String(res.varighetSekunder)
    });

    // Blob-klienten følger med ut: Graph-opplastingen leser fila derfra i
    // biter, i stedet for å hente den ned igjen over en SAS-URL.
    return { filnavn, blob, modus: erDelta ? 'delta' : 'full', ...res };
}

// Peker på siste vellykkede FULLE backup. Et delta bygger på den, og trenger
// både navnet — for å kunne si hva det hviler på — og starttidspunktet, for å
// vite hvilke blobber som er nye.
//
// Vi bruker starttiden, ikke sluttiden: en blobb som kom til mens den fulle
// kjørte kan ha blitt oversett av den. Å ta den med i deltaet også er
// ufarlig — en dobbel blobb skrives bare over ved gjenoppretting — mens å
// hoppe over den ville betydd at den aldri fantes i noen backup.
const FULL_RK = 'BackupSisteFulle';

async function hentSisteFulle() {
    try {
        const rad = await tabellKlient('CacheMetadata').getEntity(STATUS_PK, FULL_RK);
        return { filnavn: rad.Filnavn || null, startet: rad.Startet || null };
    } catch (e) {
        if (e.statusCode === 404) return null;
        throw e;
    }
}

async function settSisteFulle(filnavn, startet) {
    try {
        await tabellKlient('CacheMetadata').upsertEntity(
            { partitionKey: STATUS_PK, rowKey: FULL_RK, Filnavn: filnavn, Startet: startet },
            'Merge'
        );
    } catch (_) { /* neste delta faller da tilbake til full — trygt nok */ }
}

/**
 * Kopier backupen ut av Azure.
 *
 * To veier, i prioritert rekkefølge:
 *   1. Microsoft Graph rett til et SharePoint-bibliotek. Vi styrer bitene selv,
 *      og får bekreftet størrelse i samme kall — altså en ekte kontroll på at
 *      fila kom hel fram.
 *   2. Power Automate-flyten, som før. Beholdt så et miljø uten Graph-oppsett
 *      fortsatt har en kopi, og så overgangen kan tas ett miljø om gangen.
 *
 * Er Graph konfigurert, men feiler, faller vi IKKE tilbake til flyten: da er
 * det en reell feil som skal ses, ikke skjules bak en reservevei.
 */
async function lastOppKopi(res, sasUrl, sti, jobbLog, fremdrift) {
    if (graphOpplast.erKonfigurert()) {
        fremdrift('laster opp til SharePoint');
        try {
            const g = await graphOpplast.lastOppBackup(
                { blob: res.blob, filnavn: res.filnavn, storrelseBytes: res.storrelseKryptert },
                jobbLog
            );
            return {
                kanal: 'graph',
                flytStatus: g.status === 'ok' ? 'ok' : 'feilet',
                flytMelding: g.status === 'ok' ? null : g.melding,
                graph: g
            };
        } catch (e) {
            jobbLog(`backup/kjor: Graph-opplasting feilet — ${e.message}`);
            return { kanal: 'graph', flytStatus: 'feilet', flytMelding: `Graph-opplasting feilet: ${e.message}` };
        }
    }
    fremdrift('kaller PA-flyt');
    return { kanal: 'pa-flyt', ...(await kallBackupFlyt(res, sasUrl, sti, jobbLog)) };
}

/** Full URL til kvitteringsendepunktet, slik flyten slipper å ha den hardkodet. */
function kvitteringUrl() {
    const base = String(process.env.SWA_URL || '').replace(/\/+$/, '');
    return base ? `${base}/api/backup/kvittering` : '';
}

/**
 * Ber PA-flyten hente backupen fra SAS-URL-en og legge den i OneDrive.
 * Returnerer { flytStatus, flytMelding } — kaster aldri.
 */
async function kallBackupFlyt(res, sasUrl, sti, jobbLog) {
    const deler = backup.byggDeler(res.filnavn, res.storrelseKryptert);
    if (deler.length > 1) {
        jobbLog(`backup/kjor: fila deles i ${deler.length} deler for OneDrive `
            + `(PA-flytens HTTP-handling tar maks 100 MiB per kall)`);
    }
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
                // Flyten henter én del om gangen med Range-headeren under.
                // Én del = uendret oppførsel; flere = én OneDrive-fil per del.
                antallDeler: deler.length,
                deler,
                miljø: process.env.MILJO || 'ukjent',
                tid: new Date().toISOString(),
                kvitteringUrl: kvitteringUrl()
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
async function kjorBackupJobb(aktor, jobbLog, onsketModus = 'full') {
    // Hjerteslag: hvert steg stempler statusraden, slik at admin-panelet kan
    // skille «jobber fortsatt» fra «døde stille». En bakgrunnsjobb som blir
    // drept av minnetak eller instansresirkulering rekker ikke å sette Status,
    // og da er det bare tidsstempelet som avslører det.
    const fremdrift = (steg) => {
        jobbLog(`backup: ${steg}`);
        settStatus({ Steg: steg, SistOppdatert: new Date().toISOString() });
    };

    try {
        // Et delta krever en full å bygge på. Finnes ingen — første kjøring,
        // eller statusraden er borte — tas en full i stedet. Alternativet
        // ville vært en deltafil som ikke kan gjenopprettes alene.
        const startet = new Date().toISOString();
        let opsjoner = { modus: 'full' };
        if (onsketModus === 'delta') {
            const full = await hentSisteFulle();
            if (full?.filnavn && full?.startet) {
                opsjoner = { modus: 'delta', basertPa: full.filnavn, blobberSiden: full.startet };
                jobbLog(`backup/kjor: delta basert på ${full.filnavn} (blobber endret etter ${full.startet})`);
            } else {
                jobbLog('backup/kjor: ba om delta, men fant ingen full backup å bygge på — kjører full');
            }
        }

        const res = await byggOgLagre(aktor, jobbLog, fremdrift, opsjoner);
        if (res.modus === 'full') await settSisteFulle(res.filnavn, startet);
        const sasUrl = lagSasUrl(res.filnavn);
        const stiInnst = await innstillinger.hent('BackupOneDriveSti');
        const sti = stiInnst?.Verdi || '';
        const { kanal, flytStatus, flytMelding, graph } = await lastOppKopi(res, sasUrl, sti, jobbLog, fremdrift);

        // Graph kvitterer i samme kall — vi vet utfallet med én gang, og
        // trenger ingen kvittering tilbake fra en flyt. PA-veien får fortsatt
        // sine felter satt av /api/backup/kvittering.
        const graphStatus = kanal === 'graph' ? {
            OneDriveStatus: flytStatus === 'ok' ? 'ok' : 'feil',
            OneDriveKvittert: new Date().toISOString(),
            OneDriveStorrelse: Number(graph?.storrelseBytes) || 0,
            OneDriveMelding: (graph?.melding || '').slice(0, 500),
            OneDriveUrl: graph?.webUrl || ''
        } : {};

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
            Kanal: kanal,
            Modus: res.modus,
            BasertPa: res.modus === 'delta' ? (opsjoner.basertPa || '') : '',
            OneDriveSti: kanal === 'graph' ? (graph?.sti || '') : sti,
            SistFeil: flytMelding || '',
            ...graphStatus
        });

        const kanalNavn = kanal === 'graph' ? 'SharePoint (Graph)' : 'PA-flyt';
        hendelser.logg({
            Type: 'backup.kjort', Aktor: aktor,
            ObjektType: 'backup', ObjektId: res.filnavn,
            Melding: `Backup (${res.modus}) kjørt — ${Math.round(res.storrelseKryptert / 1024 / 1024 * 10) / 10} MB kryptert. ${kanalNavn}: ${flytStatus}${flytMelding ? ' (' + flytMelding + ')' : ''}`,
            Detaljer: { ...res.manifest, storrelseBytes: res.storrelseKryptert, kanal, flytStatus, flytMelding, webUrl: graph?.webUrl || null }
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

        // modus: 'full' (standard) eller 'delta'. Et delta tar alle dynamiske
        // tabeller i sin helhet, men bare blobber som er kommet til siden
        // forrige fulle backup.
        const body = await request.json().catch(() => ({}));
        const onsketModus = String(body?.modus || '').trim().toLowerCase() === 'delta' ? 'delta' : 'full';

        const startTid = new Date().toISOString();
        await settStatus({
            Status: 'kjører', Startet: startTid, Kilde: auth.upn,
            SistOppdatert: startTid, Steg: 'starter',
            Ferdig: '', Filnavn: '', FlytStatus: '', SistFeil: '', Tider: '', Modus: '', BasertPa: '',
            OneDriveStatus: '', OneDriveKvittert: '', OneDriveMelding: '', OneDriveStorrelse: 0
        });

        const jobbLog = (...a) => context.log(...a);
        jobbLog(`backup/kjor: trigget av ${auth.upn}, modus=${onsketModus} (fire-and-forget)`);
        kjorBackupJobb(auth.upn, jobbLog, onsketModus).catch(e => jobbLog(`backup/kjor: uventet feil i bakgrunnsjobb — ${e.message}`));

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
                    // 'graph' = SharePoint via Microsoft Graph, 'pa-flyt' = OneDrive
                    // via Power Automate. Avgjør hvordan panelet skal formulere seg.
                    kanal: rad.Kanal || null,
                    modus: rad.Modus || null,
                    basertPa: rad.BasertPa || null,
                    oneDriveStatus: rad.OneDriveStatus || null,
                    oneDriveKvittert: rad.OneDriveKvittert || null,
                    oneDriveMelding: rad.OneDriveMelding || null,
                    oneDriveSti: rad.OneDriveSti || null,
                    oneDriveStorrelse: rad.OneDriveStorrelse ?? null,
                    kopiUrl: rad.OneDriveUrl || null,
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

/**
 * POST /api/backup/kvittering
 * Auth: x-flow-key som matcher FLOW_CALLBACK_KEY.
 *
 * PA-flyten melder tilbake om fila faktisk landet i OneDrive. Grunnen til at
 * dette trengs: OneDrive-handlingen «Upload file from URL» rapporterer alltid
 * suksess etter 20 sekunder, uansett hva som skjedde. Uten en kvittering ville
 * vi altså registrert backupen som vellykket på et løfte connectoren ikke
 * holder.
 *
 * Body: {
 *   filnavn,                  // må matche backupen vi sist kjørte
 *   status: 'ok' | 'feil',
 *   storrelseBytes?,          // fra «Get file metadata» — sammenliknes med vår
 *   sti?, melding?
 * }
 *
 * Flyten bør hente storrelseBytes fra metadataen etter opplasting. Avviker den
 * fra det vi lastet opp, er fila ufullstendig, og kvitteringen underkjennes
 * selv om flyten mener alt gikk bra.
 */
/**
 * Avgjør hva kvitteringen faktisk betyr. En flyt som melder «ok» blir ikke
 * trodd på ordet: stemmer ikke størrelsen med det vi lastet opp, er fila
 * ufullstendig uansett hva flyten sier.
 */
function vurderKvittering({ meldtStatus, meldtStorrelse, vårStorrelse, melding }) {
    const meldt = String(meldtStatus || '').toLowerCase() === 'ok' ? 'ok' : 'feil';
    const tekst = String(melding || '').slice(0, 500);

    if (meldt === 'ok' && meldtStorrelse !== null && vårStorrelse !== null && meldtStorrelse !== vårStorrelse) {
        return {
            resultat: 'feil',
            melding: `Fila i OneDrive er ${meldtStorrelse} bytes, men vi lastet opp ${vårStorrelse}. Opplastingen er ufullstendig.`
        };
    }
    return { resultat: meldt, melding: tekst };
}

app.http('backupKvittering', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'backup/kvittering',
    handler: async (request, context) => {
        const flowKey = request.headers.get('x-flow-key');
        const konfigurert = String(process.env.FLOW_CALLBACK_KEY || '').trim();
        if (!konfigurert || flowKey !== konfigurert) {
            return { status: 401, jsonBody: { status: 'feil', melding: 'Ugyldig x-flow-key' } };
        }

        try {
            const body = await request.json().catch(() => ({}));
            const filnavn = String(body.filnavn || '').trim();
            if (!filnavn) return { status: 400, jsonBody: { status: 'feil', melding: 'filnavn mangler' } };

            let rad = null;
            try {
                rad = await tabellKlient('CacheMetadata').getEntity(STATUS_PK, STATUS_RK);
            } catch (e) {
                if (e.statusCode !== 404) throw e;
            }

            // En kvittering for en eldre backup skal ikke overskrive statusen
            // for den nyeste. Flyten kan komme sent tilbake.
            if (rad && rad.Filnavn && rad.Filnavn !== filnavn) {
                context.log(`backup/kvittering: gjelder ${filnavn}, men siste backup er ${rad.Filnavn} — ignorert`);
                return {
                    status: 409,
                    jsonBody: { status: 'ignorert', melding: `Kvitteringen gjelder ${filnavn}, siste backup er ${rad.Filnavn}` }
                };
            }

            const meldtStorrelse = Number(body.storrelseBytes) || null;
            const { resultat, melding } = vurderKvittering({
                meldtStatus: body.status,
                meldtStorrelse,
                vårStorrelse: rad?.StorrelseBytes ? Number(rad.StorrelseBytes) : null,
                melding: body.melding
            });

            await settStatus({
                OneDriveStatus: resultat,
                OneDriveKvittert: new Date().toISOString(),
                OneDriveStorrelse: meldtStorrelse ?? 0,
                OneDriveMelding: melding,
                SistOppdatert: new Date().toISOString()
            });

            hendelser.logg({
                Type: resultat === 'ok' ? 'backup.onedrive-ok' : 'backup.onedrive-feil',
                Aktor: 'flyt',
                ObjektType: 'backup', ObjektId: filnavn,
                Melding: resultat === 'ok'
                    ? `Backup bekreftet i OneDrive${body.sti ? ' (' + String(body.sti).slice(0, 200) + ')' : ''}`
                    : `Backup kom ikke trygt i OneDrive: ${melding || 'flyten meldte feil'}`.slice(0, 500)
            });

            context.log(`backup/kvittering: ${filnavn} → ${resultat}${melding ? ' — ' + melding : ''}`);
            return { jsonBody: { status: 'ok', registrert: resultat, melding: melding || null } };
        } catch (e) {
            context.log('backup/kvittering FEIL:', e.message);
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
            const { buffer, manifest, varighetSekunder } = await backup.byggOgKrypterTilBuffer(jobbLog);
            const stempel = new Date().toISOString().replace(/[:.]/g, '-');
            const miljø = (process.env.MILJO || 'ukjent').replace(/[^a-z0-9]/gi, '');
            const filnavn = `${miljø}-backup-${stempel}.fsbk`;
            hendelser.logg({
                Type: 'backup.last-ned', Aktor: a.upn,
                ObjektType: 'backup', ObjektId: filnavn,
                Melding: `Last-ned backup — ${Math.round(buffer.length / 1024 / 1024 * 10) / 10} MB (${varighetSekunder}s)`
            });
            return {
                body: buffer,
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

// ==================== MIDLERTIDIG: BACKUP AV ET ANNET MILJØ ====================
//
// Prod venter på egen app-registrering og Graph-oppsett. Inntil den er på
// plass, kan dette miljøet ta backup av prod og laste den opp til SharePoint
// med sitt eget Graph-oppsett.
//
// Legitimasjonen til det andre miljøet limes inn per kjøring og lagres ALDRI —
// ikke i Key Vault, ikke i en tabell, ikke i loggen. Den lever i minnet så
// lenge jobben kjører. Bruk helst et kortlevd, lesebegrenset SAS framfor
// kontonøkkelen; se docs/BACKUP-SHAREPOINT.md.
//
// Endepunktet krever admin — bevisst ikke x-scheduler-key. Dette skal ikke
// kunne automatiseres i stillhet, og ordningen skal være ubehagelig nok til
// at den blir fjernet når prod står på egne bein.
//
// Kjøringen rører ikke dette miljøets egen backup-status eller pekeren til
// siste fulle, så delta-kjeden her forblir intakt.

const EKSTERN_RK = 'BackupEksternt';

async function settEksternStatus(felter) {
    try {
        const t = tabellKlient('CacheMetadata');
        await t.upsertEntity({ partitionKey: STATUS_PK, rowKey: EKSTERN_RK, ...felter }, 'Merge');
    } catch (_) { /* statusraden er ikke kritisk */ }
}

async function kjorEksternBackup(aktor, { connectionString, miljo, passphrase }, jobbLog) {
    const start = Date.now();
    // Kontonavnet er trygt å logge og er det eneste som er verdt å se: det
    // avslører med én gang om man har limt inn feil miljøs streng.
    const konto = kontoNavnFra(connectionString) || 'ukjent konto';
    try {
        const stempel = new Date().toISOString().replace(/[:.]/g, '-');
        const rentMiljo = miljo.replace(/[^a-z0-9]/gi, '');
        const filnavn = `${rentMiljo}-backup-${stempel}.fsbk`;

        await settEksternStatus({
            Status: 'kjører', Steg: `leser fra ${konto}`,
            SistOppdatert: new Date().toISOString(), Filnavn: filnavn, Konto: konto
        });
        jobbLog(`backup/eksternt: leser fra ${konto} som ${miljo}`);

        const c = await backupContainer();
        const blob = c.getBlockBlobClient(filnavn);

        const res = await backup.byggOgKrypterTilBlob(
            blob,
            { blobContentType: 'application/octet-stream' },
            jobbLog,
            (steg) => settEksternStatus({ Steg: steg, SistOppdatert: new Date().toISOString() }),
            {
                modus: 'full',
                kilde: backup.kildeFra(connectionString, 'ekstern connection string'),
                miljo,
                // Fila krypteres med DET andre miljøets passphrase når den er
                // oppgitt, slik at den faktisk kan gjenopprettes der.
                passphrase: passphrase || null
            }
        );

        await blob.setMetadata({
            miljo, modus: 'full', ekstern: 'ja', kilde_konto: konto,
            opprettet: new Date().toISOString(), opprettet_av: aktor,
            klartekst_bytes: String(res.storrelseKlar)
        });

        let opplasting = { status: 'hoppet-over', melding: 'Graph ikke satt opp i dette miljøet' };
        if (graphOpplast.erKonfigurert()) {
            opplasting = await graphOpplast.lastOppBackup(
                { blob, filnavn, storrelseBytes: res.storrelseKryptert }, jobbLog);
        }

        const sek = Math.round((Date.now() - start) / 1000);
        await settEksternStatus({
            Status: opplasting.status === 'ok' ? 'ok' : 'feil',
            Ferdig: new Date().toISOString(), SistOppdatert: new Date().toISOString(),
            Steg: 'ferdig', StorrelseBytes: res.storrelseKryptert,
            VarighetSekunder: sek, Miljo: miljo,
            Melding: opplasting.melding || '', SistFeil: opplasting.status === 'ok' ? '' : (opplasting.melding || '')
        });
        hendelser.logg({
            Type: 'backup.eksternt', Aktor: aktor,
            ObjektType: 'backup', ObjektId: filnavn,
            Melding: `Ekstern backup av ${miljo} fra ${konto} — `
                + `${Math.round(res.storrelseKryptert / 1024 / 1024 * 10) / 10} MB, `
                + `SharePoint: ${opplasting.status} (${sek}s)`
        });
        jobbLog(`backup/eksternt: ferdig — ${filnavn}, SharePoint ${opplasting.status}`);
    } catch (e) {
        // Meldingen kan i teorien inneholde deler av connection stringen fra
        // en SDK-feil. Vi tar bare kontonavnet og feiltypen med videre.
        const trygg = `${e.name || 'Feil'}: ${String(e.message || '').replace(/(SharedAccessSignature|AccountKey)=[^;]*/gi, '$1=***').slice(0, 400)}`;
        jobbLog(`backup/eksternt FEIL (${konto}): ${trygg}`);
        await settEksternStatus({
            Status: 'feil', Ferdig: new Date().toISOString(),
            SistOppdatert: new Date().toISOString(), SistFeil: trygg
        });
        hendelser.logg({
            Type: 'backup.eksternt-feil', Aktor: aktor,
            ObjektType: 'backup', ObjektId: konto,
            Melding: `Ekstern backup feilet: ${trygg}`.slice(0, 500)
        });
    }
}

/**
 * POST /api/backup/kjor-eksternt — ADMIN ONLY.
 * Body: { connectionString, miljo, passphrase?, bekreftelse: 'EKSTERN' }
 *
 * Svarer 202 og kjører videre i bakgrunnen. Legitimasjonen lagres ikke.
 */
app.http('backupKjorEksternt', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'backup/kjor-eksternt',
    handler: async (request, context) => {
        const a = admin(request);
        if (!a.ok) return { status: a.status, jsonBody: { status: 'feil', melding: a.melding } };

        const body = await request.json().catch(() => ({}));
        const connectionString = String(body?.connectionString || '').trim();
        const miljo = String(body?.miljo || '').trim();
        const passphrase = String(body?.passphrase || '').trim();

        if (String(body?.bekreftelse || '') !== 'EKSTERN') {
            return { status: 400, jsonBody: { status: 'feil', melding: 'bekreftelse må være strengen "EKSTERN"' } };
        }
        if (!connectionString) {
            return { status: 400, jsonBody: { status: 'feil', melding: 'connectionString mangler' } };
        }
        if (!miljo || !/^[a-z0-9-]{2,30}$/i.test(miljo)) {
            return { status: 400, jsonBody: { status: 'feil', melding: 'miljo må være 2-30 tegn (bokstaver, tall, bindestrek) — blir prefiks i filnavnet' } };
        }
        // Uten dette får fila dette miljøets passphrase, og kan ikke åpnes av
        // det miljøet den er en backup av. Bedre å si fra enn å oppdage det
        // under en gjenoppretting.
        if (passphrase && passphrase.length < 16) {
            return { status: 400, jsonBody: { status: 'feil', melding: 'passphrase må være minst 16 tegn' } };
        }
        const konto = kontoNavnFra(connectionString);
        if (!konto) {
            return { status: 400, jsonBody: { status: 'feil', melding: 'Fant verken AccountName eller endepunkt i connection stringen' } };
        }

        const egenKonto = kontoNavnFra(process.env.STORAGE_CONNECTION_STRING || '');
        if (egenKonto && konto.toLowerCase() === egenKonto.toLowerCase()) {
            return {
                status: 400,
                jsonBody: {
                    status: 'feil',
                    melding: `Connection stringen peker på ${konto} — dette miljøets egen lagringskonto. `
                        + `Bruk vanlig backup for det, ellers får du en fil merket «${miljo}» med feil miljøs data.`
                }
            };
        }

        await settEksternStatus({
            Status: 'kjører', Startet: new Date().toISOString(), Aktor: a.upn,
            SistOppdatert: new Date().toISOString(), Steg: 'starter',
            Miljo: miljo, Konto: konto, Ferdig: '', SistFeil: '', Melding: '', StorrelseBytes: 0
        });

        const jobbLog = (...m) => context.log(...m);
        kjorEksternBackup(a.upn, { connectionString, miljo, passphrase }, jobbLog)
            .catch(e => jobbLog(`backup/eksternt: uventet feil — ${e.message}`));

        return {
            status: 202,
            jsonBody: {
                status: 'startet', miljo, konto,
                passphrase: passphrase ? 'egen' : 'dette miljøets',
                melding: 'Backupen kjører i bakgrunnen. Følg med på /api/backup/eksternt-status.'
            }
        };
    }
});

/** GET /api/backup/eksternt-status — admin. Siste eksterne kjøring. */
app.http('backupEksterntStatus', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'backup/eksternt-status',
    handler: async (request, context) => {
        const a = admin(request);
        if (!a.ok) return { status: a.status, jsonBody: { status: 'feil', melding: a.melding } };
        try {
            const rad = await tabellKlient('CacheMetadata').getEntity(STATUS_PK, EKSTERN_RK);
            return {
                jsonBody: {
                    status: rad.Status || 'ukjent',
                    startet: rad.Startet || null, ferdig: rad.Ferdig || null,
                    steg: rad.Steg || null, sistOppdatert: rad.SistOppdatert || null,
                    filnavn: rad.Filnavn || null, miljo: rad.Miljo || null,
                    konto: rad.Konto || null,
                    storrelseBytes: rad.StorrelseBytes ?? null,
                    varighetSekunder: rad.VarighetSekunder ?? null,
                    melding: rad.Melding || null, sistFeil: rad.SistFeil || null,
                    aktor: rad.Aktor || null
                }
            };
        } catch (e) {
            if (e.statusCode === 404) return { jsonBody: { status: 'aldri-kjørt' } };
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});


// ==================== VERIFISERING UTEN GJENOPPRETTING ====================
//
// En backup ingen har prøvd å lese er en antakelse, ikke en sikkerhet. Men å
// laste ned 400 MB og opp igjen for å teste den er tungvint nok til at ingen
// gjør det.
//
// Her leses fila der den ligger, dekrypteres strømmende, og klarteksten
// kastes fortløpende. AES-GCM autentiserer hver eneste byte, så går
// dekrypteringen igjennom, er fila komplett og uendret — og passphrasen
// virker. Ingenting skrives, ingenting gjenopprettes, minnebruken er én bit
// om gangen.
//
// Kilden bør normalt være 'sharepoint': det er kopien utenfor Azure som
// faktisk skal redde oss, og en verifisering av blobben sier ingenting om
// hva som kom fram dit.

const VERIFISER_RK = 'BackupVerifisering';

async function settVerifiserStatus(felter) {
    try {
        const t = tabellKlient('CacheMetadata');
        await t.upsertEntity({ partitionKey: STATUS_PK, rowKey: VERIFISER_RK, ...felter }, 'Merge');
    } catch (_) { /* statusraden er ikke kritisk for selve verifiseringen */ }
}

async function kjorVerifisering(aktor, filnavn, kilde, jobbLog) {
    const start = Date.now();
    try {
        const passphrase = String(process.env.BACKUP_PASSPHRASE || '').trim();
        if (!passphrase || passphrase.length < 16) {
            throw new Error('BACKUP_PASSPHRASE mangler eller er kortere enn 16 tegn');
        }

        let lesBit, total, hvor;
        if (kilde === 'sharepoint') {
            const ned = await graphOpplast.lagNedlaster(filnavn, jobbLog);
            lesBit = ned.lesBit;
            total = ned.storrelseBytes;
            hvor = `${ned.bibliotek}/${ned.sti}`;
        } else {
            const c = await backupContainer();
            const blob = c.getBlockBlobClient(filnavn);
            const props = await blob.getProperties();
            total = Number(props.contentLength) || 0;
            lesBit = (fra, antall) => blob.downloadToBuffer(fra, antall);
            hvor = `blob-storage/${BACKUP_CONTAINER}`;
        }

        await settVerifiserStatus({
            Status: 'kjører', Steg: `leser ${Math.round(total / 1024 / 1024)} MB fra ${kilde}`,
            SistOppdatert: new Date().toISOString()
        });
        jobbLog(`backup/verifiser-lagret: ${filnavn} fra ${hvor} — ${total} bytes`);

        const res = await backup.verifiserKryptertStrom({ lesBit, total }, passphrase);
        const sek = Math.round((Date.now() - start) / 1000);

        // Taggen holdt, men er innholdet en zip? Billig ekstrasjekk som skiller
        // «dekrypterte riktig» fra «dekrypterte riktig til noe meningsfullt».
        const melding = res.zipSignatur
            ? `Verifisert: ${Math.round(res.kryptertBytes / 1024 / 1024)} MB dekryptert og autentisert, innholdet er en gyldig zip`
            : `Dekrypteringen gikk igjennom, men innholdet starter ikke som en zip — undersøk fila`;

        await settVerifiserStatus({
            Status: res.zipSignatur ? 'ok' : 'feil',
            Ferdig: new Date().toISOString(), SistOppdatert: new Date().toISOString(),
            Steg: 'ferdig', Filnavn: filnavn, Kilde: kilde, Hvor: hvor,
            KryptertBytes: res.kryptertBytes, KlartekstBytes: res.klartekstBytes,
            VarighetSekunder: sek, Melding: melding, SistFeil: ''
        });
        hendelser.logg({
            Type: res.zipSignatur ? 'backup.verifisert' : 'backup.verifisering-avvik',
            Aktor: aktor, ObjektType: 'backup', ObjektId: filnavn,
            Melding: `${melding} (${hvor}, ${sek}s)`
        });
        jobbLog(`backup/verifiser-lagret: ${melding}`);
    } catch (e) {
        // «Unsupported state or unable to authenticate data» er GCM-taggen som
        // ikke stemmer: fila er ufullstendig, endret, eller passphrasen er feil.
        const autentiseringsfeil = /unable to authenticate|unsupported state/i.test(e.message || '');
        const melding = autentiseringsfeil
            ? `Fila kunne IKKE autentiseres. Den er ufullstendig eller endret, eller BACKUP_PASSPHRASE er en annen enn da den ble laget. (${e.message})`
            : String(e.message || e);
        jobbLog(`backup/verifiser-lagret FEIL: ${melding}`);
        await settVerifiserStatus({
            Status: 'feil', Ferdig: new Date().toISOString(),
            SistOppdatert: new Date().toISOString(),
            Filnavn: filnavn, Kilde: kilde,
            SistFeil: melding.slice(0, 500), Melding: ''
        });
        hendelser.logg({
            Type: 'backup.verifisering-feil', Aktor: aktor,
            ObjektType: 'backup', ObjektId: filnavn,
            Melding: melding.slice(0, 500)
        });
    }
}

/**
 * POST /api/backup/verifiser-lagret
 * Admin eller x-scheduler-key. Body: { filnavn?, kilde? }
 *
 * filnavn utelatt → siste backup fra statusraden.
 * kilde: 'sharepoint' (standard når Graph er satt opp) eller 'blob'.
 *
 * Svarer 202 og kjører videre i bakgrunnen — 400 MB tar lengre tid enn
 * SWA-gatewayen holder en forbindelse åpen. Følg med på verifiser-status.
 */
app.http('backupVerifiserLagret', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'backup/verifiser-lagret',
    handler: async (request, context) => {
        const auth = schedulerEllerAdmin(request);
        if (!auth.ok) return { status: auth.status, jsonBody: { status: 'feil', melding: auth.melding } };

        const body = await request.json().catch(() => ({}));
        let filnavn = String(body?.filnavn || '').trim();
        if (!filnavn) {
            try {
                const rad = await tabellKlient('CacheMetadata').getEntity(STATUS_PK, STATUS_RK);
                filnavn = rad.Filnavn || '';
            } catch (_) { /* ingen tidligere kjøring */ }
        }
        if (!filnavn) {
            return { status: 400, jsonBody: { status: 'feil', melding: 'Fant ingen backup å verifisere — oppgi filnavn' } };
        }

        const onsket = String(body?.kilde || '').trim().toLowerCase();
        const kilde = onsket === 'blob' ? 'blob'
            : onsket === 'sharepoint' ? 'sharepoint'
            : (graphOpplast.erKonfigurert() ? 'sharepoint' : 'blob');
        if (kilde === 'sharepoint' && !graphOpplast.erKonfigurert()) {
            return { status: 400, jsonBody: { status: 'feil', melding: 'Graph er ikke satt opp — kan bare verifisere kilde "blob"' } };
        }

        const startTid = new Date().toISOString();
        await settVerifiserStatus({
            Status: 'kjører', Startet: startTid, Kilde: kilde, Aktor: auth.upn,
            SistOppdatert: startTid, Steg: 'starter', Filnavn: filnavn,
            Ferdig: '', SistFeil: '', Melding: '', KryptertBytes: 0, KlartekstBytes: 0
        });

        const jobbLog = (...m) => context.log(...m);
        kjorVerifisering(auth.upn, filnavn, kilde, jobbLog);

        return {
            status: 202,
            jsonBody: {
                status: 'startet', filnavn, kilde,
                melding: 'Verifiseringen kjører i bakgrunnen. Følg med på /api/backup/verifiser-status.'
            }
        };
    }
});

/** GET /api/backup/verifiser-status — admin. Resultat for siste verifisering. */
app.http('backupVerifiserStatus', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'backup/verifiser-status',
    handler: async (request, context) => {
        const a = admin(request);
        if (!a.ok) return { status: a.status, jsonBody: { status: 'feil', melding: a.melding } };
        try {
            const rad = await tabellKlient('CacheMetadata').getEntity(STATUS_PK, VERIFISER_RK);
            return {
                jsonBody: {
                    status: rad.Status || 'ukjent',
                    startet: rad.Startet || null,
                    ferdig: rad.Ferdig || null,
                    steg: rad.Steg || null,
                    sistOppdatert: rad.SistOppdatert || null,
                    filnavn: rad.Filnavn || null,
                    kilde: rad.Kilde || null,
                    hvor: rad.Hvor || null,
                    kryptertBytes: rad.KryptertBytes ?? null,
                    klartekstBytes: rad.KlartekstBytes ?? null,
                    varighetSekunder: rad.VarighetSekunder ?? null,
                    melding: rad.Melding || null,
                    sistFeil: rad.SistFeil || null,
                    aktor: rad.Aktor || null
                }
            };
        } catch (e) {
            if (e.statusCode === 404) return { jsonBody: { status: 'aldri-kjørt' } };
            context.log('backup/verifiser-status FEIL:', e.message);
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

module.exports = { vurderKvittering };
