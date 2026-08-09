/**
 * Datauttrekk-endepunkter.
 *
 *   POST /api/datauttrekk
 *     Body: { skjematypeId, type: 'excel'|'csv'|'json', filtere: [{Seksjon, Felt, Verdier}] }
 *     Respons: { filnavn, innhold(base64), contentType }
 *
 *   GET  /api/datauttrekk/filtre?skjematypeId=X
 *     Respons: { filtere: [{Navn, Seksjon, Felt, Type, Verdier}] }
 *     — brukes av frontend for å bygge filter-UI dynamisk fra Filtrerbar-felter
 *
 * Krever eier-tilgang på skjematypen (eller admin).
 */
const { app } = require('@azure/functions');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');
const skjemaStorage = require('../lib/skjema-storage');
const forekomstStorage = require('../lib/skjema-forekomst-storage');
const { filtrerTyperPåTilgang } = require('../lib/tilgang');
const datauttrekk = require('../lib/datauttrekk');
const kryptering = require('../lib/kryptering');
const nokkelStorage = require('../lib/nokkel-storage');

async function harEierTilgang(skjematypeId, upn) {
    if (erAdmin(upn)) return true;
    const st = await skjemaStorage.hentSkjematype(skjematypeId);
    if (!st) return false;
    const treff = await filtrerTyperPåTilgang([st], upn, 'Eiere');
    return treff.length > 0;
}

/**
 * Trekk ut filtrerbare felter fra en skjematype-definisjon.
 * For hvert felt med Filtrerbar=true, returner metadata + valg-liste.
 */
function samleFiltrerbareFelter(definisjon) {
    const filtre = [];
    for (const s of (definisjon?.Seksjoner || [])) {
        const sekNr = s.Seksjon_nummer;
        for (const f of (s.Felter || [])) {
            if (!(f.Filtrerbar || f.Filtrerbar_i_register)) continue;
            if (f.Type === 'Informasjon') continue;
            const verdier = Array.isArray(f.Valg)
                ? f.Valg.map(v => v.Tekst).filter(Boolean)
                : [];
            filtre.push({
                Navn: f.Tekst?.Verdi || `${sekNr}-${f.Nummer}`,
                Seksjon: sekNr,
                Felt: String(f.Nummer).padStart(2, '0'),
                Type: f.Type,
                Verdier: verdier
            });
        }
    }
    return filtre;
}

app.http('datauttrekkFiltre', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'datauttrekk/filtre',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        try {
            const skjematypeId = request.query.get('skjematypeId');
            if (!skjematypeId) return { status: 400, jsonBody: { status: 'feil', melding: 'skjematypeId mangler' } };
            if (!(await harEierTilgang(skjematypeId, upn))) {
                return { status: 403, jsonBody: { status: 'avvist', melding: 'Krever eier- eller admin-tilgang' } };
            }
            const st = await skjemaStorage.hentSkjematype(skjematypeId);
            if (!st) return { status: 404, jsonBody: { status: 'feil', melding: 'Skjematype ikke funnet' } };
            return { jsonBody: {
                skjemaNavn: st.JSON?.Skjema_navn || st.navn || '',
                filtere: samleFiltrerbareFelter(st.JSON || {})
            }};
        } catch (e) {
            context.log('datauttrekk/filtre FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('datauttrekkBygg', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'datauttrekk',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        try {
            const body = await request.json();
            const skjematypeId = String(body.skjematypeId || '');
            const type = String(body.type || 'excel').toLowerCase();
            const filtere = Array.isArray(body.filtere) ? body.filtere : [];

            if (!skjematypeId) return { status: 400, jsonBody: { status: 'feil', melding: 'skjematypeId mangler' } };
            if (!(await harEierTilgang(skjematypeId, upn))) {
                return { status: 403, jsonBody: { status: 'avvist', melding: 'Krever eier- eller admin-tilgang' } };
            }

            const st = await skjemaStorage.hentSkjematype(skjematypeId);
            if (!st) return { status: 404, jsonBody: { status: 'feil', melding: 'Skjematype ikke funnet' } };
            const definisjon = st.JSON || {};

            const skjemaer = await forekomstStorage.hentAlleSkjemaerForType(skjematypeId, { fulltFormat: true });

            // Kryptering-håndtering:
            //   - Brukers manuelt oppgitte Nokkel har prioritet
            //   - Ellers hentes nøkkelen automatisk fra Kryptonokler-tabellen
            //   - Uten nøkkel: krypterte verdier vises som [Kryptert] i output
            let nokkel = body.Nokkel ? String(body.Nokkel).trim() : null;
            const noenKryptert = skjemaer.some(s => s?.Kryptert);
            if (noenKryptert && !nokkel) {
                nokkel = await nokkelStorage.hentNokkel(skjematypeId);
                if (!nokkel) context.log(`datauttrekk: krypterte skjemaer men nøkkel mangler for type ${skjematypeId}`);
            }
            const dekrypterte = nokkel
                ? skjemaer.map(s => {
                    if (!s?.Kryptert) return s;
                    try { return kryptering.dekrypterSkjema(s, nokkel); }
                    catch (_) { return s; }
                })
                : skjemaer;

            const fil = datauttrekk.bygg(dekrypterte, definisjon, filtere, type);

            context.log(`datauttrekk: ${upn} genererte ${type} for type ${skjematypeId} — ${skjemaer.length} skjemaer inn, ${fil.filnavn}`);
            return { jsonBody: fil };
        } catch (e) {
            context.log('datauttrekk POST FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});
