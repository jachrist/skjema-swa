/**
 * Rapporttype-endepunkter.
 *
 *   GET    /api/rapporttyper           — mine rapporttyper (filtrert på tilgang)
 *   GET    /api/rapporttyper/:id       — hent én rapporttype (må ha tilgang)
 *   POST   /api/rapporttyper           — opprett/oppdater (admin eller Skjemaskaper)
 *   DELETE /api/rapporttyper/:id       — slett (eier eller admin)
 *
 * Auth via SWA. Bruker samme tilgangsmodell som skjematyper (Publikum/Eiere),
 * men hele rapport-funksjonaliteten er i tillegg låst til admin/Skjemaskaper
 * mens den er i Utvikling-fase — se `krevSkjemaskaper`.
 */
const { app } = require('@azure/functions');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');
const rapportStorage = require('../lib/rapport-storage');
const skjemaStorage = require('../lib/skjema-storage');
const { filtrerTyperPåTilgang, erSkjemaskaper } = require('../lib/tilgang');
const hendelser = require('../lib/hendelser-storage');

/**
 * Felles inngangssjekk for alle rapport-endepunkt: innlogget + admin/Skjemaskaper.
 * Returnerer { upn } ved OK, eller { svar } med ferdig HTTP-respons ved avvisning.
 */
async function krevSkjemaskaper(request) {
    const upn = hentInnloggetUpn(request);
    if (!upn) return { svar: { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } } };
    if (!await erSkjemaskaper(upn)) {
        return { svar: { status: 403, jsonBody: { status: 'avvist', melding: 'Rapporter er foreløpig forbeholdt admin og rollen "Skjemaskaper"' } } };
    }
    return { upn };
}

async function nesteRapporttypeId() {
    const alle = await rapportStorage.hentAlleRapporttyper();
    let max = 0;
    for (const st of alle) {
        const n = parseInt(st.id, 10);
        if (!isNaN(n) && n > max) max = n;
    }
    return String(max + 1);
}

async function harEierPåType(rapporttypeId, upn) {
    if (erAdmin(upn)) return true;
    const st = await rapportStorage.hentRapporttype(rapporttypeId);
    if (!st) return false;
    const treff = await filtrerTyperPåTilgang([st], upn, 'Eiere');
    return treff.length > 0;
}

function tilKortformat(st, erEier, kanKjore) {
    const data = st.JSON || {};
    return {
        Rapporttype_id: st.id,
        Rapport_navn: st.navn || data.Rapport_navn || '',
        Beskrivelse: data.Beskrivelse || '',
        Fase: data.Fase || 'Produksjon',
        Kildeskjematype_id: data.Kildeskjematype_id || '',
        ErEier: erEier,
        KanKjore: kanKjore,
        AlleTilgang: data.Publikum?.AlleTilgang === true
    };
}

app.http('mineRapporttyper', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'rapporttyper',
    handler: async (request, context) => {
        const { upn, svar } = await krevSkjemaskaper(request);
        if (svar) return svar;

        try {
            const alle = await rapportStorage.hentAlleRapporttyper();

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

            // Fase-filter: Utvikling kun for admin+eiere
            const filtrertPåFase = aktuelle.filter(t => {
                const fase = t.JSON?.Fase || 'Produksjon';
                if (fase === 'Produksjon') return true;
                if (erAdmin(upn)) return true;
                return eierIder.has(String(t.id));
            });

            const resultat = filtrertPåFase
                .map(t => tilKortformat(t, eierIder.has(String(t.id)), publikumsIder.has(String(t.id))))
                .sort((a, b) => (a.Rapport_navn || '').localeCompare(b.Rapport_navn || '', 'nb'));

            return { jsonBody: resultat };
        } catch (e) {
            context.log('rapporttyper GET FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('hentRapporttype', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'rapporttyper/{id}',
    handler: async (request, context) => {
        const { upn, svar } = await krevSkjemaskaper(request);
        if (svar) return svar;

        try {
            const id = request.params.id;
            const st = await rapportStorage.hentRapporttype(id);
            if (!st) return { status: 404, jsonBody: { status: 'feil', melding: 'Rapporttype ikke funnet' } };

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
            context.log('rapporttyper GET :id FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('lagreRapporttype', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'rapporttyper',
    handler: async (request, context) => {
        const { upn, svar } = await krevSkjemaskaper(request);
        if (svar) return svar;

        try {
            const body = await request.json();
            let erNy = false;
            if (!body.Rapporttype_id) {
                // Selve opprettelses-kravet (admin/Skjemaskaper) dekkes av krevSkjemaskaper
                body.Rapporttype_id = await nesteRapporttypeId();
                erNy = true;
                if (!body.Eiere || typeof body.Eiere !== 'object') body.Eiere = { Personer: [], Roller: [], Team: [] };
                if (!Array.isArray(body.Eiere.Personer)) body.Eiere.Personer = [];
                const upnLower = upn.toLowerCase();
                if (!body.Eiere.Personer.some(p => String(p).toLowerCase() === upnLower)) {
                    body.Eiere.Personer.push(upn);
                }
            } else {
                const tillatt = await harEierPåType(body.Rapporttype_id, upn);
                if (!tillatt) return { status: 403, jsonBody: { status: 'avvist', melding: 'Kun eier eller admin kan endre denne rapporttypen' } };
            }

            // Valider kildeskjematype-referanse — må eksistere
            if (body.Kildeskjematype_id) {
                const kilde = await skjemaStorage.hentSkjematype(body.Kildeskjematype_id);
                if (!kilde) {
                    return { status: 400, jsonBody: { status: 'feil', melding: `Kildeskjematype ${body.Kildeskjematype_id} finnes ikke` } };
                }
            }

            await rapportStorage.lagreRapporttype(body);
            context.log(`rapporttyper: ${upn} ${erNy ? 'opprettet' : 'oppdaterte'} rapporttype ${body.Rapporttype_id}`);
            hendelser.logg({
                Type: erNy ? 'rapporttype.opprett' : 'rapporttype.oppdater',
                Aktor: upn,
                ObjektType: 'rapporttype', ObjektId: String(body.Rapporttype_id),
                Melding: `${erNy ? 'Opprettet' : 'Oppdaterte'} rapporttype "${body.Rapport_navn || ''}"`,
                Detaljer: { fase: body.Fase || '', kildeskjematype: body.Kildeskjematype_id || '' }
            });
            return { jsonBody: { status: 'ok', Rapporttype_id: body.Rapporttype_id, erNy } };
        } catch (e) {
            context.log('rapporttyper POST FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('slettRapporttype', {
    methods: ['DELETE'],
    authLevel: 'anonymous',
    route: 'rapporttyper/{id}',
    handler: async (request, context) => {
        const { upn, svar } = await krevSkjemaskaper(request);
        if (svar) return svar;

        try {
            const id = request.params.id;
            const tillatt = await harEierPåType(id, upn);
            if (!tillatt) return { status: 403, jsonBody: { status: 'avvist', melding: 'Kun eier eller admin kan slette denne rapporttypen' } };

            const slettet = await rapportStorage.slettRapporttype(id);
            if (!slettet) return { status: 404, jsonBody: { status: 'feil', melding: 'Rapporttype ikke funnet' } };

            context.log(`rapporttyper DELETE: ${upn} slettet rapporttype ${id}`);
            hendelser.logg({
                Type: 'rapporttype.slett', Aktor: upn,
                ObjektType: 'rapporttype', ObjektId: String(id),
                Melding: `Slettet rapporttype ${id}`
            });
            return { jsonBody: { status: 'ok' } };
        } catch (e) {
            context.log('rapporttyper DELETE FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});
