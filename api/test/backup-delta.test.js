/**
 * Tester for full/delta-modellen.
 *
 * De farlige feilene her er stille: et delta som tømmer containeren ved
 * gjenoppretting, eller et delta som utelater en blobb som aldri kom med i
 * noen full. Begge oppdages først den dagen noen faktisk gjenoppretter.
 *
 * Kjøres med:  node api/test/backup-delta.test.js
 */
const backup = require('../src/lib/backup');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

/**
 * Minimal JSZip-erstatning: vi trenger bare å vite hvilke filer som ble lagt
 * inn, ikke å lage en ekte zip.
 */
// Hvilken zip stubben skal levere akkurat nå. Se medStubber().
let aktivZip = null;

function fakeZip() {
    const filer = new Map();
    return { file: (navn, innhold) => filer.set(navn, innhold), filer };
}

/** Tabellklient som leverer et fast sett rader. */
const fakeTabell = (rader) => ({
    async *listEntities() { for (const r of rader) yield r; }
});

/** Container med blobber som har hvert sitt lastModified. */
function fakeContainer(blobber) {
    return {
        async *listBlobsFlat() {
            for (const b of blobber) {
                yield { name: b.navn, properties: { lastModified: new Date(b.endret), contentType: 'application/pdf' } };
            }
        },
        getBlockBlobClient: (navn) => ({
            async downloadToBuffer() {
                const b = blobber.find(x => x.navn === navn);
                return Buffer.from(b.innhold || navn);
            }
        })
    };
}

const FULL_START = '2026-08-24T02:00:00.000Z';
const BLOBBER = [
    { navn: 'gammel-1.pdf', endret: '2026-08-20T10:00:00.000Z' },
    { navn: 'gammel-2.pdf', endret: '2026-08-23T23:59:59.000Z' },
    // Nøyaktig på grensen: lastet opp i det den fulle startet. Skal med i
    // deltaet, ellers kan den ha falt mellom to stoler.
    { navn: 'grense.pdf',   endret: FULL_START },
    { navn: 'ny-1.pdf',     endret: '2026-08-25T08:00:00.000Z' },
    { navn: 'ny-2.pdf',     endret: '2026-08-26T09:00:00.000Z' }
];

async function kjor() {
    // ---------- eksporterContainer med og uten filter ----------
    // eksporterContainer er ikke eksportert, så den testes gjennom byggZip
    // under. Her sjekkes bare at grensetilfellene i filteret er som forventet.
    {
        const etter = (siden) => BLOBBER.filter(b => !(siden && b.endret <= siden));
        sjekk('uten filter tas alt', etter(null).length, 5);
        sjekk('med filter tas bare det nye', etter(FULL_START).map(b => b.navn),
            ['ny-1.pdf', 'ny-2.pdf']);
        // Blobben som ble endret nøyaktig da den fulle startet regnes som
        // dekket av den fulle — derfor <=, ikke <.
        sjekk('grensetilfellet regnes som dekket',
            etter(FULL_START).includes(BLOBBER[2]), false);
    }

    // ---------- byggZip: full ----------
    {
        const zip = fakeZip();
        const res = await medStubber(zip, () => backup.byggZip(() => {}, () => {}, { modus: 'full' }));
        sjekk('full merkes som full', res.manifest.modus, 'full');
        sjekk('full har ingen basertPa', res.manifest.basertPa, null);
        sjekk('Postnumre er med i full',
            res.manifest.tabeller.some(t => t.navn === 'Postnumre'), true);
        sjekk('delte tabeller er med i full',
            res.manifest.delteTabeller.map(t => t.navn), ['TodoPunkter', 'Nokkelkalender']);
        sjekk('alle blobber er med', res.manifest.containers[0].antall, 5);
        sjekk('zipen har blobfilene',
            [...zip.filer.keys()].filter(k => k.startsWith('blobs/vedlegg/') && !k.endsWith('_meta.json')).length, 5);
    }

    // ---------- byggZip: delta ----------
    {
        const zip = fakeZip();
        const res = await medStubber(zip, () => backup.byggZip(() => {}, () => {}, {
            modus: 'delta', basertPa: 'pilot-backup-2026-08-24.fsbk', blobberSiden: FULL_START
        }));
        sjekk('delta merkes som delta', res.manifest.modus, 'delta');
        sjekk('delta husker hva det bygger på', res.manifest.basertPa, 'pilot-backup-2026-08-24.fsbk');
        sjekk('delta husker skjæringstidspunktet', res.manifest.blobberSiden, FULL_START);

        // Postnumre skal IKKE med. Og fordi den ikke står i manifestet, rører
        // ikke restore den heller — det er hele poenget med å utelate den.
        sjekk('Postnumre utelates fra delta',
            res.manifest.tabeller.some(t => t.navn === 'Postnumre'), false);
        sjekk('dynamiske tabeller er fortsatt med i sin helhet',
            res.manifest.tabeller.some(t => t.navn === 'Skjemaer'), true);
        sjekk('delte tabeller utelates fra delta', res.manifest.delteTabeller, []);

        sjekk('bare nye blobber er med', res.manifest.containers[0].antall, 2);
        sjekk('og de gamle telles som hoppet over', res.manifest.containers[0].hoppetOver, 3);
        sjekk('zipen inneholder bare de nye',
            [...zip.filer.keys()].filter(k => k.startsWith('blobs/vedlegg/') && !k.endsWith('_meta.json')).sort(),
            ['blobs/vedlegg/ny-1.pdf', 'blobs/vedlegg/ny-2.pdf']);
    }

    // ---------- restore leser modus fra manifestet ----------
    {
        // Den farligste feilen i hele opplegget: restore som tømmer
        // containeren før den legger inn et delta. Da forsvinner alt som ikke
        // er i deltaet. Modus leses fra manifestet, ikke fra et valg noen må
        // huske å sette.
        const restore = require('../src/lib/restore');
        const kilde = fs2(); // stubber tabell- og blob-laget
        const zip = {
            file: (navn) => navn.endsWith('_meta.json')
                ? { async: async () => JSON.stringify([{ navn: 'ny-1.pdf', storrelse: 9 }]) }
                : null
        };

        const deltaRes = await kilde.kjor(() => restore.kjorRestore(
            { manifest: { modus: 'delta', basertPa: 'x.fsbk', containers: [{ navn: 'vedlegg' }] }, zip }, () => {}));
        sjekk('delta wiper ikke containeren', kilde.wipet, []);
        sjekk('og rapporterer modus', deltaRes.modus, 'delta');

        kilde.nullstill();
        const fullRes = await kilde.kjor(() => restore.kjorRestore(
            { manifest: { containers: [{ navn: 'vedlegg' }] }, zip }, () => {}));
        sjekk('manifest uten modus behandles som full', fullRes.modus, 'full');
        sjekk('full wiper containeren', kilde.wipet, ['vedlegg']);
    }

    // ---------- ekstern kilde ----------
    {
        // Backup av et annet miljø: alt skal leses fra den oppgitte kilden, og
        // ingenting fra vårt eget lager. Går det galt her, får man en fil
        // merket «Production» full av dev-data — en backup som ser riktig ut
        // og er ubrukelig.
        const sett = [];
        const kilde = {
            tabell: (navn) => { sett.push(`tabell:${navn}`); return fakeTabell([{ partitionKey: 'p', rowKey: navn }]); },
            container: (navn) => { sett.push(`container:${navn}`); return fakeContainer(navn === 'vedlegg' ? BLOBBER : []); },
            deltCs: ''
        };
        const zip = fakeZip();
        const res = await medStubber(zip, () => backup.byggZip(() => {}, () => {}, {
            modus: 'full', kilde, miljo: 'Production'
        }));

        sjekk('miljømerket kommer fra parameteren', res.manifest.miljø, 'Production');
        sjekk('alle tabeller ble lest fra den eksterne kilden',
            res.manifest.tabeller.every(t => sett.includes(`tabell:${t.navn}`)), true);
        sjekk('containerne også', sett.includes('container:vedlegg'), true);
        // Våre egne delte tabeller skal ikke havne i en annen tenants backup.
        sjekk('delte tabeller utelates for ekstern kilde', res.manifest.delteTabeller, []);
    }

    // ---------- kildeFra bygger klienter av en connection string ----------
    {
        const cs = 'DefaultEndpointsProtocol=https;AccountName=stfhsprod;AccountKey=abc==;EndpointSuffix=core.windows.net';
        const k = backup.kildeFra(cs);
        sjekk('kildeFra gir en tabellklient', typeof k.tabell, 'function');
        sjekk('kildeFra gir en containerklient', typeof k.container, 'function');
        sjekk('og tar ikke med våre delte tabeller', k.deltCs, '');
    }

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
}

/**
 * Bytter ut storage-laget mens byggZip kjører. backup.js henter klientene via
 * de samme modulene, så det holder å bytte funksjonene på moduleksporten.
 */
async function medStubber(zip, fn) {
    const storage = require('../src/lib/storage');
    const blob = require('../src/lib/blob');
    const Module = require('module');

    const orig = {
        tabellKlient: storage.tabellKlient,
        tabellKlientFra: storage.tabellKlientFra,
        containerKlient: blob.containerKlient,
        cs: process.env.TODO_STORAGE_CONNECTION_STRING
    };
    storage.tabellKlient = () => fakeTabell([{ partitionKey: 'p', rowKey: 'r', Verdi: 1 }]);
    storage.tabellKlientFra = () => fakeTabell([{ partitionKey: 'p', rowKey: 'r' }]);
    blob.containerKlient = (navn) => navn === 'vedlegg' ? fakeContainer(BLOBBER) : fakeContainer([]);
    process.env.TODO_STORAGE_CONNECTION_STRING = 'stub';

    // byggZip lager sin egen JSZip, og cacher klassen etter første kall. Derfor
    // peker stubben på en variabel vi kan sette om, i stedet for på én zip.
    //
    // Vi fanger opp selve require-kallet i stedet for å skrive i require.cache:
    // cache-varianten krever require.resolve('jszip'), som kaster når pakken
    // ikke er installert. Testene skal kunne kjøre uten node_modules — deploy
    // kjører dem uten npm ci, og en test som krever pakker stopper utrullingen.
    aktivZip = zip;
    const origLoad = Module._load;
    Module._load = function (req, ...rest) {
        if (req === 'jszip') return function () { return aktivZip; };
        return origLoad.call(this, req, ...rest);
    };

    try {
        return await fn();
    } finally {
        storage.tabellKlient = orig.tabellKlient;
        storage.tabellKlientFra = orig.tabellKlientFra;
        blob.containerKlient = orig.containerKlient;
        if (orig.cs === undefined) delete process.env.TODO_STORAGE_CONNECTION_STRING;
        else process.env.TODO_STORAGE_CONNECTION_STRING = orig.cs;
        Module._load = origLoad;
    }
}

/** Stubber wipe/import i restore ved å bytte ut storage-laget under den. */
function fs2() {
    const storage = require('../src/lib/storage');
    const blob = require('../src/lib/blob');
    const wipet = [];
    return {
        get wipet() { return wipet; },
        nullstill() { wipet.length = 0; },
        async kjor(fn) {
            const orig = { containerKlient: blob.containerKlient, tabellKlient: storage.tabellKlient };
            blob.containerKlient = (navn) => ({
                // wipeContainer er det eneste som lister — registrerer vi kallet
                // her, ser vi presist om containeren ble tømt.
                async *listBlobsFlat() { wipet.push(navn); },
                async createIfNotExists() { return {}; },
                getBlockBlobClient: () => ({
                    async deleteIfExists() { return { succeeded: true }; },
                    async uploadData() { return {}; }
                })
            });
            try { return await fn(); }
            finally { blob.containerKlient = orig.containerKlient; storage.tabellKlient = orig.tabellKlient; }
        }
    };
}

kjor().catch(e => { console.error('Testen krasjet:', e); process.exit(1); });
