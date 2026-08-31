/**
 * Opplasting av backup til et SharePoint-bibliotek via Microsoft Graph.
 *
 * Bakgrunn: veien om Power Automate viste seg uholdbar for store filer.
 * HTTP-handlingen der leser hele svaret i minnet med et tak på 100 MiB, og
 * blir svaret stort nok lagres det som «partial content» som ingen uttrykk
 * kan røre. Slår man på chunking overtar PA Range-headeren selv og kolliderer
 * med vår egen. En Graph upload session har ingen av delene: vi bestemmer
 * bitstørrelsen, hver bit sier eksplisitt hvilke bytes den er, og taket er
 * 250 GB.
 *
 * Vi laster opp fra backup-blobben vi allerede har skrevet, én bit om gangen.
 * Minnebruken er en konstant, ikke en funksjon av filstørrelsen.
 *
 * Autentisering: client credentials mot måltenanten. App-registreringen
 * trenger ikke ligge i samme tenant som appen — SWA-en er bare en HTTP-klient
 * med en hemmelighet. Derfor kan både pilot og prod laste opp til samme
 * bibliotek uten multi-tenant-oppsett og uten kryssgående datatilgang.
 *
 * Env-vars:
 *   GRAPH_TENANT_ID              — tenanten biblioteket ligger i
 *   GRAPH_CLIENT_ID              — app-registreringen
 *   GRAPH_CLIENT_SECRET          — hemmelighet (Key Vault-referanse)
 *   BACKUP_SHAREPOINT_SITE       — «https://fhs.sharepoint.com/sites/Skjema»
 *                                  eller «fhs.sharepoint.com:/sites/Skjema»
 *   BACKUP_SHAREPOINT_BIBLIOTEK  — valgfritt bibliotek-navn; uten dette brukes
 *                                  områdets standardbibliotek
 *   BACKUP_SHAREPOINT_MAPPE      — valgfri undermappe, f.eks. «Backup/Skjema»
 *
 * Rettigheter: appen bør ha Sites.Selected, ikke Files.ReadWrite.All, og få
 * skrivetilgang til nøyaktig dette området. Se docs/BACKUP-SHAREPOINT.md.
 */
const GRAPH = 'https://graph.microsoft.com/v1.0';

// Graph krever at alle biter unntatt den siste er et multiplum av 320 KiB.
// 10 MiB = 320 KiB × 32.
const BIT_STORRELSE = 10 * 1024 * 1024;
const BIT_JUSTERING = 320 * 1024;

const HTTP_TIMEOUT_MS = 120_000;
const MAKS_FORSOK = 4;

let tokenCache = null; // { nokkel, token, utloper }

function konfig() {
    const les = (n) => String(process.env[n] || '').trim();
    return {
        tenantId: les('GRAPH_TENANT_ID'),
        clientId: les('GRAPH_CLIENT_ID'),
        clientSecret: les('GRAPH_CLIENT_SECRET'),
        site: les('BACKUP_SHAREPOINT_SITE'),
        bibliotek: les('BACKUP_SHAREPOINT_BIBLIOTEK'),
        mappe: les('BACKUP_SHAREPOINT_MAPPE')
    };
}

/** Er Graph-veien satt opp? Uten dette faller backupjobben tilbake til PA-flyten. */
function erKonfigurert(k = konfig()) {
    return !!(k.tenantId && k.clientId && k.clientSecret && k.site);
}

/** Hva som mangler — til feilmeldinger og helsesjekk. */
function manglerKonfig(k = konfig()) {
    const kreves = {
        GRAPH_TENANT_ID: k.tenantId,
        GRAPH_CLIENT_ID: k.clientId,
        GRAPH_CLIENT_SECRET: k.clientSecret,
        BACKUP_SHAREPOINT_SITE: k.site
    };
    return Object.entries(kreves).filter(([, v]) => !v).map(([n]) => n);
}

/**
 * Graph-referansen til et område, på formen «vertsnavn:/sites/Navn».
 * Tar imot både full URL og ferdig referanse, siden begge deler er det folk
 * har for hånden når de setter env-varen.
 */
function siteReferanse(verdi) {
    const s = String(verdi || '').trim().replace(/\/+$/, '');
    if (!s) return null;
    let vert, sti;
    if (/^https?:\/\//i.test(s)) {
        const u = new URL(s);
        vert = u.hostname;
        sti = decodeURIComponent(u.pathname);
    } else if (s.includes(':')) {
        const i = s.indexOf(':');
        vert = s.slice(0, i);
        sti = s.slice(i + 1);
    } else {
        const i = s.indexOf('/');
        vert = i < 0 ? s : s.slice(0, i);
        sti = i < 0 ? '' : s.slice(i);
    }
    sti = sti.replace(/\/+$/, '');
    if (!vert) return null;
    return sti && sti !== '/' ? `${vert}:${sti}` : vert;
}

/** Full sti i biblioteket, uten ledende og doble skråstreker. */
function elementSti(mappe, filnavn) {
    const deler = [...String(mappe || '').split('/'), String(filnavn || '')]
        .map(d => d.trim())
        .filter(Boolean);
    return deler.join('/');
}

/** Graph vil ha stien URL-kodet, men skråstrekene skal stå. */
function kodetSti(sti) {
    return String(sti).split('/').map(encodeURIComponent).join('/');
}

/**
 * Del opp filen. Alle biter unntatt den siste må være et multiplum av 320 KiB,
 * ellers avviser Graph opplastingen med 400 midt i løpet.
 */
function beregnBiter(total, bitStorrelse = BIT_STORRELSE) {
    const t = Math.max(0, Number(total) || 0);
    const b = Math.max(BIT_JUSTERING, Math.floor(bitStorrelse / BIT_JUSTERING) * BIT_JUSTERING);
    const biter = [];
    for (let fra = 0; fra < t; fra += b) {
        const til = Math.min(t, fra + b) - 1;
        biter.push({ fra, til, bytes: til - fra + 1, contentRange: `bytes ${fra}-${til}/${t}` });
    }
    return biter;
}

/**
 * Hvor Graph vil ha neste byte, lest ut av nextExpectedRanges («12345-» eller
 * «12345-67890»). Brukes til å ta opp igjen en opplasting som ble avbrutt,
 * i stedet for å begynne på null.
 */
function nesteForventet(nextExpectedRanges) {
    if (!Array.isArray(nextExpectedRanges) || nextExpectedRanges.length === 0) return null;
    const forste = String(nextExpectedRanges[0] || '');
    const n = Number(forste.split('-')[0]);
    return Number.isFinite(n) && n >= 0 ? n : null;
}

async function medRetry(navn, fn, log) {
    let sisteFeil = null;
    for (let forsok = 1; forsok <= MAKS_FORSOK; forsok++) {
        try {
            return await fn();
        } catch (e) {
            sisteFeil = e;
            // 4xx er våre egne feil og blir ikke bedre av å prøve igjen.
            if (e.status && e.status < 500 && e.status !== 429) throw e;
            if (forsok === MAKS_FORSOK) break;
            const ventMs = Math.min(30_000, 1000 * 2 ** (forsok - 1));
            log(`graph: ${navn} feilet (${e.message}) — nytt forsøk om ${ventMs} ms`);
            await new Promise(r => setTimeout(r, ventMs));
        }
    }
    throw sisteFeil;
}

function graphFeil(melding, status, tekst) {
    const e = new Error(`${melding}${status ? ` (HTTP ${status})` : ''}${tekst ? `: ${String(tekst).slice(0, 300)}` : ''}`);
    e.status = status;
    return e;
}

/** Token via client credentials. Caches til like før utløp. */
async function hentToken(k, fetchFn) {
    const nokkel = `${k.tenantId}|${k.clientId}`;
    if (tokenCache && tokenCache.nokkel === nokkel && tokenCache.utloper > Date.now() + 60_000) {
        return tokenCache.token;
    }
    const kropp = new URLSearchParams({
        client_id: k.clientId,
        client_secret: k.clientSecret,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials'
    });
    const svar = await fetchFn(`https://login.microsoftonline.com/${encodeURIComponent(k.tenantId)}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: kropp.toString(),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
    });
    const tekst = await svar.text();
    if (!svar.ok) throw graphFeil('Fikk ikke token fra Entra', svar.status, tekst);
    const data = JSON.parse(tekst);
    if (!data.access_token) throw graphFeil('Entra svarte uten access_token', svar.status, tekst);
    tokenCache = {
        nokkel,
        token: data.access_token,
        utloper: Date.now() + (Number(data.expires_in) || 3600) * 1000
    };
    return tokenCache.token;
}

/** Glem tokenet — brukes av tester og ved rotasjon. */
function tomTokenCache() {
    tokenCache = null;
}

async function graphGet(sti, token, fetchFn) {
    const svar = await fetchFn(`${GRAPH}${sti}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
    });
    const tekst = await svar.text();
    if (!svar.ok) throw graphFeil(`Graph GET ${sti} feilet`, svar.status, tekst);
    return JSON.parse(tekst);
}

/** Slå opp område og bibliotek. Begge er stabile, men slås opp per kjøring. */
async function finnDrive(k, token, fetchFn, log) {
    const ref = siteReferanse(k.site);
    if (!ref) throw graphFeil(`BACKUP_SHAREPOINT_SITE er ikke en gyldig områdeadresse: «${k.site}»`, 400);

    const omrade = await graphGet(`/sites/${ref}`, token, fetchFn);
    if (!omrade?.id) throw graphFeil(`Fant ikke SharePoint-området «${k.site}»`, 404);
    log(`graph: område ${omrade.displayName || omrade.name || ref}`);

    if (!k.bibliotek) {
        const drive = await graphGet(`/sites/${omrade.id}/drive`, token, fetchFn);
        return { driveId: drive.id, driveNavn: drive.name || '(standardbibliotek)' };
    }
    const liste = await graphGet(`/sites/${omrade.id}/drives`, token, fetchFn);
    const treff = (liste.value || []).find(d =>
        String(d.name || '').toLowerCase() === k.bibliotek.toLowerCase());
    if (!treff) {
        const navn = (liste.value || []).map(d => d.name).join(', ');
        throw graphFeil(`Fant ikke biblioteket «${k.bibliotek}» på området. Tilgjengelige: ${navn || '(ingen)'}`, 404);
    }
    return { driveId: treff.id, driveNavn: treff.name };
}

async function opprettSesjon(driveId, sti, token, fetchFn) {
    const url = `${GRAPH}/drives/${driveId}/root:/${kodetSti(sti)}:/createUploadSession`;
    const svar = await fetchFn(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            item: {
                '@microsoft.graph.conflictBehavior': 'replace',
                name: sti.split('/').pop()
            }
        }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
    });
    const tekst = await svar.text();
    if (!svar.ok) throw graphFeil(`Kunne ikke opprette opplastingssesjon for ${sti}`, svar.status, tekst);
    const data = JSON.parse(tekst);
    if (!data.uploadUrl) throw graphFeil('Graph svarte uten uploadUrl', svar.status, tekst);
    return data.uploadUrl;
}

/**
 * Last opp én bit.
 *
 * Content-Length settes ikke: fetch regner den ut selv, og forsøk på å sette
 * den manuelt avvises som en forbudt header. uploadUrl er forhåndsautorisert,
 * så den skal IKKE ha Authorization — sender vi den, avviser Graph kallet.
 */
async function lastOppBit(uploadUrl, bit, data, fetchFn) {
    const svar = await fetchFn(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Range': bit.contentRange },
        body: data,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
    });
    const tekst = await svar.text().catch(() => '');
    if (svar.status === 202) {
        let neste = null;
        try { neste = nesteForventet(JSON.parse(tekst)?.nextExpectedRanges); } catch (_) { /* tomt svar er lov */ }
        return { ferdig: false, neste };
    }
    if (svar.status === 200 || svar.status === 201) {
        let element = null;
        try { element = JSON.parse(tekst); } catch (_) { /* tomt svar er lov */ }
        return { ferdig: true, element };
    }
    throw graphFeil(`Opplasting av ${bit.contentRange} feilet`, svar.status, tekst);
}

/**
 * Last opp en backup-blob til SharePoint.
 *
 * @param {object} args
 * @param {object} args.blob          BlockBlobClient for den ferdige backupen
 * @param {string} args.filnavn       Filnavn i biblioteket
 * @param {number} args.storrelseBytes Forventet størrelse
 * @param {(m:string)=>void} log
 * @returns {Promise<{status,melding,storrelseBytes,webUrl,sti,bibliotek,biter}>}
 */
async function lastOppBackup({ blob, filnavn, storrelseBytes }, log = () => {}, deps = {}) {
    const fetchFn = deps.fetchFn || fetch;
    const k = deps.konfig || konfig();

    const mangler = manglerKonfig(k);
    if (mangler.length) {
        return {
            status: 'hoppet-over',
            melding: `Graph-opplasting ikke satt opp — mangler ${mangler.join(', ')}`
        };
    }

    const start = Date.now();
    const token = await medRetry('token', () => hentToken(k, fetchFn), log);
    const { driveId, driveNavn } = await medRetry('oppslag', () => finnDrive(k, token, fetchFn, log), log);
    const sti = elementSti(k.mappe, filnavn);
    const uploadUrl = await medRetry('sesjon', () => opprettSesjon(driveId, sti, token, fetchFn), log);

    const biter = beregnBiter(storrelseBytes, deps.bitStorrelse || BIT_STORRELSE);
    log(`graph: laster opp ${filnavn} til ${driveNavn}/${sti} — ${biter.length} biter`);

    let element = null;
    let i = 0;
    while (i < biter.length) {
        const bit = biter[i];
        const data = await medRetry(`les bit ${i + 1}`,
            () => blob.downloadToBuffer(bit.fra, bit.bytes), log);
        const res = await medRetry(`bit ${i + 1}/${biter.length}`,
            () => lastOppBit(uploadUrl, bit, data, fetchFn), log);

        if (res.ferdig) { element = res.element; break; }
        // Graph forteller hvor den vil ha neste byte. Normalt er det bare
        // neste bit, men etter et avbrudd kan den be om noe annet — da følger
        // vi den i stedet for å anta.
        if (res.neste !== null && res.neste !== bit.til + 1) {
            const j = biter.findIndex(b => b.fra === res.neste);
            if (j >= 0) { i = j; continue; }
            log(`graph: Graph ba om byte ${res.neste}, som ikke er starten på en bit — fortsetter sekvensielt`);
        }
        i++;
    }

    const sek = Math.round((Date.now() - start) / 1000);
    const lastet = Number(element?.size);

    // Størrelsen Graph rapporterer er den ekte kontrollen: stemmer den ikke,
    // er fila i biblioteket ufullstendig, og da er den verdiløs den dagen den
    // trengs. Nettopp dette gikk galt og ubemerket i PA-veien.
    if (!element) {
        return {
            status: 'feil',
            melding: `Opplastingen ble aldri bekreftet av Graph etter ${biter.length} biter (${sek}s)`
        };
    }
    if (Number.isFinite(lastet) && Number(storrelseBytes) && lastet !== Number(storrelseBytes)) {
        return {
            status: 'feil',
            melding: `Fila i SharePoint er ${lastet} bytes, men backupen er ${storrelseBytes}. Opplastingen er ufullstendig.`,
            storrelseBytes: lastet,
            webUrl: element.webUrl || null
        };
    }

    log(`graph: ${filnavn} lastet opp (${lastet} bytes, ${biter.length} biter, ${sek}s)`);
    return {
        status: 'ok',
        melding: `Lastet opp til ${driveNavn}/${sti}`,
        storrelseBytes: lastet,
        webUrl: element.webUrl || null,
        sti,
        bibliotek: driveNavn,
        biter: biter.length,
        varighetSekunder: sek
    };
}

/**
 * Leser for en fil som allerede ligger i biblioteket.
 *
 * Poenget er å kunne verifisere *kopien* — den som ligger utenfor Azure og
 * som faktisk skal redde oss. En verifisering av blobben i Azure sier
 * ingenting om hva som kom fram til SharePoint.
 *
 * `@microsoft.graph.downloadUrl` er en kortlevd, forhåndsautorisert adresse.
 * Den tåler Range-forespørsler, og skal ikke ha Authorization-header.
 */
async function lagNedlaster(filnavn, log = () => {}, deps = {}) {
    const fetchFn = deps.fetchFn || fetch;
    const k = deps.konfig || konfig();
    const mangler = manglerKonfig(k);
    if (mangler.length) throw graphFeil(`Graph er ikke satt opp — mangler ${mangler.join(', ')}`, 400);

    const token = await medRetry('token', () => hentToken(k, fetchFn), log);
    const { driveId, driveNavn } = await medRetry('oppslag', () => finnDrive(k, token, fetchFn, log), log);
    const sti = elementSti(k.mappe, filnavn);

    const element = await medRetry('elementoppslag',
        () => graphGet(`/drives/${driveId}/root:/${kodetSti(sti)}`, token, fetchFn), log);
    const url = element['@microsoft.graph.downloadUrl'];
    if (!url) throw graphFeil(`Fant ingen nedlastingsadresse for ${sti}`, 404);

    return {
        sti,
        bibliotek: driveNavn,
        webUrl: element.webUrl || null,
        storrelseBytes: Number(element.size) || 0,
        async lesBit(fra, antall) {
            return medRetry(`les ${fra}+${antall}`, async () => {
                const svar = await fetchFn(url, {
                    headers: { Range: `bytes=${fra}-${fra + antall - 1}` },
                    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
                });
                if (svar.status !== 206 && svar.status !== 200) {
                    throw graphFeil(`Nedlasting av bytes ${fra}-${fra + antall - 1} feilet`, svar.status,
                        await svar.text().catch(() => ''));
                }
                return Buffer.from(await svar.arrayBuffer());
            }, log);
        }
    };
}

module.exports = {
    lastOppBackup, lagNedlaster, erKonfigurert, manglerKonfig, konfig,
    siteReferanse, elementSti, kodetSti, beregnBiter, nesteForventet,
    hentToken, tomTokenCache,
    BIT_STORRELSE, BIT_JUSTERING
};
