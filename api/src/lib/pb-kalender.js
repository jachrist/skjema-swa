/**
 * Power BI-koblinger inn i nøkkelkalenderen.
 *
 * Tokenet bak en Power BI-rapport varer i 365 dager. Når det går ut, feiler
 * oppdateringen med 403 og Power BI deaktiverer oppdateringsplanen — for noen
 * som sannsynligvis ikke var med da koblingen ble satt opp. Ingenting varslet
 * om det før 23.09.2026.
 *
 * Tokenene settes IKKE inn som rader i Nokkelkalender-tabellen. To grunner:
 *
 *   De opprettes av skjemaeiere, når som helst, uten at noen administrerer
 *   kalenderen. En manuelt vedlikeholdt rad ville manglet for nettopp de
 *   koblingene ingen husket.
 *
 *   Utløpet ligger allerede i `ExpiresUTC` på tokenraden. Kalenderens datoer
 *   føres for hånd fordi vi ikke kan spørre Key Vault; her trengs det ikke, og
 *   en kopi kunne kommet ut av takt med virkeligheten. Samme resonnement som
 *   for SAS-strenger, som leser sin egen `se=`.
 *
 * I stedet formes de som kalenderrader ved varsling. Da gjelder ÉN
 * eskaleringsregel — `nokkelkalender-storage.skalVarsles` — for begge slag, og
 * de havner i samme e-post. To regler for «når skal vi mase» ville før eller
 * siden gitt to ulike svar.
 *
 * Mottakeren er admin, ikke rapporteier. Rapportene forvaltes av eierne av
 * skjematypen, men vi vet ikke hvem det er på utløpstidspunktet — eierskap
 * flytter seg. Admin videreformidler. Avklart med oppdragsgiver 23.09.2026.
 */
const { dagerTil, tilstand, VARSLE_DAGER_STANDARD } = require('./nokkelkalender-storage');

/** Radene er syntetiske. Prefikset gjør dem hørbare i logg og hendelseslogg. */
const ID_PREFIKS = 'pb-token:';

function erPbRad(rad) {
    return String(rad?.Id || '').startsWith(ID_PREFIKS);
}

/**
 * Form tokenene som kalenderrader.
 *
 * `navnFor` slår opp skjematypenavnet. Den injiseres i stedet for å importeres,
 * dels for å kunne testes uten lagringskonto, dels fordi et oppslag som feiler
 * ikke skal stoppe varselet — da står ID-en der i stedet, og admin finner den
 * likevel.
 */
function somKalenderRader(tokens, { na = new Date(), navnFor = () => '' } = {}) {
    return (tokens || [])
        .filter(t => t && t.utloper)
        .map(t => {
            const navn = String(navnFor(t.skjematypeId) || '').trim();
            const hvem = navn ? `«${navn}»` : `skjematype ${t.skjematypeId || '?'}`;
            const dager = dagerTil(t.utloper, na);
            return {
                Id: `${ID_PREFIKS}${t.upn}:${t.guid}`,
                Navn: `Power BI-kobling — ${hvem}`,
                Type: 'token',
                Hvor: `Datauttrekk → ${hvem}. Utstedt til ${t.upn}.`,
                Konsekvens: 'Power BI-oppdateringen feiler med 403, og oppdateringsplanen '
                    + 'blir deaktivert. Rapporten viser gamle tall til noen griper inn.',
                Rotasjon: 'Skjemaeier lager ny kobling i Datauttrekk → «Lag eller forny '
                    + 'Power BI-kobling», bytter URL i Power BI Desktop, publiserer .pbix på '
                    + 'nytt og setter legitimasjonen (Anonym) i tjenesten igjen. '
                    + 'Se docs/POWER-BI.md.',
                UtloperFaktisk: t.utloper,
                DagerIgjen: dager,
                Tilstand: tilstand(dager, 'ja'),
                VarsleDagerFor: VARSLE_DAGER_STANDARD,
                Roteres: 'ja',
                SistVarslet: t.sistVarslet || '',
                SistVarsletTrinn: t.sistVarsletTrinn ?? null,
                // Beholdes så varslingen vet hvilken rad den skal merke av på.
                _pb: { upn: t.upn, guid: t.guid }
            };
        });
}

module.exports = { somKalenderRader, erPbRad, ID_PREFIKS };
