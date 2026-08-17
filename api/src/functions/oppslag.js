/**
 * POST /api/oppslag — dynamisk FasteData-oppslag med feltverdier fra klient.
 *
 * Brukes av utfyllingssiden for å re-fetche dropdown-valg når felt bruker
 * refererer til et annet felt (f.eks. Studenter{Emne={2-03}} — når feltet
 * 2-03 endres, kaller frontend dette endepunktet med feltverdiene og får
 * oppdatert valg-array).
 *
 * Auth: authenticated (utsending-token også godtatt).
 *
 * Body: {
 *   skjematypeId: "42",
 *   seksjon: 3, felt: "01",       // hvilket felt vi ber om valg for
 *   feltSvar: { "2-03": ["MILM2301-1"], ... }  // svar-map til resolving
 * }
 *
 * Returnerer: { Valg: [{Tekst, Verdi, ...}] }
 */
const { app } = require('@azure/functions');
const { hentInnloggetUpn } = require('../lib/auth');
const skjemaStorage = require('../lib/skjema-storage');
const { parseFasteData, avkleFeltref } = require('../lib/faste-data');
const { hentDropdownVerdier } = require('../lib/oppslag');
const utsendingToken = require('../lib/utsending-token');

// Kopiert fra faste-data.js — resolverBetingelse med feltSvar-støtte
function erFeltref(v) {
    if (typeof v !== 'string') return false;
    const b = avkleFeltref(v);
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(b) || /^\d+-\d+$/.test(b);
}

function resolverBetingelse(betingelse, upn, feltSvar) {
    const v = betingelse.Verdi;
    if (v === '' || v == null) return { ...betingelse, Verdi: '' };
    if (v === '$upn') return upn ? { ...betingelse, Verdi: String(upn) } : null;
    if (erFeltref(v)) {
        if (!feltSvar) return null;
        const rå = avkleFeltref(v);
        const kandidater = [rå];
        const m = /^(\d+)-(\d+)$/.exec(rå);
        if (m) kandidater.push(`${Number(m[1])}-${Number(m[2])}`);
        for (const k of kandidater) {
            if (feltSvar[k] !== undefined) {
                const svar = Array.isArray(feltSvar[k]) ? feltSvar[k] : [feltSvar[k]];
                if (svar.length === 0 || svar[0] === '' || svar[0] == null) return null;
                return { ...betingelse, Verdi: String(svar[0]) };
            }
        }
        return null;
    }
    return { ...betingelse, Verdi: String(v) };
}

app.http('oppslagDynamisk', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'oppslag',
    handler: async (request, context) => {
        // Auth: SWA-innlogget eller utsending-token
        let upn = hentInnloggetUpn(request);
        const utsHeader = request.headers.get('x-utsending-token');
        if (!upn && utsHeader) {
            const v = utsendingToken.valider(utsHeader);
            if (v.gyldig) upn = v.mottaker;
        }
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };

        try {
            const body = await request.json();
            const skjematypeId = String(body.skjematypeId || '');
            const sekNr = Number(body.seksjon);
            const feltNr = String(body.felt || '');
            const feltSvar = body.feltSvar && typeof body.feltSvar === 'object' ? body.feltSvar : {};

            if (!skjematypeId || !sekNr || !feltNr) {
                return { status: 400, jsonBody: { status: 'feil', melding: 'Mangler skjematypeId/seksjon/felt' } };
            }

            const st = await skjemaStorage.hentSkjematype(skjematypeId);
            if (!st?.JSON) return { status: 404, jsonBody: { status: 'feil', melding: 'Skjematype ikke funnet' } };

            // Finn feltet
            let felt = null;
            for (const s of (st.JSON.Seksjoner || [])) {
                if (Number(s.Seksjon_nummer) !== sekNr) continue;
                for (const f of (s.Felter || [])) {
                    if (String(f.Nummer).padStart(2, '0') === String(feltNr).padStart(2, '0')) { felt = f; break; }
                }
                if (felt) break;
            }
            if (!felt) return { status: 404, jsonBody: { status: 'feil', melding: 'Felt ikke funnet' } };

            const dnf = parseFasteData(felt.FasteData);
            if (!dnf?.Datakilde) return { jsonBody: { Valg: [] } };

            // Resolve betingelser med feltSvar
            const resolverteGrupper = [];
            for (const gruppe of (dnf.EllerAv || [])) {
                const og = Array.isArray(gruppe?.OgAv) ? gruppe.OgAv : [];
                const løste = [];
                let ok = true;
                for (const b of og) {
                    const r = resolverBetingelse(b, upn, feltSvar);
                    if (!r) { ok = false; break; }
                    løste.push(r);
                }
                if (ok) resolverteGrupper.push(løste);
            }

            // Ingen filter = hent alle. Alle uresolvbare = tom liste (mangler kontekst)
            if ((dnf.EllerAv || []).length > 0 && resolverteGrupper.length === 0) {
                return { jsonBody: { Valg: [], melding: 'Filter mangler verdier (velg refererte felt først)' } };
            }

            const log = (m) => context.log(m);
            let rådata = [];
            if (resolverteGrupper.length === 0) {
                rådata = await hentDropdownVerdier(dnf.Datakilde, null, null, null, log);
            } else {
                // Union av alle OR-grupper (samme som hentOgSettFasteData)
                const alle = new Map();
                for (const gruppe of resolverteGrupper) {
                    // OG-gruppe: bruker første kolonne som filter (matcher unionsemantikken i faste-data)
                    const førsteKrit = gruppe[0] || {};
                    const del = await hentDropdownVerdier(
                        dnf.Datakilde,
                        førsteKrit.Kolonne || null,
                        førsteKrit.Operator || '=',
                        førsteKrit.Verdi != null ? String(førsteKrit.Verdi) : null,
                        log
                    );
                    for (const v of (del || [])) {
                        const key = String(v.Verdi ?? v.Tekst ?? JSON.stringify(v));
                        if (!alle.has(key)) alle.set(key, v);
                    }
                }
                rådata = [...alle.values()];
            }

            return { jsonBody: { Valg: rådata } };
        } catch (e) {
            context.log('oppslag FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});
