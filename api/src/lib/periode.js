/**
 * periode.js — Sjekker om en skjematype er tilgjengelig for utfylling akkurat nå
 * basert på Tilgjengelighetsperioder-array.
 *
 * Format: [{ Fra: "YYYY-MM-DD", Til: "YYYY-MM-DD" }, ...]
 * - Både Fra og Til er inklusive (hele dagen)
 * - Fra/Til kan være tomme — betyr "ingen grense"
 * - Ingen perioder = alltid tilgjengelig
 * - Én treff er nok (perioder OR-es sammen)
 */

function erTilgjengeligNaa(perioder, naa = new Date()) {
    if (!Array.isArray(perioder) || perioder.length === 0) return true;
    const naaMs = naa.getTime();

    for (const p of perioder) {
        const fra = p?.Fra ? parseDato(p.Fra, false) : -Infinity;
        const til = p?.Til ? parseDato(p.Til, true)  : Infinity;
        if (fra === null || til === null) continue; // ugyldig dato — hopp over
        if (naaMs >= fra && naaMs <= til) return true;
    }
    return false;
}

function parseDato(iso, slutten) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
        slutten ? 23 : 0, slutten ? 59 : 0, slutten ? 59 : 0, slutten ? 999 : 0);
    return d.getTime();
}

module.exports = { erTilgjengeligNaa };
