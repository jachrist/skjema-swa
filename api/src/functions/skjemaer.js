/**
 * Skjema-forekomst-endepunkter.
 *
 *   POST /api/skjemaer                        — opprett/lagre skjema
 *   GET  /api/skjemaer/:skjematypeId/:skjemaId — hent én forekomst
 *
 * POST forventer body med:
 *   { Skjematype_id, Seksjoner: [...], Skjema_status?, Skjema_id? (kun ved oppdatering) }
 *
 * Innsender settes automatisk fra pålogget bruker (x-ms-client-principal).
 * Skjema_id genereres serverside for nye skjemaer.
 */
const { app } = require('@azure/functions');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');
const skjemaStorage = require('../lib/skjema-storage');
const forekomstStorage = require('../lib/skjema-forekomst-storage');
const vedleggStorage = require('../lib/vedlegg-storage');
const { genererSkjemaId } = require('../lib/skjema-id');
const { filtrerTyperPåTilgang } = require('../lib/tilgang');
const { erKompaktFormat, komprimerSkjema } = require('../lib/skjema-kompakt');

async function harPublikumTilgang(skjematypeId, upn) {
    if (erAdmin(upn)) return true;
    const st = await skjemaStorage.hentSkjematype(skjematypeId);
    if (!st) return false;
    const treff = await filtrerTyperPåTilgang([st], upn, 'Publikum');
    return treff.length > 0;
}

async function harEierTilgang(skjematypeId, upn) {
    if (erAdmin(upn)) return true;
    const st = await skjemaStorage.hentSkjematype(skjematypeId);
    if (!st) return false;
    const treff = await filtrerTyperPåTilgang([st], upn, 'Eiere');
    return treff.length > 0;
}

/**
 * POST /api/skjemaer/:type/:id/komprimer — komprimer skjema til kompakt lagringsformat.
 * Reduserer JSON-størrelsen ved arkivering. Ekspanderes transparent ved henting.
 * Kun eier/admin. Kan gjøres når som helst (idempotent).
 */
app.http('komprimerSkjema', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'skjemaer/{skjematypeId}/{skjemaId}/komprimer',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };

        try {
            const { skjematypeId, skjemaId } = request.params;
            const skjema = await forekomstStorage.hentSkjema(skjemaId, skjematypeId);
            if (!skjema) return { status: 404, jsonBody: { status: 'feil', melding: 'Skjema ikke funnet' } };

            // Kun eier eller admin — innsender skal ikke kunne komprimere andres arkiv
            if (!erAdmin(upn)) {
                const erEier = await harEierTilgang(skjematypeId, upn);
                if (!erEier) return { status: 403, jsonBody: { status: 'avvist', melding: 'Krever eier-tilgang' } };
            }

            if (erKompaktFormat(skjema)) {
                return { jsonBody: { status: 'ok', allerede_kompakt: true } };
            }

            const kompakt = komprimerSkjema(skjema);
            const førSt = JSON.stringify(skjema).length;
            const etterSt = JSON.stringify(kompakt).length;
            await forekomstStorage.lagreSkjema(kompakt, false);

            context.log(`komprimer: ${upn} komprimerte ${skjemaId} (${førSt} → ${etterSt} bytes)`);
            return { jsonBody: { status: 'ok', størrelse_før: førSt, størrelse_etter: etterSt } };
        } catch (e) {
            context.log('komprimerSkjema FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('mineMellomlagrede', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'mine-mellomlagrede',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        try {
            const mine = await forekomstStorage.hentMineMellomlagrede(upn);
            // Grupper per skjematype: { [skjematypeId]: [skjemaer] }
            const gruppert = {};
            for (const s of mine) {
                const key = String(s.Skjematype_id);
                if (!gruppert[key]) gruppert[key] = [];
                gruppert[key].push(s);
            }
            return { jsonBody: gruppert };
        } catch (e) {
            context.log('mine-mellomlagrede FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('nyttSkjemaId', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'ny-skjema-id/{skjematypeId}',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        try {
            const skjematypeId = request.params.skjematypeId;
            const tillatt = await harPublikumTilgang(skjematypeId, upn);
            if (!tillatt) return { status: 403, jsonBody: { status: 'avvist', melding: 'Ingen tilgang' } };
            const skjemaId = await genererSkjemaId(skjematypeId);
            return { jsonBody: { Skjema_id: skjemaId } };
        } catch (e) {
            context.log('nyttSkjemaId FEIL:', e.message);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('lagreSkjema', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'skjemaer',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };

        try {
            const body = await request.json();
            const skjematypeId = String(body.Skjematype_id || '');
            if (!skjematypeId) {
                return { status: 400, jsonBody: { status: 'feil', melding: 'Skjematype_id mangler' } };
            }

            // Tilgangskontroll: må være publikum eller eier for å lagre
            const tillatt = await harPublikumTilgang(skjematypeId, upn);
            if (!tillatt) {
                return { status: 403, jsonBody: { status: 'avvist', melding: 'Ingen tilgang til denne skjematypen' } };
            }

            // Generer nytt Skjema_id hvis ikke oppgitt. Hvis oppgitt (f.eks. pre-generert
            // av ny-skjema-id-endpoint), sjekk om det allerede finnes for å avgjøre erNytt.
            let skjemaId = body.Skjema_id ? String(body.Skjema_id) : null;
            let erNytt;
            if (!skjemaId) {
                skjemaId = await genererSkjemaId(skjematypeId);
                erNytt = true;
            } else {
                const eksisterer = await forekomstStorage.hentSkjema(skjemaId, skjematypeId);
                erNytt = !eksisterer;
            }

            // Bygg skjemadata. Ved opprettelse: arv Behandling-struktur fra skjematypen
            // (dyp kopi, alle Beslutning nullstilles til 0 = ikke behandlet).
            let behandlingArvet = null;
            if (erNytt) {
                const st = await skjemaStorage.hentSkjematype(skjematypeId);
                if (Array.isArray(st?.JSON?.Behandling)) {
                    behandlingArvet = JSON.parse(JSON.stringify(st.JSON.Behandling)).map(steg => ({
                        ...steg,
                        Beslutning: 0,
                        Dialog: []
                    }));
                }
            }

            const skjemaData = {
                ...body,
                Skjema_id: skjemaId,
                Skjematype_id: skjematypeId,
                Innsender_Epost: upn,
                Skjema_status: body.Skjema_status || 2 // 1=mellomlagret, 2=innsendt
            };
            if (behandlingArvet && !Array.isArray(skjemaData.Behandling)) {
                skjemaData.Behandling = behandlingArvet;
            }

            await forekomstStorage.lagreSkjema(skjemaData, erNytt);
            context.log(`skjemaer: ${upn} ${erNytt ? 'opprettet' : 'oppdaterte'} ${skjemaId} (type ${skjematypeId})`);

            return {
                jsonBody: {
                    status: 'ok',
                    Skjema_id: skjemaId,
                    Skjematype_id: skjematypeId
                }
            };
        } catch (e) {
            context.log('skjemaer POST FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('listSkjemaer', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'skjema-liste/{skjematypeId}',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };

        try {
            const skjematypeId = request.params.skjematypeId;

            // Kun eiere (eller admin) kan liste alle skjemaer for en type
            const erEier = await harEierTilgang(skjematypeId, upn);
            if (!erEier) return { status: 403, jsonBody: { status: 'avvist', melding: 'Krever eier-tilgang' } };

            const alle = await forekomstStorage.hentAlleSkjemaerForType(skjematypeId);

            // Kompakt liste — kun feltene registeret trenger for kolonner
            const liste = alle.map(s => ({
                Skjema_id: s.Skjema_id,
                Skjematype_id: s.Skjematype_id,
                Skjema_navn: s.Skjema_navn || '',
                Innsender_Epost: s.Innsender_Epost || s.Innsender_epost || '',
                Skjema_status: s.Skjema_status || 0,
                Opprettet: s.Opprettet || s.OpprettetDato || '',
                Sist_endret: s.Sist_endret || s.Oppdatert || ''
            }));

            // Nyeste først
            liste.sort((a, b) => (b.Sist_endret || '').localeCompare(a.Sist_endret || ''));

            return { jsonBody: liste };
        } catch (e) {
            context.log('skjemaer/liste FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('slettSkjema', {
    methods: ['DELETE'],
    authLevel: 'anonymous',
    route: 'skjemaer/{skjematypeId}/{skjemaId}',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };

        try {
            const { skjematypeId, skjemaId } = request.params;
            const skjema = await forekomstStorage.hentSkjema(skjemaId, skjematypeId);
            if (!skjema) return { status: 404, jsonBody: { status: 'feil', melding: 'Skjema ikke funnet' } };

            // Kun eier, admin eller innsender selv kan slette
            const upnLower = upn.toLowerCase();
            const erInnsender = (skjema.Innsender_Epost || '').toLowerCase() === upnLower;
            if (!erInnsender && !erAdmin(upn)) {
                const erEier = await harEierTilgang(skjematypeId, upn);
                if (!erEier) return { status: 403, jsonBody: { status: 'avvist', melding: 'Ingen tilgang' } };
            }

            const slettet = await forekomstStorage.slettSkjema(skjemaId, skjematypeId);
            if (!slettet) return { status: 404, jsonBody: { status: 'feil', melding: 'Skjema ikke funnet' } };

            // Slett også alle vedlegg for skjemaet (best-effort)
            try {
                const antall = await vedleggStorage.slettAlleVedleggForSkjema(skjematypeId, skjemaId);
                if (antall > 0) context.log(`skjemaer DELETE: ryddet ${antall} vedlegg for ${skjemaId}`);
            } catch (e) {
                context.log(`skjemaer DELETE: kunne ikke rydde vedlegg for ${skjemaId}: ${e.message}`);
            }

            context.log(`skjemaer DELETE: ${upn} slettet ${skjemaId} (type ${skjematypeId})`);
            return { jsonBody: { status: 'ok' } };
        } catch (e) {
            context.log('skjemaer DELETE FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('hentSkjema', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'skjemaer/{skjematypeId}/{skjemaId}',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };

        try {
            const { skjematypeId, skjemaId } = request.params;
            const skjema = await forekomstStorage.hentSkjema(skjemaId, skjematypeId);
            if (!skjema) return { status: 404, jsonBody: { status: 'feil', melding: 'Skjema ikke funnet' } };

            // Tilgang: admin, eier eller innsender selv
            const upnLower = upn.toLowerCase();
            const erInnsender = (skjema.Innsender_Epost || '').toLowerCase() === upnLower;
            if (!erInnsender && !erAdmin(upn)) {
                const erEier = await harEierTilgang(skjematypeId, upn);
                if (!erEier) return { status: 403, jsonBody: { status: 'avvist', melding: 'Ingen tilgang' } };
            }

            return { jsonBody: skjema };
        } catch (e) {
            context.log('skjemaer GET FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});
