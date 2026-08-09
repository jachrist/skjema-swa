#!/usr/bin/env node
/**
 * Migreringsscript for skjema-appen.
 *
 * Kopierer Table Storage-tabeller og Blob-containere mellom to Azure
 * storage-konti. Kjøres lokalt av admin — ikke deployet.
 *
 * Bruk:
 *   node migrer.js --kilde-cs "<connection-string>" --mal-cs "<connection-string>"
 *   node migrer.js --tabell Skjemadefinisjoner --tabell Skjemaer
 *   node migrer.js --kun-tabeller
 *   node migrer.js --kun-blobs
 *   node migrer.js --dry-run
 *
 * Connection strings kan også gis via env:
 *   MIGRER_KILDE_CS, MIGRER_MAL_CS
 *
 * Se README.md for detaljert bruksanvisning.
 */
const { kopierTabell } = require('./lib/tabell-kopi');
const { kopierContainer } = require('./lib/blob-kopi');

// Kjente tabeller i skjema-appen. Kopieres i denne rekkefølgen (avhengigheter først).
const TABELLER = [
    'Skjemadefinisjoner',   // skjematypen — kryptonokler er avhengig av at type finnes
    'Kryptonokler',         // nøkler per skjematype (KRITISK for krypterte skjemaer)
    'Skjemaer',             // forekomster
    'Rollemedlemskap',      // rolle-tildelinger
    'Emner',                // FS-masterdata (kan re-genereres via refresh-fs)
    'EmneStudenter',
    'Postnumre',            // kan re-seedes fra bring/postnord
    'Tilgangskontroll',     // tokens + OTP-koder (ephemeral, kan hoppes over)
    'CacheMetadata'         // sist-refresh-info per kilde
];

const CONTAINERE = [
    'vedlegg'
];

function parseArgs(argv) {
    const args = { tabeller: [], containere: [], dryRun: false, kunTabeller: false, kunBlobs: false };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--kilde-cs') args.kildeConn = argv[++i];
        else if (a === '--mal-cs') args.malConn = argv[++i];
        else if (a === '--tabell') args.tabeller.push(argv[++i]);
        else if (a === '--container') args.containere.push(argv[++i]);
        else if (a === '--kun-tabeller') args.kunTabeller = true;
        else if (a === '--kun-blobs') args.kunBlobs = true;
        else if (a === '--dry-run') args.dryRun = true;
        else if (a === '--help' || a === '-h') args.hjelp = true;
        else console.error(`Ukjent argument: ${a}`);
    }
    args.kildeConn = args.kildeConn || process.env.MIGRER_KILDE_CS;
    args.malConn = args.malConn || process.env.MIGRER_MAL_CS;
    return args;
}

function visHjelp() {
    console.log(`
Migreringsscript for skjema-appen.

Bruk:
  node migrer.js [flagg]

Flagg:
  --kilde-cs <str>       Kilde-storage connection string (eller env MIGRER_KILDE_CS)
  --mal-cs <str>         Mål-storage connection string (eller env MIGRER_MAL_CS)
  --tabell <navn>        Kun spesifikk tabell (kan gjentas). Ellers: alle kjente
  --container <navn>     Kun spesifikk blob-container (kan gjentas). Ellers: alle kjente
  --kun-tabeller         Kopier kun tabeller, hopp over blobs
  --kun-blobs            Kopier kun blobs, hopp over tabeller
  --dry-run              Kun list opp — ingen skriving
  --help                 Vis denne meldingen

Kjente tabeller: ${TABELLER.join(', ')}
Kjente containere: ${CONTAINERE.join(', ')}

Eksempel — full migrering med env-vars:
  export MIGRER_KILDE_CS="DefaultEndpointsProtocol=https;AccountName=legacy;..."
  export MIGRER_MAL_CS="DefaultEndpointsProtocol=https;AccountName=pilot;..."
  node migrer.js

Eksempel — kun skjemadefinisjoner:
  node migrer.js --tabell Skjemadefinisjoner
`);
}

async function main() {
    const args = parseArgs(process.argv);
    if (args.hjelp) { visHjelp(); return; }
    if (!args.kildeConn) { console.error('FEIL: --kilde-cs eller MIGRER_KILDE_CS mangler'); process.exit(1); }
    if (!args.malConn) { console.error('FEIL: --mal-cs eller MIGRER_MAL_CS mangler'); process.exit(1); }

    // Sanity-sjekk: samme connection string på begge sider = sannsynligvis feil
    if (args.kildeConn === args.malConn) {
        console.error('FEIL: kilde og mål er samme storage-konto. Migrering er ikke meningsfull.');
        process.exit(1);
    }

    const tabellerKjor = args.tabeller.length > 0 ? args.tabeller : TABELLER;
    const containereKjor = args.containere.length > 0 ? args.containere : CONTAINERE;
    const log = console.log;

    log('Migreringsscript for skjema-appen');
    log(`Modus:        ${args.dryRun ? 'DRY-RUN (ingen skriving)' : 'LIVE'}`);
    log(`Kilde-konto:  ${extraherKontoNavn(args.kildeConn)}`);
    log(`Mål-konto:    ${extraherKontoNavn(args.malConn)}`);

    const sammendrag = { tabeller: [], containere: [] };
    const start = Date.now();

    if (!args.kunBlobs) {
        for (const t of tabellerKjor) {
            try {
                const res = await kopierTabell({
                    tabellNavn: t,
                    kildeConn: args.kildeConn,
                    malConn: args.malConn,
                    dryRun: args.dryRun,
                    log
                });
                sammendrag.tabeller.push({ tabell: t, ...res });
            } catch (e) {
                log(`  KATASTROFE-FEIL for ${t}: ${e.message}`);
                sammendrag.tabeller.push({ tabell: t, feil: e.message });
            }
        }
    }

    if (!args.kunTabeller) {
        for (const c of containereKjor) {
            try {
                const res = await kopierContainer({
                    containerNavn: c,
                    kildeConn: args.kildeConn,
                    malConn: args.malConn,
                    dryRun: args.dryRun,
                    log
                });
                sammendrag.containere.push({ container: c, ...res });
            } catch (e) {
                log(`  KATASTROFE-FEIL for ${c}: ${e.message}`);
                sammendrag.containere.push({ container: c, feil: e.message });
            }
        }
    }

    const varighet = ((Date.now() - start) / 1000).toFixed(1);
    log(`\n=== Sammendrag (${varighet} s) ===`);
    for (const t of sammendrag.tabeller) {
        if (t.feil) log(`  ${t.tabell.padEnd(24)}  FEIL: ${t.feil}`);
        else log(`  ${t.tabell.padEnd(24)}  lest=${t.lest}  upsertet=${t.upsertet}  feil=${t.feil}${t.hoppetOver ? '  (hoppet over)' : ''}`);
    }
    for (const c of sammendrag.containere) {
        if (c.feil) log(`  ${('blob:' + c.container).padEnd(24)}  FEIL: ${c.feil}`);
        else log(`  ${('blob:' + c.container).padEnd(24)}  lest=${c.lest}  kopiert=${c.kopiert}  feil=${c.feil}${c.hoppetOver ? '  (hoppet over)' : ''}`);
    }
    log('');

    // Exit-kode reflekterer om det var noen feil (ikke bare hoppet-over)
    const noenFeil = sammendrag.tabeller.some(t => t.feil || t.feil > 0)
        || sammendrag.containere.some(c => c.feil || c.feil > 0);
    process.exit(noenFeil ? 2 : 0);
}

function extraherKontoNavn(cs) {
    const m = /AccountName=([^;]+)/i.exec(String(cs || ''));
    return m ? m[1] : '(ukjent)';
}

main().catch(e => {
    console.error('\nUFANGET FEIL:', e.message);
    console.error(e.stack);
    process.exit(3);
});
