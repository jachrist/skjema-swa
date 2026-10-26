/**
 * feltperson.js — «behandleren er den innsenderen oppga».
 *
 * En personoppføring kan være en feltreferanse i stedet for en adresse:
 *
 *     "{2-01}"                       posisjonell referanse
 *     "{3f7a1c2e-...}"               referanse via felt-Id
 *
 * Den slås opp mot svaret i skjemaet og blir til en konkret e-postadresse.
 * Brukes tre steder — behandlingssteg (`steg.Personer`), ferdigvarsling og
 * kvitteringskopi (`Mottakere.Personer` / `Kopi.Personer`).
 *
 * Tre valg er verdt å begrunne, fordi de alle kunne vært tatt motsatt:
 *
 * **Hele oppføringen må være referansen.** "{2-01}" er lov, "sjef-{2-01}@x.no"
 * er det ikke. En rolle er en streng der referansen er ett ledd av omfanget;
 * en e-postadresse er én verdi. Å tillate innfletting her ville gitt en
 * adresse satt sammen av et svar vi ikke kontrollerer — og den hadde vi sendt
 * saksdokumenter til.
 *
 * **Feltet må gi en KONTROLLERT adresse.** To veier gir den garantien, og
 * ingen tredje:
 *
 *   1. Felttypen **E-post**. Den har syntakssjekk ved utfylling, så verdien er
 *      kontrollert før den når oss.
 *   2. Et **flervalgsfelt som henter valgene fra en persondatakilde**
 *      (`Personer`, `Studenter`). De returnerer `Verdi: <EP>` fra masterdata,
 *      og `felt-render.js` lagrer `Verdi`, ikke visningsteksten. Svaret ER
 *      altså adressen, og den er aldri skrevet for hånd — en strengere
 *      garanti enn syntakssjekken i punkt 1.
 *
 * Et Tekst-felt som *tilfeldigvis* inneholder en adresse avvises fortsatt, og
 * et flervalgsfelt med håndskrevne valg likeså: regelen skal være mulig å lese
 * av feltdefinisjonen alene, ikke av hva noen kan ha skrevet.
 *
 * Vei 2 kom til 26.10.2026. Uten den måtte en kadett som velger klassesjefen
 * sin fra en Studenter-nedtrekk ALLIKEVEL skrive adressen i et eget
 * E-post-felt — en adresse systemet allerede hadde, skrevet av hånd av den
 * som minst kjenner den.
 *
 * Konsekvens verdt å kjenne: E-post er ikke en flervalgstype, så én referanse
 * til et E-post-felt gir én mottaker. Et persondatakilde-felt ER en
 * flervalgstype, så der gir hvert valg sin egen mottaker — samme regel som
 * dynamiske roller allerede har.
 *
 * **Verdier som ikke ser ut som e-post forkastes likevel.** Typesjekken sier
 * at feltet SKAL være kontrollert; den sier ikke at raden i lagringen er det.
 * Importerte og eldre svar har ikke vært gjennom skjemaets validering.
 *
 * **En ubesvart referanse forkastes — malen beholdes IKKE.** Her skiller vi
 * lag med dynamisk-rolle.js, som beholder "Klassesjef({2-01})" når feltet er
 * tomt. En rollestreng som blir stående er inert: `hentInnehavere` finner
 * ingenting. En personoppføring som blir stående er verre enn inert:
 *   - `sikreBehandler` hopper over steget fordi `Personer.length > 0`, så
 *     reserverollen slår ikke inn,
 *   - `beregnAlleKrav` legger "{2-01}" inn som et krav ingen kan dekke, og et
 *     «alle må avgjøre»-steg blir stående for alltid.
 * Begge deler ser riktige ut i data og feiler stille i drift.
 *
 * Peker referansen på et flervalgsfelt, gir hvert valg sin egen mottaker —
 * samme regel som for dynamiske roller.
 */
const { finnFeltViaRef, finnFeltViaId, alleSvarIFelt, FLERVALGSTYPER } = require('./placeholder');

/** Hele oppføringen, ikke en del av den. Se toppkommentaren. */
const HEL_REFERANSE = /^\s*\{([^{}]+)\}\s*$/;
const POSISJONELL = /^(\d+)-(\d+)$/;

/**
 * Er dette en e-postadresse vi tør sende til?
 *
 * Bevisst strengere enn `auth.js:erEpostlignende` (`/\S+@\S+/`), som svarer på
 * et annet spørsmål: «ser denne claim-verdien ut som en adresse, altså ikke
 * som et navn». Her skal verdien faktisk brukes som mottaker, og et svar som
 * "ola@kontoret" eller "a@b, c@d" skal ikke slippe gjennom.
 */
const EPOST = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]{2,}$/;

/**
 * Felttypene en personreferanse kan peke på.
 *
 * Ett sted, og eksportert: diagnosen melder feil for alt annet, og
 * skjemaeditoren tilbyr bare disse i velgeren. Tre kopier av «hvilke typer er
 * lov» ville gitt en velger som tilbyr noe diagnosen underkjenner.
 */
const GYLDIGE_FELTTYPER = ['E-post'];

/**
 * Datakildene som gir `Verdi` = e-post/UPN fra masterdata.
 *
 * Lest ut av `lib/oppslag.js`: `_hentPersoner` (alle tre grenene) og
 * `_hentStudenter` setter `Verdi: <EP>`. De øvrige kildene gir noe annet —
 * `Roller` gir «Rolle(Omfang)», `Klasser` gir FS-nøkkelen, `Postnumre` gir
 * postnummeret — og et felt med dem ville gitt en «adresse» som ikke er en.
 *
 * Står her og ikke i oppslag.js fordi det er DENNE modulen som avgjør hva en
 * personreferanse får peke på. Editoren speiler lista, og
 * `frontend/test/feltperson-ui.test.js` krever at de er like.
 */
const PERSON_DATAKILDER = ['Personer', 'Studenter'];

/**
 * Datakilden til et felt, uansett hvilken form den har overlevd i.
 *
 * Tre former, og det er ikke valgfritt å kjenne alle tre:
 *   - `FasteData: { Datakilde: 'Studenter', ... }`  — skjematypen, slik
 *     editoren og diagnosen ser den
 *   - `FasteData: 'Studenter|Kolonne|=|Verdi'`      — den eldre pipe-formen,
 *     se `parseFasteData` i faste-data.js
 *   - `FasteData_kilde: 'Studenter'`                — det INNSENDTE skjemaet
 *
 * Den siste finnes fordi `settFasteDataISkjema` tømmer `FasteData` når den
 * har fylt `Valg` (ellers ville frontend fylt på nytt), og fordi `samleSvar`
 * sender et smalt felt tilbake: { Id, Nummer, Type, Svar, SvarTekst }. Uten
 * et eget merke ville datakilden vært borte nettopp der ekspansjonen leser.
 *
 * Én funksjon, ikke tre avlesninger: hadde editoren lest `FasteData` og
 * ekspansjonen `FasteData_kilde` hver for seg, ville velgeren tilbudt felter
 * ekspansjonen ikke kjente igjen.
 */
function datakildenTil(felt) {
    const fd = felt && felt.FasteData;
    if (fd && typeof fd === 'object' && !Array.isArray(fd)) {
        return String(fd.Datakilde || '').trim();
    }
    if (typeof fd === 'string' && fd.trim()) {
        return String(fd).split('|')[0].trim();
    }
    return String((felt && felt.FasteData_kilde) || '').trim();
}

/**
 * Kan dette feltet brukes som personreferanse? Se de to veiene øverst.
 *
 * Eksportert og brukt av diagnosen; editoren har en tvilling. Tre kopier av
 * «hvilke felter er lov» ville gitt en velger som tilbyr noe ekspansjonen
 * avviser — og den feilen ser man først når et varsel ikke kom fram.
 */
function erPersonfelt(felt) {
    const type = String((felt && felt.Type) || '');
    if (GYLDIGE_FELTTYPER.includes(type)) return true;
    return FLERVALGSTYPER.has(type) && PERSON_DATAKILDER.includes(datakildenTil(felt));
}

function erEpost(verdi) {
    return EPOST.test(String(verdi || '').trim());
}

/** Er personoppføringen en feltreferanse? */
function erFeltreferanse(person) {
    return HEL_REFERANSE.test(String(person || ''));
}

/** Referansen inni "{...}", eller '' hvis oppføringen ikke er en referanse. */
function referansen(person) {
    const m = HEL_REFERANSE.exec(String(person || ''));
    return m ? m[1].trim() : '';
}

/** Feltet referansen peker på, eller null. */
function feltFor(ref, seksjoner) {
    const m = POSISJONELL.exec(ref);
    return (m ? finnFeltViaRef(seksjoner, m[1], m[2]) : finnFeltViaId(seksjoner, ref)) || null;
}

/**
 * Løs én referanse mot svarene.
 *
 * Returnerer { eposter, mangler, feilType, ubesvart, ugyldige }. De fire
 * grunnene til at det ikke ble noen adresse holdes fra hverandre fordi
 * rettelsen er ulik for hver:
 *
 *   mangler   — feltet finnes ikke: skjematypen må rettes
 *   feilType  — feltet er ikke et E-post-felt: skjematypen må rettes
 *   ubesvart  — innsenderen fylte ikke ut feltet
 *   ugyldige  — feltet var utfylt, men verdien er ikke en adresse
 *
 * En samlet «ingen mottaker» ville sendt skjemaeier på leting i feil ende.
 */
function slaOppEposter(ref, seksjoner) {
    const felt = feltFor(String(ref || '').trim(), seksjoner || []);
    if (!felt) return { eposter: [], mangler: true, feilType: null, ubesvart: false, ugyldige: [] };

    const type = String(felt.Type || '');
    if (!erPersonfelt(felt)) {
        return { eposter: [], mangler: false, feilType: type || 'ukjent', ubesvart: false, ugyldige: [] };
    }

    const verdier = alleSvarIFelt(felt);
    if (verdier.length === 0) {
        return { eposter: [], mangler: false, feilType: null, ubesvart: true, ugyldige: [] };
    }

    const eposter = [];
    const ugyldige = [];
    for (const v of verdier) {
        const s = String(v || '').trim();
        if (!s) continue;
        if (!erEpost(s)) { ugyldige.push(s); continue; }
        const e = s.toLowerCase();
        if (!eposter.includes(e)) eposter.push(e);
    }
    return { eposter, mangler: false, feilType: null, ubesvart: false, ugyldige };
}

/**
 * Løs opp alle feltreferanser i en personliste.
 *
 * Returnerer { personer, uloste, ugyldige }. `personer` er lista slik den skal
 * brukes: konkrete adresser, med referansene byttet ut og de uløselige fjernet.
 * De to andre er til logging og hendelseslogg — de er grunnen til at en
 * mottaker mangler, og uten dem er «ingen fikk varsel» umulig å forklare.
 */
function ekspanderPersoner(personer, seksjoner) {
    const inn = Array.isArray(personer) ? personer : [];
    const ut = [];
    const uloste = [];
    const ugyldige = [];

    const leggTil = (e) => {
        const v = String(e || '').trim().toLowerCase();
        if (v && !ut.includes(v)) ut.push(v);
    };

    for (const p of inn) {
        if (!erFeltreferanse(p)) { leggTil(p); continue; }
        const ref = referansen(p);
        const { eposter, mangler, feilType, ubesvart, ugyldige: ug } = slaOppEposter(ref, seksjoner);
        if (mangler) { uloste.push({ mal: String(p), grunn: 'feltet finnes ikke' }); continue; }
        if (feilType) {
            uloste.push({ mal: String(p), grunn: `feltet er av typen «${feilType}», ikke E-post` });
            continue;
        }
        if (ubesvart) { uloste.push({ mal: String(p), grunn: 'ubesvart' }); continue; }
        for (const u of ug) ugyldige.push({ mal: String(p), verdi: u });
        if (eposter.length === 0 && ug.length > 0) {
            uloste.push({ mal: String(p), grunn: 'ingen gyldig e-postadresse' });
            continue;
        }
        for (const e of eposter) leggTil(e);
    }

    return { personer: ut, uloste, ugyldige };
}

/**
 * Frys personreferansene i behandlingsstegene. Endrer skjemaet in-place.
 *
 * Kjøres ved innsending, av samme grunn som dynamisk-rolle.js: på skjematyper
 * med Krypteres=Svar/Alt ligger svaret som chiffertekst når tilgangssjekken
 * kjører, og et oppslag i ettertid ville ikke funnet adressen. Malen tas vare
 * på i `steg.PersonerMal`, så ompuss + ny innsending ekspanderer på nytt fra
 * malen og ikke fra forrige resultat.
 *
 * Returnerer array av { steg, mal, personer, uloste, ugyldige } for de stegene
 * som faktisk hadde en referanse.
 */
function ekspanderBehandlingPersoner(skjema) {
    const seksjoner = skjema?.Seksjoner || [];
    const endret = [];

    for (const steg of (skjema?.Behandling || [])) {
        const maler = Array.isArray(steg.PersonerMal) && steg.PersonerMal.length > 0
            ? steg.PersonerMal
            : (Array.isArray(steg.Personer) ? steg.Personer : []);
        if (!maler.some(erFeltreferanse)) continue;

        steg.PersonerMal = [...maler];
        const { personer, uloste, ugyldige } = ekspanderPersoner(maler, seksjoner);
        steg.Personer = personer;
        endret.push({
            steg: steg.Steg,
            mal: maler.filter(erFeltreferanse),
            personer,
            uloste,
            ugyldige
        });
    }

    return endret;
}

module.exports = {
    GYLDIGE_FELTTYPER,
    PERSON_DATAKILDER,
    datakildenTil,
    erPersonfelt,
    erEpost,
    erFeltreferanse,
    referansen,
    slaOppEposter,
    ekspanderPersoner,
    ekspanderBehandlingPersoner
};
