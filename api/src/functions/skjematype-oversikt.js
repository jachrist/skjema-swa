/**
 * GET /api/skjematype-oversikt[?format=excel]
 *
 * Én rad per skjematype: eiere, fase, antall skjemaer og siste aktivitet.
 * Til administrasjonssiden.
 *
 * `format=excel` gir den SAMME sammenstillingen som regneark, bygget av
 * samme `byggOversikt`-kall. Det er hele poenget med å legge eksporten her og
 * ikke i nettleseren: en eksport bygget av det tabellen tilfeldigvis hadde
 * tegnet, ville sluttet å stemme den dagen visningen filtrerer noe bort.
 *
 * Bare for admin. Oversikten viser eierskap og bruksmengde på tvers av hele
 * installasjonen, og det er ikke noe en vanlig skjemaeier skal kunne lese ut.
 *
 * Kostnaden er én gjennomgang av Skjemaer-tabellen med `select` på fire
 * felter. Alternativet — én spørring per skjematype — er like mange rader
 * lest, men én rundtur per type.
 */
const { app } = require('@azure/functions');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');
const skjemaStorage = require('../lib/skjema-storage');
const forekomstStorage = require('../lib/skjema-forekomst-storage');
const { byggOversikt, tilEksportRader } = require('../lib/skjematype-oversikt');
const { genererExcel } = require('../lib/datauttrekk');

app.http('skjematypeOversikt', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'skjematype-oversikt',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        if (!erAdmin(upn)) {
            return { status: 403, jsonBody: { status: 'avvist', melding: 'Kun for administratorer' } };
        }
        try {
            const [skjematyper, antall] = await Promise.all([
                skjemaStorage.hentAlleSkjematyper(),
                forekomstStorage.hentAntallPerType()
            ]);
            const rader = byggOversikt(skjematyper, antall);

            if (String(request.query.get('format') || '').toLowerCase() === 'excel') {
                // Samme generator som datauttrekket. Den kan auto-kolonnebredde
                // og tom-tilfellet fra før, og en kopi her ville vært en kopi
                // til å vedlikeholde.
                const fil = genererExcel(tilEksportRader(rader), 'Skjematyper');
                return { jsonBody: fil };
            }

            return {
                jsonBody: {
                    rader,
                    // Summen er med fordi den er det første man ser etter, og
                    // fordi den avslører om noe mangler: stemmer den ikke med
                    // det man vet om installasjonen, er det raden man leter
                    // etter som ikke kom med.
                    sum: {
                        Skjematyper: rader.length,
                        Utfylte: rader.reduce((n, r) => n + r.Utfylte, 0),
                        Mellomlagret: rader.reduce((n, r) => n + r.Mellomlagret, 0),
                        Totalt: rader.reduce((n, r) => n + r.Totalt, 0)
                    }
                }
            };
        } catch (e) {
            context.log('skjematype-oversikt FEIL:', e.message);
            return { status: 500, jsonBody: { status: 'feil', melding: 'Kunne ikke bygge oversikten' } };
        }
    }
});
