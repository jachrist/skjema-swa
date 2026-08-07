/**
 * Oppslag-dispatcher for masterdata-lookups brukt av FasteData på skjemafelter.
 *
 * hentDropdownVerdier(datakilde, filterbegrep, filteroperasjon, filterverdi) → Promise<Array>
 * Returnerer alltid array av { Tekst, Verdi, ... } objekter.
 *
 * Datakilder implementert:
 *   - Postnumre        (via postnumre-storage)
 *   - Skjematyper      (via skjema-storage)
 *
 * Datakilder som venter på masterdata-modul (fase 5) — returnerer tom liste + log:
 *   - Personer, Roller, Team, Emner, Studenter, Avdelinger, Studieprogrammer
 */
const postnumreStorage = require('./postnumre-storage');
const skjemaStorage = require('./skjema-storage');
const rollerStorage = require('./roller-storage');

const IKKE_IMPLEMENTERT = new Set([
    'Team', 'Emner', 'Studenter',
    'Avdelinger', 'Studieprogrammer'
]);

/**
 * Hovedinngang for dropdown-oppslag. Signaturen matcher referanse-appens
 * hentDropdownVerdier så FasteData-modul kan brukes uendret.
 */
async function hentDropdownVerdier(datakilde, filterbegrep, filteroperasjon, filterverdi, log = () => {}) {
    switch (datakilde) {
        case 'Postnumre':
            return await _hentPostnumre(filterbegrep, filterverdi);
        case 'Skjematyper':
            return await _hentSkjematyper(filterbegrep, filterverdi);
        case 'Roller':
            return await _hentRolleGrupper(filterbegrep, filterverdi);
        case 'Personer':
            return await _hentPersoner(filterbegrep, filterverdi, log);
        default:
            if (IKKE_IMPLEMENTERT.has(datakilde)) {
                log(`oppslag: datakilde "${datakilde}" kommer med masterdata-modul (fase 5)`);
                return [];
            }
            log(`oppslag: ukjent datakilde "${datakilde}"`);
            return [];
    }
}

async function _hentRolleGrupper(filterbegrep, filterverdi) {
    // Returnerer distinkte (Rolle, Omfang) — for dropdown "velg en rolle"
    const alle = await rollerStorage.hentAlleGrupper();
    let filtrerte = alle;
    if (filterbegrep === 'Omfang' && filterverdi) {
        filtrerte = alle.filter(g => String(g.Omfang || '').toLowerCase() === String(filterverdi).toLowerCase());
    }
    return filtrerte.map(g => ({
        Tekst: g.Omfang ? `${g.Rolle} (${g.Omfang})` : g.Rolle,
        Verdi: g.Omfang ? `${g.Rolle}(${g.Omfang})` : g.Rolle,
        Rolle: g.Rolle,
        Omfang: g.Omfang
    }));
}

async function _hentPersoner(filterbegrep, filterverdi, log) {
    if (filterbegrep === 'Rolle') {
        if (!filterverdi) return [];
        const innehavere = await rollerStorage.hentInnehavere(filterverdi);
        return innehavere.map(p => ({
            Tekst: `${p.EN}, ${p.FN} (${p.EP})`.replace(/^, /, '').replace(/^ \(/, '('),
            Verdi: p.EP,
            FN: p.FN, EN: p.EN, EP: p.EP, Omfang: p.Omfang
        }));
    }
    // Team/Emne/EmneLarere/EmneHovedlarere — kommer i 5b/5c
    log(`oppslag: Personer med filterbegrep "${filterbegrep}" er ikke implementert ennå`);
    return [];
}

async function _hentPostnumre(filterbegrep, filterverdi) {
    // Uten filter: returnerer alle 25 seed-postnumre (praktisk for demo)
    if (!filterbegrep || !filterverdi) {
        const alle = await postnumreStorage.sokPostnumre('', 100);
        return alle.map(p => ({ Tekst: `${p.Postnr} ${p.Poststed}`, Verdi: p.Postnr }));
    }
    // Filter Kommune=X: bare postnumre i den kommunen
    if (filterbegrep === 'Kommune') {
        const alle = await postnumreStorage.sokPostnumre('', 500);
        const filtrert = alle.filter(p => (p.Kommune || '').toLowerCase() === String(filterverdi).toLowerCase());
        return filtrert.map(p => ({ Tekst: `${p.Postnr} ${p.Poststed}`, Verdi: p.Postnr }));
    }
    // Filter Poststed-prefiks
    if (filterbegrep === 'Poststed') {
        const treff = await postnumreStorage.sokPostnumre(filterverdi, 100);
        return treff.map(p => ({ Tekst: `${p.Postnr} ${p.Poststed}`, Verdi: p.Postnr }));
    }
    return [];
}

async function _hentSkjematyper(filterbegrep, filterverdi) {
    const alle = await skjemaStorage.hentAlleSkjematyper();
    let filtrerte = alle;
    if (filterbegrep === 'Fase' && filterverdi) {
        filtrerte = alle.filter(t => (t.JSON?.Fase || 'Produksjon') === String(filterverdi));
    }
    return filtrerte.map(t => ({ Tekst: t.navn || t.id, Verdi: t.id }));
}

module.exports = { hentDropdownVerdier };
