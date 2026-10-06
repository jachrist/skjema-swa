/**
 * Import av skjemaer fra regneark — de rene reglene.
 *
 * Delt mellom `scripts/importer-skjemaer.js` (kommandolinje) og
 * `POST /api/skjemaer/{skjematypeId}/import` (adminpanelet/registeret). Begge
 * kaller NØYAKTIG de samme funksjonene, så en import kjørt fra nettleseren
 * gir samme resultat som en kjørt fra terminalen.
 *
 * Ingenting her rører lagring eller nettverk. Modulen leser et regneark og en
 * skjematypedefinisjon, og svarer med hva som ville blitt skrevet. Kalleren
 * bestemmer om det faktisk skjer.
 *
 * `xlsx` lastes lat av samme grunn som i rolle-import.js: testene skal kunne
 * kjøre uten node_modules, og reglene her er det som er verdt å teste.
 */
const path = require('path');

// ==================== regneark ====================

/**
 * Regneark → matrise av celler.
 *
 * Tar en buffer og et filnavn, ikke en sti: endepunktet får fila som opplastet
 * innhold, og kommandolinja leser den selv. Samme signatur som
 * `rolle-import.lesFil`.
 */
function lesMatrise(buffer, filnavn) {
    const ext = path.extname(String(filnavn || '')).toLowerCase();
    if (ext === '.csv' || ext === '.txt') {
        // Norsk Excel skriver semikolon. Samme vurdering som i rolle-import.js:
        // tell i første linje og la flertallet bestemme.
        const tekst = buffer.toString('utf8').replace(/^\ufeff/, '');
        const forste = tekst.split(/\r?\n/, 1)[0] || '';
        const skille = [';', '\t', ','].sort((a, b) =>
            (forste.split(b).length - 1) - (forste.split(a).length - 1))[0];
        return tekst.split(/\r?\n/).map(l => l.split(skille).map(c => c.replace(/^"|"$/g, '')));
    }
    // Lat lasting — testene skal kunne kjøre uten node_modules.
    const XLSX = require('xlsx');
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const arkNavn = wb.SheetNames[0];
    if (!arkNavn) return [];
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
function finnOverskrift(matrise, kjente) {
    for (let i = 0; i < Math.min(matrise.length, 20); i++) {
        const rad = (matrise[i] || []).map(normaliser);
        const treff = rad.filter(c => c && kjente.has(c)).length;
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

/**
 * Feltet slik SKRIPTET leser det — type, tak på antall verdier, valgliste.
 *
 * Står det «maks 1» her mens editoren viser 5, er spørsmålet besvart med én
 * gang: skriptet leser en annen definisjon enn den du redigerte, eller
 * endringen er ikke lagret. Uten tallet i utskriften blir det en runde med
 * gjetting, og den rundet vi 06.10.2026.
 */
function beskrivFelt(felt) {
    const deler = [felt.Type];
    if (felt.valg) {
        deler.push(felt.maksValg === Infinity ? 'maks: alle' : `maks ${felt.maksValg}`);
        deler.push(`${felt.valg.length} valg`);
    }
    return deler.join(', ');
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

/**
 * Avklar utfallet FØR fila leses.
 *
 * Har skjematypen behandlingssteg og importen ikke sier hva utfallet ble,
 * står alle radene som «Ikke behandlet» i registerets utfallsfilter — og det
 * oppdages først når noen filtrerer og ikke finner dem. Et valg man ikke tar
 * bevisst, skal ikke tas stille.
 *
 * Og: en skrivefeil i «Godkjent» skal komme fram nå, ikke etter at 270 rader
 * er validert. Derfor bygges behandlingen prøvevis her.
 *
 * `hjelp` er kallerens egne ord for de tre utveiene — kommandolinja snakker om
 * flagg, grensesnittet om knapper. Regelen er den samme; formuleringen er det
 * ikke.
 */
function krevBeslutning(def, { status, beslutning, utenBehandling = false, behandletAv = '', hjelp = '' }) {
    const harBehandling = Array.isArray(def?.Behandling) && def.Behandling.length > 0;
    if (!harBehandling) return;
    if (Number(status) === 5 && !beslutning && !utenBehandling) {
        const valg = (def.Behandling[0].Beslutningsvalg || []).map(v => v.Tekst).filter(Boolean);
        throw new Error(
            `Skjematypen har ${def.Behandling.length} behandlingssteg, men utfallet er ikke oppgitt`
            + (valg.length ? ` (valg: ${valg.join(', ')})` : '') + '.'
            + (hjelp ? `\n${hjelp}` : ''));
    }
    // Kaster hvis navnet ikke finnes på et av stegene.
    if (beslutning) byggFerdigBehandling(def, beslutning, behandletAv, new Date().toISOString(), '');
}

/**
 * Hele analysen av et regneark mot en skjematype, uten å skrive noe.
 *
 * Dette er funksjonen både kommandolinja og endepunktet kaller. Delte
 * småfunksjoner ville ikke vært nok: rekkefølgen — finn overskriften, koble,
 * tolk, grupper feilene, hopp over det som finnes — ER regelen, og to
 * kopier av den ville før eller siden gitt to ulike svar på samme fil.
 *
 * Returnerer alt grensesnittet trenger for å vise planen, og alt skrivingen
 * trenger for å utføre den. Ingenting lagres her.
 */
function lagPlan({ matrise, def, eksisterende = [], opsjoner = {} }) {
    const { kolonner = {}, verdier = {}, skilletegn = '/', nokkelfelt = '' } = opsjoner;

    // Rettingene normaliseres, så kasus i arket ikke avgjør om de treffer.
    const aliaser = {};
    for (const [fra, til] of Object.entries(verdier)) {
        aliaser[fra] = til;
        aliaser[normaliser(fra)] = til;
    }

    const katalog = feltKatalog(def);
    if (katalog.length === 0) throw new Error('Skjematypen har ingen felt som kan ta imot svar');

    // Overskriftsraden kjennes igjen på at minst to celler er navn vi kjenner.
    // Både feltetikettene OG nøklene i koblingsfila teller: en kolonne som
    // bare kobles manuelt er like mye en overskrift som en som treffer av seg
    // selv. Uten koblingsnøklene kunne et ark med to manuelt koblede kolonner
    // ikke finne raden i det hele tatt — og feilmeldingen pekte da på
    // feltnavnene, som var helt riktige.
    const kjente = new Set([
        ...katalog.map(f => normaliser(f.etikett)),
        ...Object.keys(kolonner).map(normaliser)
    ].filter(Boolean));
    const linje = finnOverskrift(matrise, kjente);
    if (linje < 0) {
        throw new Error('Fant ingen overskriftsrad der minst to kolonner er kjente navn. '
            + `Feltnavnene i skjematypen er: ${katalog.map(f => f.etikett).filter(Boolean).join(', ')}`
            + (Object.keys(kolonner).length > 0
                ? `. Koblingsfila nevner: ${Object.keys(kolonner).join(', ')}`
                : '. Har arket andre kolonnenavn, koble dem med en koblingsfil.'));
    }

    const { kobling, ukoblede } = koble(matrise[linje], katalog, kolonner);
    if (kobling.length === 0) throw new Error('Ingen kolonner lot seg koble til felt.');
    const brukte = new Set(kobling.map(k => k.felt.nokkel));
    const ledige = katalog.filter(f => !brukte.has(f.nokkel));

    // Nøkkelfeltet gjør kjøringen idempotent. Det må være en KOBLET kolonne —
    // ellers er det tomt på hver rad, og idempotensen virker ikke uansett.
    let nokkelFelt = null;
    if (nokkelfelt) {
        const treff = kobling.find(k => normaliser(k.overskrift) === normaliser(nokkelfelt));
        nokkelFelt = treff?.felt
            || katalog.find(f => f.nokkel === nokkelfelt && brukte.has(f.nokkel))
            || null;
        if (!nokkelFelt) {
            throw new Error(`Fant ikke nøkkelfeltet "${nokkelfelt}". Det må være en kolonne som er koblet. `
                + `Koblede kolonner: ${kobling.map(k => `"${k.overskrift}"`).join(', ')}`);
        }
    }

    // Nøkkelverdier som finnes fra før — rader med dem hoppes over.
    const finnes = new Set();
    if (nokkelFelt) {
        for (const sk of eksisterende) {
            const v = nokkelverdi(sk, nokkelFelt.nokkel);
            if (v) finnes.add(normaliser(v));
        }
    }

    const rader = [], feil = [], hoppet = [];
    for (let i = linje + 1; i < matrise.length; i++) {
        const rad = matrise[i] || [];
        const radNr = i + 1;
        const svar = {};
        let tom = true;
        let radHarFeil = false;
        for (const k of kobling) {
            const { verdi, feil: f, ukjent } = tolkVerdi(rad[k.kolonne], k.felt, { aliaser, skilletegn });
            if (f) { feil.push({ radNr, kolonne: k.overskrift, melding: f, ukjent }); radHarFeil = true; continue; }
            if (verdi === null) continue;
            tom = false;
            svar[k.felt.nokkel] = Array.isArray(verdi) ? verdi : [verdi];
        }
        if (tom) continue;
        // En rad med en ugyldig celle er ikke klar til import. Uten dette ble
        // den telt med blant de klare, med den ene cella stilltiende utelatt —
        // og «2 rader klar, 1 feil» er en setning som ikke går opp.
        if (radHarFeil) continue;
        if (nokkelFelt) {
            const n = (svar[nokkelFelt.nokkel] || [])[0];
            if (!n) { feil.push({ radNr, kolonne: nokkelFelt.etikett, melding: 'Nøkkelfeltet er tomt' }); continue; }
            if (finnes.has(normaliser(n))) { hoppet.push({ radNr, verdi: n }); continue; }
            // Dubletter INNE i fila teller også — ellers lager én kjøring dem selv.
            finnes.add(normaliser(n));
        }
        rader.push({ radNr, svar });
    }

    return { linje, kobling, ukoblede, ledige, nokkelFelt, rader, feil, hoppet, grupper: grupperFeil(feil) };
}

/**
 * Feilene gruppert på verdi i stedet for på rad.
 *
 * 270 rader med fire skrivefeil gir 300 enkeltfeil, og den lista er ikke til
 * å jobbe med. Gruppert blir den fire ting å rette, med antall og noen
 * radnumre å slå opp.
 */
function grupperFeil(feil) {
    const kart = new Map();
    for (const f of feil) {
        const n = `${f.kolonne}\u0000${f.ukjent ?? f.melding}`;
        if (!kart.has(n)) kart.set(n, { kolonne: f.kolonne, ukjent: f.ukjent ?? null, melding: f.melding, antall: 0, rader: [] });
        const g = kart.get(n);
        g.antall++;
        if (g.rader.length < 5) g.rader.push(f.radNr);
    }
    return [...kart.values()].sort((a, b) => b.antall - a.antall);
}

module.exports = {
    lagPlan, grupperFeil, krevBeslutning,
    lesMatrise, normaliser, finnOverskrift, feltKatalog, koble,
    slaOppValg, tolkVerdi, finnValg, byggFerdigBehandling, byggSeksjoner,
    beskrivFelt, nokkelverdi
};
