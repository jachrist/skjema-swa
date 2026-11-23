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
const { byggKoblinger } = require('../lib/m365-koblinger');
const { lesAvslatte, kandidater, GRENSE_DAGER } = require('../lib/ubrukt-varsel');
const { genererExcel } = require('../lib/datauttrekk');

/**
 * Merk koblingene med om skjematypen regnes som ubrukt — med JOBBENS regel
 * (`kandidater` i lib/ubrukt-varsel.js), ikke en egen. Panelet viser «kan
 * ryddes» ut fra dette, og skal svare det samme som varselet gjør.
 *
 * Avkrysningen er ikke med her: en skjematype med varselet av er like ubrukt.
 */
function merkUbrukte(koblinger, skjematyper, rader) {
    const ubrukte = new Set(kandidater(skjematyper, rader, new Set()).map(k => k.id));
    for (const rad of koblinger) {
        for (const s of rad.Skjematyper) s.Ubrukt = ubrukte.has(String(s.Skjematype_id));
        rad.KanRyddes = rad.Skjematyper.every(s => s.Ubrukt);
    }
    return koblinger;
}

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
            const [skjematyper, antall, varselAv] = await Promise.all([
                skjemaStorage.hentAlleSkjematyper(),
                forekomstStorage.hentAntallPerType(),
                lesAvslatte()
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
                    // M365-koblingene: hvilke team og områder skjematypene
                    // skriver til, med siste aktivitet fra radene over — samme
                    // tall, ikke en ny opptelling. Se lib/m365-koblinger.js.
                    koblinger: merkUbrukte(byggKoblinger(skjematyper, rader, varselAv), skjematyper, rader),
                    ubruktGrenseDager: GRENSE_DAGER,
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
