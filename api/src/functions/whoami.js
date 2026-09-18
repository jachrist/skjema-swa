/**
 * GET /api/whoami — returnerer basic info om innlogget bruker + admin-status.
 * Bruker kan lese denne uten å måtte kalle .auth/me OG sjekke admin separat.
 *
 * `serSkjemaoversikt` er avgjørelsen, ikke rollene: admin, skjemaskaper eller
 * eier av minst én skjematype. Sidene skal lese den ferdige avgjørelsen, ikke
 * sette sammen tre roller hver for seg.
 *
 * `navn` og `navnKilde` er med for å kunne se ETT sted hvor navnet kommer fra:
 *   'claims'  — SWA sender claims videre til API-et
 *   'lagret'  — fra Brukernavn-tabellen, fylt ved innlogging
 *   null      — ikke funnet noe sted, og da blir $innsender_navn
 *               e-postadressen. Logg inn på nytt hvis dette er uventet:
 *               tabellen fylles først ved neste innlogging.
 */
const { app } = require('@azure/functions');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');
const brukernavn = require('../lib/brukernavn-storage');
const rollerStorage = require('../lib/roller-storage');
const skjemaStorage = require('../lib/skjema-storage');
const { filtrerTyperPåTilgang } = require('../lib/tilgang');

app.http('whoami', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'whoami',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        const admin = erAdmin(upn);
        let navnFunn = { navn: '', kilde: null };
        try { navnFunn = await brukernavn.losNavn(request, upn); }
        catch (_) { /* best-effort */ }
        // Skjemaskaper: admin, eller medlem av rollen (uansett omfang)
        let kanOppretteSkjematype = admin;
        if (!kanOppretteSkjematype) {
            try { kanOppretteSkjematype = await rollerStorage.erMedlem('Skjemaskaper', upn); }
            catch (_) { /* best-effort */ }
        }

        // Skal denne brukeren se lenken til skjemaoversikten?
        //
        // Admin, skjemaskapere og eiere. En vanlig innsender kommer via en
        // lenke til én bestemt skjematype og skal videre til noe annet
        // etterpå; skjemavelgeren er arbeidsflaten til dem som forvalter
        // skjemaene. Eierskap er per skjematype, så det
        // finnes ikke noe globalt «er eier»-flagg å slå opp — vi må spørre om
        // hen eier NOEN av dem.
        //
        // Svaret er en avgjørelse, ikke en rolleliste. Klientene skal lese
        // «skal jeg vise lenken», ikke sette sammen tre roller hver for seg —
        // da ville reglene ligget i ti HTML-filer og kunne gli fra hverandre.
        //
        // Feiler oppslaget, svarer vi nei. En lenke for lite er en omvei; en
        // lenke for mye er en side brukeren ikke skulle sett.
        let serSkjemaoversikt = kanOppretteSkjematype;
        if (!serSkjemaoversikt) {
            try {
                const alle = await skjemaStorage.hentAlleSkjematyper();
                const eide = await filtrerTyperPåTilgang(alle, upn, 'Eiere');
                serSkjemaoversikt = eide.length > 0;
            } catch (_) { /* best-effort — nei er det trygge svaret */ }
        }
        return {
            jsonBody: {
                upn,
                navn: navnFunn.navn || null,
                navnKilde: navnFunn.kilde,
                erAdmin: admin,
                kanOppretteSkjematype,
                serSkjemaoversikt
            }
        };
    }
});
