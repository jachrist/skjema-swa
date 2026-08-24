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
// Resolving og filtersemantikk deles med faste-data.js. Endepunktet hadde
// tidligere egne kopier, og OG-gruppa der brukte bare første betingelse — så
// «Rolle=Klassesjef OG Omfang={1-01}» ga alle klassesjefene i stedet for én.
const { parseFasteData, resolverBetingelse, hentForOgGruppe, unionDedup } = require('../lib/faste-data');
const { hentDropdownVerdier } = require('../lib/oppslag');
const utsendingToken = require('../lib/utsending-token');

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
                rådata = await hentForOgGruppe(dnf.Datakilde, [], hentDropdownVerdier, log);
            } else {
                // OG-gruppe: alle betingelsene snittes. Union på tvers av gruppene.
                const grupperesultater = [];
                for (const gruppe of resolverteGrupper) {
                    grupperesultater.push(await hentForOgGruppe(dnf.Datakilde, gruppe, hentDropdownVerdier, log));
                }
                rådata = unionDedup(grupperesultater);
            }

            return { jsonBody: { Valg: rådata } };
        } catch (e) {
            context.log('oppslag FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

/**
 * GET /api/emner/{termin}/{emneId}/beskrivelse
 *
 * Emnebeskrivelsen fra FS (tekstkategori E-FHSLUB) som Markdown, klar til å
 * settes inn i et informasjonsfelt. Ligger utenfor dropdown-oppslagene med
 * vilje: teksten er lang, og skal ikke sendes med for hvert emne i en liste.
 *
 * termin  = kort termin-kode, f.eks. "26H"
 * emneId  = "{EK}-{VK}", f.eks. "CBU1503-1"
 *
 * Auth: innlogget bruker.
 */
app.http('hentEmnebeskrivelse', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'emner/{termin}/{emneId}/beskrivelse',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };

        try {
            const emnerStorage = require('../lib/emner-storage');
            const termin = String(request.params.termin || '').trim();
            const emneId = String(request.params.emneId || '').trim();
            if (!emneId) return { status: 400, jsonBody: { status: 'feil', melding: 'emneId mangler' } };

            const emne = await emnerStorage.hentEmne(termin, emneId);
            if (!emne) return { status: 404, jsonBody: { status: 'feil', melding: `Fant ikke emne ${emneId} i termin ${termin || '(alle)'}` } };

            return {
                jsonBody: {
                    EK: emne.EK,
                    VK: emne.VK,
                    EN: emne.EN,
                    Termin: emne.Termin,
                    Format: 'Markdown',
                    Beskrivelse: emne.LU || ''
                }
            };
        } catch (e) {
            context.log('emnebeskrivelse FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});
