/**
 * Utfallet av et behandlingssteg — ett sted, fordi det ble vist tre.
 *
 * «Alle må avgjøre» lar flere behandlere avgi hver sin beslutning. Sluttsvaret
 * på steget settes til den SISTE som leverte:
 *
 *     stegObj.Beslutning = beslutning;   // skjemaer.js, alle-modus
 *
 * Så lenge alle sier det samme er det riktig nok. Sier de ulike ting, er det
 * vilkårlig — og tre visninger leste nettopp det feltet og viste ett svar:
 *
 *   frontend/evaluering.html   `tolkStatus` i steg-oversikten
 *   frontend/visning.html      `tolkStatus` i behandlingshistorikken
 *   api/src/lib/pdf-generator  linja «Steg N: Navn - Tekst (hvem, dato)»
 *
 * Meldt 26.10.2026: to behandlere ga ulike anbefalinger, og bare den siste
 * sto i utskriftene. Den andre vurderingen fantes i dataene hele tiden.
 *
 * Her er regelen, og alle tre leser den herfra:
 *
 *   `enkeltutfall(steg)` — én rad per behandler, med sin egen beslutning
 *   `samletUtfall(steg)` — det uthevede svaret: ett utfall når alle sier det
 *                          samme, ellers «Ulike vurderinger»
 *
 * MERK: den samme filen finnes i `api/src/lib/behandling-utfall.js`. Sidene
 * kan ikke importere fra `api/`, så den må dupliseres — men
 * `api/test/behandling-utfall.test.js` kjører BEGGE mot de samme stegene og
 * krever samme svar.
 *
 * HVA DENNE IKKE GJØR: den endrer ikke hva flyten gjør. `steg.Beslutning`
 * styrer fortsatt veien videre, og ved ulike vurderinger er det fortsatt den
 * siste som avgjør. Det er en reell designbeslutning som hører hjemme hos
 * oppdragsgiver, ikke i en visningsmodul — men nå er den i det minste synlig.
 */

/**
 * Fargene. Gul på hvitt er nær uleselig, så ompuss får en mørk ravgul, og
 * «ulike» en kraftigere oransje. De to vises aldri på samme steg, men de står
 * under hverandre i en liste, og da må de kunne skilles.
 */
export const FARGER = {
    positiv: '#34c759',
    negativ: '#ff3b30',
    ompuss: '#c98a00',
    ulike: '#ff6a00',
    hoppet: '#8e8e93',
    ukjent: '#8e8e93'
};

/** Beslutningsvalget med dette nummeret, eller null. */
export function valgFor(steg, nummer) {
    const n = Number(nummer);
    return (steg?.Beslutningsvalg || []).find(v => Number(v.Nummer) === n) || null;
}

/**
 * Hvilken SLAGS beslutning er dette?
 *
 * Ompuss er erklært (`Handling === 'ompuss'`) og leses derfra. «Negativ» fikk
 * sin egen bryter 26.10.2026 (`Handling === 'avvisning'`), men bare nye valg
 * har den — så teksten er fortsatt reserve for alt som finnes fra før.
 * Den regelen fantes i tre kopier med litt ulikt innhold: visning.html tok
 * også med «revid», de to andre ikke. Her er den én, og den tar med begge.
 */
export function typeFor(valg) {
    if (!valg) return 'ukjent';
    // Erklært vinner over utledet. `ompuss` har hatt sin bryter i editoren
    // hele tiden; `avvisning` kom 26.10.2026 og gjelder bare valg som er
    // satt etter det — derfor står tekstregelen under som reserve for alt
    // som finnes fra før.
    const handling = String(valg.Handling || '');
    if (handling === 'ompuss') return 'ompuss';
    if (handling === 'avvisning') return 'negativ';

    // Utledet, og bevisst bred: «Ikke anbefalt» er like negativt som
    // «Avslått», og et skjema med nettopp de to valgene var det som meldte
    // feilen. En heuristikk som bare kjente «avslå» og «avvis» ville vist
    // avslaget i grønt.
    // Navngitte vendinger, ikke et bredt «starter med ikke». Første utgave
    // brukte /^ikke\b/ og gjorde «Ikke relevant» til et avslag — et utfall
    // som er nøytralt, og som da ville stått i rødt. Det er bedre å la et
    // uvanlig avslag bli grønt og erklæres med bryteren, enn å farge et
    // nøytralt utfall som en avvisning.
    const t = String(valg.Tekst || '').toLowerCase().trim();
    if (t.includes('avslå') || t.includes('avvis')) return 'negativ';
    if (t.includes('ikke anbefal') || t.includes('ikke godkjen')
        || t.includes('ikke innvilg') || t.includes('ikke støtt')) return 'negativ';
    if (t.includes('ompuss') || t.includes('revid')) return 'ompuss';
    return 'positiv';
}

/** Teksten for et beslutningsnummer, slik den skal leses. */
export function tekstFor(steg, nummer) {
    const n = Number(nummer || 0);
    if (n === 5) return 'Hoppet over';
    if (!n) return '';
    return valgFor(steg, n)?.Tekst || `Beslutning ${n}`;
}

/**
 * Én rad per behandler som har avgitt.
 *
 * Alle-modus har dem i `Beslutninger[]`. Standardmodus har ett svar på
 * steget. Leses bare den ene formen, står den andre modusen tom — samme felle
 * som kommentarene gikk i, se behandling-kommentar.js.
 *
 * Avgivelser med beslutning 0 er ikke avgivelser; de kan ikke oppstå i dag,
 * men en tom rad ville blitt vist som «Beslutning 0».
 */
export function enkeltutfall(steg) {
    const avgitte = (steg?.Beslutninger || []).filter(b => Number(b?.Beslutning || 0) !== 0);
    if (avgitte.length > 0) {
        return avgitte.map(b => ({
            aktor: String(b.Aktor || ''),
            beslutning: Number(b.Beslutning),
            tekst: tekstFor(steg, b.Beslutning),
            type: typeFor(valgFor(steg, b.Beslutning)),
            kommentar: String(b.Kommentar || ''),
            dato: String(b.Dato || '')
        }));
    }
    const n = Number(steg?.Beslutning || 0);
    if (!n) return [];
    return [{
        aktor: String(steg.BehandletAv || ''),
        beslutning: n,
        tekst: tekstFor(steg, n),
        type: typeFor(valgFor(steg, n)),
        kommentar: String(steg.Kommentar || ''),
        dato: String(steg.BehandletDato || '')
    }];
}

/**
 * Det uthevede svaret.
 *
 * Én behandler, eller flere som sier det samme → utfallet, med sin farge.
 * Flere som sier ulike ting → «Ulike vurderinger», oransje. Da er det
 * enkeltutfallene som bærer informasjonen, og en uthevet «Avslått» ville
 * skjult at noen anbefalte.
 *
 * Sammenligner NUMMER, ikke tekst: to valg kan hete det samme og bety ulike
 * ting, og teksten kan endres i editoren etter at beslutningen ble tatt.
 */
export function samletUtfall(steg) {
    const enkelt = enkeltutfall(steg);
    if (enkelt.length === 0) {
        return { type: 'ukjent', tekst: '', farge: FARGER.ukjent, ulike: false, antall: 0 };
    }
    if (Number(steg?.Beslutning || 0) === 5 && enkelt.length === 1) {
        return { type: 'hoppet', tekst: 'Hoppet over', farge: FARGER.hoppet, ulike: false, antall: 1 };
    }
    const unike = [...new Set(enkelt.map(e => e.beslutning))];
    if (unike.length > 1) {
        return { type: 'ulike', tekst: 'Ulike vurderinger', farge: FARGER.ulike, ulike: true, antall: enkelt.length };
    }
    const f = enkelt[0];
    return { type: f.type, tekst: f.tekst, farge: FARGER[f.type] || FARGER.ukjent, ulike: false, antall: enkelt.length };
}

/**
 * Enkeltutfallene som én linje, til PDF og regneark.
 *
 * Aktøren tas med bare når det er flere — med én behandler står navnet
 * allerede i linja rundt. Samme regel som `kommentarLinje`.
 */
export function utfallLinje(steg) {
    const e = enkeltutfall(steg);
    if (e.length === 0) return '';
    if (e.length === 1) return e[0].tekst;
    return e.map(x => `${x.aktor}: ${x.tekst}`).join(' | ');
}
