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
 * **Verdier som ikke ser ut som e-post forkastes.** Peker referansen på feil
 * felt, får vi "Ja" eller "MILM23-1" som behandler. Da kan ingen behandle
 * steget, og ingen får beskjed om hvorfor — akkurat den stille varianten.
 * Bedre å droppe den og si fra i loggen.
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
const { finnAlleSvarForFeltRef, finnAlleSvarForFeltViaId } = require('./placeholder');

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

function slaOppSvar(ref, seksjoner) {
    const m = POSISJONELL.exec(ref);
    return m
        ? finnAlleSvarForFeltRef(seksjoner, m[1], m[2])
        : finnAlleSvarForFeltViaId(seksjoner, ref);
}

/**
 * Løs én referanse mot svarene.
 *
 * Returnerer { eposter, ubesvart, ugyldige }. `ubesvart` og `ugyldige` er
 * skilt fra hverandre fordi rettelsen er ulik: den ene betyr «innsenderen
 * fylte ikke ut feltet», den andre «skjematypen peker på feil felt».
 */
function slaOppEposter(ref, seksjoner) {
    const verdier = slaOppSvar(String(ref || '').trim(), seksjoner || []);
    if (verdier.length === 0) return { eposter: [], ubesvart: true, ugyldige: [] };

    const eposter = [];
    const ugyldige = [];
    for (const v of verdier) {
        const s = String(v || '').trim();
        if (!s) continue;
        if (!erEpost(s)) { ugyldige.push(s); continue; }
        const e = s.toLowerCase();
        if (!eposter.includes(e)) eposter.push(e);
    }
    return { eposter, ubesvart: false, ugyldige };
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
        const { eposter, ubesvart, ugyldige: ug } = slaOppEposter(ref, seksjoner);
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
    erEpost,
    erFeltreferanse,
    referansen,
    slaOppEposter,
    ekspanderPersoner,
    ekspanderBehandlingPersoner
};
