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

/**
 * Posisjoner der definisjonen har et Informasjon-felt.
 *
 * Både komprimering og ekspandering hopper over Informasjon, så disse
 * posisjonene finnes ikke i nøkkelkartet. Et svar som bommer HIT betyr noe
 * annet enn et svar som bommer på ingenting: her står det nå et
 * informasjonsfelt der det før stod et spørsmål — altså en omnummerering,
 * ikke bare en sletting.
 */
function informasjonsPosisjoner(def) {
    const ut = new Set();
    for (const seksjon of (def?.Seksjoner || [])) {
        const sekNr = seksjon.Nummer ?? seksjon.Seksjon_nummer;
        for (const felt of (seksjon.Felter || [])) {
            if (felt.Type !== 'Informasjon') continue;
            ut.add(`${sekNr}-${String(felt.Nummer).padStart(2, '0')}`);
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

/** Definisjonens felt slått opp på Id, og på posisjon. */
function definisjonsIndeks(def) {
    const påId = new Map();
    const påPosisjon = new Map();
    for (const seksjon of (def?.Seksjoner || [])) {
        const sekNr = seksjon.Nummer ?? seksjon.Seksjon_nummer;
        for (const felt of (seksjon.Felter || [])) {
            if (felt.Type === 'Informasjon') continue;
            const pos = `${sekNr}-${String(felt.Nummer).padStart(2, '0')}`;
            påPosisjon.set(pos, felt);
            if (felt.Id) påId.set(felt.Id, pos);
        }
    }
    return { påId, påPosisjon };
}

/**
 * Måler om posisjonsnøkkelen fortsatt peker på det feltet svaret hører til.
 *
 * `renummererFelter` i editoren tildeler Nummer etter posisjon. Slettes et felt
 * midt i en seksjon, forskyves alle under, og gamle svar peker på nabospørsmålet
 * — samme spørsmål, feil svar, uten noe synlig varsel. Feltets Id endrer seg
 * derimot ikke, så avviket mellom de to er selve målingen.
 *
 * Rapporterer også hvor mange lagrede felt som i det hele tatt HAR en Id.
 * Uten Id kan et forskjøvet svar ikke kobles tilbake, og da er en Id-basert
 * løsning bare noe som hjelper framover, ikke bakover.
 */
function målDrift(skjema, def) {
    const { påId, påPosisjon } = definisjonsIndeks(def);
    let besvart = 0, medId = 0, forskjøvet = 0, borteFraDef = 0, gjenkoblbar = 0;

    for (const seksjon of (skjema.Seksjoner || [])) {
        const sekNr = seksjon.Nummer ?? seksjon.Seksjon_nummer;
        for (const f of (seksjon.Felter || [])) {
            if (f.Type === 'Informasjon') continue;
            const harSvar = Array.isArray(f.Svar) && f.Svar.length > 0 && f.Svar[0] !== '';
            if (!harSvar) continue;
            besvart++;
            if (!f.Id) continue;
            medId++;

            const posNå = `${sekNr}-${String(f.Nummer).padStart(2, '0')}`;
            const posIDef = påId.get(f.Id);
            if (posIDef === undefined) {
                // Feltet finnes ikke lenger i definisjonen — svaret hører til et
                // spørsmål som er slettet.
                borteFraDef++;
            } else if (posIDef !== posNå) {
                forskjøvet++;
                gjenkoblbar++;
            } else if (!påPosisjon.has(posNå)) {
                borteFraDef++;
            }
        }
    }
    return { besvart, medId, utenId: besvart - medId, forskjøvet, borteFraDef, gjenkoblbar };
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
        const drift = def ? målDrift(skjema, def) : null;
        let verdikt;
        if (t.besvart === 0) verdikt = 'fullt format, MEN alle felt tomme';
        else if (drift && drift.forskjøvet > 0) verdikt = 'fullt format, svar FORSKJØVET av omnummerering';
        else if (drift && drift.borteFraDef > 0) verdikt = 'fullt format, svar på felt som er slettet fra definisjonen';
        else verdikt = 'fullt format, svar til stede';

        return {
            verdikt,
            detalj: `${t.besvart}/${t.felt} felt besvart`,
            drift
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

    // Skill de to slagene bom fra hverandre — de betyr ulike ting.
    const info = informasjonsPosisjoner(def);
    const bomPåInfo = bom.filter(k => info.has(k));
    const bomPåIngenting = bom.filter(k => !info.has(k));

    return {
        verdikt,
        detalj: `${treff.length}/${sn.size} svarnøkler funnet i definisjonen (definisjonen har ${dn.size} felt)`,
        bom: bom.slice(0, 10),
        bomPåInfo, bomPåIngenting,
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

/**
 * Hvilke skjematyper er omnummerert — og hvor mange skjemaer står i fare?
 *
 * Dette er den viktigste utskriften, og grunnen er ubehagelig: i kompaktformat
 * finnes ingen Id. Et svar som er forskjøvet til en posisjon der det FINNES et
 * felt, teller derfor som treff. Analysen kan bare se de forskyvningene som
 * lander på et Informasjon-felt eller utenfor skjemaet.
 *
 * Ett slikt synlig treff er likevel bevis for at skjematypen er omnummerert.
 * Og er den det, er alle kompakte rader av samme type usikre — også de som
 * ser friske ut. Derfor rapporteres eksponeringen per type, ikke per rad.
 */
function skrivTypeoversikt(alle) {
    const perType = new Map();
    for (const r of alle) {
        const t = String(r.pk);
        if (!perType.has(t)) perType.set(t, { rader: 0, kompakte: 0, påInfo: 0, påIngenting: 0, forskjøvet: 0 });
        const s = perType.get(t);
        s.rader++;
        if (String(r.verdikt).startsWith('kompakt')) s.kompakte++;
        s.påInfo += r.bomPåInfo?.length || 0;
        s.påIngenting += r.bomPåIngenting?.length || 0;
        s.forskjøvet += r.drift?.forskjøvet || 0;
    }

    const mistenkte = [...perType.entries()]
        .filter(([, s]) => s.påInfo > 0 || s.forskjøvet > 0)
        .sort((a, b) => b[1].kompakte - a[1].kompakte);

    console.log('══ Skjematyper med spor av omnummerering ══\n');
    if (mistenkte.length === 0) {
        console.log('  Ingen. Ingen svar har landet på en gjenbrukt posisjon.\n');
        return;
    }

    let usikre = 0;
    console.log('  type   rader  kompakte  bom på info  forskjøvet');
    for (const [t, s] of mistenkte) {
        usikre += s.kompakte;
        console.log(`  ${t.padEnd(6)} ${String(s.rader).padStart(5)} ${String(s.kompakte).padStart(9)} ` +
            `${String(s.påInfo).padStart(12)} ${String(s.forskjøvet).padStart(11)}`);
    }
    console.log(`\n  ${mistenkte.length} skjematype(r) er omnummerert.`);
    console.log(`  ${usikre} kompakt(e) rad(er) av disse typene kan ha svar under feil spørsmål`);
    console.log('  uten at det lar seg påvise herfra — kompaktformatet lagrer ingen Id.');
    console.log('  Avklaring krever den gamle definisjonen fra backup.\n');
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

        // Summer bom-typene over gruppa. Bom på et Informasjon-felt betyr at
        // posisjonen er gjenbrukt — altså forskyvning. Bom på ingenting betyr
        // som regel bare at spørsmålet er slettet.
        const medBom = rader.filter(r => r.bomPåInfo || r.bomPåIngenting);
        if (medBom.length) {
            const påInfo = medBom.reduce((a, r) => a + (r.bomPåInfo?.length || 0), 0);
            const påIngenting = medBom.reduce((a, r) => a + (r.bomPåIngenting?.length || 0), 0);
            const raderPåInfo = medBom.filter(r => (r.bomPåInfo?.length || 0) > 0).length;
            if (påInfo || påIngenting) {
                console.log(`   bom på Informasjon-felt: ${påInfo} (i ${raderPåInfo} rad(er)) — posisjonen er gjenbrukt`);
                console.log(`   bom på ingenting:        ${påIngenting} — spørsmålet er trolig slettet`);
            }
        }
        if (f.eksempelDefNokler?.length) console.log(`   definisjonens nøkler:  ${f.eksempelDefNokler.join(', ')}`);

        // Summer Id-dekning og drift over hele gruppa, ikke bare eksempelrada.
        const meddrift = rader.filter(r => r.drift);
        if (meddrift.length) {
            const sum = meddrift.reduce((a, r) => ({
                besvart: a.besvart + r.drift.besvart,
                medId: a.medId + r.drift.medId,
                utenId: a.utenId + r.drift.utenId,
                forskjøvet: a.forskjøvet + r.drift.forskjøvet,
                borteFraDef: a.borteFraDef + r.drift.borteFraDef,
                gjenkoblbar: a.gjenkoblbar + r.drift.gjenkoblbar
            }), { besvart: 0, medId: 0, utenId: 0, forskjøvet: 0, borteFraDef: 0, gjenkoblbar: 0 });
            console.log(`   svar totalt: ${sum.besvart}  |  med Id: ${sum.medId}  |  uten Id: ${sum.utenId}`);
            console.log(`   forskjøvet: ${sum.forskjøvet}  |  felt slettet fra def: ${sum.borteFraDef}  |  gjenkoblbare via Id: ${sum.gjenkoblbar}`);
        }
        console.log('');
    }

    if (perVerdikt.size === 0) {
        console.log('Ingen rader traff filteret.');
        return;
    }

    skrivTypeoversikt([...perVerdikt.values()].flat());
}

if (require.main === module) {
    kjor().catch(e => { console.error('Diagnosen feilet:', e.message); process.exit(1); });
}

// Eksporteres for test — analysen er verdt å verifisere uten en storage-konto.
module.exports = { analyser, definisjonsNokler, svarNokler, erKompakt };
