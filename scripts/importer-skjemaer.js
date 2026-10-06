#!/usr/bin/env node
/**
 * Importer rader fra et regneark som skjemaer av en skjematype.
 *
 * Laget for verdivurderingsregisteret — 270 informasjonstyper som alt er
 * vurdert i et Excel-ark — men skriptet kjenner ingenting til det registeret.
 * Det leser skjematypedefinisjonen og lar DEN bestemme hvilke kolonner som
 * finnes og hvilke verdier som er gyldige.
 *
 * Kjøres lokalt av admin, ikke deployet. Trenger STORAGE_CONNECTION_STRING og
 * `npm install` i api/ (xlsx + @azure/data-tables).
 *
 * Reglene ligger i `api/src/lib/skjema-import.js` og deles med
 * `POST /api/skjemaer/{id}/import`, som registeret bruker. Dette skriptet er
 * bare kommandolinja rundt dem — en import herfra og en fra nettleseren gir
 * samme resultat fordi begge kaller den samme `lagPlan`.
 *
 *   node scripts/importer-skjemaer.js --fil vurdering.xlsx --skjematype 130 \
 *       --innsender datasikkerhetsleder@mil.no --nokkelfelt "Datapunkt (navn)"
 *
 * Uten `--utfor` er kjøringen en tørrkjøring: fila leses, kolonnene kobles,
 * verdiene valideres og planen skrives ut — men ingenting lagres. Samme kode
 * kjører begge veier, så det du ser er det som skjer.
 *
 * ## Hvorfor valideringen er det viktigste her
 *
 * Svar lagres som verdier, ikke som referanser til valglista. Skriver vi
 * «TJENSTLIG» inn i et felt der valglista sier «Tjenstlig», ser raden riktig
 * ut i visningen — men åpner noen den for redigering i registeret, filtrerer
 * widgeten bort verdien som ukjent, og lagringen skriver den bort. Stille.
 *
 * Derfor: hver eneste verdi mot et valgfelt må finnes i `Valg`. Gjør den ikke
 * det, stopper importen og sier hvilken rad, hvilken kolonne og hvilke
 * alternativer som finnes. Store og små bokstaver godtas — verdien som
 * LAGRES er alltid den kanoniske fra definisjonen.
 *
 * ## Flere verdier i én celle, og skrivefeil
 *
 * «TJENSTLIG/AVSKJERMET» er to verdier. Hele cella prøves først — et valg som
 * selv inneholder en skråstrek skal ikke deles i to som ingen av dem finnes —
 * og først når den ikke treffer, deles den på `/` (`--skilletegn` endrer
 * tegnet). Tar feltet bare én verdi, stopper importen: da er det enten
 * `Max_valg` som skal opp, eller den sammensatte verdien som skal inn som et
 * eget valg, og det er en modelleringsavgjørelse.
 *
 * Skrivefeil i arket rettes med en fil, ikke i 270 celler:
 *
 *   --verdier rettinger.json   →  { "TJENESTLIG": "TJENSTLIG" }
 *
 * Feilrapporten er gruppert på verdi, ikke på rad, og foreslår fila ferdig
 * utfylt. Fire skrivefeil i 270 rader gir ellers 300 enkeltfeil å lese.
 *
 * ## Kobling kolonne → felt
 *
 * Automatisk på etiketten: kolonneoverskriften matches mot `Tekst` på
 * feltene, uten hensyn til store bokstaver, doble mellomrom og etterstilt
 * kolon. Treffer det ikke, oppgi en koblingsfil:
 *
 *   --kolonner kobling.json   →  { "Særlig kategori per GDPR": "1-06" }
 *
 * Kolonner uten kobling hoppes over, og tørrkjøringen sier hvilke. Det er
 * med vilje: et regneark har gjerne kolonner som ikke hører hjemme i skjemaet.
 *
 * ## Hva som skrives
 *
 * Ett skjema per rad, i fullt format — samme form som `samleSeksjonerFraDom`
 * i frontend produserer: `Seksjoner[].Felter[] = { Id, Nummer, Type, Svar }`.
 *
 * Standard status er 5 (Avsluttet): radene er alt vurdert, og å sende 270 av
 * dem gjennom behandling ville sendt 270 varslinger til datasikkerhetsleder.
 * Skriptet går uansett utenom API-et, så ingen varsling går ut.
 *
 * Har skjematypen behandlingssteg, må `--beslutning` si HVA utfallet ble:
 *
 *   --beslutning Godkjent
 *
 * Da skrives et ferdig avgjort steg — `Beslutning`, `BehandletAv`,
 * `BehandletDato`, som `lagreBeslutning` gjør det — og radene kommer fram når
 * registeret filtreres på utfall. Uten den ville alle 270 stått som «Ikke
 * behandlet», og det er ikke et valg man tar ved et uhell: skriptet stopper og
 * ber om enten `--beslutning` eller `--uten-behandling`.
 *
 * `--status 2` arver i stedet behandlingsstrukturen med Beslutning 0, slik en
 * vanlig innsending gjør — altså til behandling.
 *
 * `--nokkelfelt` gjør kjøringen idempotent: rader der nøkkelverdien allerede
 * finnes blant skjemaene, hoppes over. Uten den vil en ny kjøring lage
 * dubletter.
 */
const fs = require('fs');
const path = require('path');

const API = path.join(__dirname, '..', 'api', 'src', 'lib');
const skjemaStorage = require(path.join(API, 'skjema-storage'));
const forekomstStorage = require(path.join(API, 'skjema-forekomst-storage'));
const { genererSkjemaId } = require(path.join(API, 'skjema-id'));
const imp = require(path.join(API, 'skjema-import'));
const { lagPlan, beskrivFelt, byggSeksjoner, byggFerdigBehandling, krevBeslutning } = imp;

// ==================== argumenter ====================

function lesArgumenter(argv) {
    const ut = { utfor: false, status: 5 };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--utfor') { ut.utfor = true; continue; }
        if (!a.startsWith('--')) continue;
        const navn = a.slice(2);
        const verdi = argv[++i];
        if (navn === 'status') ut.status = Number(verdi);
        else ut[navn] = verdi;
    }
    return ut;
}

function krev(args, navn) {
    if (!args[navn]) {
        console.error(`Mangler --${navn}. Se kommentaren øverst i skriptet.`);
        process.exit(2);
    }
    return args[navn];
}

const lesJson = (sti) => (sti ? JSON.parse(fs.readFileSync(sti, 'utf8')) : {});

// ==================== hovedløp ====================

async function main() {
    const args = lesArgumenter(process.argv.slice(2));
    const fil = krev(args, 'fil');
    const skjematypeId = String(krev(args, 'skjematype'));
    const innsender = krev(args, 'innsender');

    const st = await skjemaStorage.hentSkjematype(skjematypeId);
    if (!st?.JSON) throw new Error(`Fant ingen skjematype ${skjematypeId}`);
    const def = st.JSON;

    // Utfallet avklares FØR fila leses. En skrivefeil i «Godkjent» skal ikke
    // komme fram etter at 270 rader er validert.
    krevBeslutning(def, {
        status: args.status, beslutning: args.beslutning,
        utenBehandling: !!args['uten-behandling'], behandletAv: innsender,
        hjelp: '  --beslutning "Godkjent"   skriver et ferdig avgjort steg\n'
            + '  --uten-behandling         lar radene stå uten behandling — de blir «Ikke behandlet» i registerfilteret\n'
            + '  --status 2                sender dem til behandling i stedet'
    });

    const opsjoner = {
        kolonner: lesJson(args.kolonner),
        verdier: lesJson(args.verdier),
        skilletegn: args.skilletegn || '/',
        nokkelfelt: args.nokkelfelt || ''
    };
    const eksisterende = opsjoner.nokkelfelt
        ? await forekomstStorage.hentAlleSkjemaerForType(skjematypeId)
        : [];
    const plan = lagPlan({ matrise: imp.lesMatrise(fs.readFileSync(fil), fil), def, eksisterende, opsjoner });

    // ---- vis planen ----
    console.log(`Skjematype ${skjematypeId}: ${def.Skjema_navn || '(uten navn)'}`);
    console.log(`Overskrifter på rad ${plan.linje + 1}. Koblet ${plan.kobling.length} kolonne(r):`);
    for (const k of plan.kobling) {
        console.log(`  ${k.overskrift}  →  ${k.felt.nokkel} «${k.felt.etikett}» (${beskrivFelt(k.felt)})`);
    }
    if (plan.ukoblede.length > 0) {
        console.log(`Hoppet over ${plan.ukoblede.length} kolonne(r): ${plan.ukoblede.join(', ')}`);
        if (plan.ledige.length > 0) {
            console.log(`Felt uten kolonne (${plan.ledige.length}):`);
            for (const f of plan.ledige) console.log(`  ${f.nokkel} «${f.etikett}» (${beskrivFelt(f)})`);
            console.log(`Koble dem med --kolonner, f.eks.  { "${plan.ukoblede[0]}": "${plan.ledige[0].nokkel}" }`);
        }
    }
    if (plan.nokkelFelt) {
        console.log(`Nøkkelfelt: ${plan.nokkelFelt.nokkel} «${plan.nokkelFelt.etikett}» — rader med en verdi som finnes fra før hoppes over.`);
    } else {
        console.log('Uten --nokkelfelt: en ny kjøring vil lage dubletter.');
    }

    const harBehandling = Array.isArray(def.Behandling) && def.Behandling.length > 0;
    if (harBehandling && args.beslutning) {
        const valg = imp.finnValg(def.Behandling[0], args.beslutning);
        console.log(`Behandling: alle ${def.Behandling.length} steg settes til «${valg.Tekst}» (${valg.Nummer}), behandlet av ${innsender}.`);
    } else if (harBehandling && args.status === 2) {
        console.log(`Behandling: ${def.Behandling.length} steg arves ubehandlet — radene går til behandling.`);
    } else if (harBehandling) {
        console.log('Behandling: ingen — radene blir stående som «Ikke behandlet» i registerfilteret.');
    }

    console.log(`\n${plan.rader.length} rad(er) klar til import, ${plan.hoppet.length} finnes fra før, ${plan.feil.length} feil.`);
    if (plan.hoppet.length > 0) {
        const vist = plan.hoppet.slice(0, 10).map(h => h.verdi).join(', ');
        console.log(`Finnes fra før: ${vist}${plan.hoppet.length > 10 ? ` …og ${plan.hoppet.length - 10} til` : ''}`);
    }
    if (plan.feil.length > 0) {
        console.log(`\nFEIL — ${plan.grupper.length} ulik(e) verdi(er) i ${plan.feil.length} celle(r). Ingenting importeres før de er rettet:`);
        for (const g of plan.grupper) {
            console.log(`  «${g.kolonne}» × ${g.antall} (rad ${g.rader.join(', ')}${g.antall > g.rader.length ? ', …' : ''})`);
            console.log(`    ${g.melding}`);
        }
        const ukjente = [...new Set(plan.grupper.map(g => g.ukjent).filter(Boolean))];
        if (ukjente.length > 0) {
            console.log('\nEr det skrivefeil i arket, rett dem med --verdier:');
            console.log('  {' + ukjente.map(u => `\n    ${JSON.stringify(u)}: ""`).join(',') + '\n  }');
        }
        process.exit(1);
    }
    if (plan.rader.length === 0) { console.log('Ingenting å gjøre.'); return; }

    if (!args.utfor) {
        console.log('\nFørste rad slik den vil bli lagret:');
        console.log(JSON.stringify(byggSeksjoner(def, new Map(Object.entries(plan.rader[0].svar))), null, 1));
        console.log(`\nTørrkjøring — ingenting er lagret. Kjør på nytt med --utfor for å skrive ${plan.rader.length} skjema(er).`);
        return;
    }

    // ---- skriv ----
    const arvBehandling = args.status === 2 && harBehandling;
    const ferdigDato = new Date().toISOString();
    let skrevet = 0;
    for (const p of plan.rader) {
        const skjema = {
            Skjema_id: await genererSkjemaId(skjematypeId),
            Skjematype_id: skjematypeId,
            Skjema_navn: def.Skjema_navn || '',
            Innsender_Epost: innsender,
            Innsender_Navn: '',
            Skjema_status: args.status,
            Seksjoner: byggSeksjoner(def, new Map(Object.entries(p.svar))),
            Importert: { Fra: path.basename(fil), Rad: p.radNr, Tidspunkt: ferdigDato, Av: innsender }
        };
        if (arvBehandling) {
            skjema.Behandling = JSON.parse(JSON.stringify(def.Behandling)).map(steg => ({ ...steg, Beslutning: 0 }));
        } else if (harBehandling && args.beslutning) {
            skjema.Behandling = byggFerdigBehandling(def, args.beslutning, innsender, ferdigDato, args.kommentar || '');
        }
        await forekomstStorage.lagreSkjema(skjema, true);
        skrevet++;
        if (skrevet % 25 === 0) console.log(`  ${skrevet}/${plan.rader.length} …`);
    }
    console.log(`\n✓ Importerte ${skrevet} skjema(er) til skjematype ${skjematypeId} med status ${args.status}.`);
}

if (require.main === module) {
    main().catch(e => { console.error('FEIL:', e.message); process.exit(1); });
}

module.exports = { lesArgumenter };
