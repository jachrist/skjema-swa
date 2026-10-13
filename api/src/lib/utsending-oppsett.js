/**
 * Masseutsending styrt av skjematype-definisjonen, ikke av en egen flyt.
 *
 * I dag finnes én masseutsending: emneevaluering. Mønsteret er generelt —
 * velg en avgrensning av mottakere, velg mottakere, velg datoer, send ut en
 * skjematype med noen faste verdier utfylt — men kartleggingen fra det
 * innsendte avsender-skjemaet til `POST /api/utsending` ligger i en
 * Power Automate-flyt. En ny type masseutsending betyr dermed en ny flyt.
 *
 * Denne modulen er kartleggingen, flyttet ut av flyten. Tre grunner:
 *
 *   Flytendringer koster en firestegs manuell ALM-runde mellom tenantene
 *   (docs/FLYT-DEPLOY.md), og kartlegging er nettopp det som endres ofte.
 *
 *   Logikken kan ikke testes i en flyt. Her kan den brytes med vilje.
 *
 *   Feilmeldingene blir brukbare. En flyt kan ikke si «felt 2-01 finnes ikke
 *   i skjematype 71»; det kan vi, og det er forskjellen på en feil som rettes
 *   på et minutt og en som rettes etter at 200 mottakere fikk tomme felter.
 *
 * Modulen er REN: ingen tabell, ingen HTTP, ingen oppslag. Den tar oppsettet
 * og det innsendte skjemaet, og returnerer kroppen `POST /api/utsending` skal
 * ha. Validering av prefill-referanser og skriving skjer der, som før.
 *
 * ── Hva som IKKE står i oppsettet, med vilje ────────────────────────────
 *
 * Avgrensningen av mottakere (Emne, Klasse, Team, Rolle) modelleres ikke her.
 * `Mottakerfelt` peker på et vanlig felt, og feltet har allerede `FasteData`
 * — `Studenter{Emne={1-01}}`, `Personer{Team}`, og resten. Datakildelista bor
 * i `oppslag.js` og i editoren; gjentas den her, har vi samme regel to steder.
 *
 * Det virker fordi `_hentStudenter` og `samleBehandlerMottakere` begge gir
 * `Verdi = e-postadressen`. Et mottakerfelt lagrer altså adresser direkte, og
 * kartleggingen trenger ingen oppslag.
 */
const { finnAlleSvarForFeltRef, finnFeltViaRef, FLERVALGSTYPER } = require('./placeholder');
const { normaliserDato } = require('./utsending-storage');

/** Feltreferansen «2-01» → { sek: '2', felt: '01' }. */
const FELTREF = /^(\d+)[-.](\d{1,2})$/;

function delFeltref(ref) {
    const m = FELTREF.exec(String(ref || '').trim());
    if (!m) return null;
    return { sek: m[1], felt: m[2].padStart(2, '0') };
}

/** Feltet en referanse peker på, eller null. */
function feltet(skjema, ref) {
    const d = delFeltref(ref);
    if (!d) return null;
    return finnFeltViaRef(skjema?.Seksjoner || [], d.sek, d.felt);
}

/**
 * Svarene i et felt, som en liste med trimmede strenger.
 *
 * `null` betyr «ikke en gyldig feltreferanse». Et felt som ikke finnes gir
 * også `null` fra `feltet()`, og kalleren skiller på de to — «feltet finnes
 * ikke» og «feltet er ubesvart» sender deg to helt ulike steder.
 */
function svarene(skjema, ref) {
    const d = delFeltref(ref);
    if (!d) return null;
    return finnAlleSvarForFeltRef(skjema?.Seksjoner || [], d.sek, d.felt)
        .map(v => String(v ?? '').trim())
        .filter(Boolean);
}

/**
 * En referanse i en prefill-verdi: `"{1-01}"` eller `"26H|{1-01}"`.
 *
 * Settes inn med FØRSTE svar i feltet. Et flervalgsfelt gir flere svar, og
 * en prefill-verdi er én verdi — å slå dem sammen til «A, B» ville gitt en
 * streng ingen mottaker kan bruke.
 */
function settInnReferanser(mal, skjema, feil, hvor) {
    return String(mal).replace(/\{([^}]+)\}/g, (hele, ref) => {
        const v = svarene(skjema, ref);
        if (v === null) {
            feil.push(`${hvor}: "${ref}" er ikke en feltreferanse (ventet f.eks. "1-01")`);
            return hele;
        }
        if (v.length === 0) {
            feil.push(`${hvor}: feltet ${ref} er ubesvart, så referansen kan ikke settes inn`);
            return hele;
        }
        return v[0];
    });
}

/** Alle oppslagstypene `utsending-prefill.js` kjenner. Holdes i synk av test. */
const OPPSLAGSTYPER = ['emnebeskrivelse'];

/**
 * Én prefill-verdi.
 *
 * Tre former, og de dekker det emneevalueringen trenger:
 *
 *   { fraFelt: "1-01" }                 svaret i et felt på avsender-skjemaet
 *   { tekst: "Evaluering {1-01}" }      fast tekst, med feltreferanser
 *   { emnebeskrivelse: "26H|{1-01}" }   oppslag, løses når mottakeren åpner
 *
 * Oppslagsformen sendes videre som objekt — `POST /api/utsending` validerer
 * den og lagrer referansen, ikke teksten. Det holder radene små og gir alltid
 * teksten som gjelder når skjemaet faktisk fylles ut.
 */
function byggPrefillVerdi(malFelt, verdi, skjema, feil) {
    const hvor = `Prefilled["${malFelt}"]`;

    if (typeof verdi === 'string') {
        return [settInnReferanser(verdi, skjema, feil, hvor)];
    }
    if (!verdi || typeof verdi !== 'object' || Array.isArray(verdi)) {
        feil.push(`${hvor}: forventet { fraFelt }, { tekst } eller en oppslagsform, fikk ${Array.isArray(verdi) ? 'en liste' : typeof verdi}`);
        return null;
    }
    if (typeof verdi.fraFelt === 'string') {
        const v = svarene(skjema, verdi.fraFelt);
        if (v === null) {
            feil.push(`${hvor}: fraFelt "${verdi.fraFelt}" er ikke en feltreferanse (ventet f.eks. "1-01")`);
            return null;
        }
        // Et ubesvart kildefelt er ikke en feil: det gir et tomt felt hos
        // mottakeren, som er det samme som å ikke forhåndsutfylle det.
        return v;
    }
    if (typeof verdi.tekst === 'string') {
        return [settInnReferanser(verdi.tekst, skjema, feil, hvor)];
    }
    for (const type of OPPSLAGSTYPER) {
        if (typeof verdi[type] === 'string') {
            return { [type]: settInnReferanser(verdi[type], skjema, feil, hvor) };
        }
    }
    feil.push(`${hvor}: ukjent form. Bruk { fraFelt }, { tekst } eller en av: ${OPPSLAGSTYPER.join(', ')}`);
    return null;
}

const DATONAVN = ['utsendingsdato', 'purredato', 'avslutningsdato'];

/**
 * Bygg kroppen til `POST /api/utsending` fra et innsendt avsender-skjema.
 *
 * @param {object} oppsett  skjematypens `Utsending`-blokk
 * @param {object} skjema   det innsendte avsender-skjemaet
 * @returns {{kropp: object|null, feil: string[], advarsler: string[]}}
 *
 * ALLE tre nøklene er alltid satt, også tomme. En nøkkel som kan forsvinne
 * kan ikke feilsøkes: «ingen feil» og «koden som samler dem er ikke deployet»
 * ville sett helt likt ut i svaret.
 *
 * Feil samles opp i stedet for å kaste på den første. Den som har satt opp en
 * ny masseutsending vil se alt som er galt i én omgang, ikke ett og ett.
 */
function byggUtsending(oppsett, skjema) {
    const feil = [];
    const advarsler = [];

    if (!oppsett || typeof oppsett !== 'object') {
        return { kropp: null, feil: ['Skjematypen har ingen Utsending-blokk'], advarsler };
    }

    const malId = String(oppsett.Målskjematype_id || '').trim();
    if (!malId) feil.push('Utsending.Målskjematype_id mangler — hvilken skjematype skal sendes ut?');

    // ---- mottakere ----
    let mottakerAdresser = [];
    const mf = String(oppsett.Mottakerfelt || '').trim();
    if (!mf) {
        feil.push('Utsending.Mottakerfelt mangler — hvilket felt holder mottakerne?');
    } else {
        const f = feltet(skjema, mf);
        const v = svarene(skjema, mf);
        if (v === null) {
            feil.push(`Utsending.Mottakerfelt "${mf}" er ikke en feltreferanse (ventet f.eks. "2-01")`);
        } else if (!f) {
            // «Finnes ikke» og «er ubesvart» sender deg to helt ulike steder.
            feil.push(`Utsending.Mottakerfelt ${mf} finnes ikke i avsender-skjemaet`);
        } else if (!FLERVALGSTYPER.has(String(f.Type || ''))) {
            // Den dyreste feilen i hele kartleggingen, og den er taus:
            // `alleSvarIFelt` leser bare FØRSTE svar på et felt som ikke er
            // flervalg. Utsendingen ville gått til én av to hundre, og både
            // kallet og svaret ville sett helt normale ut.
            feil.push(`Mottakerfeltet ${mf} har typen "${f.Type || '(ingen)'}", som bare gir ÉTT svar. `
                + `Mottakerfeltet må være ${[...FLERVALGSTYPER].join(' eller ')} — ellers går utsendingen til bare den første.`);
        } else if (v.length === 0) {
            feil.push(`Mottakerfeltet ${mf} er ubesvart — ingen å sende til`);
        } else {
            // Samme adresse to ganger gir to lenker til samme person, og den
            // andre gjør den første ubrukelig. Feltet er et flervalgsfelt, og
            // et dobbeltvalg er lett å gjøre.
            const sett = new Set();
            for (const a of v) {
                const n = a.toLowerCase();
                if (sett.has(n)) { advarsler.push(`Mottakeren ${a} sto flere ganger og er tatt med én gang`); continue; }
                sett.add(n);
                mottakerAdresser.push(a);
            }
        }
    }

    // ---- datoer ----
    const datoer = {};
    for (const navn of DATONAVN) {
        const ref = oppsett.Datoer?.[navn];
        if (!ref) { datoer[navn] = ''; continue; }
        const v = svarene(skjema, ref);
        if (v === null) {
            feil.push(`Utsending.Datoer.${navn} "${ref}" er ikke en feltreferanse`);
            datoer[navn] = '';
            continue;
        }
        if (v.length === 0) { datoer[navn] = ''; continue; }
        // Samme normalisering som endepunktet bruker. Gjøres den bare der,
        // oppdages en ugyldig dato først etter at flyten har kalt oss.
        const n = normaliserDato(v[0], { slutten: navn === 'avslutningsdato' });
        if (n === null) {
            feil.push(`${navn}: "${v[0]}" i felt ${ref} er ikke en gyldig dato`);
            datoer[navn] = '';
        } else {
            datoer[navn] = n;
        }
    }

    // Rekkefølgen sjekkes her OG i endepunktet. Her for å gi beskjed med
    // feltnummeret i meldingen; der fordi endepunktet også kalles direkte.
    const { utsendingsdato: u, purredato: p, avslutningsdato: a } = datoer;
    if (a && u && a < u) feil.push('avslutningsdato er før utsendingsdato — lenka ville vært stengt før den ble sendt');
    if (a && p && a < p) feil.push('avslutningsdato er før purredato — purringen ville aldri gått ut');
    if (p && u && p < u) feil.push('purredato er før utsendingsdato — det ville blitt purret før lenka gikk ut');

    // ---- prefilled ----
    // Batch-nivå: alle mottakerne får de samme verdiene. Mekanismen i
    // `POST /api/utsending` støtter verdier per mottaker, men ingen kjent sak
    // trenger det, og formen for «denne verdien kommer fra mottakerraden» er
    // en reell forgrening i designet. Den tas når et tilfelle dukker opp.
    const prefilled = {};
    for (const [malFelt, verdi] of Object.entries(oppsett.Prefilled || {})) {
        if (!delFeltref(malFelt)) {
            feil.push(`Prefilled-nøkkelen "${malFelt}" er ikke en feltreferanse i målskjemaet (ventet f.eks. "1-01")`);
            continue;
        }
        const bygd = byggPrefillVerdi(malFelt, verdi, skjema, feil);
        if (bygd !== null) prefilled[malFelt] = bygd;
    }

    if (feil.length > 0) return { kropp: null, feil, advarsler };

    return {
        kropp: {
            skjematypeId: malId,
            senderSkjemaId: String(skjema?.Skjema_id || ''),
            kanalHint: String(oppsett.KanalHint || 'epost'),
            purretekst: String(oppsett.Purretekst || ''),
            ...datoer,
            mottakere: mottakerAdresser.map(a => ({
                mottaker: a,
                ...(Object.keys(prefilled).length > 0 ? { prefilled } : {})
            }))
        },
        feil,
        advarsler
    };
}

module.exports = { byggUtsending, OPPSLAGSTYPER, DATONAVN };
