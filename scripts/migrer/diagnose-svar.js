/**
 * diagnose-svar.js — Hvorfor viser et skjema «(ikke besvart)» på alle felt?
 *
 * Symptomet oppstår når svarene ligger i rada, men ikke lar seg koble til
 * definisjonen. `ekspanderSkjema` bygger nøkkelen «seksjon-felt» fra begge
 * sider, og bommer den, settes HVERT felt til tom Svar-array. Resultatet er
 * ikke et halvt utfylt skjema — det er et helt tomt et, og det ser ut som
 * tapte data selv om svarene ligger urørt i tabellen.
 *
 * Skriptet leser rada, bygger de samme nøklene appen bygger, og viser hvilke
 * som ikke møtes.
 *
 * Det skriver ALDRI ut svarverdier — bare nøkler, typer og antall. Da kan
 * utskriften limes inn i en sak uten å ta med persondata.
 *
 * Tabellen med utfylte skjemaer heter «Skjemaresultater» i legacy og «Skjemaer»
 * i SWA — migreringen døper den om. Skriptet prøver begge, så det kan peke på
 * en legacy-konto og en SWA-konto uten at man trenger å vite hvilken man har.
 * Definisjonene heter «Skjemadefinisjoner» begge steder.
 *
 * Bruk:
 *   node diagnose-svar.js --conn "<connection string>" --type 113
 *   node diagnose-svar.js --conn "<...>" --type 113 --skjema 42
 *   node diagnose-svar.js --conn "<...>" --alle          # alle typer, sammendrag
 *   node diagnose-svar.js --conn "<...>" --alle --tabell Skjemaresultater
 *
 * Connection string kan også ligge i STORAGE_CONN.
 */
const { TableClient, TableServiceClient, odata } = require('@azure/data-tables');

/** Legacy først eller SWA først spiller ingen rolle — vi tar den som finnes. */
const SKJEMATABELLER = ['Skjemaer', 'Skjemaresultater'];

function parseArgs(argv) {
    const a = { conn: process.env.STORAGE_CONN || '', type: '', skjema: '', alle: false, maks: 200, tabell: '' };
    for (let i = 2; i < argv.length; i++) {
        const v = argv[i + 1];
        switch (argv[i]) {
            case '--conn': a.conn = v; i++; break;
            case '--type': a.type = String(v); i++; break;
            case '--skjema': a.skjema = String(v); i++; break;
            case '--maks': a.maks = parseInt(v, 10) || 200; i++; break;
            case '--tabell': a.tabell = String(v); i++; break;
            case '--alle': a.alle = true; break;
            case '--hjelp': case '-h': a.hjelp = true; break;
        }
    }
    return a;
}

/** Samme regel som skjema-kompakt.js. */
function erKompakt(s) {
    return !!s && Array.isArray(s.Svar) && !Array.isArray(s.Seksjoner);
}

/** Nøklene definisjonen tilbyr — nøyaktig slik ekspanderSkjema slår opp. */
function definisjonsNokler(def) {
    const ut = new Map();
    for (const seksjon of (def?.Seksjoner || [])) {
        const sekNr = seksjon.Nummer ?? seksjon.Seksjon_nummer;
        for (const felt of (seksjon.Felter || [])) {
            if (felt.Type === 'Informasjon') continue;
            ut.set(`${sekNr}-${String(felt.Nummer).padStart(2, '0')}`, {
                sekType: typeof sekNr,
                feltType: typeof felt.Nummer
            });
        }
    }
    return ut;
}

/** Nøklene de lagrede svarene tilbyr — slik ekspanderSkjema bygger kartet. */
function svarNokler(kompakt) {
    const ut = new Map();
    for (const s of (kompakt.Svar || [])) {
        ut.set(`${s.sek}-${String(s.spm).padStart(2, '0')}`, {
            sekType: typeof s.sek,
            feltType: typeof s.spm,
            antall: Array.isArray(s.sva) ? s.sva.length : 0
        });
    }
    return ut;
}

/** Fullformat: hvor mange felt har faktisk et svar? */
function tellFulltFormat(skjema) {
    let felt = 0, besvart = 0;
    for (const seksjon of (skjema.Seksjoner || [])) {
        for (const f of (seksjon.Felter || [])) {
            if (f.Type === 'Informasjon') continue;
            felt++;
            if (Array.isArray(f.Svar) && f.Svar.length > 0 && f.Svar[0] !== '') besvart++;
        }
    }
    return { felt, besvart };
}

function analyser(skjema, def) {
    if (!skjema) return { verdikt: 'rad uten gyldig JSON' };

    if (!erKompakt(skjema)) {
        const t = tellFulltFormat(skjema);
        if (!Array.isArray(skjema.Seksjoner)) {
            return {
                verdikt: 'HVERKEN kompakt ELLER fullt',
                detalj: `mangler både Svar-array og Seksjoner — nøkler i rada: ${Object.keys(skjema).slice(0, 12).join(', ')}`
            };
        }
        return {
            verdikt: t.besvart > 0 ? 'fullt format, svar til stede' : 'fullt format, MEN alle felt tomme',
            detalj: `${t.besvart}/${t.felt} felt besvart`
        };
    }

    // Kompakt: her ligger den vanlige fellen.
    if (!def) return { verdikt: 'kompakt, men fant ingen definisjon å ekspandere mot' };

    const dn = definisjonsNokler(def);
    const sn = svarNokler(skjema);
    const treff = [...sn.keys()].filter(k => dn.has(k));
    const bom = [...sn.keys()].filter(k => !dn.has(k));

    let verdikt;
    if (sn.size === 0) verdikt = 'kompakt med TOM Svar-array — svarene finnes ikke i rada';
    else if (treff.length === 0) verdikt = 'kompakt, INGEN nøkler matcher definisjonen';
    else if (bom.length > 0) verdikt = 'kompakt, delvis match';
    else verdikt = 'kompakt, alle nøkler matcher';

    return {
        verdikt,
        detalj: `${treff.length}/${sn.size} svarnøkler funnet i definisjonen (definisjonen har ${dn.size} felt)`,
        bom: bom.slice(0, 10),
        // Typene avslører den klassiske årsaken: "01-01" mot "1-01".
        typer: {
            svar: sn.size ? [...sn.values()][0] : null,
            def: dn.size ? [...dn.values()][0] : null
        },
        eksempelDefNokler: [...dn.keys()].slice(0, 10)
    };
}

/** Navnene på tabellene i kontoen — brukes bare for å gi en nyttig feilmelding. */
async function listTabeller(conn) {
    try {
        const svc = TableServiceClient.fromConnectionString(conn);
        const ut = [];
        for await (const t of svc.listTables()) ut.push(t.name);
        return ut.sort();
    } catch (_) {
        return null;
    }
}

/**
 * Finn tabellen med utfylte skjemaer. En tabell kan finnes og likevel være tom
 * — da er den ikke den vi leter etter, så vi krever at den har minst én rad.
 */
async function finnSkjemaTabell(conn, overstyrt) {
    const kandidater = overstyrt ? [overstyrt] : SKJEMATABELLER;
    let sisteFeil = null;
    let tomTreff = null;

    for (const navn of kandidater) {
        const t = TableClient.fromConnectionString(conn, navn);
        try {
            // Vi bryter etter første rad, så dette henter aldri mer enn én side.
            for await (const _ of t.listEntities()) {
                return { klient: t, navn };
            }
            tomTreff = tomTreff || navn;   // finnes, men tom
        } catch (e) {
            sisteFeil = e;
        }
    }

    if (tomTreff) return { klient: TableClient.fromConnectionString(conn, tomTreff), navn: tomTreff, tom: true };

    const finnes = await listTabeller(conn);
    const prøvd = kandidater.join(' og ');
    let melding = `Fant ingen skjematabell (prøvde ${prøvd}).`;
    if (finnes) melding += `\nTabeller i kontoen: ${finnes.join(', ') || '(ingen)'}`;
    else if (sisteFeil) melding += `\nSiste feil: ${sisteFeil.message}`;
    melding += `\nOverstyr med --tabell <navn>.`;
    throw new Error(melding);
}

async function hentDefinisjon(conn, skjematypeId, cache) {
    if (cache.has(skjematypeId)) return cache.get(skjematypeId);
    const t = TableClient.fromConnectionString(conn, 'Skjemadefinisjoner');
    let def = null;
    // Legacy la definisjonene under PartitionKey 'Def'. Prøv det først, og fall
    // tilbake til et søk hvis SWA har lagt dem et annet sted.
    try {
        const e = await t.getEntity('Def', String(skjematypeId));
        def = JSON.parse(e.JSON);
    } catch (_) {
        try {
            for await (const e of t.listEntities({ queryOptions: { filter: odata`RowKey eq ${String(skjematypeId)}` } })) {
                def = JSON.parse(e.JSON); break;
            }
        } catch (_) { /* ingen definisjon */ }
    }
    cache.set(skjematypeId, def);
    return def;
}

async function kjor() {
    const args = parseArgs(process.argv);
    if (args.hjelp || !args.conn || (!args.type && !args.alle)) {
        console.log(`
Bruk:
  node diagnose-svar.js --conn "<connection string>" --type 113
  node diagnose-svar.js --conn "<...>" --type 113 --skjema 42
  node diagnose-svar.js --conn "<...>" --alle
  node diagnose-svar.js --conn "<...>" --alle --tabell Skjemaresultater

Tabellen finnes som «Skjemaer» (SWA) eller «Skjemaresultater» (legacy).
Skriptet prøver begge; --tabell overstyrer.

Skriver aldri ut svarverdier — bare nøkler, typer og antall.
`);
        process.exit(args.hjelp ? 0 : 1);
    }

    const funnet = await finnSkjemaTabell(args.conn, args.tabell);
    const skjemaer = funnet.klient;
    console.log(`\nLeser fra tabellen «${funnet.navn}»${funnet.tom ? ' (som er tom)' : ''}.`);
    const defCache = new Map();

    const filter = args.skjema
        ? odata`PartitionKey eq ${args.type} and RowKey eq ${args.skjema}`
        : (args.alle ? undefined : odata`PartitionKey eq ${args.type}`);

    const perVerdikt = new Map();
    let lest = 0;

    for await (const e of skjemaer.listEntities(filter ? { queryOptions: { filter } } : {})) {
        if (lest >= args.maks) break;
        lest++;

        let skjema = null;
        try { skjema = JSON.parse(e.JSON); } catch (_) { /* ugyldig */ }
        const typeId = skjema?.Skjematype_id || e.partitionKey;
        const def = await hentDefinisjon(args.conn, typeId, defCache);
        const res = analyser(skjema, def);

        if (!perVerdikt.has(res.verdikt)) perVerdikt.set(res.verdikt, []);
        perVerdikt.get(res.verdikt).push({ pk: e.partitionKey, rk: e.rowKey, ...res });
    }

    console.log(`\nLest ${lest} skjemarader.\n`);
    for (const [verdikt, rader] of [...perVerdikt.entries()].sort((a, b) => b[1].length - a[1].length)) {
        console.log(`── ${verdikt} — ${rader.length} rad(er)`);
        const f = rader[0];
        console.log(`   f.eks. type ${f.pk}, skjema ${f.rk}`);
        if (f.detalj) console.log(`   ${f.detalj}`);
        if (f.typer?.svar && f.typer?.def) {
            console.log(`   typer: svar sek=${f.typer.svar.sekType} felt=${f.typer.svar.feltType}` +
                `  |  def sek=${f.typer.def.sekType} felt=${f.typer.def.feltType}`);
        }
        if (f.bom?.length) console.log(`   svarnøkler uten treff: ${f.bom.join(', ')}`);
        if (f.eksempelDefNokler?.length) console.log(`   definisjonens nøkler:  ${f.eksempelDefNokler.join(', ')}`);
        console.log('');
    }

    if (perVerdikt.size === 0) console.log('Ingen rader traff filteret.');
}

if (require.main === module) {
    kjor().catch(e => { console.error('Diagnosen feilet:', e.message); process.exit(1); });
}

// Eksporteres for test — analysen er verdt å verifisere uten en storage-konto.
module.exports = { analyser, definisjonsNokler, svarNokler, erKompakt };
