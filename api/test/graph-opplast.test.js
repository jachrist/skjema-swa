/**
 * Tester for Graph-opplastingen av backup til SharePoint.
 *
 * Alt går mot en stubbet fetch — ingen nettverk, ingen node_modules. Det som
 * testes er akkurat det som gikk galt i Power Automate-veien: at bitene dekker
 * fila nøyaktig, at Content-Range er riktig formet, og at en ufullstendig
 * opplasting blir oppdaget i stedet for å se grønn ut.
 *
 * Kjøres med:  node api/test/graph-opplast.test.js
 */
const graph = require('../src/lib/graph-opplast');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const KONFIG = {
    tenantId: 'tenant-1', clientId: 'app-1', clientSecret: 'hemmelig',
    site: 'https://fhs.sharepoint.com/sites/Skjemasystem',
    bibliotek: '', mappe: 'Backup/Skjema'
};

/** Svar som ligner nok på fetch til at modulen ikke merker forskjell. */
const svar = (status, kropp) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof kropp === 'string' ? kropp : JSON.stringify(kropp ?? {}))
});

/**
 * Stubbet Graph. Samler opp alt den blir bedt om, slik at testene kan se
 * hvilke kall som ble gjort og med hvilke headere.
 */
function lagGraph({ totalStorrelse, feilPaBit = null, rapportertStorrelse = null } = {}) {
    const kall = [];
    const mottatt = [];
    let levert = 0;
    const fetchFn = async (url, opts = {}) => {
        kall.push({ url, method: opts.method || 'GET', headers: opts.headers || {} });

        if (url.includes('/oauth2/v2.0/token')) {
            return svar(200, { access_token: 'token-abc', expires_in: 3600 });
        }
        if (url.endsWith('/sites/fhs.sharepoint.com:/sites/Skjemasystem')) {
            return svar(200, { id: 'site-1', displayName: 'Skjemasystem' });
        }
        if (url.endsWith('/sites/site-1/drive')) {
            return svar(200, { id: 'drive-1', name: 'Dokumenter' });
        }
        if (url.endsWith('/sites/site-1/drives')) {
            return svar(200, { value: [{ id: 'drive-1', name: 'Dokumenter' }, { id: 'drive-2', name: 'Backup' }] });
        }
        if (url.includes('createUploadSession')) {
            return svar(200, { uploadUrl: 'https://opplasting.example/sesjon-1' });
        }
        if (url.startsWith('https://opplasting.example/')) {
            const cr = opts.headers['Content-Range'];
            mottatt.push({ contentRange: cr, bytes: opts.body.length, harAuth: 'Authorization' in opts.headers });
            levert++;
            if (feilPaBit && levert === feilPaBit) return svar(500, 'Internal Server Error');
            // «bytes <fra>-<til>/<total>». Strengt mønster, så en feilformet
            // header i modulen slår ut her i stedet for å bli tolket velvillig.
            const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(cr));
            if (!m) return svar(400, `ugyldig Content-Range: ${cr}`);
            const til = Number(m[2]);
            const slutt = Number(m[3]);
            if (til + 1 >= slutt) {
                return svar(201, { id: 'item-1', size: rapportertStorrelse ?? totalStorrelse, webUrl: 'https://fhs.sharepoint.com/…/fil.fsbk' });
            }
            return svar(202, { nextExpectedRanges: [`${til + 1}-`] });
        }
        return svar(404, 'ukjent url i stubben: ' + url);
    };
    return { fetchFn, kall, mottatt };
}

/** Blob-klient som leverer forutsigbare bytes, så innholdet kan verifiseres. */
function lagBlob(total) {
    const hele = Buffer.alloc(total);
    for (let i = 0; i < total; i++) hele[i] = i % 251;
    return {
        hele,
        async downloadToBuffer(fra, antall) { return hele.subarray(fra, fra + antall); }
    };
}

async function kjor() {
    // ---------- siteReferanse ----------
    sjekk('full URL blir Graph-referanse',
        graph.siteReferanse('https://fhs.sharepoint.com/sites/Skjemasystem'),
        'fhs.sharepoint.com:/sites/Skjemasystem');
    sjekk('ferdig referanse beholdes',
        graph.siteReferanse('fhs.sharepoint.com:/sites/Skjemasystem'),
        'fhs.sharepoint.com:/sites/Skjemasystem');
    sjekk('vertsnavn med sti uten protokoll',
        graph.siteReferanse('fhs.sharepoint.com/sites/Skjemasystem'),
        'fhs.sharepoint.com:/sites/Skjemasystem');
    sjekk('etterslepende skråstrek fjernes',
        graph.siteReferanse('https://fhs.sharepoint.com/sites/Skjemasystem/'),
        'fhs.sharepoint.com:/sites/Skjemasystem');
    sjekk('rot-området uten sti', graph.siteReferanse('https://fhs.sharepoint.com'), 'fhs.sharepoint.com');
    sjekk('tom verdi gir null', graph.siteReferanse(''), null);

    // ---------- stier ----------
    sjekk('mappe og filnavn settes sammen',
        graph.elementSti('Backup/Skjema', 'fil.fsbk'), 'Backup/Skjema/fil.fsbk');
    sjekk('tom mappe gir bare filnavnet', graph.elementSti('', 'fil.fsbk'), 'fil.fsbk');
    sjekk('doble skråstreker ryddes', graph.elementSti('/Backup//Skjema/', 'fil.fsbk'), 'Backup/Skjema/fil.fsbk');
    sjekk('skråstreker overlever kodingen',
        graph.kodetSti('Backup/Skjema æøå/fil navn.fsbk'),
        'Backup/Skjema%20%C3%A6%C3%B8%C3%A5/fil%20navn.fsbk');

    // ---------- beregnBiter ----------
    {
        const MiB = 1024 * 1024;
        const biter = graph.beregnBiter(25 * MiB, 10 * MiB);
        sjekk('riktig antall biter', biter.length, 3);
        sjekk('summen er hele fila', biter.reduce((s, b) => s + b.bytes, 0), 25 * MiB);
        sjekk('ingen hull mellom bitene',
            biter.every((b, i) => i === 0 || b.fra === biter[i - 1].til + 1), true);
        sjekk('content-range er riktig formet',
            biter[0].contentRange, `bytes 0-${10 * MiB - 1}/${25 * MiB}`);
        sjekk('siste bit avsluttes på siste byte',
            biter[2].contentRange, `bytes ${20 * MiB}-${25 * MiB - 1}/${25 * MiB}`);

        // Graph avviser opplastingen midt i løpet hvis en bit som ikke er den
        // siste bryter 320 KiB-regelen.
        const skjev = graph.beregnBiter(30 * MiB, 7_000_000);
        sjekk('bitstørrelsen rundes til multiplum av 320 KiB',
            skjev.slice(0, -1).every(b => b.bytes % graph.BIT_JUSTERING === 0), true);
        sjekk('for liten bitstørrelse løftes til minstemålet',
            graph.beregnBiter(1000, 10)[0].bytes, 1000);
        sjekk('tom fil gir ingen biter', graph.beregnBiter(0), []);
    }

    // ---------- nesteForventet ----------
    sjekk('åpen range leses', graph.nesteForventet(['1048576-']), 1048576);
    sjekk('lukket range leses', graph.nesteForventet(['200-499']), 200);
    sjekk('tom liste gir null', graph.nesteForventet([]), null);
    sjekk('udefinert gir null', graph.nesteForventet(undefined), null);

    // ---------- konfigurasjonssjekk ----------
    sjekk('mangler alt uten env', graph.manglerKonfig({}),
        ['GRAPH_TENANT_ID', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET', 'BACKUP_SHAREPOINT_SITE']);
    sjekk('komplett konfig mangler ingenting', graph.manglerKonfig(KONFIG), []);
    sjekk('erKonfigurert følger manglerKonfig', graph.erKonfigurert(KONFIG), true);
    sjekk('halvferdig konfig avvises',
        graph.erKonfigurert({ ...KONFIG, clientSecret: '' }), false);

    // ---------- hel opplasting ----------
    {
        const total = 25 * 1024 * 1024;
        const g = lagGraph({ totalStorrelse: total });
        const blob = lagBlob(total);
        graph.tomTokenCache();

        const res = await graph.lastOppBackup(
            { blob, filnavn: 'Production-backup.fsbk', storrelseBytes: total },
            () => {},
            { fetchFn: g.fetchFn, konfig: KONFIG, bitStorrelse: 10 * 1024 * 1024 }
        );

        sjekk('opplastingen er ok', res.status, 'ok');
        sjekk('tre biter sendt', g.mottatt.length, 3);
        sjekk('alle bytes kom fram', g.mottatt.reduce((s, m) => s + m.bytes, 0), total);
        sjekk('bitene kom i rekkefølge',
            g.mottatt.map(m => m.contentRange),
            graph.beregnBiter(total, 10 * 1024 * 1024).map(b => b.contentRange));
        // uploadUrl er forhåndsautorisert. Sender vi Authorization dit, avviser Graph kallet.
        sjekk('ingen Authorization mot uploadUrl', g.mottatt.every(m => !m.harAuth), true);
        sjekk('stien inkluderer mappa', res.sti, 'Backup/Skjema/Production-backup.fsbk');
        sjekk('webUrl følger med', !!res.webUrl, true);
        sjekk('sesjonen ble opprettet én gang',
            g.kall.filter(k => k.url.includes('createUploadSession')).length, 1);
        sjekk('standardbiblioteket brukes uten navn', res.bibliotek, 'Dokumenter');
    }

    // ---------- navngitt bibliotek ----------
    {
        const total = 10 * 1024 * 1024;
        const g = lagGraph({ totalStorrelse: total });
        graph.tomTokenCache();
        const res = await graph.lastOppBackup(
            { blob: lagBlob(total), filnavn: 'f.fsbk', storrelseBytes: total },
            () => {},
            { fetchFn: g.fetchFn, konfig: { ...KONFIG, bibliotek: 'Backup' }, bitStorrelse: 10 * 1024 * 1024 }
        );
        sjekk('navngitt bibliotek slås opp', res.bibliotek, 'Backup');
        sjekk('og drives-lista ble spurt',
            g.kall.some(k => k.url.endsWith('/sites/site-1/drives')), true);
    }

    // ---------- ufullstendig opplasting oppdages ----------
    {
        // Nøyaktig feilen som gikk ubemerket i PA: fila så ut til å bli
        // opprettet, men innholdet var ikke der.
        const total = 10 * 1024 * 1024;
        const g = lagGraph({ totalStorrelse: total, rapportertStorrelse: 4 });
        graph.tomTokenCache();
        const res = await graph.lastOppBackup(
            { blob: lagBlob(total), filnavn: 'f.fsbk', storrelseBytes: total },
            () => {},
            { fetchFn: g.fetchFn, konfig: KONFIG, bitStorrelse: 10 * 1024 * 1024 }
        );
        sjekk('feil størrelse gir feil', res.status, 'feil');
        sjekk('og melder hva avviket er', /er 4 bytes, men backupen er/.test(res.melding), true);
    }

    // ---------- manglende konfigurasjon ----------
    {
        const res = await graph.lastOppBackup(
            { blob: lagBlob(10), filnavn: 'f.fsbk', storrelseBytes: 10 },
            () => {},
            { fetchFn: async () => svar(500, 'skulle aldri blitt kalt'), konfig: { ...KONFIG, site: '' } }
        );
        sjekk('uten konfig hoppes det over', res.status, 'hoppet-over');
        sjekk('og sier hva som mangler',
            /BACKUP_SHAREPOINT_SITE/.test(res.melding), true);
    }

    // ---------- tokencache ----------
    {
        const total = 10 * 1024 * 1024;
        graph.tomTokenCache();
        const g = lagGraph({ totalStorrelse: total });
        const args = [{ blob: lagBlob(total), filnavn: 'f.fsbk', storrelseBytes: total }, () => {},
            { fetchFn: g.fetchFn, konfig: KONFIG, bitStorrelse: 10 * 1024 * 1024 }];
        await graph.lastOppBackup(...args);
        await graph.lastOppBackup(...args);
        sjekk('tokenet hentes bare én gang',
            g.kall.filter(k => k.url.includes('/oauth2/v2.0/token')).length, 1);
    }

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
}

kjor().catch(e => { console.error('Testen krasjet:', e); process.exit(1); });
