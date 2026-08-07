/**
 * Skjematype-endepunkter.
 *
 *   GET  /api/skjematyper           — mine skjematyper (filtrert på tilgang)
 *   GET  /api/skjematyper/:id       — hent én skjematype (må ha tilgang)
 *   POST /api/skjematyper           — opprett/oppdater (admin only)
 *
 * Auth via SWA — bruker plukkes fra x-ms-client-principal-header.
 */
const { app } = require('@azure/functions');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');
const skjemaStorage = require('../lib/skjema-storage');
const { filtrerTyperPåTilgang } = require('../lib/tilgang');

/**
 * Mapping fra intern representasjon til frontend-vennlig format.
 * ErEier og KanFylle indikerer hvilke handlingsknapper som skal vises.
 * Ekstra felter kommer etter hvert (mellomlagrede, behandle-antall, m.m.).
 */
function tilKortformat(st, erEier, kanFylle) {
    const data = st.JSON || {};
    return {
        Skjematype_id: st.id,
        Skjema_navn: st.navn || data.Skjema_navn || '',
        Skjema_forklaring: data.Skjemaforklaring
            ? { Verdi: data.Skjemaforklaring.Innhold || '', Format: data.Skjemaforklaring.Format || 'Tekst' }
            : null,
        Logo_url: data.Logo_url || '',
        Fase: data.Fase || 'Produksjon',
        ErEier: erEier,
        KanFylle: kanFylle
    };
}

app.http('mineSkjematyper', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'skjematyper',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };

        try {
            const alle = await skjemaStorage.hentAlleSkjematyper();

            // For admin: se alt som både eier og publikum. Ellers: filtrer på Eier/Publikum.
            let eierIder, publikumsIder, aktuelle;
            if (erAdmin(upn)) {
                aktuelle = alle;
                eierIder = new Set(alle.map(t => String(t.id)));
                publikumsIder = new Set(alle.map(t => String(t.id)));
            } else {
                const [eiere, publikum] = await Promise.all([
                    filtrerTyperPåTilgang(alle, upn, 'Eiere'),
                    filtrerTyperPåTilgang(alle, upn, 'Publikum')
                ]);
                eierIder = new Set(eiere.map(t => String(t.id)));
                publikumsIder = new Set(publikum.map(t => String(t.id)));
                const map = new Map();
                [...eiere, ...publikum].forEach(t => map.set(String(t.id), t));
                aktuelle = [...map.values()];
            }

            // Vanlige brukere ser kun Produksjon-fase; admin ser alt
            const filtrertPåFase = erAdmin(upn)
                ? aktuelle
                : aktuelle.filter(t => (t.JSON?.Fase || 'Produksjon') === 'Produksjon');

            const resultat = filtrertPåFase
                .map(t => tilKortformat(t, eierIder.has(String(t.id)), publikumsIder.has(String(t.id))))
                .sort((a, b) => (a.Skjema_navn || '').localeCompare(b.Skjema_navn || '', 'nb'));

            return { jsonBody: resultat };
        } catch (e) {
            context.log('skjematyper GET FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('hentSkjematype', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'skjematyper/{id}',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };

        try {
            const id = request.params.id;
            const st = await skjemaStorage.hentSkjematype(id);
            if (!st) return { status: 404, jsonBody: { status: 'feil', melding: 'Skjematype ikke funnet' } };

            // Tilgang: admin, eier eller publikum
            if (!erAdmin(upn)) {
                const [eier, publikum] = await Promise.all([
                    filtrerTyperPåTilgang([st], upn, 'Eiere'),
                    filtrerTyperPåTilgang([st], upn, 'Publikum')
                ]);
                if (eier.length === 0 && publikum.length === 0) {
                    return { status: 403, jsonBody: { status: 'avvist', melding: 'Ingen tilgang' } };
                }
            }

            return { jsonBody: st.JSON };
        } catch (e) {
            context.log('skjematyper GET :id FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('lagreSkjematype', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'skjematyper',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        if (!erAdmin(upn)) return { status: 403, jsonBody: { status: 'avvist', melding: 'Krever admin-tilgang' } };

        try {
            const body = await request.json();
            if (!body.Skjematype_id) {
                return { status: 400, jsonBody: { status: 'feil', melding: 'Skjematype_id mangler' } };
            }
            await skjemaStorage.lagreSkjematype(body);
            context.log(`skjematyper: ${upn} lagret skjematype ${body.Skjematype_id}`);
            return { jsonBody: { status: 'ok', Skjematype_id: body.Skjematype_id } };
        } catch (e) {
            context.log('skjematyper POST FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});
