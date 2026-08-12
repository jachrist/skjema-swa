/**
 * Tilgangskontroll.
 *
 * Støtter tilgang via:
 *   - Direkte UPN-match i Personer-listen
 *   - Rolle-basert medlemskap (via roller-storage) — fase 5a
 *   - Team-basert medlemskap — kommer med Graph API (fase 8) / stub
 */
const rollerStorage = require('./roller-storage');
const teamStorage = require('./team-storage');

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
async function harRolleTilgang(tilgang, upn) {
    const roller = tilgang?.Roller || [];
    if (roller.length === 0) return false;
    for (const r of roller) {
        try {
            if (await rollerStorage.erMedlem(r, upn)) return true;
        } catch (_) { /* ignorer, prøv neste */ }
    }
    return false;
}

/**
 * Sjekk om upn er medlem av noen av teamene i tilgangsstrukturen.
 * Data hentes fra Teammedlemskap-tabellen — populeres av PA-flyt
 * (cron 6-timer + lazy-load ved editor-input).
 */
async function harTeamTilgang(tilgang, upn) {
    const team = tilgang?.Team || [];
    if (team.length === 0) return false;
    for (const t of team) {
        try {
            if (await teamStorage.erMedlem(t, upn)) return true;
        } catch (_) { /* ignorer, prøv neste */ }
    }
    return false;
}

async function filtrerTyperPåTilgang(skjematyper, upn, tilgangsFelt) {
    const brukerensTyper = [];
    for (const st of skjematyper) {
        const tilgang = st.JSON?.[tilgangsFelt];
        if (!tilgang) continue;

        // "Åpen for alle innloggede" — overstyrer alle andre sjekker.
        // Kun for Publikum-felt; ellers ville alle blitt eiere/behandlere også.
        if (tilgangsFelt === 'Publikum' && tilgang.AlleTilgang === true) {
            brukerensTyper.push(st);
            continue;
        }
        if (harPersonligTilgang(tilgang, upn)) {
            brukerensTyper.push(st);
            continue;
        }
        if (await harRolleTilgang(tilgang, upn)) {
            brukerensTyper.push(st);
            continue;
        }
        if (await harTeamTilgang(tilgang, upn)) {
            brukerensTyper.push(st);
            continue;
        }
    }
    return brukerensTyper;
}

module.exports = {
    harPersonligTilgang,
    harRolleTilgang,
    harTeamTilgang,
    filtrerTyperPåTilgang
};
