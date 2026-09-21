/**
 * Hvor mange ganger kan én person svare på en skjematype?
 *
 * Bakgrunnen er avstemninger: valg til høgskolestyret, studentvalg og
 * lignende, der «ett svar per person» ER regelen og ikke en detalj. Uten den
 * kan samme bruker sende inn så mange ganger hen vil, og resultatet er
 * verdiløst.
 *
 * Innstillingen ligger på skjematypen som `MaksSvarPerBruker`. 0 eller
 * fraværende betyr ubegrenset — det er standarden, og det er et bevisst valg:
 * skjematypene som alt ligger i produksjon skal ikke begrenses fordi vi rullet
 * ut en ny funksjon.
 *
 * ANONYMISERING. En avstemning vil som regel ha `Anonymiseres` på, og da
 * skrives innsenderen om til et pseudonym ved lagring. Det ville normalt gjort
 * tellingen umulig — men pseudonymet er deterministisk
 * (`kryptering.pseudonymFor`): samme person gir samme verdi, hver gang. Derfor
 * teller vi på BEGGE identitetene, den åpne og den anonymiserte. En anonym
 * avstemning kan altså fortsatt være begrenset til én stemme per person, og
 * uten at noen kan lese hvem som stemte hva.
 *
 * MELLOMLAGRING TELLER IKKE. Et utkast er ikke et svar. Teller det, ville en
 * person som begynte å fylle ut og ombestemte seg vært utestengt fra sin egen
 * eneste stemme.
 *
 * GRENSEN GJELDER ALLE, også eiere og administratorer. En eier som stemmer er
 * også én person. Skal du teste flere innsendinger, bruk en testbruker.
 */
const { pseudonymFor } = require('./kryptering');

/** Over dette er tallet åpenbart en skrivefeil, ikke en grense. */
const MAKS_GRENSE = 1000;

/**
 * Grensen som gjelder for denne skjematypen. 0 = ubegrenset.
 *
 * Alt som ikke er et positivt heltall leses som «ingen grense». Et ugyldig
 * tall skal ikke kunne stenge et skjema ved et uhell — feilen skal falle mot
 * å slippe folk inn, ikke mot å stenge dem ute.
 */
function grenseFor(skjematype) {
    const n = Number(skjematype?.MaksSvarPerBruker);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(Math.floor(n), MAKS_GRENSE);
}

/**
 * Identitetene denne personen kan være lagret under.
 *
 * Den åpne (UPN eller e-post fra OTP/utsending) og den anonymiserte. Begge må
 * telles: et svar avgitt før anonymiseringen slo inn ligger under den første,
 * et ferdigbehandlet anonymisert svar under den andre.
 */
function identiteterFor(innsenderId, salt) {
    const aapen = String(innsenderId || '').trim().toLowerCase();
    if (!aapen) return [];
    const ut = [aapen];
    const pseudonym = pseudonymFor(aapen, salt);
    if (pseudonym && pseudonym !== aapen) ut.push(pseudonym);
    return ut;
}

/**
 * Er dette et innlegg som skal telles mot grensen?
 *
 * Bare overgangen fra «ikke innsendt» til «innsendt». En oppdatering av et
 * skjema som ALLEREDE er sendt inn — en behandler som registrerer en
 * beslutning, en revidering — er ikke et nytt svar, og skal ikke kunne bli
 * avvist av en grense personen ikke har brutt.
 *
 * Status 1 er mellomlagret. Alt fra 2 og opp er sendt inn.
 */
function erNyInnsending({ nyStatus, gammelStatus = 0 }) {
    return Number(nyStatus || 0) >= 2 && Number(gammelStatus || 0) < 2;
}

/**
 * Skal denne lagringen i det hele tatt prøves mot grensen?
 *
 * Både at det finnes en grense, og at dette er en ny innsending. Den står som
 * en egen funksjon og ikke som et `if` i endepunktet med vilje: et vilkår
 * inne i en handler kan byttes ut med `if (false)` uten at noen test merker
 * det — kallene rundt står jo fortsatt der. Som navngitt regel kan den prøves
 * direkte, og endepunktet må bruke svaret for å komme til sperren.
 *
 * Den koster også et oppslag mot tabellen når den svarer ja, så den skal
 * svare nei for alt som ikke er en ny innsending.
 */
function maaSjekkes({ grense, nyStatus, gammelStatus }) {
    return Number(grense || 0) > 0 && erNyInnsending({ nyStatus, gammelStatus });
}

/**
 * Teller denne tabellraden mot grensen?
 *
 * Ligger her og ikke inne i spørringen, fordi det er en REGEL og ikke
 * plumbing: at utkast ikke teller, og at raden man selv holder på med ikke
 * teller seg selv, er nettopp det som må kunne prøves uten en lagringskonto.
 *
 * Tar imot både tabellformen (`rowKey`, `Skjemastatus`) og skjemaformen
 * (`Skjema_id`, `Skjema_status`), så den kan brukes på begge sider.
 */
function radTellerMot(rad, unntattSkjemaId = null) {
    if (!rad) return false;
    const id = String(rad.rowKey ?? rad.RowKey ?? rad.Skjema_id ?? '');
    if (unntattSkjemaId && id === String(unntattSkjemaId)) return false;
    // Status 1 er mellomlagret. Alt fra 2 og opp er sendt inn.
    return Number(rad.Skjemastatus ?? rad.Skjema_status ?? 0) >= 2;
}

/**
 * Kan personen sende inn, gitt hvor mange hen har fra før?
 *
 * Returnerer et objekt og ikke en boolsk verdi, fordi kalleren trenger å si
 * noe forståelig til brukeren. «Du har allerede svart» er et annet budskap enn
 * «du har brukt 3 av 3 svar».
 */
function sjekkGrense({ grense, antallSvar }) {
    const g = Number(grense || 0);
    const brukt = Number(antallSvar || 0);
    if (g <= 0) return { ok: true, grense: 0, brukt, gjenstaaende: null };
    const gjenstaaende = Math.max(0, g - brukt);
    if (gjenstaaende > 0) return { ok: true, grense: g, brukt, gjenstaaende };
    return {
        ok: false, grense: g, brukt, gjenstaaende: 0,
        melding: g === 1
            ? 'Du har allerede svart på dette skjemaet. Det kan bare besvares én gang.'
            : `Du har brukt alle dine ${g} svar på dette skjemaet.`
    };
}

module.exports = {
    grenseFor, identiteterFor, erNyInnsending, maaSjekkes, radTellerMot, sjekkGrense, MAKS_GRENSE
};
