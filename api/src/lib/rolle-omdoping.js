/**
 * Omdøping av roller — reglene, uten I/O.
 *
 * Ønsket 03.11.2026: rollenavn og omfang skal kunne endres i admin. Mest
 * omfanget (et emne får ny kode), men også navnet (en skrivefeil). Saker
 * under behandling skal følge med, og alt vises i en forhåndsvisning før noe
 * skrives.
 *
 * ## To operasjoner, ikke én
 *
 *   { type: 'navn',   fra: 'Emneansvarleg', til: 'Emneansvarlig' }
 *       Rollen får nytt navn i ALLE omfang. «A» → «B», «A(x)» → «B(x)»,
 *       «A({2-01})» → «B({2-01})».
 *
 *   { type: 'omfang', rolle: 'Emneansvarlig', fra: 'ING2308', til: 'ING2309' }
 *       Én rollegruppe får nytt omfang. Bare «A(x)» → «A(y)», eksakt. «A»
 *       (alle omfang) og «A({2-01})» (omfanget hentes fra et svar) røres ikke.
 *
 * Å endre navn og omfang samtidig er bevisst ikke en operasjon: den ville
 * flyttet én gruppe til en ny rolle mens de andre omfangene ble igjen, og et
 * rollenavn uten omfang — `fraRolle` i en rapport, `EierRolle` på en gruppe —
 * ville ikke hatt noe riktig svar. To steg etter hverandre har det.
 *
 * ## Hvor rollestrenger står
 *
 * Kartlagt 03.11.2026, og listet ETT sted — her. Gjennomgangen er generisk
 * over JSON-treet, men styres av nøkkelnavn, ikke av innhold: et søk-og-erstatt
 * på tekst ville truffet fritekst i e-postmaler og forklaringer.
 *
 *   ROLLELISTER   lister av rollestrenger: tilgang (`{ Personer, Roller, Team }`
 *                 i Publikum, Eiere, rapporter, mottakere) og behandlingssteg,
 *                 også `RollerMal` i innsendte saker
 *   ROLLESTRENGER én rollestreng: Planner-ansvarlig
 *   ROLLENAVN     et rollenavn uten omfang: rapportfilter `fraRolle`,
 *                 rollegruppens `EierRolle`
 *   FasteData     filterledd `{ Kolonne: 'Rolle', Verdi }` i nedtrekkslister
 *
 * Utenfor: svar i innsendte skjemaer. De er brukerens data, kan være kryptert,
 * og en rolle valgt i en nedtrekksliste er et svar, ikke et oppsett.
 */
const { delRolleStreng } = require('./roller-storage');

const ROLLELISTER = ['Roller', 'RollerMal'];
const ROLLESTRENGER = ['AnsvarligRolle'];
const ROLLENAVN = ['fraRolle', 'EierRolle'];

/**
 * Roller koden selv slår opp ved navn. Gis de nytt navn, slutter koden å
 * finne dem; gis en annen rolle navnet, får medlemmene rettighetene.
 * `api/test/rolle-omdoping.test.js` leser kildekoden og krever at hvert
 * navn som slås opp som en strengkonstant, står her.
 */
const RESERVERTE = ['Skjemaskaper'];

// Table Storage tillater ikke disse i PartitionKey eller RowKey.
const ULOVLIG_I_NOKKEL = /[/\\#?\u0000-\u001f\u007f-\u009f]/;

/** Hva som er galt med operasjonen, eller null. */
function valider(op) {
    const type = op?.type;
    if (type !== 'navn' && type !== 'omfang') return 'Ukjent operasjon — bruk «navn» eller «omfang»';
    const fra = String(op.fra ?? '').trim();
    const til = String(op.til ?? '').trim();
    if (!fra || !til) return 'Både gammelt og nytt navn må fylles ut';
    if (fra === til) return 'Det nye er likt det gamle';
    if (ULOVLIG_I_NOKKEL.test(til)) return 'Kan ikke inneholde / \\ # ? eller kontrolltegn';
    if (/[(){}]/.test(til)) return 'Kan ikke inneholde parenteser eller klammer — de har egen betydning i en rollestreng';

    if (type === 'navn') {
        if (/\|/.test(til)) return 'Et rollenavn kan ikke inneholde |';
        for (const navn of [fra, til]) {
            if (RESERVERTE.includes(navn)) {
                return `«${navn}» brukes av systemet selv og kan ikke gis nytt navn, eller gis til en annen rolle`;
            }
        }
    } else {
        if (!String(op.rolle ?? '').trim()) return 'Rollen må oppgis';
    }
    return null;
}

/** En rollestreng etter operasjonen. Uendret hvis den ikke treffes. */
function omskrivRolleStreng(streng, op) {
    if (typeof streng !== 'string') return streng;
    const delt = delRolleStreng(streng);
    if (!delt) return streng;
    const { rolle, omfang } = delt;
    if (op.type === 'navn') {
        if (rolle !== op.fra) return streng;
        return omfang ? `${op.til}(${omfang})` : op.til;
    }
    if (rolle !== op.rolle || omfang !== op.fra) return streng;
    return `${rolle}(${op.til})`;
}

/** Et rollenavn uten omfang. Bare navneoperasjonen rører det. */
function omskrivRolleNavn(navn, op) {
    if (op.type !== 'navn' || typeof navn !== 'string') return navn;
    return navn.trim() === op.fra ? op.til : navn;
}

/**
 * Hele treet etter operasjonen, og hvor det ble endret.
 *
 * Returnerer { tre, endringer } — `tre` er en ny kopi, og `endringer` er en
 * liste { sti, fra, til } til forhåndsvisningen. Det opprinnelige objektet
 * røres ikke, så forhåndsvisning og utførelse kan bruke samme kall.
 */
function omskrivTre(rot, op) {
    const endringer = [];
    const merk = (sti, fra, til) => { if (fra !== til) endringer.push({ sti, fra, til }); };

    function gaa(node, sti) {
        if (Array.isArray(node)) return node.map((v, i) => gaa(v, `${sti}[${i}]`));
        if (!node || typeof node !== 'object') return node;

        const ut = {};
        for (const [nokkel, verdi] of Object.entries(node)) {
            const her = sti ? `${sti}.${nokkel}` : nokkel;
            if (ROLLELISTER.includes(nokkel) && Array.isArray(verdi)) {
                ut[nokkel] = verdi.map((r, i) => {
                    const ny = omskrivRolleStreng(r, op);
                    merk(`${her}[${i}]`, r, ny);
                    return ny;
                });
            } else if (ROLLESTRENGER.includes(nokkel) && typeof verdi === 'string') {
                ut[nokkel] = omskrivRolleStreng(verdi, op);
                merk(her, verdi, ut[nokkel]);
            } else if (ROLLENAVN.includes(nokkel) && typeof verdi === 'string') {
                ut[nokkel] = omskrivRolleNavn(verdi, op);
                merk(her, verdi, ut[nokkel]);
            } else {
                ut[nokkel] = gaa(verdi, her);
            }
        }
        // Filterledd i FasteData: { Kolonne: 'Rolle', Operator, Verdi }.
        // Verdien er et rollenavn (datakilden Roller) eller en rollestreng
        // (Personer) — omskrivRolleStreng håndterer begge.
        if (ut.Kolonne === 'Rolle' && typeof ut.Verdi === 'string') {
            const ny = omskrivRolleStreng(ut.Verdi, op);
            merk(sti ? `${sti}.Verdi` : 'Verdi', ut.Verdi, ny);
            ut.Verdi = ny;
        }
        return ut;
    }

    return { tre: gaa(rot, ''), endringer };
}

/** Treffer operasjonen denne (Rolle, Omfang)? */
function treffer(rolle, omfang, op) {
    if (op.type === 'navn') return rolle === op.fra;
    return rolle === op.rolle && omfang === op.fra;
}

/** Hvor (Rolle, Omfang) havner etter operasjonen. */
function maal(rolle, omfang, op) {
    return op.type === 'navn' ? { rolle: op.til, omfang } : { rolle, omfang: op.til };
}

/**
 * Medlemskapene som må flyttes.
 *
 * `rader` er innehaverne slik `roller-storage.hentAlle()` gir dem. En person
 * som allerede står i målet, får ikke en rad til: kilderaden slettes, og
 * målraden står. Ellers ville en sammenslåing gitt to rader for samme person
 * med ulik `Kilde`, og importen ville bare kunne fjerne den ene.
 */
function planMedlemskap(rader, op) {
    const finnes = new Set(rader.map(r => `${r.Rolle}\u0000${r.Omfang}\u0000${String(r.UPN).toLowerCase()}`));
    const skriv = [], slett = [];
    let alleredeIMaal = 0;
    for (const r of rader) {
        if (!treffer(r.Rolle, r.Omfang, op)) continue;
        const m = maal(r.Rolle, r.Omfang, op);
        slett.push({ Rolle: r.Rolle, Omfang: r.Omfang, UPN: r.UPN });
        if (finnes.has(`${m.rolle}\u0000${m.omfang}\u0000${String(r.UPN).toLowerCase()}`)) {
            alleredeIMaal++;
            continue;
        }
        skriv.push({ ...r, Rolle: m.rolle, Omfang: m.omfang });
    }
    return { skriv, slett, alleredeIMaal };
}

/**
 * Rollegruppene (Team, EierRolle) som må flyttes, og EierRolle som må
 * skrives om på grupper som ikke flyttes.
 *
 * Finnes målgruppen fra før, beholdes den — den har sitt eget team og sin
 * egen eier, og å overskrive dem ville flyttet folk inn og ut av et team uten
 * at noen ba om det. Kildens oppsett meldes som en konflikt i
 * forhåndsvisningen hvis det skiller seg fra målets.
 */
function planGrupper(grupper, op) {
    const nokkel = (r, o) => `${r}\u0000${o}`;
    const finnes = new Map(grupper.map(g => [nokkel(g.Rolle, g.Omfang), g]));
    const flytt = [], oppdater = [], konflikter = [];
    for (const g of grupper) {
        const nyEier = omskrivRolleNavn(g.EierRolle || '', op);
        if (!treffer(g.Rolle, g.Omfang, op)) {
            if (nyEier !== (g.EierRolle || '')) oppdater.push({ ...g, EierRolle: nyEier });
            continue;
        }
        const m = maal(g.Rolle, g.Omfang, op);
        const iMaal = finnes.get(nokkel(m.rolle, m.omfang));
        if (iMaal) {
            if ((g.Team || '') !== (iMaal.Team || '') || nyEier !== (iMaal.EierRolle || '')) {
                konflikter.push({
                    fra: { Rolle: g.Rolle, Omfang: g.Omfang, Team: g.Team || '', EierRolle: g.EierRolle || '' },
                    til: { Rolle: iMaal.Rolle, Omfang: iMaal.Omfang, Team: iMaal.Team || '', EierRolle: iMaal.EierRolle || '' }
                });
            }
            flytt.push({ fra: g, til: null });
            continue;
        }
        flytt.push({ fra: g, til: { ...g, Rolle: m.rolle, Omfang: m.omfang, EierRolle: nyEier } });
    }
    return { flytt, oppdater, konflikter };
}

module.exports = {
    valider, omskrivRolleStreng, omskrivRolleNavn, omskrivTre,
    planMedlemskap, planGrupper,
    ROLLELISTER, ROLLESTRENGER, ROLLENAVN, RESERVERTE
};
