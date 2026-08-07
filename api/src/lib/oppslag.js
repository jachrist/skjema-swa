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

const IKKE_IMPLEMENTERT = new Set([
    'Personer', 'Roller', 'Team', 'Emner', 'Studenter',
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
        default:
            if (IKKE_IMPLEMENTERT.has(datakilde)) {
                log(`oppslag: datakilde "${datakilde}" kommer med masterdata-modul (fase 5)`);
                return [];
            }
            log(`oppslag: ukjent datakilde "${datakilde}"`);
            return [];
    }
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
