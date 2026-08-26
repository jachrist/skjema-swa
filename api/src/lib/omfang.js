/**
 * Omfangsalias for roller.
 *
 * Rolle-lista vedlikeholdes for hånd, og admin skriver inn omfanget slik hen
 * ser klassen i nedtrekket: «KS Kull Rønneberg 22-25». FasteData-kildene
 * Klasser og Kull leverer derimot FS' egen naturlige nøkkel som verdi:
 *
 *     "FHSBA|22H|A"        {studieprogram}|{kullets start-termin}|{klassekode}
 *
 * De tre leddene er ikke utbyttbare:
 *   - Hele nøkkelen er unik og stabil. Terminen er kullets START-termin, ikke
 *     inneværende, så nøkkelen står uendret så lenge klassen finnes.
 *   - Klassekoden alene er IKKE unik — i et uttrekk på ti klasser gikk "A" igjen
 *     fem ganger (FILTERSTUDENT-SPEC.md §6 funn 1). Den kan bare brukes som
 *     alias for den klassen oppslaget faktisk gjelder.
 *   - Klassenavnet ("KS Kull Rønneberg 22-25") ligger i FilterStudent-metadata
 *     under `Navn`, sammen med studieprogram og termin i parentes.
 *
 * hentOmfangsalias() slår derfor opp klassen og returnerer alle formene admin
 * rimeligvis kan ha skrevet, i prioritert rekkefølge. Kallere som skal treffe
 * ÉN rolle (rolleoppslag, dynamisk behandler) prøver dem i tur; kallere som
 * filtrerer en liste kan matche mot hele settet.
 */
const emnerStorage = require('./emner-storage');

/** Siste ledd etter «|» — klassekoden i en sammensatt nøkkel. */
function normaliserOmfang(verdi) {
    const s = String(verdi ?? '').trim();
    const i = s.lastIndexOf('|');
    return (i >= 0 ? s.slice(i + 1) : s).trim();
}

function erSammensatt(verdi) {
    return String(verdi ?? '').includes('|');
}

/**
 * Metadatas `Navn` er "{klassenavn} ({SP}, {termin})" for klasser og
 * "{kullnavn} ({termin})" for kull. Vi har SP og Termin på raden, så halen
 * fjernes eksakt i stedet for med et gjettet mønster.
 */
function navnUtenHale(rad) {
    const navn = String(rad?.Navn || '').trim();
    for (const hale of [` (${rad?.SP}, ${rad?.Termin})`, ` (${rad?.Termin})`]) {
        if (rad?.Termin && navn.endsWith(hale)) return navn.slice(0, -hale.length).trim();
    }
    return navn;
}

async function finnMetaRad(verdi) {
    for (const partisjon of ['KLASSE', 'KULL']) {
        let rader;
        try {
            rader = await emnerStorage.hentFilterMeta(partisjon);
        } catch (_) {
            continue; // Manglende FS-data skal ikke velte et rolleoppslag
        }
        const treff = rader.find(r => String(r.Verdi || '') === String(verdi));
        if (treff) return treff;
    }
    return null;
}

/**
 * Alle omfangsformene som kan svare til `verdi`, mest spesifikke først:
 *   1. verdien selv (hele nøkkelen — unik og stabil)
 *   2. klasse-/kullnavnet slik det vises i nedtrekket
 *   3. klassekoden alene (siste ledd) — minst spesifikk, se §6 funn 1
 *
 * En verdi uten «|» er allerede ren tekst og returneres alene.
 */
async function hentOmfangsalias(verdi) {
    const start = String(verdi ?? '').trim();
    if (!start) return [];
    if (!erSammensatt(start)) return [start];

    const alias = [start];
    const rad = await finnMetaRad(start);
    const navn = rad ? navnUtenHale(rad) : '';
    if (navn && !alias.includes(navn)) alias.push(navn);

    const kode = normaliserOmfang(start);
    if (kode && !alias.includes(kode)) alias.push(kode);
    return alias;
}

/**
 * Alle formene et sett med omfang kan ha i et skjemasvar.
 *
 * `hentOmfangsalias` går fra FS-nøkkelen og utover. Denne går motsatt vei:
 * rollelista har omfanget slik admin skrev det inn — klassenavnet, eller bare
 * klassekoden — mens svaret i skjemaet er FS' sammensatte nøkkel. Et rollefilter
 * på klasse ville aldri truffet uten denne oversettelsen.
 *
 * Treffer et omfang en rad i FilterMeta, tas alle radens former med. Omfang som
 * ikke finnes i FS (manuelt vedlikeholdte klasser, emnekoder) blir stående som
 * de er — de er allerede den formen svaret har.
 */
async function finnOmfangsvarianter(omfangListe) {
    const ut = [];
    const leggTil = (v) => {
        const s = String(v ?? '').trim();
        if (s && !ut.some(x => x.toLowerCase() === s.toLowerCase())) ut.push(s);
    };
    for (const o of (omfangListe || [])) leggTil(o);
    if (ut.length === 0) return [];

    const sokte = new Set(ut.map(s => s.toLowerCase()));
    for (const partisjon of ['KLASSE', 'KULL']) {
        let rader;
        try {
            rader = await emnerStorage.hentFilterMeta(partisjon);
        } catch (_) {
            continue; // Manglende FS-data skal ikke velte en rapportkjøring
        }
        for (const rad of rader) {
            const former = [String(rad.Verdi || ''), navnUtenHale(rad), normaliserOmfang(rad.Verdi)]
                .map(s => String(s || '').trim())
                .filter(Boolean);
            if (!former.some(f => sokte.has(f.toLowerCase()))) continue;
            for (const f of former) leggTil(f);
        }
    }
    return ut;
}

module.exports = { normaliserOmfang, erSammensatt, hentOmfangsalias, finnOmfangsvarianter };
