/**
 * Tester for verifisering av en lagret backup uten gjenoppretting.
 *
 * Det som må stemme er at en ØDELAGT fil faktisk blir avvist. En verifisering
 * som alltid sier «ok» er verre enn ingen verifisering: den gir en trygghet
 * som ikke finnes. Derfor testes hver måte fila kan være ødelagt på — endret
 * byte, avkuttet hale, feil passphrase, tuklet hode.
 *
 * Kjøres med:  node api/test/backup-verifiser.test.js
 */
const { Readable } = require('stream');
const backup = require('../src/lib/backup');
const krypto = require('../src/lib/backup-krypto');

const PASSORD = 'test-passphrase-minst-16-tegn';

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

function medTestpassord(fn) {
    const original = krypto.startKryptering;
    krypto.startKryptering = () => krypto.startKrypteringMed(PASSORD);
    try { return fn(); } finally { krypto.startKryptering = original; }
}

/** Lag en kryptert container av gitt klartekst, via den ekte skriveveien. */
async function lagFil(klartekst) {
    const sink = backup.bufferSink();
    await medTestpassord(() => backup.skrivKryptertStrom(Readable.from([klartekst]), sink));
    return sink.hentResultat();
}

/** Leser som en blob-klient — henter et utsnitt om gangen. */
const leserFor = (buf) => ({
    lesBit: async (fra, antall) => buf.subarray(fra, fra + antall),
    total: buf.length
});

async function forventFeil(fn) {
    try { await fn(); return null; }
    catch (e) { return e.message; }
}

// En liten «zip»: det eneste verifiseringen ser etter er signaturen først.
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(50_000, 42)]);

async function kjor() {
    // ---------- hel fil ----------
    {
        const fila = await lagFil(ZIP);
        const res = await backup.verifiserKryptertStrom(leserFor(fila), PASSORD, 4096);
        sjekk('hel fil verifiserer', res.klartekstBytes, ZIP.length);
        sjekk('kryptert størrelse rapporteres', res.kryptertBytes, fila.length);
        sjekk('zip-signaturen kjennes igjen', res.zipSignatur, true);
    }

    // ---------- bitstørrelsen skal ikke påvirke resultatet ----------
    {
        const fila = await lagFil(ZIP);
        for (const bit of [16, 1000, 4096, 1_000_000]) {
            const res = await backup.verifiserKryptertStrom(leserFor(fila), PASSORD, bit);
            sjekk(`samme resultat med bitstørrelse ${bit}`, res.klartekstBytes, ZIP.length);
        }
    }

    // ---------- én endret byte ----------
    {
        const fila = await lagFil(ZIP);
        const skadet = Buffer.from(fila);
        skadet[skadet.length - 100] ^= 0x01;
        const melding = await forventFeil(() => backup.verifiserKryptertStrom(leserFor(skadet), PASSORD, 4096));
        sjekk('én endret byte avvises', melding !== null, true);
        sjekk('og feilen peker på autentisering',
            /unable to authenticate|unsupported state/i.test(melding || ''), true);
    }

    // ---------- avkuttet fil ----------
    {
        // Nøyaktig det som skjer hvis en opplasting stopper halvveis. Fila ser
        // fin ut i en filliste, men mangler slutten.
        const fila = await lagFil(ZIP);
        const kuttet = fila.subarray(0, fila.length - 5000);
        const melding = await forventFeil(() => backup.verifiserKryptertStrom(leserFor(kuttet), PASSORD, 4096));
        sjekk('avkuttet fil avvises', melding !== null, true);
    }

    // ---------- feil passphrase ----------
    {
        const fila = await lagFil(ZIP);
        const melding = await forventFeil(() =>
            backup.verifiserKryptertStrom(leserFor(fila), 'feil-passphrase-16-tegn', 4096));
        sjekk('feil passphrase avvises', melding !== null, true);
    }

    // ---------- tuklet hode ----------
    {
        const fila = await lagFil(ZIP);
        const feilMagic = Buffer.from(fila);
        feilMagic[0] = 0x58;
        sjekk('feil magic avvises tidlig',
            await forventFeil(() => backup.verifiserKryptertStrom(leserFor(feilMagic), PASSORD)),
            'Ugyldig magic — ikke en FSBK-backup');

        const feilVersjon = Buffer.from(fila);
        feilVersjon[4] = 9;
        sjekk('ukjent versjon avvises',
            await forventFeil(() => backup.verifiserKryptertStrom(leserFor(feilVersjon), PASSORD)),
            'Ustøttet versjon: 9');
    }

    // ---------- for kort fil ----------
    {
        const melding = await forventFeil(() =>
            backup.verifiserKryptertStrom({ lesBit: async () => Buffer.alloc(0), total: 10 }, PASSORD));
        sjekk('for kort fil avvises med forklaring',
            /for kort til å være en backup/.test(melding || ''), true);
    }

    // ---------- innhold som ikke er zip ----------
    {
        // Dekrypteringen kan gå fint selv om innholdet er noe annet enn en
        // backup. Da skal det ikke meldes som ok.
        const fila = await lagFil(Buffer.from('dette er ikke en zip'.repeat(100)));
        const res = await backup.verifiserKryptertStrom(leserFor(fila), PASSORD, 4096);
        sjekk('gyldig kryptering uten zip-signatur flagges', res.zipSignatur, false);
    }

    // ---------- leseren kalles i rekkefølge og dekker fila ----------
    {
        const fila = await lagFil(ZIP);
        const kall = [];
        const leser = {
            total: fila.length,
            lesBit: async (fra, antall) => { kall.push([fra, antall]); return fila.subarray(fra, fra + antall); }
        };
        await backup.verifiserKryptertStrom(leser, PASSORD, 4096);
        sjekk('første kall henter hodet', kall[0], [0, krypto.HODE_LENGDE]);
        sjekk('lesingen dekker hele fila',
            kall.reduce((s, [, n]) => s + n, 0), fila.length);
        sjekk('ingen hull i lesingen',
            kall.every(([fra], i) => i === 0 || fra === kall[i - 1][0] + kall[i - 1][1]), true);
    }

    // ---------- vern mot feilbruk ----------
    {
        const fila = await lagFil(ZIP);
        const d = krypto.startDekrypteringMed(PASSORD, fila.subarray(0, krypto.HODE_LENGDE));
        d.oppdater(fila.subarray(krypto.HODE_LENGDE));
        d.avslutt();
        sjekk('avslutt() to ganger avvises',
            await forventFeil(async () => d.avslutt()), 'Dekrypteringen er allerede avsluttet');
        sjekk('oppdater() etter avslutt avvises',
            await forventFeil(async () => d.oppdater(Buffer.from('x'))), 'Dekrypteringen er avsluttet');
    }

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
}

kjor().catch(e => { console.error('Testen krasjet:', e); process.exit(1); });
