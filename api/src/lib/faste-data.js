/**
 * Faste data-modul.
 *
 * Fyller Valg-arrays på skjemafelter fra masterdata via oppslag-dispatcher.
 * Kalles ved henting av skjematype (server-side) slik at frontend ser vanlige Valg.
 *
 * FasteData-format på et felt:
 *   FasteData: {
 *     Datakilde: "Postnumre",
 *     EllerAv: [
 *       { OgAv: [{ Kolonne: "Kommune", Operator: "=", Verdi: "Oslo" }] }
 *     ]
 *   }
 *
 * Legacy format { Datakilde, Filterbegrep, Filteroperasjon, Filterverdi }
 * konverteres automatisk til DNF.
 *
 * Pilot-begrensninger:
 *   - $upn resolves; feltreferanser (UUID, S-FF) hoppes over (tomt = ikke oppfylt).
 *     Dynamisk oppfrisking ved klient-endring kommer i fase 5.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse FasteData til DNF-format. Aksepterer:
 *   - DNF-objekt (returneres normalisert)
 *   - Legacy { Datakilde, Filterbegrep, Filteroperasjon, Filterverdi }
 *   - Pipe-streng "Datakilde|Kolonne|Op|Verdi"
 */
function parseFasteData(verdi) {
    if (!verdi) return null;

    if (typeof verdi === 'object') {
        if (!verdi.Datakilde) return null;
        if (Array.isArray(verdi.EllerAv)) {
            return {
                Datakilde: verdi.Datakilde,
                EllerAv: verdi.EllerAv.map(g => ({
                    OgAv: Array.isArray(g?.OgAv) ? g.OgAv.map(b => ({
                        Kolonne: String(b.Kolonne || ''),
                        Operator: String(b.Operator || '='),
                        Verdi: b.Verdi === undefined || b.Verdi === null ? '' : String(b.Verdi)
                    })) : []
                }))
            };
        }
        const dnf = { Datakilde: verdi.Datakilde, EllerAv: [] };
        if (verdi.Filterbegrep) {
            dnf.EllerAv.push({
                OgAv: [{
                    Kolonne: String(verdi.Filterbegrep),
                    Operator: String(verdi.Filteroperasjon || '='),
                    Verdi: verdi.Filterverdi === undefined || verdi.Filterverdi === null ? '' : String(verdi.Filterverdi)
                }]
            });
        }
        return dnf;
    }

    if (typeof verdi !== 'string' || !verdi.trim()) return null;
    const deler = verdi.split('|').map(d => d.trim());
    const dnf = { Datakilde: deler[0], EllerAv: [] };
    if (deler[1]) {
        dnf.EllerAv.push({
            OgAv: [{ Kolonne: deler[1], Operator: deler[2] || '=', Verdi: deler[3] || '' }]
        });
    }
    return dnf;
}

function erFeltreferanse(v) {
    if (typeof v !== 'string') return false;
    return UUID_RE.test(v) || /^\d+-\d+$/.test(v);
}

/**
 * Resolver $upn i en betingelses Verdi. Returnerer null hvis Verdi ikke kan
 * resolves (mangler upn eller er feltreferanse — pilot støtter ikke det ennå).
 */
function resolverBetingelse(betingelse, upn) {
    const v = betingelse.Verdi;
    if (v === '' || v === null || v === undefined) {
        return { ...betingelse, Verdi: '' };
    }
    if (v === '$upn') {
        if (!upn) return null;
        return { ...betingelse, Verdi: String(upn) };
    }
    if (erFeltreferanse(v)) {
        // Pilot: feltreferanser hoppes over (kommer i fase 5 med dynamisk oppfrisking)
        return null;
    }
    return { ...betingelse, Verdi: String(v) };
}

/**
 * Skann seksjoner og bygg liste over felt som skal ha Valg-array fylt fra masterdata.
 * Returnerer bare de forespørslene som kan resolves med bare $upn.
 */
function hentFasteDataForespørsler(seksjoner, upn) {
    const resultat = [];
    for (const seksjon of (seksjoner || [])) {
        for (const felt of (seksjon.Felter || [])) {
            const dnf = parseFasteData(felt.FasteData);
            if (!dnf || !dnf.Datakilde) continue;

            const resolverte = [];
            for (const gruppe of (dnf.EllerAv || [])) {
                const og = Array.isArray(gruppe?.OgAv) ? gruppe.OgAv : [];
                const løste = [];
                let ok = true;
                for (const b of og) {
                    const r = resolverBetingelse(b, upn);
                    if (!r) { ok = false; break; }
                    løste.push(r);
                }
                if (ok) resolverte.push({ OgAv: løste });
            }

            // Ingen filter = hent alle. Alle filtre ikke-resolvbare = hopp over.
            if ((dnf.EllerAv || []).length > 0 && resolverte.length === 0) continue;

            resultat.push({
                Seksjon: seksjon.Seksjon_nummer,
                Felt: felt.Nummer,
                FasteData: { Datakilde: dnf.Datakilde, EllerAv: resolverte }
            });
        }
    }
    return resultat;
}

/**
 * Erstatt Valg-arrayen for felt som matcher Seksjon+Felt i resultater.
 * Tømmer FasteData-feltet etter vellykket erstatning (så frontend ikke re-fyller).
 */
function settFasteDataISkjema(skjemadefinisjon, resultater) {
    const nyeSeksjoner = (skjemadefinisjon.Seksjoner || []).map(seksjon => ({
        ...seksjon,
        Felter: (seksjon.Felter || []).map(felt => {
            const treff = resultater.find(r =>
                String(r.Seksjon) === String(seksjon.Seksjon_nummer) &&
                String(r.Felt) === String(felt.Nummer)
            );
            if (treff && Array.isArray(treff.Valg)) {
                return { ...felt, Valg: treff.Valg, FasteData: '' };
            }
            return felt;
        })
    }));
    return { ...skjemadefinisjon, Seksjoner: nyeSeksjoner };
}

function normaliserValg(verdier) {
    if (!Array.isArray(verdier)) return [];
    return verdier.map(v => {
        if (typeof v === 'string') return { Tekst: v };
        if (v.Tekst) return v;
        if (v.tekst) return { Tekst: v.tekst };
        return { Tekst: String(v) };
    });
}

async function hentForOgGruppe(datakilde, ogAv, hentDropdownVerdier, log) {
    if (!ogAv || ogAv.length === 0) {
        return await hentDropdownVerdier(datakilde, '', '', '', log);
    }
    if (ogAv.length === 1) {
        const b = ogAv[0];
        return await hentDropdownVerdier(datakilde, b.Kolonne || '', b.Operator || '=', b.Verdi || '', log);
    }
    // Flere filter i samme OG: intersect på Verdi (eller Tekst) — pilot-forenklet
    const delresultater = await Promise.all(ogAv.map(b =>
        hentDropdownVerdier(datakilde, b.Kolonne || '', b.Operator || '=', b.Verdi || '', log)
    ));
    const ikkeArr = delresultater.find(r => !Array.isArray(r));
    if (ikkeArr) return [];
    const nokkel = r => String(r?.Verdi ?? r?.Tekst ?? '');
    const tillatte = delresultater.slice(1).map(liste => new Set(liste.map(nokkel)));
    return delresultater[0].filter(rad => tillatte.every(sett => sett.has(nokkel(rad))));
}

function unionDedup(lister) {
    const sett = new Set();
    const resultat = [];
    for (const liste of lister) {
        if (!Array.isArray(liste)) continue;
        for (const rad of liste) {
            const n = String(rad?.Verdi ?? rad?.Tekst ?? '');
            if (sett.has(n)) continue;
            sett.add(n);
            resultat.push(rad);
        }
    }
    return resultat;
}

/**
 * Hovedfunksjon: gå gjennom skjematype, hent alle FasteData-verdier og sett
 * inn i Valg-arrayer. Returnerer ny (immutabel) skjemadefinisjon.
 */
async function hentOgSettFasteData(skjemadefinisjon, hentDropdownVerdier, upn, log = () => {}) {
    const forespørsler = hentFasteDataForespørsler(skjemadefinisjon?.Seksjoner || [], upn);
    if (forespørsler.length === 0) return skjemadefinisjon;

    const resultater = await Promise.all(forespørsler.map(async f => {
        const dnf = f.FasteData;
        let rådata;
        if (!dnf.EllerAv || dnf.EllerAv.length === 0) {
            rådata = await hentForOgGruppe(dnf.Datakilde, [], hentDropdownVerdier, log);
        } else if (dnf.EllerAv.length === 1) {
            rådata = await hentForOgGruppe(dnf.Datakilde, dnf.EllerAv[0].OgAv, hentDropdownVerdier, log);
        } else {
            const grupperesultater = await Promise.all(dnf.EllerAv.map(g =>
                hentForOgGruppe(dnf.Datakilde, g.OgAv, hentDropdownVerdier, log)
            ));
            rådata = unionDedup(grupperesultater);
        }
        return { Seksjon: f.Seksjon, Felt: f.Felt, Valg: normaliserValg(rådata) };
    }));

    return settFasteDataISkjema(skjemadefinisjon, resultater);
}

module.exports = {
    parseFasteData,
    hentFasteDataForespørsler,
    settFasteDataISkjema,
    hentOgSettFasteData
};
