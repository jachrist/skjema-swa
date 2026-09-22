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
 * **Bare felter av typen E-post er gyldige.** Den typen har syntakssjekk ved
 * utfylling, så verdien er kontrollert allerede før den når oss — ingen annen
 * felttype gir den garantien. Et Tekst-felt som *tilfeldigvis* inneholder en
 * adresse avvises altså også: regelen skal være mulig å lese av felttypen
 * alene, ikke av hva noen kan ha skrevet.
 *
 * Konsekvens verdt å kjenne: E-post er ikke en flervalgstype, så én referanse
 * gir én mottaker. Et flervalgsfelt med adresser kan ikke brukes til å sende
 * til flere — det er rollene som er verktøyet for det.
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
const { finnFeltViaRef, finnFeltViaId, alleSvarIFelt } = require('./placeholder');

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
    if (!GYLDIGE_FELTTYPER.includes(type)) {
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
    erEpost,
    erFeltreferanse,
    referansen,
    slaOppEposter,
    ekspanderPersoner,
    ekspanderBehandlingPersoner
};
