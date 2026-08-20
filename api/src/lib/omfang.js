/**
 * Omfangs-normalisering for roller.
 *
 * Rolle-lista vedlikeholdes på ren kode — "MILM23-1", "KS Kull Rønneberg 22-25".
 * FasteData-kildene Klasser og Kull leverer derimot sammensatte nøkler der
 * studieprogram og termin er bakt inn:
 *
 *     "FHSBA|22H|KS Kull Rønneberg 22-25"
 *
 * (se rowKey-byggingen i refresh-fs.js). Sammenligner man de to direkte, får man
 * null treff selv om rollen finnes. Klassen består dessuten over flere terminer,
 * så det er siste ledd — ikke hele nøkkelen — som er den stabile identiteten.
 *
 * Normaliser derfor begge sider av en omfangssammenligning med denne.
 */

function normaliserOmfang(verdi) {
    const s = String(verdi ?? '').trim();
    const i = s.lastIndexOf('|');
    return (i >= 0 ? s.slice(i + 1) : s).trim();
}

module.exports = { normaliserOmfang };
