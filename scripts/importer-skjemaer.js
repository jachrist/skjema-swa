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

// ==================== regneark ====================

function lesMatrise(sti) {
    const ext = path.extname(sti).toLowerCase();
    if (ext === '.csv' || ext === '.txt') {
        // Norsk Excel skriver semikolon. Samme vurdering som i rolle-import.js:
        // tell i første linje og la flertallet bestemme.
        const tekst = fs.readFileSync(sti, 'utf8').replace(/^﻿/, '');
        const forste = tekst.split(/\r?\n/, 1)[0] || '';
        const skille = [';', '\t', ','].sort((a, b) =>
            (forste.split(b).length - 1) - (forste.split(a).length - 1))[0];
        return tekst.split(/\r?\n/).map(l => l.split(skille).map(c => c.replace(/^"|"$/g, '')));
    }
    const XLSX = require(path.join(__dirname, '..', 'api', 'node_modules', 'xlsx'));
    const wb = XLSX.read(fs.readFileSync(sti), { type: 'buffer' });
    const arkNavn = wb.SheetNames[0];
    // raw:false gir tekst også for tall, så «2501» ikke blir 2501.
    return XLSX.utils.sheet_to_json(wb.Sheets[arkNavn], { header: 1, raw: false, defval: '' });
}

/** Normaliser en overskrift for sammenligning: små bokstaver, ett mellomrom, uten kolon. */
function normaliser(v) {
    return String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/:$/, '');
}

/**
 * Finn overskriftsraden.
 *
 * Arket har en tittelrad over overskriftene («VERKTØY FOR KARTLEGGING …»), så
 * rad 1 er ikke overskriftene. Vi leter etter den FØRSTE raden der minst to
 * celler matcher et feltnavn — en tittelrad har én utfylt celle, og det
 * skiller dem.
 */
function finnOverskrift(matrise, feltEtiketter) {
    for (let i = 0; i < Math.min(matrise.length, 20); i++) {
        const rad = (matrise[i] || []).map(normaliser);
        const treff = rad.filter(c => c && feltEtiketter.has(c)).length;
        if (treff >= 2) return i;
    }
    return -1;
}

// ==================== skjematypen ====================

/** Alle felt som kan ta imot et svar, med etikett og valgliste. */
function feltKatalog(def) {
    const ut = [];
    for (const s of (def?.Seksjoner || [])) {
        for (const f of (s?.Felter || [])) {
            if (f.Type === 'Informasjon') continue;
            const sekNr = String(s.Seksjon_nummer ?? s.Nummer ?? '');
            const feltNr = String(f.Nummer ?? '');
            ut.push({
                nokkel: `${sekNr}-${feltNr.padStart(2, '0')}`,
                sekNr, feltNr,
                Id: f.Id || null,
                Type: f.Type,
                etikett: typeof f.Tekst === 'object' && f.Tekst ? String(f.Tekst.Verdi ?? '') : String(f.Tekst ?? ''),
                // Hvor mange verdier feltet tar. Samme regel som felt-render.js:
                // MerkAlle opphever taket, ellers Max_valg med 1 som standard.
                // En celle med to verdier i et felt som bare tar én, er ikke
                // noe skriptet skal skrive seg ut av.
                maksValg: f.MerkAlle ? Infinity : Math.max(1, Number(f.Max_valg) || 1),
                // Verdien som LAGRES er `Verdi ?? Tekst` — samme regel som
                // felt-render.js bruker når widgeten tegnes. Men regnearket
                // inneholder det et menneske har sett på skjermen, altså
                // TEKSTEN. Begge formene må kunne gjenkjennes; bare verdien
                // skrives.
                valg: Array.isArray(f.Valg) && f.Valg.length > 0
                    ? f.Valg
                        .map(v => ({ verdi: String(v.Verdi ?? v.Tekst ?? ''), tekst: String(v.Tekst ?? v.Verdi ?? '') }))
                        .filter(v => v.verdi)
                    : null
            });
        }
    }
    return ut;
}

/**
 * Koble kolonner til felt.
 *
 * Koblingsfila vinner over navnetreffet. Den peker på feltnøkkelen
 * («1-06»), ikke på etiketten, så en omdøpt etikett ikke river koblingen.
 */
function koble(overskrifter, katalog, overstyringer) {
    const påEtikett = new Map(katalog.map(f => [normaliser(f.etikett), f]));
    const påNokkel = new Map(katalog.map(f => [f.nokkel, f]));
    const kobling = [];   // [{ kolonne, overskrift, felt }]
    const ukoblede = [];
    for (let i = 0; i < overskrifter.length; i++) {
        const o = String(overskrifter[i] ?? '').trim();
        if (!o) continue;
        const overstyrt = overstyringer[o] || overstyringer[normaliser(o)];
        const felt = overstyrt ? påNokkel.get(String(overstyrt)) : påEtikett.get(normaliser(o));
        if (felt) kobling.push({ kolonne: i, overskrift: o, felt });
        else ukoblede.push(o);
    }
    return { kobling, ukoblede };
}

// ==================== verdier ====================

/**
 * Verdien slik den skal lagres, eller en feil.
 *
 * For et valgfelt må cella gjenkjennes i `Valg` — enten som verdien eller som
 * visningsteksten. Regnearket er fylt ut av et menneske som så teksten, så
 * det er den som står der: «Kan offentliggjøres», ikke «OFFENTLIG». Lagret
 * blir alltid VERDIEN.
 *
 * Store og små bokstaver godtas, men den kanoniske formen fra definisjonen er
 * den som skrives. Ellers havner vi tilbake i «verdien finnes ikke i lista» —
 * og den feilen viser seg først når noen redigerer raden et halvår senere.
 */
/** Slå opp én enkeltverdi i valglista. Null når den ikke finnes. */
function slaOppValg(felt, tekst, aliaser = {}) {
    // Rettinger først: regnearket har skrivefeil som ikke er verdt å rette i
    // 270 celler, og en rettefil er lettere å etterprøve enn en ryddejobb i
    // Excel.
    const rettet = aliaser[tekst] ?? aliaser[normaliser(tekst)] ?? tekst;
    return felt.valg.find(v => v.verdi === rettet || v.tekst === rettet)
        ?? felt.valg.find(v => normaliser(v.verdi) === normaliser(rettet) || normaliser(v.tekst) === normaliser(rettet))
        ?? null;
}

/**
 * Verdiene i én celle, slik de skal lagres — eller en feil.
 *
 * To ting cella kan inneholde som ikke er én ren verdi:
 *
 *   **Flere verdier,** skilt med `/`: «TJENSTLIG/AVSKJERMET». Hele cella
 *   prøves FØRST, så et valg som selv inneholder en skråstrek ikke blir
 *   splittet i to som ingen av dem finnes. Først når hele cella ikke treffer,
 *   deles den.
 *
 *   **Skrivefeil.** Rettingene kommer fra `--verdier`, og brukes før
 *   oppslaget. Å rette 270 celler i Excel er både mer arbeid og vanskeligere
 *   å etterprøve enn en fil med fire linjer.
 *
 * Et felt som bare tar én verdi får ikke to. Da er det enten `Max_valg` som
 * skal opp, eller «TJENSTLIG/AVSKJERMET» som skal inn som et eget valg — og
 * det er en modelleringsavgjørelse, ikke noe skriptet skal gjette.
 */
function tolkVerdi(rå, felt, { aliaser = {}, skilletegn = '/' } = {}) {
    const tekst = String(rå ?? '').trim();
    if (!tekst) return { verdi: null };
    if (!felt.valg) return { verdi: tekst };

    const gyldige = () => felt.valg.map(v => v.verdi === v.tekst ? v.verdi : `${v.tekst} (${v.verdi})`).join(', ');

    // Hele cella først.
    const helt = slaOppValg(felt, tekst, aliaser);
    if (helt) return { verdi: helt.verdi };

    // Så som flere verdier.
    const deler = tekst.split(skilletegn).map(d => d.trim()).filter(Boolean);
    if (deler.length > 1) {
        const verdier = [];
        const ukjente = [];
        for (const d of deler) {
            const t = slaOppValg(felt, d, aliaser);
            if (t) { if (!verdier.includes(t.verdi)) verdier.push(t.verdi); }
            else ukjente.push(d);
        }
        if (ukjente.length > 0) {
            return { feil: `${ukjente.map(u => `"${u}"`).join(' og ')} finnes ikke i valglista for «${felt.etikett}». Gyldige: ${gyldige()}`,
                ukjent: ukjente[0] };
        }
        if (verdier.length > felt.maksValg) {
            return { feil: `«${felt.etikett}» tar ${felt.maksValg} verdi(er), men cella har ${verdier.length} `
                + `(${verdier.join(', ')}). Øk Max_valg på feltet, eller legg inn "${tekst}" som et eget valg.`,
                ukjent: tekst };
        }
        return { verdi: verdier };
    }

    return { feil: `"${tekst}" finnes ikke i valglista for «${felt.etikett}». Gyldige: ${gyldige()}`, ukjent: tekst };
}

/**
 * Finn beslutningsvalget på et steg, fra tekst eller nummer.
 *
 * Teksten er det man ser i editoren og i registerfilteret, så det er den man
 * oppgir. Tallet godtas også — en skjematype kan ha to valg med samme tekst,
 * og da må man kunne peke entydig.
 */
function finnValg(steg, oppgitt) {
    const valg = Array.isArray(steg?.Beslutningsvalg) ? steg.Beslutningsvalg : [];
    const t = String(oppgitt ?? '').trim();
    if (!t) return null;
    return valg.find(v => String(v.Nummer) === t)
        ?? valg.find(v => String(v.Tekst ?? '') === t)
        ?? valg.find(v => normaliser(v.Tekst) === normaliser(t))
        ?? null;
}

/**
 * Behandlingen slik den ser ut når alt er avgjort.
 *
 * Formen er kopiert fra `lagreBeslutning` i api/src/functions/skjemaer.js —
 * `Beslutning`, `BehandletAv`, `BehandletDato`, `Kommentar` — ikke funnet opp
 * her. Et steg med en annen form ville lagret seg fint og vært usynlig for
 * `sisteBeslutning`, som er den registeret filtrerer på.
 *
 * Alle steg får samme beslutning. Radene er vurdert utenfor systemet; at det
 * ene steget skulle vært godkjent og det neste avslått, finnes det ingen
 * opplysning om i regnearket.
 */
function byggFerdigBehandling(def, beslutning, behandletAv, dato, kommentar) {
    const steg = JSON.parse(JSON.stringify(def.Behandling || []));
    for (const s of steg) {
        const valg = finnValg(s, beslutning);
        if (!valg) {
            const alternativer = (s.Beslutningsvalg || []).map(v => `${v.Tekst} (${v.Nummer})`).join(', ');
            throw new Error(`Steg ${s.Steg} «${s.Stegnavn || ''}» har ingen beslutning som heter "${beslutning}". `
                + `Alternativer: ${alternativer || '(ingen beslutningsvalg definert)'}`);
        }
        s.Beslutning = Number(valg.Nummer);
        s.BehandletAv = behandletAv;
        s.BehandletDato = dato;
        s.Kommentar = kommentar || '';
    }
    return steg;
}

/** Bygg skjemaets Seksjoner i fullt format — samme form som frontend sender. */
function byggSeksjoner(def, svarPåNokkel) {
    return (def?.Seksjoner || []).map(s => ({
        Seksjon_nummer: s.Seksjon_nummer ?? s.Nummer,
        Nummer: s.Seksjon_nummer ?? s.Nummer,
        Felter: (s.Felter || []).map(f => {
            const nokkel = `${String(s.Seksjon_nummer ?? s.Nummer ?? '')}-${String(f.Nummer ?? '').padStart(2, '0')}`;
            const svar = f.Type === 'Informasjon' ? [] : (svarPåNokkel.get(nokkel) || []);
            return { Id: f.Id, Nummer: f.Nummer, Type: f.Type, Svar: svar };
        })
    }));
}

/** Verdien av nøkkelfeltet på et eksisterende skjema — for idempotens. */
function nokkelverdi(skjema, nokkel) {
    for (const s of (skjema?.Seksjoner || [])) {
        for (const f of (s.Felter || [])) {
            const n = `${String(s.Seksjon_nummer ?? s.Nummer ?? '')}-${String(f.Nummer ?? '').padStart(2, '0')}`;
            if (n === nokkel) return String((f.Svar || [])[0] ?? '').trim();
        }
    }
    return '';
}

// ==================== hovedløp ====================

async function main() {
    const args = lesArgumenter(process.argv.slice(2));
    const fil = krev(args, 'fil');
    const skjematypeId = String(krev(args, 'skjematype'));
    const innsender = krev(args, 'innsender');
    const overstyringer = args.kolonner ? JSON.parse(fs.readFileSync(args.kolonner, 'utf8')) : {};
    // Rettinger for skrivefeil i regnearket: { "TJENESTLIG": "TJENSTLIG" }.
    // Nøklene normaliseres, så kasus i fila ikke avgjør om rettingen treffer.
    const aliasFil = args.verdier ? JSON.parse(fs.readFileSync(args.verdier, 'utf8')) : {};
    const aliaser = {};
    for (const [fra, til] of Object.entries(aliasFil)) {
        aliaser[fra] = til;
        aliaser[normaliser(fra)] = til;
    }
    const skilletegn = args.skilletegn || '/';

    const st = await skjemaStorage.hentSkjematype(skjematypeId);
    if (!st?.JSON) throw new Error(`Fant ingen skjematype ${skjematypeId}`);
    const def = st.JSON;
    const katalog = feltKatalog(def);
    if (katalog.length === 0) throw new Error(`Skjematype ${skjematypeId} har ingen felt som kan ta imot svar`);

    // Har skjematypen behandlingssteg, må importen si hva utfallet ble.
    // Uten det står alle radene som «Ikke behandlet» i registerets
    // utfallsfilter — og det oppdages først når noen filtrerer og ikke finner
    // dem. Et valg man ikke tar bevisst, skal ikke tas stille.
    const harBehandling = Array.isArray(def.Behandling) && def.Behandling.length > 0;
    if (harBehandling && args.status === 5 && !args.beslutning && !args['uten-behandling']) {
        const valg = (def.Behandling[0].Beslutningsvalg || []).map(v => v.Tekst).filter(Boolean);
        throw new Error(
            `Skjematype ${skjematypeId} har ${def.Behandling.length} behandlingssteg, men du har ikke sagt hva utfallet ble.\n`
            + `  --beslutning "${valg[0] || 'Godkjent'}"   skriver et ferdig avgjort steg${valg.length ? ` (valg: ${valg.join(', ')})` : ''}\n`
            + '  --uten-behandling             lar radene stå uten behandling — de blir «Ikke behandlet» i registerfilteret\n'
            + '  --status 2                    sender dem til behandling i stedet');
    }
    // Feil i beslutningsnavnet skal komme FØR fila leses, ikke etter at 270
    // rader er validert.
    if (harBehandling && args.beslutning) {
        byggFerdigBehandling(def, args.beslutning, innsender, new Date().toISOString(), '');
    }

    const matrise = lesMatrise(fil);
    const etiketter = new Set(katalog.map(f => normaliser(f.etikett)).filter(Boolean));
    const linje = finnOverskrift(matrise, etiketter);
    if (linje < 0) {
        throw new Error('Fant ingen overskriftsrad der minst to kolonner matcher et feltnavn. '
            + `Feltnavnene i skjematypen er: ${katalog.map(f => f.etikett).filter(Boolean).join(', ')}`);
    }
    const { kobling, ukoblede } = koble(matrise[linje], katalog, overstyringer);
    if (kobling.length === 0) throw new Error('Ingen kolonner lot seg koble til felt.');

    console.log(`Skjematype ${skjematypeId}: ${def.Skjema_navn || '(uten navn)'}`);
    console.log(`Overskrifter på rad ${linje + 1}. Koblet ${kobling.length} kolonne(r):`);
    for (const k of kobling) console.log(`  ${k.overskrift}  →  ${k.felt.nokkel} «${k.felt.etikett}» (${k.felt.Type})`);
    if (ukoblede.length > 0) {
        console.log(`Hoppet over ${ukoblede.length} kolonne(r): ${ukoblede.join(', ')}`);
        // Og — like viktig — hvilke FELT som står igjen uten kolonne.
        //
        // Uten denne lista sier skriptet bare at en kolonne ikke traff, og
        // den som leser må gjette hva feltet heter i skjematypen. Skal
        // «Datapunkt (navn)» kobles, må man vite at feltet heter noe annet,
        // og hva. Svaret finnes her, og det er gratis å skrive det ut.
        const brukte = new Set(kobling.map(k => k.felt.nokkel));
        const ledige = katalog.filter(f => !brukte.has(f.nokkel));
        if (ledige.length > 0) {
            console.log(`Felt uten kolonne (${ledige.length}):`);
            for (const f of ledige) console.log(`  ${f.nokkel} «${f.etikett}» (${f.Type})`);
            console.log('Koble dem med --kolonner, f.eks.  { "'
                + ukoblede[0] + '": "' + ledige[0].nokkel + '" }');
        }
    }

    // Nøkkelfeltet, for idempotens
    let nokkelFelt = null;
    if (args.nokkelfelt) {
        const treff = kobling.find(k => normaliser(k.overskrift) === normaliser(args.nokkelfelt))
            || katalog.find(f => normaliser(f.etikett) === normaliser(args.nokkelfelt) || f.nokkel === args.nokkelfelt);
        nokkelFelt = treff?.felt || treff || null;
        if (!nokkelFelt) {
            // «Fant ikke» uten å si hva som FINNES, sender den som leser
            // tilbake til skjematypen for å gjette. Nøkkelfeltet må være et
            // felt som faktisk har en kolonne — ellers er det tomt på hver
            // eneste rad, og idempotensen virker ikke uansett.
            throw new Error(`Fant ikke nøkkelfeltet "${args.nokkelfelt}".\n`
                + 'Det må være en kolonne som er koblet. Koblede kolonner:\n'
                + kobling.map(k => `  "${k.overskrift}"  (${k.felt.nokkel} «${k.felt.etikett}»)`).join('\n')
                + (ukoblede.length > 0
                    ? `\nKolonnen "${args.nokkelfelt}" ${ukoblede.includes(args.nokkelfelt) ? 'ER i fila, men traff ingen felt' : 'finnes ikke i fila'}`
                        + ' — se «Felt uten kolonne» over og koble den med --kolonner.'
                    : ''));
        }
        console.log(`Nøkkelfelt: ${nokkelFelt.nokkel} «${nokkelFelt.etikett}» — rader med en verdi som finnes fra før hoppes over.`);
    } else {
        console.log('Uten --nokkelfelt: en ny kjøring vil lage dubletter.');
    }

    if (harBehandling && args.beslutning) {
        const valg = finnValg(def.Behandling[0], args.beslutning);
        console.log(`Behandling: alle ${def.Behandling.length} steg settes til «${valg.Tekst}» (${valg.Nummer}), behandlet av ${innsender}.`);
    } else if (harBehandling && args.status === 2) {
        console.log(`Behandling: ${def.Behandling.length} steg arves ubehandlet — radene går til behandling.`);
    } else if (harBehandling) {
        console.log('Behandling: ingen — radene blir stående som «Ikke behandlet» i registerfilteret.');
    }

    const finnes = new Set();
    if (nokkelFelt) {
        for (const s of await forekomstStorage.hentAlleSkjemaerForType(skjematypeId)) {
            const v = nokkelverdi(s, nokkelFelt.nokkel);
            if (v) finnes.add(normaliser(v));
        }
        console.log(`${finnes.size} rad(er) finnes fra før i skjematypen.`);
    }

    // ---- les radene ----
    const nye = [];
    const feil = [];
    const hoppet = [];
    for (let i = linje + 1; i < matrise.length; i++) {
        const rad = matrise[i] || [];
        const radNr = i + 1;
        const svarPåNokkel = new Map();
        let tom = true;
        for (const k of kobling) {
            const { verdi, feil: f, ukjent } = tolkVerdi(rad[k.kolonne], k.felt, { aliaser, skilletegn });
            if (f) { feil.push({ radNr, kolonne: k.overskrift, melding: f, ukjent }); continue; }
            if (verdi === null) continue;
            tom = false;
            svarPåNokkel.set(k.felt.nokkel, Array.isArray(verdi) ? verdi : [verdi]);
        }
        if (tom) continue;
        if (nokkelFelt) {
            const n = (svarPåNokkel.get(nokkelFelt.nokkel) || [])[0];
            if (!n) { feil.push({ radNr, kolonne: nokkelFelt.etikett, melding: 'Nøkkelfeltet er tomt' }); continue; }
            if (finnes.has(normaliser(n))) { hoppet.push({ radNr, n }); continue; }
            // Dubletter INNE i fila teller også — ellers lager én kjøring dem selv.
            finnes.add(normaliser(n));
        }
        nye.push({ radNr, svarPåNokkel });
    }

    console.log(`\n${nye.length} rad(er) klar til import, ${hoppet.length} finnes fra før, ${feil.length} feil.`);
    if (hoppet.length > 0) {
        console.log(`Finnes fra før: ${hoppet.slice(0, 10).map(h => h.n).join(', ')}${hoppet.length > 10 ? ` …og ${hoppet.length - 10} til` : ''}`);
    }
    if (feil.length > 0) {
        // Gruppert på verdien, ikke listet per rad.
        //
        // 270 rader med fire skrivefeil gir fort 300 enkeltfeil, og den lista
        // er ikke til å jobbe med. Gruppert blir den en arbeidsliste: fire
        // verdier å rette, med antall og et radnummer å slå opp.
        const grupper = new Map();
        for (const f of feil) {
            const n = `${f.kolonne}\u0000${f.ukjent ?? f.melding}`;
            if (!grupper.has(n)) grupper.set(n, { ...f, antall: 0, rader: [] });
            const g = grupper.get(n);
            g.antall++;
            if (g.rader.length < 5) g.rader.push(f.radNr);
        }
        console.log(`\nFEIL — ${grupper.size} ulik(e) verdi(er) i ${feil.length} celle(r). Ingenting importeres før de er rettet:`);
        for (const g of [...grupper.values()].sort((a, b) => b.antall - a.antall)) {
            console.log(`  «${g.kolonne}» × ${g.antall} (rad ${g.rader.join(', ')}${g.antall > g.rader.length ? ', …' : ''})`);
            console.log(`    ${g.melding}`);
        }
        // Et ferdig utkast til rettefila sparer en avskrift.
        const ukjente = [...new Set([...grupper.values()].map(g => g.ukjent).filter(Boolean))];
        if (ukjente.length > 0) {
            console.log('\nEr det skrivefeil i arket, rett dem med --verdier:');
            console.log('  {' + ukjente.map(u => `\n    ${JSON.stringify(u)}: ""`).join(',') + '\n  }');
        }
        process.exit(1);
    }
    if (nye.length === 0) { console.log('Ingenting å gjøre.'); return; }

    if (!args.utfor) {
        const p = nye[0];
        console.log('\nFørste rad slik den vil bli lagret:');
        console.log(JSON.stringify(byggSeksjoner(def, p.svarPåNokkel), null, 1));
        console.log(`\nTørrkjøring — ingenting er lagret. Kjør på nytt med --utfor for å skrive ${nye.length} skjema(er).`);
        return;
    }

    // ---- skriv ----
    // Tre utfall, og de er ulike nok til å stå hver for seg:
    //   --status 2        strukturen arves ubehandlet — til behandling
    //   --beslutning X    strukturen arves ferdig avgjort — ut av behandling
    //   ellers            ingen behandling i det hele tatt
    const arvBehandling = args.status === 2 && harBehandling;
    const ferdigDato = new Date().toISOString();
    let skrevet = 0;
    for (const p of nye) {
        const skjemaId = await genererSkjemaId(skjematypeId);
        const skjema = {
            Skjema_id: skjemaId,
            Skjematype_id: skjematypeId,
            Skjema_navn: def.Skjema_navn || '',
            Innsender_Epost: innsender,
            Innsender_Navn: '',
            Skjema_status: args.status,
            Seksjoner: byggSeksjoner(def, p.svarPåNokkel),
            // Si høyt hvor radene kom fra. Uten dette er «importert» og
            // «sendt inn av et menneske» umulig å skille i ettertid.
            Importert: { Fra: path.basename(fil), Rad: p.radNr, Tidspunkt: new Date().toISOString(), Av: innsender }
        };
        if (arvBehandling) {
            skjema.Behandling = JSON.parse(JSON.stringify(def.Behandling)).map(steg => ({ ...steg, Beslutning: 0 }));
        } else if (harBehandling && args.beslutning) {
            skjema.Behandling = byggFerdigBehandling(def, args.beslutning, innsender, ferdigDato, args.kommentar || '');
        }
        await forekomstStorage.lagreSkjema(skjema, true);
        skrevet++;
        if (skrevet % 25 === 0) console.log(`  ${skrevet}/${nye.length} …`);
    }
    console.log(`\n✓ Importerte ${skrevet} skjema(er) til skjematype ${skjematypeId} med status ${args.status}.`);
}

if (require.main === module) {
    main().catch(e => { console.error('FEIL:', e.message); process.exit(1); });
}

module.exports = { lesArgumenter, normaliser, finnOverskrift, feltKatalog, koble, tolkVerdi,
    byggSeksjoner, nokkelverdi, finnValg, byggFerdigBehandling };
