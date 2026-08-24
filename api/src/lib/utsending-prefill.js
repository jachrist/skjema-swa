/**
 * Oppslag i prefilled-verdier for utsendinger.
 *
 * En prefilled-verdi er normalt bare tekst:
 *
 *   { "1-01": ["CBU1503"] }
 *
 * Men den kan også være en referanse som slås opp når mottakeren åpner lenka:
 *
 *   { "1-02": { "emnebeskrivelse": "26H|CBU1503-1" } }
 *
 * Da lagres bare referansen i Utsendinger-tabellen — ikke teksten. Det holder
 * radene små (Prefilled har en grense på 30 000 tegn), slipper å duplisere en
 * lang beskrivelse for hver eneste mottaker i en batch, og gir alltid den
 * teksten som gjelder når skjemaet faktisk fylles ut.
 *
 * Referansene valideres når utsendingen opprettes, slik at en skrivefeil i
 * emnekoden oppdages der og da — ikke som et tomt felt hos 200 mottakere.
 */
const emnerStorage = require('./emner-storage');

const OPPSLAGSTYPER = ['emnebeskrivelse'];

/** Er verdien en oppslags-referanse og ikke en ferdig tekst? */
function erOppslag(verdi) {
    if (!verdi || typeof verdi !== 'object' || Array.isArray(verdi)) return false;
    return OPPSLAGSTYPER.some(t => typeof verdi[t] === 'string');
}

/** "26H|CBU1503-1" → { termin: "26H", emneId: "CBU1503-1" }. Termin er valgfri. */
function delEmneref(ref) {
    const s = String(ref || '').trim();
    if (s.includes('|')) {
        const [termin, emneId] = s.split('|');
        return { termin: termin.trim(), emneId: emneId.trim() };
    }
    return { termin: '', emneId: s };
}

/**
 * Slår opp én referanse. Returnerer { tekst } ved treff, { feil } ellers.
 */
async function slaOpp(verdi) {
    if (typeof verdi.emnebeskrivelse === 'string') {
        const { termin, emneId } = delEmneref(verdi.emnebeskrivelse);
        if (!emneId) return { feil: 'emnebeskrivelse mangler emnekode' };
        const emne = await emnerStorage.hentEmne(termin, emneId);
        if (!emne) return { feil: `fant ikke emne ${emneId}${termin ? ' i termin ' + termin : ''}` };
        return { tekst: emne.LU || '' };
    }
    return { feil: 'ukjent oppslagstype' };
}

/**
 * Sjekk at alle referanser i et prefilled-objekt lar seg slå opp.
 * Returnerer en liste med feilmeldinger — tom liste betyr at alt er i orden.
 * Hver unik referanse slås opp én gang.
 */
async function validerOppslag(prefilled, cache = new Map()) {
    const feil = [];
    for (const [nokkel, verdi] of Object.entries(prefilled || {})) {
        if (!erOppslag(verdi)) continue;
        const memo = JSON.stringify(verdi);
        if (!cache.has(memo)) cache.set(memo, await slaOpp(verdi));
        const res = cache.get(memo);
        if (res.feil) feil.push(`${nokkel}: ${res.feil}`);
    }
    return feil;
}

/**
 * Bytt referanser med oppslått tekst. Verdier som allerede er tekst røres ikke.
 * Et oppslag som feiler gir tom tekst og logges — mottakeren skal få opp
 * skjemaet selv om beskrivelsen mangler.
 */
async function resolverPrefilled(prefilled, log = () => {}) {
    if (!prefilled || typeof prefilled !== 'object') return prefilled;
    const ut = {};
    const cache = new Map();
    for (const [nokkel, verdi] of Object.entries(prefilled)) {
        if (!erOppslag(verdi)) { ut[nokkel] = verdi; continue; }
        const memo = JSON.stringify(verdi);
        if (!cache.has(memo)) cache.set(memo, await slaOpp(verdi));
        const res = cache.get(memo);
        if (res.feil) {
            log(`utsending-prefill: ${nokkel} — ${res.feil}`);
            ut[nokkel] = [''];
        } else {
            ut[nokkel] = [res.tekst];
        }
    }
    return ut;
}

module.exports = { erOppslag, validerOppslag, resolverPrefilled, delEmneref };
