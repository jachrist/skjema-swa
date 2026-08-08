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
const { hentOgSettFasteData } = require('../lib/faste-data');
const { hentDropdownVerdier } = require('../lib/oppslag');
const { erTilgjengeligNaa } = require('../lib/periode');

async function nesteSkjematypeId() {
    const alle = await skjemaStorage.hentAlleSkjematyper();
    let max = 0;
    for (const st of alle) {
        const n = parseInt(st.id, 10);
        if (!isNaN(n) && n > max) max = n;
    }
    return String(max + 1);
}

async function harEierPåType(skjematypeId, upn) {
    if (erAdmin(upn)) return true;
    const st = await skjemaStorage.hentSkjematype(skjematypeId);
    if (!st) return false;
    const treff = await filtrerTyperPåTilgang([st], upn, 'Eiere');
    return treff.length > 0;
}

/**
 * Mapping fra intern representasjon til frontend-vennlig format.
 * ErEier og KanFylle indikerer hvilke handlingsknapper som skal vises.
 * Ekstra felter kommer etter hvert (mellomlagrede, behandle-antall, m.m.).
 */
function tilKortformat(st, erEier, kanFylle) {
    const data = st.JSON || {};
    const iPeriode = erTilgjengeligNaa(data.Tilgjengelighetsperioder);
    return {
        Skjematype_id: st.id,
        Skjema_navn: st.navn || data.Skjema_navn || '',
        Skjema_forklaring: data.Skjemaforklaring
            ? { Verdi: data.Skjemaforklaring.Innhold || '', Format: data.Skjemaforklaring.Format || 'Tekst' }
            : null,
        Logo_url: data.Logo_url || '',
        Fase: data.Fase || 'Produksjon',
        ErEier: erEier,
        // Utfylling blokkeres utenfor tilgjengelighetsperioden — eier ser kortet uansett
        KanFylle: kanFylle && iPeriode,
        ErIPeriode: iPeriode,
        Tilgjengelighetsperioder: data.Tilgjengelighetsperioder || []
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

            // Fase-filter:
            //   Utvikling  — kun admin (bruker ikke i lista i det hele tatt)
            //   Test       — admin + eiere (skjult for Publikum-brukere som ikke også er eier)
            //   Produksjon — alle med tilgang
            const filtrertPåFase = aktuelle.filter(t => {
                const fase = t.JSON?.Fase || 'Produksjon';
                if (fase === 'Produksjon') return true;
                if (erAdmin(upn)) return true;
                if (fase === 'Test' && eierIder.has(String(t.id))) return true;
                return false;
            });

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

            // Rå-modus (editor): returner definisjon uten FasteData-berikelse
            // så editor kan redigere selve datakilde/filter-oppsettet.
            if (request.query.get('rå') === '1' || request.query.get('raw') === '1') {
                return { jsonBody: st.JSON };
            }

            // Fyll Valg-arrays for felter med FasteData (masterdata-oppslag) — for utfylling
            const berikaSkjema = await hentOgSettFasteData(
                st.JSON,
                (dk, fb, fo, fv) => hentDropdownVerdier(dk, fb, fo, fv, (m) => context.log('oppslag: ' + m)),
                upn,
                (m) => context.log('faste-data: ' + m)
            );

            return { jsonBody: berikaSkjema };
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

        try {
            const body = await request.json();

            // Ny skjematype: generer id og krev admin. Eksisterende: krev admin eller eier.
            let erNy = false;
            if (!body.Skjematype_id) {
                if (!erAdmin(upn)) return { status: 403, jsonBody: { status: 'avvist', melding: 'Krever admin-tilgang for å opprette ny skjematype' } };
                body.Skjematype_id = await nesteSkjematypeId();
                erNy = true;
            } else {
                const tillatt = await harEierPåType(body.Skjematype_id, upn);
                if (!tillatt) return { status: 403, jsonBody: { status: 'avvist', melding: 'Kun eier eller admin kan endre denne skjematypen' } };
            }

            await skjemaStorage.lagreSkjematype(body);
            context.log(`skjematyper: ${upn} ${erNy ? 'opprettet' : 'oppdaterte'} skjematype ${body.Skjematype_id}`);
            return { jsonBody: { status: 'ok', Skjematype_id: body.Skjematype_id, erNy } };
        } catch (e) {
            context.log('skjematyper POST FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('slettSkjematype', {
    methods: ['DELETE'],
    authLevel: 'anonymous',
    route: 'skjematyper/{id}',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };

        try {
            const id = request.params.id;
            const tillatt = await harEierPåType(id, upn);
            if (!tillatt) return { status: 403, jsonBody: { status: 'avvist', melding: 'Kun eier eller admin kan slette denne skjematypen' } };

            const slettet = await skjemaStorage.slettSkjematype(id);
            if (!slettet) return { status: 404, jsonBody: { status: 'feil', melding: 'Skjematype ikke funnet' } };

            context.log(`skjematyper DELETE: ${upn} slettet skjematype ${id}`);
            return { jsonBody: { status: 'ok' } };
        } catch (e) {
            context.log('skjematyper DELETE FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});
