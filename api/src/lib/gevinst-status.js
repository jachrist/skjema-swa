/**
 * Gevinststatus per skjematype — fargen i Administrasjon → Skjematyper.
 *
 * Besluttet 24.11.2026. For skjematyper i produksjon:
 *
 *   gronn    baseline (gevinstestimat) OG gevinstrapportering er sendt inn
 *   gul      baseline er sendt inn, rapporteringen ikke
 *   rod      baseline er ikke sendt inn
 *   fritatt  admin har slått av kravet for skjematypen
 *
 * Et skjema er «sendt inn for skjematype X» når felt 1-01 har X — regelen
 * står i lib/gevinst-sjekk.js (`hentDekkede`), og brukes for begge skjemaene.
 *
 * Ingen status (`null`) når skjematypen ikke er i produksjon, når den ER et
 * av de to gevinstskjemaene, eller når baseline-skjemaet ikke er satt opp.
 * Da finnes det ikke noe å kreve.
 *
 * Fritaket lagres i SystemInnstillinger (`Gevinst.Fritatt`, se
 * lib/innstilling-sett.js), ikke i skjematypen.
 */
const FRITATT = 'Gevinst.Fritatt';

/** Statusen som ord — til Excel-eksporten og til hjelpeteksten i admin. */
const STATUS_TEKST = {
    gronn: 'Baseline og gevinstrapportering sendt inn',
    gul: 'Baseline sendt inn',
    rod: 'Ingen gevinstskjema sendt inn',
    fritatt: 'Fritatt av admin'
};

/**
 * @param rader      skjematypeoversiktens rader (`Skjematype_id`, `Fase`)
 * @param gevinst    { baselineTypeId, rapportTypeId, baseline: Set, rapport: Set, fritatt: Set }
 * @returns `Map` fra skjematype-id til { status, baseline, rapport, krav }
 */
function gevinstStatus(rader, { baselineTypeId = null, rapportTypeId = null, baseline = new Set(), rapport = new Set(), fritatt = new Set() } = {}) {
    const ut = new Map();
    for (const r of (rader || [])) {
        const id = String(r?.Skjematype_id || '');
        if (!id) continue;
        const erGevinstskjema = id === String(baselineTypeId || '') || id === String(rapportTypeId || '');
        if (!baselineTypeId || erGevinstskjema || String(r?.Fase || '') !== 'Produksjon') {
            ut.set(id, null);
            continue;
        }
        const harBaseline = baseline.has(id);
        const harRapport = rapport.has(id);
        const krav = !fritatt.has(id);
        const status = !krav ? 'fritatt' : (harBaseline && harRapport ? 'gronn' : (harBaseline ? 'gul' : 'rod'));
        ut.set(id, { status, baseline: harBaseline, rapport: harRapport, krav });
    }
    return ut;
}

module.exports = { gevinstStatus, FRITATT, STATUS_TEKST };
