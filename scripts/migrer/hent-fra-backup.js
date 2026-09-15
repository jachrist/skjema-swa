#!/usr/bin/env node
/**
 * Hent ÉN tabell ut av en backup-fil, og skriv den til en storage-konto.
 *
 * Finnes fordi `/api/backup/restore` er feil verktøy når bare én tabell er
 * borte. Restore wiper alle tabellene i manifestet og skriver inn alt på
 * nytt — og de DELTE tabellene (TodoPunkter, Nokkelkalender) rører den ikke
 * i det hele tatt. Skal en av dem tilbake, må den hentes ut for hånd.
 *
 * Skriptet gjør ingenting destruktivt av seg selv:
 *
 *   uten --skriv    leser backupen, viser manifestet og antall rader, og
 *                   dumper tabellen til JSON. Rører ingen konto.
 *   med --skriv     upserter radene til måltabellen. Sletter aldri noe:
 *                   rader som finnes fra før overskrives, resten blir
 *                   stående. Kjør om igjen så mye du vil.
 *
 * Passphrasen leses KUN fra BACKUP_PASSPHRASE. Ikke som argument — argumenter
 * havner i kommandohistorikk og i prosesslista på maskinen.
 *
 * Bruk:
 *   npm install                       (i denne mappa — egne avhengigheter)
 *   $env:BACKUP_PASSPHRASE = "..."
 *   node hent-fra-backup.js --fil backup-2026-09-15.bin --delt --tabell TodoPunkter
 *   node hent-fra-backup.js --fil backup-2026-09-15.bin --delt --tabell TodoPunkter --skriv
 *
 * Målkontoen tas fra MAL_CONN (anbefalt) eller --conn. Samme grunn: en
 * connection string på kommandolinja blir liggende igjen.
 *
 * Backupfilen hentes fra `GET /api/backup/liste` — feltet `sasUrl` per fil.
 */
const fs = require('fs');
const path = require('path');

const { dekrypterBufferMed } = require(
    path.join(__dirname, '..', '..', 'api', 'src', 'lib', 'backup-krypto')
);

function arg(navn, standard = null) {
    const i = process.argv.indexOf(`--${navn}`);
    if (i === -1) return standard;
    const v = process.argv[i + 1];
    return (!v || v.startsWith('--')) ? true : v;
}

const HJELP = process.argv.includes('--hjelp') || process.argv.includes('-h');

if (HJELP || process.argv.length <= 2) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#![^\n]*\n/, ''));
    process.exit(0);
}

async function main() {
    const fil = arg('fil');
    const tabell = arg('tabell', 'TodoPunkter');
    const erDelt = !!arg('delt', false);
    const skriv = !!arg('skriv', false);
    const utFil = arg('ut', null);
    const conn = process.env.MAL_CONN || arg('conn', null);

    if (!fil || fil === true) throw new Error('--fil <backupfil> mangler');
    if (!fs.existsSync(fil)) throw new Error(`Finner ikke ${fil}`);

    const passphrase = String(process.env.BACKUP_PASSPHRASE || '').trim();
    if (!passphrase) throw new Error('BACKUP_PASSPHRASE er ikke satt');

    // ---- dekrypter og åpne ----
    const kryptert = fs.readFileSync(fil);
    console.log(`Leser ${fil} (${(kryptert.length / 1024 / 1024).toFixed(1)} MB)`);
    const klartekst = dekrypterBufferMed(passphrase, kryptert);

    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(klartekst);

    const manifestFil = zip.file('manifest.json');
    if (!manifestFil) throw new Error('manifest.json mangler — ikke en gyldig backup');
    const manifest = JSON.parse(await manifestFil.async('string'));

    console.log(`\nBackup tatt : ${manifest.tid}`);
    console.log(`Miljø       : ${manifest.miljø || '(ikke satt)'}`);
    console.log(`Tabeller    : ${(manifest.tabeller || []).map(t => t.navn || t).join(', ')}`);
    console.log(`Delte       : ${(manifest.delteTabeller || []).map(t => t.navn || t).join(', ') || '(ingen)'}`);

    // ---- finn tabellen ----
    const sti = erDelt ? `delte-tabeller/${tabell}.json` : `tabeller/${tabell}.json`;
    const tabellFil = zip.file(sti);
    if (!tabellFil) {
        // Den viktigste feilmeldingen i skriptet. Mangler en delt tabell, er
        // det som regel fordi TODO_STORAGE_CONNECTION_STRING ikke var gyldig
        // da backupen kjørte — da hoppet jobben over dem med bare en logglinje.
        throw new Error(
            `${sti} finnes ikke i backupen.\n`
            + (erDelt
                ? '  Delte tabeller hoppes over når TODO_STORAGE_CONNECTION_STRING mangler\n'
                + '  eller SAS-en er utløpt. Sjekk en eldre backup — eller kjørelogg for\n'
                + '  backup-jobben den natta.'
                : '  Prøv --delt hvis tabellen ligger på den delte kontoen.')
        );
    }

    const rader = JSON.parse(await tabellFil.async('string'));
    console.log(`\n${sti}: ${rader.length} rader`);

    if (rader.length > 0) {
        const p = new Set(rader.map(r => r.partitionKey || r.PartitionKey));
        console.log(`Partisjoner : ${[...p].slice(0, 10).join(', ')}${p.size > 10 ? ` … (${p.size} i alt)` : ''}`);
    }

    // ---- dump til fil ----
    const ut = utFil && utFil !== true ? utFil : `${tabell}-fra-backup.json`;
    fs.writeFileSync(ut, JSON.stringify(rader, null, 2), 'utf8');
    console.log(`Skrev ${ut}`);

    if (!skriv) {
        console.log('\nIngenting er skrevet til noen konto. Legg til --skriv for det.');
        return;
    }

    // ---- skriv til målkontoen ----
    if (!conn) throw new Error('--skriv krever MAL_CONN (eller --conn) med connection string / SAS til målkontoen');

    const { TableClient } = require('@azure/data-tables');
    const klient = TableClient.fromConnectionString(conn, tabell);
    await klient.createTable().catch(() => { /* finnes fra før */ });

    let skrevet = 0, feilet = 0;
    for (const r of rader) {
        const entity = {
            ...r,
            partitionKey: r.partitionKey || r.PartitionKey,
            rowKey: r.rowKey || r.RowKey
        };
        if (!entity.partitionKey || !entity.rowKey) { feilet++; continue; }
        // Feltene Table Storage setter selv skal ikke sendes tilbake.
        delete entity.PartitionKey; delete entity.RowKey;
        delete entity.etag; delete entity.timestamp; delete entity.Timestamp;
        try {
            await klient.upsertEntity(entity, 'Replace');
            skrevet++;
        } catch (e) {
            feilet++;
            console.log(`  FEIL ${entity.partitionKey}/${entity.rowKey}: ${e.message}`);
        }
    }
    console.log(`\nSkrevet ${skrevet} rader til ${tabell}${feilet ? `, ${feilet} feilet` : ''}.`);
}

main().catch(e => {
    console.error(`\nFEIL: ${e.message}`);
    process.exit(1);
});
