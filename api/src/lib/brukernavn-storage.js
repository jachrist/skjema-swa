/**
 * Brukernavn — UPN → visningsnavn.
 *
 * Tabellen finnes fordi navnet bare er å få tak i ETT sted.
 *
 * Static Web Apps sender claims fra id-tokenet til rollekilden
 * (`POST /api/roller-swa`) ved innlogging, men IKKE videre i
 * `x-ms-client-principal`-headeren API-et får på vanlige kall. Der står bare
 * `userDetails`, `userId` og `userRoles`. Verifisert på dev 16.09.2026:
 * `/api/whoami` svarte `"navn": null` med claims-lesingen på plass.
 *
 * Følgen er at innsendingen aldri selv kan se hva innsenderen heter. Navnet
 * fanges derfor ved innlogging og slås opp igjen når skjemaet lagres.
 *
 * Dette er en cache, ikke en kilde: den fylles på nytt neste gang brukeren
 * logger inn, og er med vilje holdt utenfor backup — på linje med
 * `Teammedlemskap`. Går den tapt, blir $innsender_navn e-postadressen til
 * folk har logget inn igjen. Ingen data går tapt.
 *
 * PK = 'Bruker', RK = UPN i små bokstaver
 * Egenskaper: Navn, SistSett
 */
// Modulobjekt, ikke destrukturert: tester bytter ut sikreTabell for å slippe
// en ekte lagringskonto. En destrukturert referanse ville pekt på den
// opprinnelige funksjonen og gjort stubben virkningsløs.
const storage = require('./storage');
const { hentInnloggetNavn } = require('./auth');

const TABELL = 'Brukernavn';
const PK = 'Bruker';

function nokkel(upn) {
    return String(upn || '').trim().toLowerCase();
}

/**
 * Lagre navnet for en UPN. Best-effort: returnerer false i stedet for å kaste.
 *
 * Kalleren er rollekilden, og den svarer på et kall som avgjør om brukeren får
 * admin-rollen. En feilende tabellskriving skal ikke kunne stenge noen ute av
 * administrasjonssidene — det ville vært å bytte et kosmetisk problem mot et
 * reelt.
 */
async function settNavn(upn, navn) {
    const rk = nokkel(upn);
    const verdi = String(navn || '').trim();
    if (!rk || !verdi) return false;
    try {
        const t = await storage.sikreTabell(TABELL);
        await t.upsertEntity({
            partitionKey: PK,
            rowKey: rk,
            Navn: verdi,
            SistSett: new Date().toISOString()
        }, 'Replace');
        return true;
    } catch (_) {
        return false;
    }
}

/** Navnet for en UPN, eller '' hvis vi ikke har sett brukeren logge inn. */
async function hentNavn(upn) {
    const rk = nokkel(upn);
    if (!rk) return '';
    try {
        const t = await storage.sikreTabell(TABELL);
        const e = await t.getEntity(PK, rk);
        return String(e.Navn || '');
    } catch (_) {
        // 404 er det vanlige: brukeren har ikke logget inn siden tabellen kom.
        // Alt annet er også «vi vet ikke» her, og skal ikke velte lagringen.
        return '';
    }
}

/**
 * Navnet på den som gjør dette kallet, med kilde.
 *
 * Claims går foran den lagrede verdien. Begynner SWA en dag å sende claims
 * videre til API-et, er det den ferskeste kilden — og da trengs ikke tabellen
 * lenger uten at noe må endres.
 *
 * `kilde` er med for diagnostikk: den skiller «navnet er ukjent fordi
 * brukeren ikke har logget inn på nytt» fra «navnet er ukjent fordi
 * innloggingen aldri ga oss noe».
 */
async function losNavn(request, upn) {
    const fraClaims = hentInnloggetNavn(request);
    if (fraClaims) return { navn: fraClaims, kilde: 'claims' };
    const lagret = await hentNavn(upn);
    if (lagret) return { navn: lagret, kilde: 'lagret' };
    return { navn: '', kilde: null };
}

module.exports = { settNavn, hentNavn, losNavn, TABELL };
