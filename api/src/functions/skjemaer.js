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
const { beregnAktiveSteg, brukerErBehandler, brukerErBehandlerAsync, alleStegFerdig, stegErFerdig, skipStegSomIkkeSkalKjore } = require('../lib/behandling');

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

/**
 * POST /api/skjemaer/:type/:id/beslutning
 * Body: { steg: <n>, beslutning: <n> }
 * Kun bruker som er behandler på steget kan gjøre beslutning.
 * Steget må være aktivt (ikke behandlet, ikke blokkert av avhengighet).
 */
app.http('lagreBeslutning', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'skjemaer/{skjematypeId}/{skjemaId}/beslutning',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };

        try {
            const { skjematypeId, skjemaId } = request.params;
            const body = await request.json();
            const stegNr = Number(body.steg);
            const beslutning = Number(body.beslutning);
            if (!stegNr || !beslutning) {
                return { status: 400, jsonBody: { status: 'feil', melding: 'Manglet steg eller beslutning' } };
            }

            const skjema = await forekomstStorage.hentSkjema(skjemaId, skjematypeId);
            if (!skjema) return { status: 404, jsonBody: { status: 'feil', melding: 'Skjema ikke funnet' } };

            const stegObj = (skjema.Behandling || []).find(s => Number(s.Steg) === stegNr);
            if (!stegObj) return { status: 404, jsonBody: { status: 'feil', melding: 'Behandlingssteg ikke funnet' } };

            // Tilgangssjekk: må være behandler (Personer eller rolle-innehaver)
            if (!(await brukerErBehandlerAsync(stegObj, upn))) {
                return { status: 403, jsonBody: { status: 'avvist', melding: 'Du er ikke behandler på dette steget' } };
            }
            // Tilstandssjekk: ikke allerede behandlet, ikke blokkert
            if (stegErFerdig(stegObj)) {
                return { status: 409, jsonBody: { status: 'feil', melding: 'Steget er allerede behandlet' } };
            }
            const aktive = beregnAktiveSteg(skjema);
            if (!aktive.some(s => Number(s.Steg) === stegNr)) {
                return { status: 409, jsonBody: { status: 'feil', melding: 'Steget er ikke aktivt ennå' } };
            }

            // Valider beslutning mot Beslutningsvalg (eller 5 = hoppet over)
            const valgtValg = (stegObj.Beslutningsvalg || []).find(v => Number(v.Nummer) === beslutning);
            if (beslutning !== 5 && !valgtValg) {
                return { status: 400, jsonBody: { status: 'feil', melding: 'Ugyldig beslutning for dette steget' } };
            }

            const erOmpuss = valgtValg?.Handling === 'ompuss';

            if (erOmpuss) {
                // Ompuss: skjemaet sendes tilbake til innsender for revidering.
                // Steget nullstilles så det kan re-behandles etter re-innsending.
                // Loggfør beslutningen som dialog-innlegg (så historikken bevares).
                const notat = valgtValg?.Tekst || 'Ompuss';
                if (!Array.isArray(skjema.Dialog)) skjema.Dialog = [];
                skjema.Dialog.push({
                    Type: 'ekstern',
                    Avsender: upn,
                    Tekst: `Sendt til revidering fra steg ${stegNr} (${stegObj.Stegnavn || ''}). Beslutning: ${notat}. Vennligst oppdater og send inn på nytt.`,
                    Dato: new Date().toISOString()
                });
                // Nullstill steget (så det er "aktivt" igjen etter re-innsending)
                delete stegObj.Beslutning;
                stegObj.Beslutning = 0;
                delete stegObj.BehandletAv;
                delete stegObj.BehandletDato;
                // Skjemaet: status=3 (Til revidering)
                skjema.Skjema_status = 3;
                context.log(`beslutning: ${upn} sendte ${skjemaId} til revidering fra steg ${stegNr}`);
            } else {
                // Vanlig beslutning
                stegObj.Beslutning = beslutning;
                stegObj.BehandletAv = upn;
                stegObj.BehandletDato = new Date().toISOString();

                // Kaskader: marker steg som skal skippes som "Hoppet over"
                const antallSkippet = skipStegSomIkkeSkalKjore(skjema);
                if (antallSkippet > 0) context.log(`beslutning: skippet ${antallSkippet} steg med uoppfylt vilkår`);

                // Oppdater skjema-status hvis alle steg ferdig
                if (alleStegFerdig(skjema)) {
                    skjema.Skjema_status = 5; // Avsluttet
                }
            }

            await forekomstStorage.lagreSkjema(skjema, false);
            context.log(`beslutning: ${upn} satte steg ${stegNr}=${beslutning} på skjema ${skjemaId}`);

            return {
                jsonBody: {
                    status: 'ok',
                    alleFerdig: alleStegFerdig(skjema),
                    nyeAktive: beregnAktiveSteg(skjema).map(s => ({ Steg: s.Steg, Stegnavn: s.Stegnavn }))
                }
            };
        } catch (e) {
            context.log('beslutning FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

/**
 * GET /api/mine-behandlinger — skjemaer der bruker er behandler på minst ett aktivt steg.
 * Returnerer { [skjematypeId]: [{ Skjema_id, Innsender_Epost, Sist_endret, Aktive_steg: [...] }] }
 *
 * Foreløpig full scan av Skjemaer med Skjemastatus=2. Optimeres senere.
 */
/**
 * Hjelper for dialog: sjekker om bruker har tilgang til skjemaet.
 * Returnerer { rolle: 'innsender' | 'behandler' | 'eier' | 'admin' | null }
 */
async function tilgangsRolle(skjema, skjematypeId, upn) {
    if (erAdmin(upn)) return 'admin';
    const upnLower = upn.toLowerCase();
    if ((skjema.Innsender_Epost || '').toLowerCase() === upnLower) return 'innsender';

    const st = await skjemaStorage.hentSkjematype(skjematypeId);
    if (!st) return null;
    const eier = await filtrerTyperPåTilgang([st], upn, 'Eiere');
    if (eier.length > 0) return 'eier';

    // Behandler-sjekk: er upn i noe steg.Personer
    if (Array.isArray(skjema.Behandling)) {
        for (const steg of skjema.Behandling) {
            if ((steg.Personer || []).some(p => String(p).toLowerCase() === upnLower)) return 'behandler';
        }
    }
    return null;
}

/**
 * POST /api/skjemaer/:type/:id/dialog — legg til dialog-innlegg
 * Body: { type: 'intern' | 'ekstern', tekst: '...' }
 *
 * Intern innlegg: krever behandler/eier/admin (ikke innsender)
 * Ekstern innlegg: alle med tilgang
 */
app.http('leggTilDialog', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'skjemaer/{skjematypeId}/{skjemaId}/dialog',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };

        try {
            const { skjematypeId, skjemaId } = request.params;
            const body = await request.json();
            const type = String(body.type || '').toLowerCase();
            const tekst = String(body.tekst || '').trim();

            if (type !== 'intern' && type !== 'ekstern') {
                return { status: 400, jsonBody: { status: 'feil', melding: 'Type må være "intern" eller "ekstern"' } };
            }
            if (!tekst) {
                return { status: 400, jsonBody: { status: 'feil', melding: 'Tekst mangler' } };
            }

            const skjema = await forekomstStorage.hentSkjema(skjemaId, skjematypeId);
            if (!skjema) return { status: 404, jsonBody: { status: 'feil', melding: 'Skjema ikke funnet' } };

            const rolle = await tilgangsRolle(skjema, skjematypeId, upn);
            if (!rolle) return { status: 403, jsonBody: { status: 'avvist', melding: 'Ingen tilgang' } };
            if (type === 'intern' && rolle === 'innsender') {
                return { status: 403, jsonBody: { status: 'avvist', melding: 'Innsender kan ikke skrive interne innlegg' } };
            }

            if (!Array.isArray(skjema.Dialog)) skjema.Dialog = [];
            skjema.Dialog.push({
                Type: type,
                Avsender: upn,
                Tekst: tekst,
                Dato: new Date().toISOString()
            });

            await forekomstStorage.lagreSkjema(skjema, false);
            return { jsonBody: { status: 'ok', antallInnlegg: skjema.Dialog.length } };
        } catch (e) {
            context.log('dialog POST FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

/**
 * POST /api/skjemaer/:type/:id/videresend
 * Body: { steg: N, tilUpn: 'x@y.no', notat?: '...' }
 * Legger til ny behandler på steget. Beholder opprinnelig (pilot-forenkling).
 * Registreres som intern dialog-innlegg.
 */
app.http('videresend', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'skjemaer/{skjematypeId}/{skjemaId}/videresend',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };

        try {
            const { skjematypeId, skjemaId } = request.params;
            const body = await request.json();
            const stegNr = Number(body.steg);
            const tilUpn = String(body.tilUpn || '').trim().toLowerCase();
            const notat = String(body.notat || '').trim();
            if (!stegNr || !tilUpn) {
                return { status: 400, jsonBody: { status: 'feil', melding: 'Manglet steg eller tilUpn' } };
            }
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(tilUpn)) {
                return { status: 400, jsonBody: { status: 'feil', melding: 'tilUpn er ikke en gyldig e-post' } };
            }

            const skjema = await forekomstStorage.hentSkjema(skjemaId, skjematypeId);
            if (!skjema) return { status: 404, jsonBody: { status: 'feil', melding: 'Skjema ikke funnet' } };

            const stegObj = (skjema.Behandling || []).find(s => Number(s.Steg) === stegNr);
            if (!stegObj) return { status: 404, jsonBody: { status: 'feil', melding: 'Behandlingssteg ikke funnet' } };
            if (!(await brukerErBehandlerAsync(stegObj, upn))) {
                return { status: 403, jsonBody: { status: 'avvist', melding: 'Du er ikke behandler på dette steget' } };
            }
            if (stegErFerdig(stegObj)) {
                return { status: 409, jsonBody: { status: 'feil', melding: 'Steget er allerede behandlet' } };
            }

            // Legg til ny person hvis ikke allerede der
            if (!Array.isArray(stegObj.Personer)) stegObj.Personer = [];
            const alleredeThere = stegObj.Personer.some(p => String(p).toLowerCase() === tilUpn);
            if (!alleredeThere) stegObj.Personer.push(tilUpn);

            // Loggfør som intern dialog
            if (!Array.isArray(skjema.Dialog)) skjema.Dialog = [];
            skjema.Dialog.push({
                Type: 'intern',
                Avsender: upn,
                Tekst: `Videresendt steg ${stegNr} til ${tilUpn}${notat ? '. Notat: ' + notat : ''}`,
                Dato: new Date().toISOString()
            });

            await forekomstStorage.lagreSkjema(skjema, false);
            context.log(`videresend: ${upn} → ${tilUpn} på steg ${stegNr} (${skjemaId})`);
            return { jsonBody: { status: 'ok', personerNa: stegObj.Personer } };
        } catch (e) {
            context.log('videresend FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('mineBehandlinger', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'mine-behandlinger',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };

        try {
            const { odata } = require('@azure/data-tables');
            const { tabellKlient } = require('../lib/storage');
            const tabell = tabellKlient('Skjemaer');
            const iter = tabell.listEntities({
                queryOptions: { filter: odata`Skjemastatus eq ${2}` }
            });

            const upnLower = upn.toLowerCase();
            const gruppert = {};
            for await (const entity of iter) {
                if (!entity.JSON) continue;
                let data;
                try { data = JSON.parse(entity.JSON); } catch { continue; }
                const skjema = await forekomstStorage.sikrFulltFormat(data);
                if (!Array.isArray(skjema?.Behandling)) continue;

                const aktive = beregnAktiveSteg(skjema);
                const mine = [];
                for (const s of aktive) {
                    if (await brukerErBehandlerAsync(s, upn)) mine.push(s);
                }
                if (mine.length === 0) continue;

                const key = String(skjema.Skjematype_id || entity.partitionKey);
                if (!gruppert[key]) gruppert[key] = [];
                gruppert[key].push({
                    Skjema_id: skjema.Skjema_id,
                    Skjematype_id: skjema.Skjematype_id,
                    Innsender_Epost: skjema.Innsender_Epost,
                    Sist_endret: skjema.Sist_endret || entity.Oppdatert || '',
                    Aktive_steg: mine.map(s => ({ Steg: s.Steg, Stegnavn: s.Stegnavn || `Steg ${s.Steg}` }))
                });
            }
            return { jsonBody: gruppert };
        } catch (e) {
            context.log('mine-behandlinger FEIL:', e.message, e.stack);
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

            // Hent eksisterende for å avgjøre erNytt og bevare metadata (Behandling, Dialog)
            let skjemaId = body.Skjema_id ? String(body.Skjema_id) : null;
            let eksisterende = null;
            if (skjemaId) {
                eksisterende = await forekomstStorage.hentSkjema(skjemaId, skjematypeId);
            }
            const erNytt = !eksisterende;
            if (!skjemaId) {
                skjemaId = await genererSkjemaId(skjematypeId);
            }

            // Ved nytt skjema: arv Behandling-struktur fra skjematypen
            let behandlingArvet = null;
            if (erNytt) {
                const st = await skjemaStorage.hentSkjematype(skjematypeId);
                if (Array.isArray(st?.JSON?.Behandling)) {
                    behandlingArvet = JSON.parse(JSON.stringify(st.JSON.Behandling)).map(steg => ({
                        ...steg,
                        Beslutning: 0
                    }));
                }
            }

            // Bygg skjemadata. Ved oppdatering: start med eksisterende (bevar Behandling,
            // Dialog, vedlegg-refs) og la body overstyre med nye svar/status.
            const skjemaData = {
                ...(eksisterende || {}),
                ...body,
                Skjema_id: skjemaId,
                Skjematype_id: skjematypeId,
                // Bevar original innsender ved oppdatering
                Innsender_Epost: eksisterende?.Innsender_Epost || upn,
                Skjema_status: body.Skjema_status || eksisterende?.Skjema_status || 2
            };
            if (behandlingArvet && !Array.isArray(skjemaData.Behandling)) {
                skjemaData.Behandling = behandlingArvet;
            }

            // Ved innsending: kjør skip-logikk så steg som ikke oppfyller vilkår
            // markeres som "Hoppet over" med én gang, og skjemaet kan lukkes hvis alt skippes.
            if (skjemaData.Skjema_status === 2 && Array.isArray(skjemaData.Behandling)) {
                skipStegSomIkkeSkalKjore(skjemaData);
                if (alleStegFerdig(skjemaData)) {
                    skjemaData.Skjema_status = 5;
                }
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

            // Filtrer interne dialog-innlegg for innsender (uten annen rolle)
            if (Array.isArray(skjema.Dialog) && skjema.Dialog.length > 0) {
                const rolle = await tilgangsRolle(skjema, skjematypeId, upn);
                if (rolle === 'innsender') {
                    skjema.Dialog = skjema.Dialog.filter(d => d.Type !== 'intern');
                }
            }

            return { jsonBody: skjema };
        } catch (e) {
            context.log('skjemaer GET FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});
