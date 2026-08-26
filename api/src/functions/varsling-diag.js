/**
 * GET /api/varsling/diag
 *
 * Diagnose for varsling-oppsett. Krever admin.
 * Viser hva base_url + eksempellenke ville blitt for et gitt skjema.
 */
const { app } = require('@azure/functions');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');
const { baseUrl } = require('../lib/flyt-kaller');
const skjemaStorage = require('../lib/skjema-storage');
const forekomstStorage = require('../lib/skjema-forekomst-storage');
const varsling = require('../lib/varsling');
const { alleStegFerdig, stegErFerdig, beregnAktiveSteg, beregnAlleKrav } = require('../lib/behandling');
const { lagTilgangsCache } = require('../lib/tilgang');

app.http('varslingDiag', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'varsling/diag',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn || !erAdmin(upn)) {
            return { status: 403, jsonBody: { status: 'avvist', melding: 'Krever admin' } };
        }
        const base = baseUrl(request);
        return {
            jsonBody: {
                SWA_URL_env: process.env.SWA_URL || null,
                base_url_utledet: base,
                x_forwarded_host: request.headers.get('x-forwarded-host') || null,
                x_forwarded_proto: request.headers.get('x-forwarded-proto') || null,
                host: request.headers.get('host') || null,
                VARSLING_FLOW_URL_satt: !!process.env.VARSLING_FLOW_URL,
                VARSLING_DEAKTIVERT: process.env.VARSLING_DEAKTIVERT || null,
                eksempel_lenke: base ? `${base}/evaluering.html?skjematype_id=108&skjema_id=1` : '(base_url tom!)'
            }
        };
    }
});

/**
 * GET /api/varsling/diag/{skjematypeId}/{skjemaId}
 *
 * Tørrkjøring av ferdigvarslingen for ett konkret skjema. Sender ingenting.
 *
 * Svarer på de tre spørsmålene som ellers ikke er mulige å skille fra
 * hverandre når det ikke kom noen e-post:
 *   1. Er skjemaet i det hele tatt ferdig behandlet? Et steg med
 *      «alle må avgjøre» er ikke ferdig før én per rolle har svart.
 *   2. Er Ferdigvarsling slått på for skjematypen?
 *   3. Løser mottakerrollene seg opp til noen som faktisk finnes i rollelista?
 */
app.http('varslingDiagSkjema', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'varsling/diag/{skjematypeId}/{skjemaId}',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn || !erAdmin(upn)) {
            return { status: 403, jsonBody: { status: 'avvist', melding: 'Krever admin' } };
        }
        try {
            const { skjematypeId, skjemaId } = request.params;
            const skjema = await forekomstStorage.hentSkjema(skjemaId, skjematypeId);
            if (!skjema) return { status: 404, jsonBody: { status: 'feil', melding: 'Skjema ikke funnet' } };

            const st = await skjemaStorage.hentSkjematype(skjematypeId);
            const skjematype = st?.JSON || {};
            const logg = [];
            const log = (m) => logg.push(m);

            // 1. Er skjemaet ferdig?
            const behandling = skjema.Behandling || [];
            const cache = lagTilgangsCache();
            const steg = [];
            for (const s of behandling) {
                const rad = {
                    steg: s.Steg,
                    stegnavn: s.Stegnavn || '',
                    beslutning: Number(s.Beslutning || 0),
                    ferdig: stegErFerdig(s),
                    alleMaaAvgjore: s.Beslutning_alle === true,
                    roller: s.Roller || [],
                    personer: s.Personer || [],
                    avgitteBeslutninger: (s.Beslutninger || []).map(b => b.Aktor)
                };
                if (s.Beslutning_alle === true && !rad.ferdig) {
                    const k = await beregnAlleKrav(s, cache);
                    rad.krav = k.krav;
                    rad.venterPaa = k.gjenstar;
                }
                steg.push(rad);
            }

            // 2. og 3. Ferdigvarslingen — oppsett og oppløste mottakere.
            const fv = skjematype.Ferdigvarsling || null;
            const ferdigMottakere = fv?.Mottakere
                ? await varsling.løsMottakere(fv.Mottakere, skjema, log)
                : [];
            const ferdigForklaring = fv?.Mottakere ? await varsling.forklarMottakere(fv.Mottakere, skjema) : null;
            const kopiOppsett = skjematype.Innsenderkvittering?.Kopi || null;
            const kopiMottakere = kopiOppsett
                ? await varsling.løsMottakere(kopiOppsett, skjema, log)
                : [];
            const kopiForklaring = kopiOppsett ? await varsling.forklarMottakere(kopiOppsett, skjema) : null;

            const alleFerdig = alleStegFerdig(skjema);
            const aktive = beregnAktiveSteg(skjema);

            return {
                jsonBody: {
                    skjema: {
                        Skjema_id: skjema.Skjema_id,
                        Skjematype_id: skjema.Skjematype_id,
                        Skjema_status: skjema.Skjema_status,
                        alleStegFerdig: alleFerdig,
                        aktiveSteg: aktive.map(s => ({ steg: s.Steg, stegnavn: s.Stegnavn || '' })),
                        steg
                    },
                    ferdigvarsling: {
                        konfigurert: !!fv,
                        aktiv: fv?.Aktiv === true,
                        mottakerOppsett: fv?.Mottakere || null,
                        oppløsteMottakere: ferdigMottakere,
                        forklaring: ferdigForklaring,
                        villeSendt: alleFerdig && fv?.Aktiv === true && ferdigMottakere.length > 0
                    },
                    kvitteringKopi: {
                        konfigurert: !!kopiOppsett,
                        mottakerOppsett: kopiOppsett,
                        oppløsteMottakere: kopiMottakere,
                        forklaring: kopiForklaring
                    },
                    logg
                }
            };
        } catch (e) {
            context.log('varsling/diag/skjema FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});
