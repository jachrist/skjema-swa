/**
 * Arkivering: eksporter ferdigbehandlede skjemaer, og slett dem så.
 *
 *   GET  /api/arkiv                                 — tidligere arkiv
 *   POST /api/arkiv/{skjematypeId}/forhandsvis      { foerDato } → hva ville skje
 *   POST /api/arkiv/{skjematypeId}                  { foerDato, medVedlegg } → arkivet
 *   POST /api/arkiv/{skjematypeId}/slett            { arkivId, sjekksum } → sletter
 *
 * Formålet er å frigjøre lagring. Arkivet er det som gjør slettingen
 * forsvarlig — se `lib/arkiv.js` for hva det må inneholde og hvorfor.
 *
 * SLETTINGEN ER ET EGET KALL, og den krever sjekksummen fra den nedlastede
 * fila. Det er ikke en formalitet: uten den kunne noen slette på grunnlag av
 * en eksport som aldri kom fram, og det er den feilen som ikke kan rettes.
 *
 * Bare admin. Dette er den eneste operasjonen i systemet som fjerner
 * saksdata for godt.
 */
const { app } = require('@azure/functions');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');
const skjemaStorage = require('../lib/skjema-storage');
const forekomstStorage = require('../lib/skjema-forekomst-storage');
const samtaleStorage = require('../lib/samtale-storage');
const vedleggStorage = require('../lib/vedlegg-storage');
const arkivStorage = require('../lib/arkiv-storage');
const hendelser = require('../lib/hendelser-storage');
const { kanArkiveres, byggArkiv, verifiser } = require('../lib/arkiv');

function avvis(status, melding) {
    return { status, jsonBody: { status: status === 403 ? 'avvist' : 'feil', melding } };
}

async function kreverAdmin(request) {
    const upn = hentInnloggetUpn(request);
    if (!upn) return { svar: avvis(401, 'Ikke innlogget') };
    if (!erAdmin(upn)) return { svar: avvis(403, 'Kun for administratorer') };
    return { upn };
}

/** Skjemaene som oppfyller kriteriet, i fullt format. */
async function finnKandidater(skjematypeId, foerDato) {
    const alle = await forekomstStorage.hentAlleSkjemaerForType(skjematypeId, { fulltFormat: true });
    return alle.filter(s => kanArkiveres(s, foerDato));
}

app.http('arkivListe', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'arkiv',
    handler: async (request, context) => {
        const a = await kreverAdmin(request);
        if (a.svar) return a.svar;
        try {
            return { jsonBody: { arkiv: await arkivStorage.hentAlle() } };
        } catch (e) {
            context.log('arkiv-liste FEIL:', e.message);
            return avvis(500, 'Kunne ikke hente arkivlista');
        }
    }
});

app.http('arkivForhandsvis', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'arkiv/{skjematypeId}/forhandsvis',
    handler: async (request, context) => {
        const a = await kreverAdmin(request);
        if (a.svar) return a.svar;
        try {
            const { skjematypeId } = request.params;
            const body = await request.json().catch(() => ({}));
            const foerDato = String(body?.foerDato || '');
            if (!foerDato) return avvis(400, 'Mangler foerDato');

            const kandidater = await finnKandidater(skjematypeId, foerDato);

            // Antall vedlegg telles her, ikke gjettes i grensesnittet: det er
            // som regel vedleggene som faktisk tar plass, og det er tallet
            // som avgjør om jobben er verdt å kjøre.
            let antallVedlegg = 0;
            for (const s of kandidater) {
                try { antallVedlegg += (await vedleggStorage.listVedlegg(skjematypeId, s.Skjema_id)).length; }
                catch (_) { /* tellingen er veiledende */ }
            }

            const datoer = kandidater.map(s => String(s.Sist_endret || '')).filter(Boolean).sort();
            return {
                jsonBody: {
                    antall: kandidater.length,
                    antallVedlegg,
                    eldste: datoer[0] || '',
                    nyeste: datoer[datoer.length - 1] || '',
                    skjemaIder: kandidater.map(s => s.Skjema_id)
                }
            };
        } catch (e) {
            context.log('arkiv-forhandsvis FEIL:', e.message);
            return avvis(500, 'Kunne ikke lage forhåndsvisning');
        }
    }
});

app.http('arkivEksporter', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'arkiv/{skjematypeId}',
    handler: async (request, context) => {
        const a = await kreverAdmin(request);
        if (a.svar) return a.svar;
        try {
            const { skjematypeId } = request.params;
            const body = await request.json().catch(() => ({}));
            const foerDato = String(body?.foerDato || '');
            const medVedlegg = body?.medVedlegg !== false;
            if (!foerDato) return avvis(400, 'Mangler foerDato');

            const skjematype = await skjemaStorage.hentSkjematype(skjematypeId);
            if (!skjematype) return avvis(404, 'Skjematypen finnes ikke');

            const skjemaer = await finnKandidater(skjematypeId, foerDato);
            if (skjemaer.length === 0) return avvis(400, 'Ingen skjemaer oppfyller kriteriet');

            // Samtalen og vedleggene ligger utenfor skjemaet. Uten dem er
            // arkivet ikke komplett, og da gir det ikke rett til å slette.
            const samtaler = {};
            const vedlegg = {};
            for (const s of skjemaer) {
                const id = String(s.Skjema_id);
                try {
                    const innlegg = await samtaleStorage.hentInnlegg(skjematypeId, id);
                    if (innlegg.length > 0) samtaler[id] = innlegg;
                } catch (e) {
                    context.log(`arkiv: kunne ikke hente samtale for ${id} — ${e.message}`);
                    throw new Error(`Samtalen for skjema ${id} kunne ikke leses. Arkivet ble ikke laget.`);
                }
                if (!medVedlegg) continue;
                try {
                    const filer = await vedleggStorage.listVedlegg(skjematypeId, id);
                    const ut = [];
                    for (const f of filer) {
                        const strom = await vedleggStorage.hentVedleggStream(skjematypeId, id, f.filnavn);
                        if (strom?.buffer) ut.push({ filnavn: f.filnavn, innhold: strom.buffer.toString('base64') });
                    }
                    if (ut.length > 0) vedlegg[id] = ut;
                } catch (e) {
                    context.log(`arkiv: kunne ikke hente vedlegg for ${id} — ${e.message}`);
                    throw new Error(`Vedlegg for skjema ${id} kunne ikke leses. Arkivet ble ikke laget.`);
                }
            }

            const arkiv = byggArkiv({
                skjematype, skjemaer, samtaler, vedlegg,
                foerDato, arkivertAv: a.upn
            });
            await arkivStorage.lagre(arkiv.Manifest, skjemaer.map(s => s.Skjema_id));

            context.log(`arkiv: ${a.upn} eksporterte ${skjemaer.length} skjema fra ${skjematypeId} (${arkiv.Manifest.ArkivId})`);
            try {
                await hendelser.logg({
                    Type: 'arkiv.eksportert', Aktor: a.upn,
                    ObjektType: 'skjematype', ObjektId: String(skjematypeId),
                    Melding: `${skjemaer.length} skjema eksportert til arkiv ${arkiv.Manifest.ArkivId}`
                });
            } catch (_) { /* logging skal ikke velte eksporten */ }

            return { jsonBody: arkiv };
        } catch (e) {
            context.log('arkiv-eksport FEIL:', e.message);
            return avvis(500, e.message || 'Kunne ikke lage arkivet');
        }
    }
});

app.http('arkivSlett', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'arkiv/{skjematypeId}/slett',
    handler: async (request, context) => {
        const a = await kreverAdmin(request);
        if (a.svar) return a.svar;
        try {
            const { skjematypeId } = request.params;
            const body = await request.json().catch(() => ({}));
            const arkivId = String(body?.arkivId || '');
            const oppgittSjekksum = String(body?.sjekksum || '');

            const manifest = await arkivStorage.hent(skjematypeId, arkivId);
            if (!manifest) return avvis(404, 'Fant ikke arkivet');
            if (manifest.Slettet) return avvis(409, `Dette arkivet ble tømt ${manifest.Slettet}`);

            const v = verifiser(manifest, oppgittSjekksum, manifest.SkjemaIder);
            if (!v.ok) return avvis(400, v.grunn);

            let slettet = 0, feilet = 0;
            for (const id of manifest.SkjemaIder) {
                try {
                    // Rekkefølgen er bevisst: vedlegg og samtale først, raden
                    // sist. Ryker noe underveis, står saken igjen med en rad
                    // som fortsatt peker på det som er igjen — i stedet for
                    // foreldreløse filer uten noe som viser til dem.
                    if (manifest.MedVedlegg) {
                        await vedleggStorage.slettAlleVedleggForSkjema(skjematypeId, id);
                    }
                    await samtaleStorage.slettForSak(skjematypeId, id);
                    await forekomstStorage.slettSkjema(id, skjematypeId);
                    slettet++;
                } catch (e) {
                    feilet++;
                    context.log(`arkiv-slett: skjema ${id} feilet — ${e.message}`);
                }
            }

            await arkivStorage.merkSlettet(skjematypeId, arkivId, slettet);
            context.log(`arkiv: ${a.upn} slettet ${slettet} skjema fra ${skjematypeId} (${arkivId}), ${feilet} feilet`);
            try {
                await hendelser.logg({
                    Type: 'arkiv.slettet', Aktor: a.upn,
                    ObjektType: 'skjematype', ObjektId: String(skjematypeId),
                    Melding: `${slettet} skjema slettet (${feilet} feilet), arkiv ${arkivId}`
                });
            } catch (_) { /* logging skal ikke velte slettingen */ }

            return { jsonBody: { status: 'ok', slettet, feilet, medVedlegg: manifest.MedVedlegg } };
        } catch (e) {
            context.log('arkiv-slett FEIL:', e.message);
            return avvis(500, 'Kunne ikke slette');
        }
    }
});
