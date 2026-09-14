/**
 * GET  /api/hendelser — audit-logg (admin only).
 *   Query-params: antall, fraDato, tilDato, type, aktor, objektId
 *
 * POST /api/hendelser/logg — skriv en infomelding i loggen.
 *   Auth: x-flow-key (FLOW_CALLBACK_KEY) eller admin.
 *   Body: { melding, type?, objektId?, detaljer? }
 *
 *   Egen sti, ikke POST på /api/hendelser. En ruteregel i
 *   staticwebapp.config kan skille på metode, men den muligheten er ikke i
 *   bruk her fra før — og en ugyldig config forkastes SOM HELHET, slik at
 *   ingen regler gjelder og innlogging faller tilbake til /common/. Prisen
 *   for en egen sti er ingenting; prisen for å ta feil er alt.
 *
 *   For flytene, som ellers ikke har noe sted å si fra om hva de gjorde.
 *   Kjørehistorikken i Power Automate viser bare flytens egen side av saken,
 *   og den er hverken søkbar sammen med resten eller tilgjengelig for den som
 *   sitter i admin-panelet.
 */
const { app } = require('@azure/functions');
const { hentInnloggetUpn, erAdmin, harFlytNokkel } = require('../lib/auth');
const hendelserStorage = require('../lib/hendelser-storage');

/** Meldinga kuttes her. Table Storage tåler mer, men en logglinje skal leses. */
const MELDING_MAKS = 2000;

app.http('hentHendelser', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'hendelser',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        if (!erAdmin(upn)) return { status: 403, jsonBody: { status: 'feil', melding: 'Krever admin-rolle' } };

        try {
            const url = new URL(request.url);
            const opts = {
                antall: url.searchParams.get('antall'),
                fraDato: url.searchParams.get('fraDato'),
                tilDato: url.searchParams.get('tilDato'),
                type: url.searchParams.get('type'),
                aktor: url.searchParams.get('aktor'),
                objektId: url.searchParams.get('objektId')
            };
            const liste = await hendelserStorage.hentSiste(opts);
            return { jsonBody: liste };
        } catch (e) {
            context.log('hendelser GET FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('skrivHendelse', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'hendelser/logg',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        const flyt = harFlytNokkel(request);
        if (!flyt.ok && !(upn && erAdmin(upn))) {
            return {
                status: 401,
                jsonBody: {
                    status: 'feil',
                    melding: `Krever gyldig x-flow-key eller admin. Flyt-nøkkel: ${flyt.grunn}`
                }
            };
        }

        try {
            const body = await request.json().catch(() => ({}));
            const melding = String(body?.melding || '').trim().slice(0, MELDING_MAKS);
            if (!melding) {
                return { status: 400, jsonBody: { status: 'feil', melding: 'Forventet { melding: string }' } };
            }

            const hendelse = {
                Type: hendelserStorage.flytType(body?.type),
                // En innlogget admin står som seg selv; en flyt som «flyt».
                // Nøkkelen er delt, så den identifiserer ingen enkelt flyt.
                Aktor: (upn && erAdmin(upn)) ? upn : 'flyt',
                ObjektType: 'flyt',
                ObjektId: String(body?.objektId || '').trim().slice(0, 200),
                Melding: melding,
                Detaljer: {
                    miljø: process.env.MILJO || 'ukjent',
                    ...(body?.detaljer && typeof body.detaljer === 'object' ? body.detaljer : {})
                }
            };

            // Begge steder med vilje: Hendelser-tabellen er den som er søkbar
            // og synlig i admin, funksjonsloggen den som har tidsoppløsningen
            // når noe skal spores minutt for minutt.
            context.log(`hendelser/logg [${hendelse.Type}] ${melding}`);
            await hendelserStorage.logg(hendelse);

            return { jsonBody: { status: 'ok', type: hendelse.Type, tid: new Date().toISOString() } };
        } catch (e) {
            context.log('hendelser/logg FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});
