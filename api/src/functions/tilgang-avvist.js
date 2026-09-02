/**
 * Logg et avvist tilgangsforsøk.
 *
 *   POST /api/tilgang-avvist   Body: { sti }
 *
 * Kalles fra ingen-tilgang.html når en innlogget bruker blir avvist av SWA på
 * en rollestyrt rute. SWA blokkerer før forespørselen når API-et vårt, så
 * dette er den eneste måten forsøket kan bli synlig i Hendelser.
 *
 * Aktøren stemples fra x-ms-client-principal på serversiden — klienten kan
 * ikke oppgi hvem den er. Stien tas fra klienten, men kappes og lagres som
 * ren tekst; den er et hint om hva noen prøvde, ikke bevis.
 *
 * Endepunktet ligger bak «authenticated» i ruteoppsettet. Det er riktig nivå:
 * en anonym besøkende blir sendt til innlogging (401) og havner aldri på
 * ingen-tilgang-siden, så det finnes ingen grunn til å slippe dem inn her.
 */
const { app } = require('@azure/functions');
const { hentInnloggetUpn } = require('../lib/auth');
const hendelser = require('../lib/hendelser-storage');

/** Kort, ufarlig representasjon av stien brukeren forsøkte seg på. */
function reinsk(sti) {
    return String(sti || '')
        .replace(/[\r\n\t]/g, ' ')
        .trim()
        .substring(0, 200);
}

app.http('tilgangAvvist', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'tilgang-avvist',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };

        try {
            const body = await request.json().catch(() => ({}));
            const sti = reinsk(body?.sti);

            hendelser.logg({
                Type: 'tilgang.avvist',
                Aktor: upn,
                ObjektType: 'side', ObjektId: sti,
                Melding: `Avvist tilgang til ${sti || '(ukjent side)'}`
            });
            context.log(`tilgang-avvist: ${upn} → ${sti}`);

            // Svaret sier ingenting om hva som ble logget. Siden som kaller
            // dette skal ikke kunne brukes til å utforske noe som helst.
            return { jsonBody: { status: 'ok' } };
        } catch (e) {
            context.log('tilgang-avvist FEIL:', e.message);
            return { jsonBody: { status: 'ok' } };
        }
    }
});

module.exports = { _reinsk: reinsk };
