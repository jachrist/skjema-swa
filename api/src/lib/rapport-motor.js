/**
 * Rapport-motor.
 *
 * Bygger en rapport ut fra en spesifikasjon og et sett med skjemaer.
 * Ren funksjon — henter ikke selv fra storage og gjør ikke auth/dekryptering
 * (det er kalleren sitt ansvar). Dette gjør den enkel å teste og gjenbruke.
 *
 *   kjør(spec, skjemaer) → { kolonner, rader, meta }
 *
 * spec:
 *   {
 *     Kildeskjematype_id: "14",
 *     Innebygde_filtre: [ ... ],       // filter-objekter, alltid aktive
 *     Brukerfiltre:     [ ... ],       // filter-definisjoner (ikke verdier)
 *     Kolonner:         [ ... ],       // kolonne-definisjoner
 *     Gruppering:       { gruppePaa: "kol-id", aggregater: [ ... ] } | null,
 *     Sortering:        { kolonneId, retning: "asc"|"desc" } | null
 *   }
 *
 * brukerVerdier (i tillegg til spec): { <filterId>: <verdi | [verdier]> }
 *
 * Filter-format:
 *   { id?, navn?, type: "meta"|"svar", kilde?: "Innsender_Epost"|...,
 *     seksjon?, felt?, operator, verdi?, verdi2? }
 *
 * Kolonne-format:
 *   { id, navn, type: "meta"|"svar", kilde?, seksjon?, felt?, format?: "dato"|"nummer"|"status" }
 */

const STATUS_TEKST = {
    0: 'Utkast',
    1: 'Mellomlagret',
    2: 'Innsendt',
    3: 'Til revidering',
    5: 'Avsluttet'
};

const META_KILDER = new Set([
    'Skjema_id', 'Skjematype_id', 'Innsender_Epost', 'Skjema_status',
    'Opprettet', 'Sist_endret', 'Skjema_navn'
]);

// ---- Utpakking av verdier ----

function hentFeltSvar(skjema, sekNr, feltNr) {
    if (!skjema) return [];
    const sekStr = String(sekNr);
    const feltPadded = String(feltNr).padStart(2, '0');

    if (Array.isArray(skjema.Seksjoner)) {
        for (const s of skjema.Seksjoner) {
            const sn = String(s.Seksjon_nummer ?? s.Nummer ?? '');
            if (sn !== sekStr) continue;
            for (const f of (s.Felter || [])) {
                if (String(f.Nummer).padStart(2, '0') !== feltPadded) continue;
                return Array.isArray(f.Svar) ? f.Svar : [];
            }
        }
    }
    if (Array.isArray(skjema.Svar)) {
        for (const s of skjema.Svar) {
            if (String(s.sek) !== sekStr) continue;
            if (String(s.spm).padStart(2, '0') !== feltPadded) continue;
            return Array.isArray(s.sva) ? s.sva : [];
        }
    }
    return [];
}

function hentMetaVerdi(skjema, kilde) {
    if (!META_KILDER.has(kilde)) return null;
    if (kilde === 'Innsender_Epost') return skjema.Innsender_Epost || skjema.Innsender_epost || '';
    return skjema[kilde] ?? '';
}

function hentRåVerdi(skjema, kildeDef) {
    if (kildeDef.type === 'meta') return hentMetaVerdi(skjema, kildeDef.kilde);
    if (kildeDef.type === 'svar') {
        const svar = hentFeltSvar(skjema, kildeDef.seksjon, kildeDef.felt);
        // For enkeltverdi-felt: første element. For flervalg: hele array (join formateres i UI).
        if (svar.length === 0) return null;
        if (svar.length === 1) return svar[0];
        return svar;
    }
    return null;
}

// ---- Filtrering ----

function tilTall(v) {
    if (v === null || v === undefined || v === '') return NaN;
    const n = Number(String(v).replace(',', '.'));
    return isNaN(n) ? NaN : n;
}

function normaliserForSammenligning(v) {
    if (v === null || v === undefined) return '';
    return String(v).toLowerCase().trim();
}

function verdiMatcher(rå, operator, ref, ref2) {
    // rå kan være enkeltverdi eller array
    const arr = Array.isArray(rå) ? rå : [rå];
    // Filter-referanse kan være liste (komma-separert eller allerede array)
    let refListe = ref;
    if (typeof ref === 'string' && (operator === 'in' || operator === 'notIn')) {
        refListe = ref.split(',').map(s => s.trim()).filter(Boolean);
    }

    for (const v of arr) {
        const nv = normaliserForSammenligning(v);
        const nref = normaliserForSammenligning(ref);
        // Dato-toleranse: ref "YYYY-MM-DD" matcher verdier som starter med samme dato
        // (typisk ISO-tidsstempel "2026-08-17T08:00:00Z" mot dato "2026-08-17").
        const refErDato = /^\d{4}-\d{2}-\d{2}$/.test(String(ref ?? '').trim());
        const vErTidsstempel = refErDato && /^\d{4}-\d{2}-\d{2}[T ]/.test(String(v ?? ''));
        switch (operator) {
            case 'eq':
                if (nv === nref) return true;
                if (vErTidsstempel && String(v).startsWith(String(ref).trim())) return true;
                break;
            case 'neq':
                if (nv !== nref && !(vErTidsstempel && String(v).startsWith(String(ref).trim()))) return true;
                break;
            case 'contains': if (nv.includes(nref)) return true; break;
            case 'startsWith': if (nv.startsWith(nref)) return true; break;
            case 'endsWith': if (nv.endsWith(nref)) return true; break;
            case 'tomt': if (nv === '') return true; break;
            case 'ikkeTomt': if (nv !== '') return true; break;
            case 'gt': { const a = tilTall(v), b = tilTall(ref); if (!isNaN(a) && !isNaN(b)) { if (a > b) return true; } else if (String(v) > String(ref)) return true; break; }
            case 'gte': { const a = tilTall(v), b = tilTall(ref); if (!isNaN(a) && !isNaN(b)) { if (a >= b) return true; } else if (String(v) >= String(ref)) return true; break; }
            case 'lt': { const a = tilTall(v), b = tilTall(ref); if (!isNaN(a) && !isNaN(b)) { if (a < b) return true; } else if (String(v) < String(ref)) return true; break; }
            case 'lte': { const a = tilTall(v), b = tilTall(ref); if (!isNaN(a) && !isNaN(b)) { if (a <= b) return true; } else if (String(v) <= String(ref)) return true; break; }
            case 'between': {
                const a = tilTall(v), lo = tilTall(ref), hi = tilTall(ref2);
                if (!isNaN(a) && !isNaN(lo) && !isNaN(hi) && a >= lo && a <= hi) return true;
                // Falltilbake til streng-sammenligning (dato-strenger)
                if (String(v) >= String(ref) && String(v) <= String(ref2)) return true;
                break;
            }
            case 'in': if (Array.isArray(refListe) && refListe.some(r => normaliserForSammenligning(r) === nv)) return true; break;
            case 'notIn': if (Array.isArray(refListe) && !refListe.some(r => normaliserForSammenligning(r) === nv)) return true; break;
            case 'datoEtter': if (String(v) > String(ref)) return true; break;
            case 'datoFor':   if (String(v) < String(ref)) return true; break;
        }
    }
    // Tomt-operator på tomt array
    if (arr.length === 0 || (arr.length === 1 && (arr[0] === null || arr[0] === undefined || arr[0] === ''))) {
        if (operator === 'tomt') return true;
    }
    return false;
}

/**
 * Løs dynamiske verdi-tokens til konkrete verdier.
 * Støtter "idag", "idag+N", "idag-N" (N = antall dager) → YYYY-MM-DD.
 * Enkeltverdi-transformasjon; komma-lister fra 'in'/'notIn' løses element for element.
 */
function resolverDynVerdi(v) {
    if (v === undefined || v === null) return v;
    if (typeof v !== 'string') return v;
    const idag = /^idag([+-]\d+)?$/i.exec(v.trim());
    if (idag) {
        const delta = idag[1] ? parseInt(idag[1], 10) : 0;
        const d = new Date();
        d.setDate(d.getDate() + delta);
        return d.toISOString().slice(0, 10);
    }
    // Komma-liste med tokens
    if (v.includes(',')) {
        const deler = v.split(',').map(s => s.trim());
        if (deler.some(d => /^idag([+-]\d+)?$/i.test(d))) {
            return deler.map(resolverDynVerdi).join(',');
        }
    }
    return v;
}

function passererFilter(skjema, filter) {
    const rå = hentRåVerdi(skjema, filter);
    return verdiMatcher(rå, filter.operator, resolverDynVerdi(filter.verdi), resolverDynVerdi(filter.verdi2));
}

function passererAlle(skjema, filtre) {
    for (const f of (filtre || [])) {
        if (f.verdi === undefined && f.verdi2 === undefined
            && f.operator !== 'tomt' && f.operator !== 'ikkeTomt') continue;
        if (!passererFilter(skjema, f)) return false;
    }
    return true;
}

// ---- Aggregater ----

function beregnAggregat(rader, kolonneId, type) {
    const tall = rader
        .map(r => r._verdier[kolonneId])
        .flatMap(v => Array.isArray(v) ? v : [v])
        .map(tilTall)
        .filter(n => !isNaN(n));
    if (type === 'count') return rader.length;
    if (type === 'countIkkeTomt') {
        return rader.filter(r => {
            const v = r._verdier[kolonneId];
            if (v === null || v === undefined) return false;
            if (Array.isArray(v)) return v.some(x => x !== null && x !== undefined && String(x).trim() !== '');
            return String(v).trim() !== '';
        }).length;
    }
    if (tall.length === 0) return null;
    if (type === 'sum') return tall.reduce((a, b) => a + b, 0);
    if (type === 'snitt') return tall.reduce((a, b) => a + b, 0) / tall.length;
    if (type === 'min') return Math.min(...tall);
    if (type === 'maks') return Math.max(...tall);
    return null;
}

// ---- Hovedinngang ----

function kjør(spec, skjemaer, brukerVerdier = {}) {
    if (!spec) throw new Error('rapport-motor: mangler spec');
    const kolonner = Array.isArray(spec.Kolonner) ? spec.Kolonner : [];
    const innebygde = Array.isArray(spec.Innebygde_filtre) ? spec.Innebygde_filtre : [];

    // Sett verdier på brukerfiltre fra brukerVerdier
    const brukerfiltre = (spec.Brukerfiltre || []).map(f => {
        const verdi = brukerVerdier[f.id];
        if (verdi === undefined || verdi === null || verdi === '') return null;
        return { ...f, verdi };
    }).filter(Boolean);

    const alleFiltre = [...innebygde, ...brukerfiltre];
    const relevante = skjemaer.filter(sk => passererAlle(sk, alleFiltre));

    // Materialiser rader — trekker ut verdier én gang
    const rader = relevante.map(sk => {
        const verdier = {};
        for (const kol of kolonner) {
            verdier[kol.id] = hentRåVerdi(sk, kol);
        }
        return { _kilde: sk, _verdier: verdier };
    });

    // Sortering
    const sortering = spec.Sortering;
    if (sortering?.kolonneId) {
        const kol = kolonner.find(k => k.id === sortering.kolonneId);
        const retning = sortering.retning === 'desc' ? -1 : 1;
        rader.sort((a, b) => {
            const va = Array.isArray(a._verdier[kol?.id]) ? a._verdier[kol.id].join(',') : a._verdier[kol?.id];
            const vb = Array.isArray(b._verdier[kol?.id]) ? b._verdier[kol.id].join(',') : b._verdier[kol?.id];
            const na = tilTall(va), nb = tilTall(vb);
            if (!isNaN(na) && !isNaN(nb)) return (na - nb) * retning;
            return String(va ?? '').localeCompare(String(vb ?? ''), 'nb') * retning;
        });
    }

    // Gruppering (valgfri)
    let grupper = null;
    const g = spec.Gruppering;
    if (g && g.gruppePaa) {
        const map = new Map();
        for (const rad of rader) {
            const rå = rad._verdier[g.gruppePaa];
            const nokler = Array.isArray(rå) ? rå.map(String) : [String(rå ?? '(tom)')];
            for (const n of nokler) {
                if (!map.has(n)) map.set(n, []);
                map.get(n).push(rad);
            }
        }
        grupper = [];
        for (const [nokkel, gruppeRader] of map.entries()) {
            const agg = {};
            for (const a of (g.aggregater || [])) {
                agg[a.navn || `${a.type}(${a.kolonneId})`] = beregnAggregat(gruppeRader, a.kolonneId, a.type);
            }
            grupper.push({ nokkel, antall: gruppeRader.length, aggregater: agg, rader: gruppeRader });
        }
        grupper.sort((a, b) => String(a.nokkel).localeCompare(String(b.nokkel), 'nb'));
    }

    // Totaler
    const totaler = {};
    if (g?.aggregater?.length) {
        for (const a of g.aggregater) {
            totaler[a.navn || `${a.type}(${a.kolonneId})`] = beregnAggregat(rader, a.kolonneId, a.type);
        }
    }

    return {
        kolonner: kolonner.map(k => ({ id: k.id, navn: k.navn, format: k.format, type: k.type })),
        rader: rader.map(r => ({ verdier: r._verdier })),
        grupper: grupper ? grupper.map(gr => ({
            nokkel: gr.nokkel, antall: gr.antall, aggregater: gr.aggregater,
            rader: gr.rader.map(r => ({ verdier: r._verdier }))
        })) : null,
        totaler,
        meta: {
            antallSkjemaer: skjemaer.length,
            antallEtterFilter: rader.length,
            kjørtDato: new Date().toISOString(),
            gruppertPaa: g?.gruppePaa || null
        }
    };
}

module.exports = { kjør, hentFeltSvar, hentMetaVerdi, hentRåVerdi, verdiMatcher, beregnAggregat, resolverDynVerdi, STATUS_TEKST };
