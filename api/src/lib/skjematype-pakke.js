/**
 * Eksport og import av SKJEMATYPER — definisjonene, ikke dataene.
 *
 * Laget for å fylle et nytt miljø (prod v3) med noen sentrale skjematyper fra
 * et eksisterende, uten å dra med seg alt. `scripts/migrer/` kopierer HELE
 * tabeller mellom lagringskonti; denne går den andre veien: et lite utvalg,
 * gjennom admin-panelet, uten tilgang til noen tilkoblingsstreng.
 *
 * **HVA PAKKEN IKKE INNEHOLDER**, og hvorfor det står her og ikke bare i
 * dokumentasjonen: det er lista noen vil lese når de lurer på hvorfor det nye
 * miljøet er tomt.
 *
 *   **Ingen innsendte skjemaer.** Bare malene.
 *   **Ingen krypteringsnøkler.** En skjematype med `Krypteres` satt får en NY
 *   nøkkel i målmiljøet. Det er riktig for et nytt miljø — men tar du med
 *   svar fra en annen konto uten nøklene, er de ulesbare for alltid.
 *   **Ingen rolletildelinger.** `Eiere` følger med i definisjonen, men
 *   personene som faktisk har rollene, gjør det ikke.
 *   **Ingen oppslagslister.** En skjematype som peker på en liste som ikke
 *   finnes i målmiljøet, får et TOMT nedtrekk — og et tomt nedtrekk er umulig
 *   å skille fra «ingenting er godkjent ennå». Derfor advarer importen om det
 *   FØR den skriver.
 *
 * Alt dette er regler uten lagring i seg, og prøves uten.
 */
const { parseFasteData } = require('./faste-data');

/**
 * Formatnavnet står i fila. En JSON-fil uten det er ikke en pakke herfra, og
 * skal avvises med en melding som sier hva den ser ut som — ikke med en
 * uforståelig feil halvveis inn i importen.
 */
const PAKKE_FORMAT = 'skjema-swa/skjematyper';
const PAKKE_VERSJON = 1;

function byggPakke(typer, { fraMiljo = '', av = '' } = {}) {
    const definisjoner = (typer || [])
        .map(t => (t && t.JSON ? t.JSON : null))
        .filter(Boolean);
    return {
        format: PAKKE_FORMAT,
        versjon: PAKKE_VERSJON,
        laget: new Date().toISOString(),
        fraMiljo,
        av,
        // Teller det som FAKTISK er med. En type uten lesbar definisjon
        // havner ikke i lista, og da skal ikke tellingen påstå noe annet.
        antall: definisjoner.length,
        skjematyper: definisjoner
    };
}

/**
 * Les og valider en pakke. Kaster aldri — feil hører hjemme i svaret.
 */
function lesPakke(raatt) {
    let pakke = raatt;
    if (typeof raatt === 'string') {
        try { pakke = JSON.parse(raatt); }
        catch (e) { return { ok: false, feil: [`Ikke gyldig JSON: ${e.message}`], skjematyper: [] }; }
    }
    if (!pakke || typeof pakke !== 'object') {
        return { ok: false, feil: ['Tom eller ugyldig fil'], skjematyper: [] };
    }
    if (pakke.format !== PAKKE_FORMAT) {
        return {
            ok: false,
            feil: [`Fila er ikke en skjematype-pakke (format="${pakke.format || '(mangler)'}", `
                + `forventet "${PAKKE_FORMAT}")`],
            skjematyper: []
        };
    }
    if (Number(pakke.versjon) !== PAKKE_VERSJON) {
        return {
            ok: false,
            feil: [`Pakkeversjon ${pakke.versjon} støttes ikke (denne koden leser versjon ${PAKKE_VERSJON})`],
            skjematyper: []
        };
    }
    const typer = Array.isArray(pakke.skjematyper) ? pakke.skjematyper : [];
    const feil = [];
    const gyldige = [];
    typer.forEach((def, i) => {
        if (!def || typeof def !== 'object') { feil.push(`Oppføring ${i + 1} er ikke et objekt`); return; }
        if (!String(def.Skjematype_id || '').trim()) {
            feil.push(`Oppføring ${i + 1} ("${def.Skjema_navn || 'uten navn'}") mangler Skjematype_id`);
            return;
        }
        gyldige.push(def);
    });
    if (gyldige.length === 0 && feil.length === 0) feil.push('Pakken inneholder ingen skjematyper');
    return { ok: feil.length === 0, feil, skjematyper: gyldige };
}

/**
 * Hvilke oppslagslister peker denne definisjonen på?
 *
 * Leser `FasteData` gjennom `parseFasteData` — den SAMME normaliseringen
 * skjemavisningen bruker. Tre former finnes (DNF, legacy og pipe-streng), og
 * en egen parser her ville vært en fjerde mening om hva et oppslag er.
 */
function oppslagslisterI(def) {
    const navn = new Set();
    for (const seksjon of (def?.Seksjoner || [])) {
        for (const felt of (seksjon?.Felter || [])) {
            const dnf = parseFasteData(felt?.FasteData);
            if (!dnf || dnf.Datakilde !== 'Skjemasvar') continue;
            for (const gruppe of (dnf.EllerAv || [])) {
                for (const b of (gruppe?.OgAv || [])) {
                    if (String(b?.Kolonne) === 'Liste' && String(b?.Verdi || '').trim()) {
                        navn.add(String(b.Verdi).trim());
                    }
                }
            }
        }
    }
    return [...navn];
}

/**
 * Hva ville skjedd ved import? Returnerer én plan per skjematype.
 *
 * `handling` er alltid satt, også når den er `hopper-over` — og `grunn` står
 * i den da. En plan uten begrunnelse etterlater den som leser med «hvorfor
 * kom ikke denne med», og det er nøyaktig spørsmålet en forhåndsvisning skal
 * besvare.
 */
function vurderImport({ skjematyper = [], finnesIder = [], finnesLister = [], overskriv = false } = {}) {
    const finnes = new Set(finnesIder.map(String));
    const lister = new Set(finnesLister.map(s => String(s).trim().toLowerCase()));
    return skjematyper.map((def) => {
        const id = String(def.Skjematype_id);
        const alleredeHer = finnes.has(id);
        const manglendeLister = oppslagslisterI(def)
            .filter(n => !lister.has(n.toLowerCase()));

        const advarsler = [];
        if (manglendeLister.length > 0) {
            advarsler.push(`Peker på oppslagsliste(r) som ikke finnes her: `
                + `${manglendeLister.map(n => `"${n}"`).join(', ')}. `
                + 'Nedtrekket blir tomt til lista er definert og bygget.');
        }
        const kryptering = String(def.Krypteres || 'Nei');
        if (kryptering !== 'Nei') {
            advarsler.push(`Krypteres=${kryptering}. Det lages en NY nøkkel i dette miljøet — `
                + 'svar kryptert i kildemiljøet kan ikke leses her.');
        }

        let handling = 'ny';
        let grunn = '';
        if (alleredeHer) {
            handling = overskriv ? 'overskriv' : 'hopper-over';
            grunn = overskriv
                ? 'Finnes fra før og blir erstattet'
                : 'Finnes fra før. Kryss av for overskriving hvis den skal erstattes';
        }
        return {
            id,
            navn: String(def.Skjema_navn || ''),
            fase: String(def.Fase || ''),
            handling,
            grunn,
            manglendeLister,
            advarsler
        };
    });
}

module.exports = {
    PAKKE_FORMAT, PAKKE_VERSJON,
    byggPakke, lesPakke, oppslagslisterI, vurderImport
};
