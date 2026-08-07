/**
 * Tilgangskontroll — pilot-versjon.
 *
 * Denne modulen speiler filtrerTyperPåTilgang fra referanse-appen, men støtter
 * KUN direkte UPN-match i Personer-listen. Rolle- og team-baserte tilganger
 * kommer når vi porterer masterdata-modulen.
 *
 * Signaturen holdes lik referanse-appen så koden lett kan utvides senere.
 */

/**
 * Sjekk om upn har direkte tilgang via Personer-listen i en tilgangsstruktur.
 *
 * @param {object} tilgang  — objekt som { Personer: [...], Roller: [...], Team: [...] }
 * @param {string} upn
 * @returns {boolean}
 */
function harPersonligTilgang(tilgang, upn) {
    if (!tilgang || !upn) return false;
    const upnLower = String(upn).toLowerCase();
    const personer = (tilgang.Personer || []).map(p => String(p).toLowerCase());
    return personer.includes(upnLower);
}

/**
 * Filtrer en liste over skjematyper til de brukeren har tilgang til
 * via oppgitt tilgangsfelt ("Publikum" eller "Eiere").
 *
 * Rader antas å ha strukturen returnert av storage.hentAlleSkjematyper():
 *   { id, navn, JSON: { Publikum, Eiere, ... } }
 *
 * @param {Array}  skjematyper
 * @param {string} upn
 * @param {string} tilgangsFelt  — "Publikum" eller "Eiere"
 * @returns {Promise<Array>}     — filtrert liste
 */
async function filtrerTyperPåTilgang(skjematyper, upn, tilgangsFelt) {
    const brukerensTyper = [];
    for (const st of skjematyper) {
        const tilgang = st.JSON?.[tilgangsFelt];
        if (!tilgang) continue;

        if (harPersonligTilgang(tilgang, upn)) {
            brukerensTyper.push(st);
            continue;
        }

        // TODO (masterdata-modul): rolle- og team-basert medlemskap
        // if (await harRolleTilgang(tilgang, upn)) { ... }
        // if (await harTeamTilgang(tilgang, upn)) { ... }
    }
    return brukerensTyper;
}

module.exports = {
    harPersonligTilgang,
    filtrerTyperPåTilgang
};
