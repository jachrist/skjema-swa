/**
 * Radtallet panelet viser skal være det som ligger i tabellen.
 *
 * `upsertBatch` deduplikerer på `partitionKey|rowKey` og RETURNERER antallet
 * som faktisk ble skrevet. To undervisningsenheter kan gi samme
 * termin + emnenøkkel — samme emne på to campus, eller med to
 * studieprogramkoblinger — og da slås de sammen, med vilje.
 *
 * Til 19.10.2026 kastet `refreshFS` det svaret og skrev `emneRader.length`
 * til metadataen. Admin-panelet meldte 365 emner mens tabellen hadde 346.
 * Et tall som er 19 for høyt er verre enn ingen tall: ingenting ser galt ut,
 * så det er ingenting å feilsøke. Avviket ble først synlig fordi
 * `diag-lu` leser tabellen og teller selv.
 *
 * FilterStudent-grenen har alltid brukt `lagret`. Dette er samme regel,
 * anvendt det andre stedet også — og testen leser BEGGE veier: at wiringen
 * bruker returverdien, og at returverdien faktisk er den dedupliserte.
 *
 * Kjøres med:  node api/test/refresh-fs-radtall.test.js
 */
const Module = require('module');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

async function medStubber(modulSti, stubber, bruk) {
    const sti = require.resolve(modulSti);
    const ekte = Module._load;
    Module._load = function (forespurt, ...r) {
        if (Object.prototype.hasOwnProperty.call(stubber, forespurt)) return stubber[forespurt];
        return ekte.call(this, forespurt, ...r);
    };
    delete require.cache[sti];
    try {
        return await bruk(require(sti));
    } finally {
        Module._load = ekte;
        delete require.cache[sti];
    }
}

/** En undervisningsenhet i formen FS faktisk leverer den. */
function enhet(emnekode, versjonskode, arstall, betegnelse, campus) {
    return {
        termin: { arstall, betegnelse: { kode: betegnelse } },
        emne: {
            kode: emnekode,
            versjonskode,
            navnAlleSprak: { nb: `Emne ${emnekode}` },
            campuser: [{ campus: { kode: campus, navnAlleSprak: { nb: campus } } }],
            studieprogramkoblinger: [{ studieprogram: { kode: 'SP', navnAlleSprak: { nb: 'Program' } } }],
            beskrivelsesavsnitt: { nodes: [{ innhold: '<p>Tekst</p>' }] }
        },
        studieretter: { nodes: [] },
        personroller: { nodes: [] }
    };
}

// ---------- 1. wiringen: metadataen får det LAGREDE tallet ----------
//
// Stubben melder et annet `lagret` enn lengden på det som ble sendt inn.
// Brukes returverdien, slår forskjellen gjennom. Brukes `.length`, gjør den
// det ikke — og det var feilen.
(async () => {
    const metadata = {};
    const logglinjer = [];
    const sendtInn = {};

    const storeStub = {
        TABELL_EMNER: 'Emner',
        TABELL_STUDENTER: 'EmneStudenter',
        TABELL_FILTERSTUDENT: 'FilterStudent',
        filterPk: (fk, fv) => `F|${fk}|${fv}`,
        slettAlleIPartisjon: async () => {},
        listPartisjoner: async () => [],
        slettGamleGenerasjoner: async () => 0,
        upsertBatch: async (navn, rader) => {
            sendtInn[navn] = rader.length;
            // To emnerader kolliderer → én går tapt. Studentene er uberørte.
            if (navn === 'Emner') return { lagret: rader.length - 1 };
            return { lagret: rader.length };
        },
        settMetadata: async (kilde, info) => { metadata[kilde] = info; },
        hentAlleEmner: async () => []
    };

    const fsStub = {
        hentTerminer: async (par) => new Map(par.map(p => [`${p.arstall}-${p.betegnelse}`, `id-${p.arstall}-${p.betegnelse}`])),
        // Samme emne i samme termin, to ganger — to campus.
        hentUndervisningsenheter: async (ider) => (
            String(ider[0]).includes('HØST')
                ? [enhet('ING2307', '1', 2026, 'HØST', 'SKSK'), enhet('ING2307', '1', 2026, 'HØST', 'CIS')]
                : []
        ),
        hentKlasser: async () => []
    };

    const res = await medStubber('../src/lib/refresh-fs.js',
        { './emner-storage': storeStub, './fs-client': fsStub },
        async (mod) => mod.refreshFS((...a) => logglinjer.push(a.join(' '))));

    sjekk('to enheter ble bygget til to emnerader', sendtInn['Emner'], 2);
    sjekk('metadataen melder det LAGREDE tallet', metadata['FS-Emner']?.antallRader, 1);
    sjekk('og ikke det bygde', metadata['FS-Emner']?.antallRader === 2, false);
    sjekk('returverdien melder lagret', res.antallEmner, 1);
    sjekk('og bærer det bygde tallet ved siden av', res.antallEmnerBygget, 2);

    // En sammenslåing som ingen får vite om, er ikke til å feilsøke.
    const merknad = logglinjer.filter(l => /delte termin\+emnenøkkel/.test(l));
    sjekk('sammenslåingen står i loggen', merknad.length, 1);
    sjekk('og loggen navngir begge tallene',
        /2 bygget, 1 lagret/.test(merknad[0] || ''), true);

    // Studentene kolliderte ikke — da skal det ikke stå noe om dem.
    sjekk('ingen falsk merknad om studentrader',
        logglinjer.filter(l => /studentrader delte/.test(l)).length, 0);

    // ---------- 2. kontrakten: upsertBatch deduplikerer faktisk ----------
    //
    // Uten denne er sjekken over bare en avtale med min egen stubb. Her
    // kjøres den EKTE upsertBatch mot en stubbet tabellklient, og teller hva
    // som når fram.
    const skrevneNokler = [];
    const tabellStub = {
        submitTransaction: async (ops) => {
            for (const [, e] of ops) skrevneNokler.push(`${e.partitionKey}|${e.rowKey}`);
        }
    };
    const lagret = await medStubber('../src/lib/emner-storage.js',
        { './storage': { sikreTabell: async () => tabellStub, tabellKlient: () => tabellStub, odata: (s) => s } },
        async (mod) => mod.upsertBatch('Emner', [
            { partitionKey: '26H', rowKey: 'ING2307-1', C: 'SKSK' },
            { partitionKey: '26H', rowKey: 'ING2307-1', C: 'CIS' },
            { partitionKey: '26H', rowKey: 'ING2309-1', C: 'SKSK' }
        ]));

    sjekk('upsertBatch melder antall UNIKE nøkler', lagret.lagret, 2);
    sjekk('og skriver bare dem', skrevneNokler.sort(), ['26H|ING2307-1', '26H|ING2309-1']);

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
})().catch(e => {
    console.log('FEIL  testen kastet:', e.message);
    console.log(e.stack);
    process.exit(1);
});
