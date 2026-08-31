/**
 * Tester for den strømmende backup-skrivingen.
 *
 * Det kritiske her er at containerformatet er uendret selv om fila nå skrives
 * i blokker: auth-taggen ligger i hodet, men er ikke kjent før siste byte er
 * kryptert. Løsningen er å stage hodeblokken sist og likevel commite den
 * først. Går det galt, oppdages det først den dagen noen faktisk skal
 * gjenopprette — derfor testes det her.
 *
 * Kjøres med:  node api/test/backup-strom.test.js
 */
const { Readable } = require('stream');
const backup = require('../src/lib/backup');
const krypto = require('../src/lib/backup-krypto');

// jszip krever node_modules. Resten av testen skal kunne kjøre uten, slik at
// deploy-steget slipper npm ci — zip-testen hoppes da over. CI kjører npm ci
// først, så der dekkes den.
let JSZip = null;
try { JSZip = require('jszip'); } catch (_) { /* hoppes over */ }

const PASSORD = 'test-passphrase-minst-16-tegn';

let ok = 0, feil = 0, hoppet = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

/** Kjører krypteringen med et kjent passord, uten å røre BACKUP_PASSPHRASE. */
function medTestpassord(fn) {
    const original = krypto.startKryptering;
    krypto.startKryptering = () => krypto.startKrypteringMed(PASSORD);
    try { return fn(); } finally { krypto.startKryptering = original; }
}

/** Block blob-klient som bare husker hva den fikk. */
function fakeBlob() {
    const blokker = new Map();
    let commitListe = null, opsjoner = null;
    return {
        async stageBlock(id, body, lengde) {
            if (lengde !== body.length) throw new Error(`stageBlock: lengde ${lengde} != ${body.length}`);
            if (blokker.has(id)) throw new Error(`stageBlock: id ${id} brukt to ganger`);
            blokker.set(id, Buffer.from(body));
        },
        async commitBlockList(ider, opts) { commitListe = ider; opsjoner = opts; },
        antallBlokker: () => blokker.size,
        ider: () => [...blokker.keys()],
        commitListe: () => commitListe,
        opsjoner: () => opsjoner,
        // Fila slik Azure ville satt den sammen: blokkene i commit-rekkefølge.
        innhold: () => Buffer.concat(commitListe.map(id => blokker.get(id)))
    };
}

const strømAv = (...deler) => Readable.from(deler.map(d => Buffer.isBuffer(d) ? d : Buffer.from(d)));

async function kjor() {
    // ---------- bufferSink ----------
    {
        const klartekst = Buffer.from('Hei på deg — æøå 😀'.repeat(50));
        const sink = backup.bufferSink();
        const res = await medTestpassord(() => backup.skrivKryptertStrom(strømAv(klartekst), sink));
        const fila = sink.hentResultat();

        sjekk('klartekstbytes telles', res.klartekstBytes, klartekst.length);
        sjekk('kryptertbytes stemmer med fila', res.kryptertBytes, fila.length);
        sjekk('fila starter med FSBK', fila.subarray(0, 4).toString(), 'FSBK');
        sjekk('formatversjon er uendret (1)', fila[4], 1);
        sjekk('lar seg dekryptere',
            krypto.dekrypterBufferMed(PASSORD, fila).equals(klartekst), true);
    }

    // ---------- blokkSink ----------
    {
        const klartekst = Buffer.alloc(70_000, 7);
        const blob = fakeBlob();
        await medTestpassord(() => backup.skrivKryptertStrom(
            strømAv(klartekst), backup.blokkSink(blob, { blobContentType: 'application/octet-stream' }), 16_384));

        // 70 000 bytes med 16 KiB blokker = 5 datablokker (4 fulle + rest), pluss hodet.
        sjekk('flere blokker stages', blob.antallBlokker() > 2, true);
        sjekk('alle blokk-ID-er har lik lengde',
            new Set(blob.ider().map(i => i.length)).size, 1);
        sjekk('ingen duplikate ID-er', new Set(blob.ider()).size, blob.antallBlokker());
        sjekk('commit-lista dekker alle blokkene', blob.commitListe().length, blob.antallBlokker());

        // Selve poenget: hodet commites først, selv om det ble staget sist.
        const hodeId = Buffer.from('blokk-000000').toString('base64');
        sjekk('hodeblokken ligger først i commit-lista', blob.commitListe()[0], hodeId);
        sjekk('hodeblokken ble staget sist', blob.ider()[blob.ider().length - 1], hodeId);

        sjekk('content-type følger med til commit',
            blob.opsjoner().blobHTTPHeaders.blobContentType, 'application/octet-stream');
        sjekk('den sammensatte fila dekrypterer til originalen',
            krypto.dekrypterBufferMed(PASSORD, blob.innhold()).equals(klartekst), true);
    }

    // ---------- blokk-kant ----------
    {
        // Klartekst som er nøyaktig et multiplum av blokkstørrelsen: siste
        // tomBuffer() må ikke stage en tom blokk, den ville Azure avvist.
        const klartekst = Buffer.alloc(32_768, 3);
        const blob = fakeBlob();
        await medTestpassord(() => backup.skrivKryptertStrom(
            strømAv(klartekst), backup.blokkSink(blob, {}), 16_384));
        sjekk('ingen tom blokk på blokkgrensen',
            blob.commitListe().every(id => blob.innhold().length > 0 && id.length > 0), true);
        sjekk('runder av riktig på blokkgrensen',
            krypto.dekrypterBufferMed(PASSORD, blob.innhold()).equals(klartekst), true);
    }

    // ---------- tom strøm ----------
    {
        const blob = fakeBlob();
        await medTestpassord(() => backup.skrivKryptertStrom(strømAv(), backup.blokkSink(blob, {})));
        sjekk('tom strøm gir bare hodeblokken', blob.commitListe().length, 1);
        sjekk('og dekrypterer til ingenting',
            krypto.dekrypterBufferMed(PASSORD, blob.innhold()).length, 0);
    }

    // ---------- mange små deler ----------
    {
        const deler = Array.from({ length: 500 }, (_, i) => Buffer.from(`del-${i};`));
        const klartekst = Buffer.concat(deler);
        const sink = backup.bufferSink();
        await medTestpassord(() => backup.skrivKryptertStrom(Readable.from(deler), sink, 1024));
        sjekk('mange små deler settes riktig sammen',
            krypto.dekrypterBufferMed(PASSORD, sink.hentResultat()).equals(klartekst), true);
    }

    // ---------- vern mot feilbruk ----------
    {
        const k = krypto.startKrypteringMed(PASSORD);
        k.oppdater(Buffer.from('noe'));
        k.avslutt();
        let feil1 = null, feil2 = null;
        try { k.avslutt(); } catch (e) { feil1 = e.message; }
        try { k.oppdater(Buffer.from('mer')); } catch (e) { feil2 = e.message; }
        sjekk('avslutt() to ganger avvises', feil1, 'Krypteringen er allerede avsluttet');
        sjekk('oppdater() etter avslutt avvises', feil2, 'Krypteringen er avsluttet');
    }

    // ---------- samme format som den gamle buffer-veien ----------
    {
        // krypterBufferMed og strømmeveien må produsere containere som er
        // utbyttbare. Salt og IV er tilfeldige, så bytene blir ulike — men
        // hodestrukturen og dekrypteringen må være identisk.
        const klartekst = Buffer.from('samme format, ulik vei');
        const gammel = krypto.krypterBufferMed(PASSORD, klartekst);
        const sink = backup.bufferSink();
        await medTestpassord(() => backup.skrivKryptertStrom(strømAv(klartekst), sink));
        const ny = sink.hentResultat();

        sjekk('samme hodelengde', ny.length - klartekst.length, gammel.length - klartekst.length);
        sjekk('samme magic og versjon',
            ny.subarray(0, 5).equals(gammel.subarray(0, 5)), true);
        sjekk('gammel container leses fortsatt',
            krypto.dekrypterBufferMed(PASSORD, gammel).equals(klartekst), true);
    }

    // ---------- ekte zip gjennom hele veien ----------
    if (!JSZip) {
        hoppet++;
        console.log('(hopper over zip-testen — jszip ikke installert)');
    } else {
        const zip = new JSZip();
        zip.file('manifest.json', JSON.stringify({ versjon: 1, tid: 'nå' }));
        zip.file('tabeller/Skjemaer.json', JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ id: i, navn: 'æøå' }))));
        zip.file('blobs/vedlegg/stor.bin', Buffer.alloc(60_000, 9), { compression: 'STORE' });

        const strom = zip.generateNodeStream({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
        const blob = fakeBlob();
        await medTestpassord(() => backup.skrivKryptertStrom(strom, backup.blokkSink(blob, {}), 16_384));

        const klartekst = krypto.dekrypterBufferMed(PASSORD, blob.innhold());
        const lest = await JSZip.loadAsync(klartekst);
        sjekk('manifestet leses tilbake',
            JSON.parse(await lest.file('manifest.json').async('string')).versjon, 1);
        sjekk('tabellfila leses tilbake',
            JSON.parse(await lest.file('tabeller/Skjemaer.json').async('string')).length, 200);
        sjekk('binærfila er uendret',
            (await lest.file('blobs/vedlegg/stor.bin').async('nodebuffer')).equals(Buffer.alloc(60_000, 9)), true);
    }

    console.log(`\n${ok} OK, ${feil} feil${hoppet ? `, ${hoppet} hoppet over` : ''}`);
    process.exit(feil ? 1 : 0);
}

kjor().catch(e => { console.error('Testen krasjet:', e); process.exit(1); });
