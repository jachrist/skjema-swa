/**
 * Synkronisering av et Teams-team fra en rolle.
 *
 * Bakgrunn: Forsvarets ugraderte plattform har ingen organisasjonsdata i
 * Entra ID — bare UPN og navn. Dynamiske team kan derfor ikke bygges på
 * avdeling. Medlemslistene vedlikeholdes i stedet manuelt og importeres hit
 * som roller (f.eks. «Publikum» med omfang «FFT»). Oppdragsgiver vil bruke
 * den samme lista til å holde et team oppdatert.
 *
 * Settes `Team` på en rollegruppe, kalles en Power Automate-flyt én gang i
 * døgnet med teamnavnet og alle UPN-ene i gruppen. Flyten oppdaterer teamet
 * DESTRUKTIVT: den som ikke står på lista, meldes ut.
 *
 * DET ER DEN DESTRUKTIVE DELEN SOM GJØR DENNE MODULEN NØDVENDIG.
 *
 * Lista kommer fra en tabell som fylles av en Excel-import. Går importen galt
 * — feil kolonne, feil omfang, en fil som ikke ble lest ferdig — er resultatet
 * en kortere liste, ikke en feilmelding. Sendes den videre, melder flyten ut
 * folk som aldri skulle vært ute, og det oppdages først når noen mister
 * tilgang. Derfor to sperrer:
 *
 *   TOM LISTE SENDES ALDRI. En rollegruppe uten medlemmer betyr nesten alltid
 *   at noe er galt oppstrøms, ikke at teamet skal tømmes.
 *
 *   ET STORT FALL STOPPES. Halveres gruppen siden forrige vellykkede kjøring,
 *   stanser synkroniseringen og avviket logges. Er fallet reelt — en avdeling
 *   er lagt ned — kan en administrator kjøre den igjen med `tillatFall`.
 *
 * Begge sperrene feiler mot å LA VÆRE å endre teamet. Et team med noen for
 * mange er et problem som kan rettes; et team som er tømt ved et uhell er
 * tapt tilgang for alle, og ingen vet hvem som sto der.
 */

/** Under dette antallet er et fall ikke informativt — 2 av 3 er ikke et varsko. */
const MINSTE_GRUNNLAG = 5;

/** Gruppen må beholde denne andelen av forrige kjøring for å gå gjennom. */
const FALL_GRENSE = 0.5;

/** Ser dette ut som en Entra-gruppe-ID? */
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Hvordan teamet skal identifiseres overfor flyten.
 *
 * Et visningsnavn er ikke unikt — to team kan hete det samme, og da er det
 * tilfeldig hvilket flyten treffer. Ser verdien ut som en GUID, sendes den
 * som `TeamId`, ellers som `TeamNavn`. Begge feltene er alltid med i
 * payloaden, så flyten slipper å gjette: den bruker det som er satt.
 */
function teamIdentitet(team) {
    const v = String(team || '').trim();
    if (!v) return { TeamId: '', TeamNavn: '' };
    return GUID.test(v) ? { TeamId: v, TeamNavn: '' } : { TeamId: '', TeamNavn: v };
}

/** Har denne rollegruppen en team-kobling i det hele tatt? */
function harTeam(gruppe) {
    return String(gruppe?.Team || '').trim().length > 0;
}

/**
 * Rene, unike UPN-er, sortert.
 *
 * Sorteringen er ikke kosmetikk: den gjør to kjøringer med samme innhold
 * identiske, slik at en logg kan sammenlignes. Duplikater fjernes fordi samme
 * person kan stå i tabellen med ulik skrivemåte, og et duplikat ville blåst
 * opp antallet og dermed svekket fall-sperren.
 */
function upnListe(innehavere) {
    const sett = new Set();
    for (const i of innehavere || []) {
        const upn = String(i?.UPN || i?.EP || '').trim().toLowerCase();
        if (upn) sett.add(upn);
    }
    return [...sett].sort();
}

/**
 * Skal denne synkroniseringen kjøres?
 *
 * `forrigeAntall` er antallet ved forrige VELLYKKEDE kjøring. Er det null
 * eller ukjent (første gang), finnes det ikke noe å sammenligne med, og bare
 * tom-sperren gjelder.
 *
 * Returnerer alltid en `grunn`, også når svaret er ja — den logges, og en
 * logg som bare sier «ok» forteller ikke hvorfor det var ok.
 */
function vurderSynk({ antallNaa, forrigeAntall = 0, tillatFall = false }) {
    const naa = Number(antallNaa || 0);
    const forrige = Number(forrigeAntall || 0);

    if (naa === 0) {
        return {
            ok: false, grunn: 'tom',
            melding: 'Rollegruppen har ingen medlemmer. Synkronisering stoppet — '
                + 'en tom liste ville meldt ut alle i teamet.'
        };
    }
    if (forrige >= MINSTE_GRUNNLAG && naa < forrige * FALL_GRENSE) {
        if (!tillatFall) {
            return {
                ok: false, grunn: 'stort-fall', forrige, naa,
                melding: `Gruppen har falt fra ${forrige} til ${naa} medlemmer siden forrige `
                    + 'kjøring. Synkronisering stoppet. Er fallet riktig, kjør den igjen '
                    + 'med «kjør likevel».'
            };
        }
        return { ok: true, grunn: 'stort-fall-overstyrt', forrige, naa };
    }
    return { ok: true, grunn: forrige === 0 ? 'forste-kjoring' : 'normal', forrige, naa };
}

/**
 * Payloaden flyten får.
 *
 * `Handling` er med selv om flyten bare gjør én ting. Den dagen det kommer en
 * ikke-destruktiv variant, skal flyten kunne skille dem uten at vi må lage et
 * nytt endepunkt — og en payload uten handling ville tvunget fram nettopp det.
 */
function byggPayload({ rolle, omfang = '', team, upner, miljo = '' }) {
    return {
        Handling: 'synkroniserTeamDestruktivt',
        ...teamIdentitet(team),
        Rolle: String(rolle || ''),
        Omfang: String(omfang || ''),
        Medlemmer: [...(upner || [])],
        Antall: (upner || []).length,
        Miljo: String(miljo || ''),
        Tidspunkt: new Date().toISOString()
    };
}

module.exports = {
    teamIdentitet, harTeam, upnListe, vurderSynk, byggPayload,
    MINSTE_GRUNNLAG, FALL_GRENSE
};
