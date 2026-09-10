/**
 * flyt-bruk.js — hvilke PA-flyter er faktisk i bruk i dette miljøet?
 *
 * Tre av flyt-adressene er betinget: koden leser dem, men bare hvis noe i
 * dataene ber om det. Å lese koden alene svarer derfor ikke på om flyten kan
 * fjernes:
 *
 *   SP_LISTE_FLOW_URL   kalles bare for skjematyper med SPListeadresse
 *                       OG SPListenavn satt
 *   OTP_FLOW_URL        kalles bare i ekstern-innsender-flyten, altså for
 *                       skjematyper med EksternTilgang=true
 *   Flyt_url per steg   er ikke en env-var i det hele tatt — adressen ligger
 *                       på behandlingssteget i skjemadefinisjonen
 *
 * Skriptet leser Skjemadefinisjoner og teller. Det endrer ingenting, og
 * skriver ingen adresser i sin helhet — bare vertsnavn, så utskriften kan
 * limes inn i en sak.
 *
 * Bruk:
 *   node flyt-bruk.js --conn "<connection string>"
 */
const { TableClient } = require('@azure/data-tables');

function parseArgs(argv) {
    const a = { conn: process.env.STORAGE_CONN || '' };
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--conn') { a.conn = argv[++i]; }
        else if (argv[i] === '--hjelp' || argv[i] === '-h') a.hjelp = true;
    }
    return a;
}

function vertsnavn(url) {
    try { return new URL(String(url)).hostname; } catch (_) { return '(ugyldig URL)'; }
}

async function kjor() {
    const args = parseArgs(process.argv);
    if (args.hjelp || !args.conn) {
        console.log('\nBruk: node flyt-bruk.js --conn "<connection string>"\n');
        process.exit(args.hjelp ? 0 : 1);
    }

    const t = TableClient.fromConnectionString(args.conn, 'Skjemadefinisjoner');
    const spListe = [];
    const eksternTilgang = [];
    const stegFlyter = new Map();   // vertsnavn → [skjematype/steg]
    let antall = 0;

    for await (const e of t.listEntities()) {
        let def;
        try { def = JSON.parse(e.JSON); } catch (_) { continue; }
        antall++;
        const navn = `${e.rowKey} «${def.Skjema_navn || ''}»`;

        if (String(def.SPListeadresse || '').trim() && String(def.SPListenavn || '').trim()) {
            spListe.push(navn);
        }
        if (def.EksternTilgang === true) eksternTilgang.push(navn);

        for (const steg of (def.Behandling || [])) {
            const u = String(steg.Flyt_url || '').trim();
            if (!u) continue;
            const v = vertsnavn(u);
            if (!stegFlyter.has(v)) stegFlyter.set(v, []);
            stegFlyter.get(v).push(`${navn}, steg ${steg.Steg}`);
        }
    }

    const vis = (tittel, envvar, treff) => {
        console.log(`\n── ${tittel}`);
        console.log(`   ${envvar}`);
        if (treff.length === 0) {
            console.log('   INGEN skjematyper bruker dette — flyten kan fjernes');
        } else {
            console.log(`   ${treff.length} skjematype(r) bruker det:`);
            treff.slice(0, 15).forEach(n => console.log('     ' + n));
            if (treff.length > 15) console.log(`     … og ${treff.length - 15} til`);
        }
    };

    console.log(`\nLest ${antall} skjemadefinisjoner.`);
    vis('SharePoint-liste ved innsending', 'SP_LISTE_FLOW_URL', spListe);
    vis('Ekstern innsender (OTP-kode)', 'OTP_FLOW_URL', eksternTilgang);

    console.log('\n── Egne flyter på behandlingssteg');
    console.log('   Flyt_url — ligger på skjemadefinisjonen, ikke i env-vars');
    if (stegFlyter.size === 0) {
        console.log('   INGEN steg har egen flyt');
    } else {
        for (const [v, steder] of [...stegFlyter].sort()) {
            console.log(`   ${v} — ${steder.length} steg`);
            steder.slice(0, 8).forEach(s => console.log('     ' + s));
            if (steder.length > 8) console.log(`     … og ${steder.length - 8} til`);
        }
    }

    console.log('\nMerk: dette dekker bare det som avhenger av DATA.');
    console.log('VARSLING, UTSENDING, PURRE, BACKUP og de to TEAM-flytene');
    console.log('avgjøres av kode og env-vars — se oversikten i samtalen.\n');
}

kjor().catch(e => { console.error('Feilet:', e.message); process.exit(1); });
