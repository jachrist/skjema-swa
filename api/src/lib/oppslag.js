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
const emnerStorage = require('./emner-storage');
const terminer = require('./terminer');

const IKKE_IMPLEMENTERT = new Set([
    'Team', 'Avdelinger'
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
        case 'Emner':
            return await _hentEmner(filterbegrep, filterverdi);
        case 'Studenter':
            return await _hentStudenter(filterbegrep, filterverdi);
        case 'Klasser':
            return await _hentKlasser();
        case 'Kull':
            return await _hentKull();
        case 'Studieprogrammer':
            return await _hentStudieprogrammer();
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
    if (filterbegrep === 'EmneLarere' || filterbegrep === 'EmneHovedlarere') {
        if (!filterverdi) return [];
        const emne = await emnerStorage.hentEmne(null, filterverdi);
        if (!emne) return [];
        const kilde = filterbegrep === 'EmneLarere' ? emne.Larere : emne.Hovedlarere;
        return (kilde || []).map(p => ({
            Tekst: `${p.EN}, ${p.FN} (${p.EP})`.replace(/^, /, '').replace(/^ \(/, '('),
            Verdi: p.EP,
            FN: p.FN, EN: p.EN, EP: p.EP
        }));
    }
    if (filterbegrep === 'EmneStudenter') {
        if (!filterverdi) return [];
        const studenter = await _studenterForEmne(String(filterverdi));
        return studenter.map(s => ({
            Tekst: `${s.EN}, ${s.FN} (${s.EP})`.replace(/^, /, '').replace(/^ \(/, '('),
            Verdi: s.EP,
            FN: s.FN, EN: s.EN, EP: s.EP, Termin: s.Termin
        }));
    }
    log(`oppslag: Personer med filterbegrep "${filterbegrep}" er ikke implementert ennå`);
    return [];
}

async function _hentEmner(filterbegrep, filterverdi) {
    // Filter: Termin=X (26H/26V/25H), Campus=X, eller ingen filter
    const opts = {};
    if (filterbegrep === 'Termin' && filterverdi) opts.termin = String(filterverdi);
    if (filterbegrep === 'Campus' && filterverdi) opts.campus = String(filterverdi);
    const alle = await emnerStorage.hentAlleEmner(opts);
    return alle.map(e => {
        const emneId = `${e.EK}-${e.VK}`;
        return {
            Tekst: `${e.EK} — ${e.EN} (${e.Termin})`,
            Verdi: emneId,
            EK: e.EK, VK: e.VK, EN: e.EN,
            SK: e.SK, SN: e.SN, C: e.C,
            Termin: e.Termin
        };
    });
}

// Filterbegrep i skjemadefinisjonene → filterkategori i FilterStudent-tabellen
const STUDENT_FILTERKATEGORI = {
    Emne: 'EK',
    Klasse: 'KL',
    Kull: 'KU',
    Studieprogram: 'SP'
};

/**
 * Studenter for ett emne. Verdien kan være "{Termin}|{EK}-{VK}" eller bare
 * "{EK}-{VK}" — sistnevnte er formatet eldre skjemadefinisjoner bruker, og
 * kan ikke slås opp direkte fordi terminen er en del av partisjonsnøkkelen.
 * Da spørres de aktive terminene i stedet (tre partisjonsspørringer).
 */
async function _studenterForEmne(verdi) {
    if (verdi.includes('|')) {
        return await emnerStorage.hentStudenterForFilter('EK', verdi);
    }
    const aktive = terminer.aktiveTerminer();
    const treff = await Promise.all(
        aktive.map(t => emnerStorage.hentStudenterForFilter('EK', `${t.kort}|${verdi}`))
    );
    return treff.flat();
}

async function _hentStudenter(filterbegrep, filterverdi) {
    // Filtre: Emne, Klasse, Kull, Studieprogram. Uten filter: alle studenter.
    let studenter;
    const fk = STUDENT_FILTERKATEGORI[filterbegrep];

    if (fk === 'EK' && filterverdi) {
        studenter = await _studenterForEmne(String(filterverdi));
    } else if (fk && filterverdi) {
        studenter = await emnerStorage.hentStudenterForFilter(fk, String(filterverdi));
    } else {
        studenter = await emnerStorage.hentStudenterForFilter('ALLE', '');
    }

    // Dedupliser: samme student kan ligge under flere terminer/emner
    const dedup = new Map();
    for (const s of studenter) {
        const nokkel = String(s.EP || '').toLowerCase();
        if (!nokkel || dedup.has(nokkel)) continue;
        dedup.set(nokkel, s);
    }
    return [...dedup.values()]
        .map(s => ({
            Tekst: `${s.EN}, ${s.FN} (${s.EP})`.replace(/^, /, '').replace(/^ \(/, '('),
            Verdi: s.EP,
            FN: s.FN, EN: s.EN, EP: s.EP, Termin: s.Termin
        }))
        .sort((a, b) => a.Tekst.localeCompare(b.Tekst, 'nb'));
}

async function _hentKlasser() {
    const alle = await emnerStorage.hentFilterMeta('KLASSE');
    return alle
        .map(k => ({ Tekst: `${k.Navn} — ${k.Antall} studenter`, Verdi: k.Verdi, SP: k.SP, Termin: k.Termin }))
        .sort((a, b) => a.Tekst.localeCompare(b.Tekst, 'nb'));
}

async function _hentKull() {
    const alle = await emnerStorage.hentFilterMeta('KULL');
    return alle
        .map(k => ({ Tekst: k.Navn, Verdi: k.Verdi, SP: k.SP, Termin: k.Termin }))
        .sort((a, b) => a.Tekst.localeCompare(b.Tekst, 'nb'));
}

async function _hentStudieprogrammer() {
    const alle = await emnerStorage.hentAlleStudieprogrammer();
    return alle.map(s => ({ Tekst: `${s.SK} — ${s.SN}`, Verdi: s.SK, SK: s.SK, SN: s.SN }));
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
