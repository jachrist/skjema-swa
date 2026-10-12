/**
 * Oppslagslister — svar fra innsendte skjemaer som verdier i et nedtrekk.
 *
 * Ønsket som utløste den: FHS har gjort verdivurdering av informasjonstyper i
 * én skjematype (ett skjema per datapunkt), og andre skjemaer skal kunne velge
 * blant de ferdige vurderingene i stedet for at hver skjemaskaper
 * vedlikeholder sin egen kopi av lista.
 *
 * Lista bygges av en døgnlig jobb og legges i en egen tabell. Den leses
 * derfra, ikke fra skjemaforekomstene. Grunnen er `faste-data.js`: FasteData
 * løses opp ved HVER `GET /api/skjematyper/{id}`, altså hver gang noen åpner
 * skjemaet. En direkte kilde ville skannet og dekryptert alle forekomstene av
 * kildeskjematypen på den kritiske veien for å åpne et skjema.
 *
 * Den andre grunnen er subtil: `faste-data.js:195` kaller oppslaget ÉN GANG
 * PER betingelse i en OG-gruppe og snitter resultatene på `Verdi`. En kilde
 * som trenger to parametre samtidig — hvilken skjematype OG hvilket felt —
 * ville fått dem i to kall, hvert uten den andre, og snittet ville gitt en tom
 * liste uten en feilmelding. En ferdigbygget liste trenger bare ETT filter
 * (`Liste=<navn>`), så den formen kan ikke oppstå.
 *
 * Denne modulen er den rene delen: ingen tabell, ingen HTTP. Den tar
 * oppsettet, kildedefinisjonen og forekomstene, og returnerer radene.
 *
 * Feltene oppgis med MERKELAPP, ikke feltnummer. Oppsettet skal kunne skrives
 * av en som ser skjemaet, ikke av en som leser JSON — og en skjematype
 * defineres i prod, der feltnumrene ikke er kjent når oppsettet lages.
 * Merkelappen slås opp mot den levende definisjonen ved hver kjøring, og en
 * merkelapp uten treff STOPPER med de tilgjengelige merkelappene i
 * feilmeldingen. Alternativet — hoppe over feltet — ville gitt en liste som
 * ser riktig ut og mangler en kolonne.
 */
const { hentFeltSvar } = require('./rapport-motor');
const { sisteBeslutning } = require('./datauttrekk');

/** Skjema_status for «Avsluttet». De øvrige: 1 Mellomlagret, 2 Innsendt, 3 Til revidering. */
const STATUS_AVSLUTTET = 5;

/** Behandlingsresultat som kvalifiserer, uavhengig av status. */
const GODKJENTE_RESULTATER = ['Godkjent'];

/**
 * Skal forekomsten med i lista?
 *
 * BEGGE deler: forekomsten må være Avsluttet OG ha behandlingsresultat
 * Godkjent. Det er to ulike akser — Avsluttet er en `Skjema_status`, mens
 * Godkjent er et behandlingsresultat utledet av `sisteBeslutning` og har
 * ingen statuskode — og begge må være oppfylt.
 *
 * Kravet er bevisst strengt. Lista er kilden andre skjemaer velger fra, og en
 * vurdering som er godkjent men ikke avsluttet, eller avsluttet uten å være
 * godkjent, er ikke et vedtatt datapunkt. Et feilaktig valg her sprer seg til
 * hvert skjema som har valgt det, og feltreferanser fryses ved innsending —
 * så det blir stående.
 *
 * Utledningen av resultatet er `sisteBeslutning` — samme funksjon som
 * registeret, rapportene og PDF-en bruker. En fjerde tolkning av
 * `Beslutning`-tallet er nettopp det denne modulen ikke skal ha.
 */
function kvalifiserer(skjema) {
    if (Number(skjema?.Skjema_status) !== STATUS_AVSLUTTET) return false;
    const resultat = sisteBeslutning(skjema)?.tekst || '';
    return GODKJENTE_RESULTATER.some(r => r.toLowerCase() === resultat.trim().toLowerCase());
}

/**
 * Merkelappen på et felt, slik editoren viser den.
 *
 * `Tekst` er en streng på vanlige felt, men et objekt ({ Verdi, Format }) på
 * informasjonsfelt. Formen leses defensivt, som i `listekolonne.js`: en
 * «[object Object]» i en merkelapp er den slags feil ingen melder, bare lever
 * med — og her ville den gjort at oppslaget på merkelapp aldri traff.
 */
function merkelappFor(felt) {
    const t = felt?.Tekst;
    const rå = (typeof t === 'object' && t) ? (t.Verdi ?? '') : (t ?? '');
    return String(rå).trim();
}

/**
 * Alle feltmerkelapper i en skjematype, med feltnummer.
 *
 * Brukes både til oppslaget og til feilmeldingen når et oppslag ikke treffer.
 * Det er samme liste begge steder med vilje: en feilmelding som lister noe
 * annet enn det oppslaget søkte i, sender deg etter en feil du ikke har.
 */
function feltKatalog(definisjon) {
    const ut = [];
    for (const s of (definisjon?.Seksjoner || [])) {
        const sekNr = String(s.Seksjon_nummer ?? s.Nummer ?? '');
        for (const f of (s.Felter || [])) {
            // Et informasjonsfelt har ingen svar å hente. Står det i
            // oppsettet, skal det si fra — ikke gi en tom del på hver rad.
            if (f.Type === 'Informasjon') continue;
            const merkelapp = merkelappFor(f);
            if (!merkelapp) continue;
            ut.push({
                sekNr,
                feltNr: String(f.Nummer).padStart(2, '0'),
                nokkel: `${sekNr}-${String(f.Nummer).padStart(2, '0')}`,
                merkelapp
            });
        }
    }
    return ut;
}

function normaliser(s) {
    return String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Finn feltet som bærer en merkelapp.
 *
 * Kaster når merkelappen ikke finnes, eller når den finnes to ganger — begge
 * er oppsettfeil som må rettes, og et stille valg mellom to felter med samme
 * navn er verre enn å stoppe.
 *
 * `nokkel` godtas også («2-01»), for den som vet feltnummeret og vil være
 * presis. Da er merkelappen irrelevant.
 */
function finnFelt(katalog, merkelapp) {
    const spør = normaliser(merkelapp);
    if (!spør) throw new Error('Feltmerkelapp mangler i oppsettet');

    const påNokkel = katalog.filter(f => normaliser(f.nokkel) === spør);
    if (påNokkel.length === 1) return påNokkel[0];

    const treff = katalog.filter(f => normaliser(f.merkelapp) === spør);
    if (treff.length === 1) return treff[0];
    if (treff.length > 1) {
        throw new Error(`Merkelappen "${merkelapp}" finnes på ${treff.length} felter `
            + `(${treff.map(f => f.nokkel).join(', ')}). Oppgi feltnummer i stedet, f.eks. "${treff[0].nokkel}".`);
    }
    throw new Error(`Fant ikke feltet "${merkelapp}". Merkelapper i skjematypen: `
        + katalog.map(f => `"${f.merkelapp}" (${f.nokkel})`).join(', '));
}

/** Skilletegnet mellom flere valg i samme felt. Samme form som importskriptet leser. */
const FLERVERDI_SKILLE = '/';

/** Skilletegnet mellom delene i den sammensatte teksten. */
const DEL_SKILLE = ' - ';

/**
 * Teksten for én forekomst.
 *
 * Hver del er «prefiks + verdi». Prefikset er fritekst fra oppsettet, så
 * «Personopplysning: Ja» krever `{ merkelapp: 'Personopplysning', prefiks:
 * 'Personopplysning: ' }` — prefikset bærer sitt eget skilletegn, slik at et
 * navnefelt kan stå uten.
 *
 * Et ubesvart felt gir en tom verdi, ikke en utelatt del: delene skal stå i
 * samme rekkefølge på hver rad, ellers kan de ikke leses side om side i
 * nedtrekket.
 */
function byggDeler(skjema, felter) {
    return felter.map(f => {
        const svar = hentFeltSvar(skjema, f.sekNr, f.feltNr)
            .map(v => String(v ?? '').trim())
            .filter(Boolean);
        const verdi = svar.join(FLERVERDI_SKILLE);
        return { verdi, tekst: `${f.prefiks || ''}${verdi}` };
    });
}

function byggTekst(skjema, felter) {
    return byggDeler(skjema, felter).map(d => d.tekst).join(DEL_SKILLE);
}

/**
 * Bygg radene for én oppslagsliste.
 *
 * @param {object} oppsett    { Navn, Skjematype_id, Felter: [{ Merkelapp, Prefiks }] }
 * @param {object} definisjon kildeskjematypens JSON
 * @param {Array}  skjemaer   forekomstene, dekryptert
 * @returns {{rader: Array, hoppet: Array, felter: Array}}
 *
 * `hoppet` er alltid satt, også tom. En nøkkel som kan forsvinne kan ikke
 * feilsøkes: «ingen rader ble hoppet over» og «koden som teller dem er ikke
 * deployet» ville sett helt likt ut i svaret.
 */
function byggListe(oppsett, definisjon, skjemaer) {
    const navn = String(oppsett?.Navn || '').trim();
    if (!navn) throw new Error('Oppslagslista mangler Navn');
    const feltOppsett = Array.isArray(oppsett?.Felter) ? oppsett.Felter : [];
    if (feltOppsett.length === 0) throw new Error(`Oppslagslista "${navn}" har ingen felter`);

    const katalog = feltKatalog(definisjon);
    if (katalog.length === 0) {
        throw new Error(`Kildeskjematypen for "${navn}" har ingen felter med merkelapp`);
    }

    // Alle merkelappene slås opp FØR noen rad bygges. Ellers ville en feil i
    // det siste feltet kommet etter at de andre var skrevet.
    const felter = feltOppsett.map(f => ({
        ...finnFelt(katalog, f.Merkelapp),
        prefiks: String(f.Prefiks ?? '')
    }));

    const rader = [];
    const hoppet = [];
    const sett = new Set();
    for (const skjema of (Array.isArray(skjemaer) ? skjemaer : [])) {
        const id = String(skjema?.Skjema_id ?? '');
        if (!kvalifiserer(skjema)) {
            hoppet.push({ skjemaId: id, grunn: 'ikke avsluttet og godkjent' });
            continue;
        }
        const deler = byggDeler(skjema, felter);
        const tekst = deler.map(d => d.tekst).join(DEL_SKILLE);
        // Første del er navnet. Er den tom, er raden uten identitet, og en
        // oppføring som bare sier « - Personopplysning: Ja» hjelper ingen.
        //
        // VERDIEN sjekkes, ikke den sammensatte teksten: et navn som selv
        // inneholder « - » ville gjort en split på skilletegnet til et
        // feilsvar, og den feilen ville bare slått inn for noen rader.
        if (!deler[0].verdi) {
            hoppet.push({ skjemaId: id, grunn: `feltet "${felter[0].merkelapp}" er ubesvart` });
            continue;
        }
        if (sett.has(tekst)) {
            hoppet.push({ skjemaId: id, grunn: 'samme tekst finnes alt i lista' });
            continue;
        }
        sett.add(tekst);
        // Verdi = Tekst: det lagrede svaret skal være lesbart i rapport, PDF
        // og arkiv uten et oppslag tilbake hit. Skjema_id blir med som
        // sporing, men er ikke det som lagres i mottakerskjemaet.
        rader.push({ Tekst: tekst, Verdi: tekst, KildeSkjemaId: id });
    }

    rader.sort((a, b) => a.Tekst.localeCompare(b.Tekst, 'nb'));
    return { rader, hoppet, felter };
}

module.exports = {
    byggListe,
    byggDeler,
    kvalifiserer,
    feltKatalog,
    finnFelt,
    byggTekst,
    STATUS_AVSLUTTET,
    GODKJENTE_RESULTATER,
    FLERVERDI_SKILLE,
    DEL_SKILLE
};
