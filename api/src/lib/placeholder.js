/**
 * Placeholder-substitusjon for meldingsutforming.
 *
 * Støttede plassholdere (samme som legacy):
 *   $lenke              — URL til skjema/kvittering (kontekst.lenke)
 *   $innsender          — e-post
 *   $innsender_navn     — navn (e-postadressen hvis navnet ikke er kjent)
 *   $skjemanavn         — Skjema_navn / Overskrift
 *   $skjema_id          — Skjema_id
 *   $beslutning         — beslutning-tekst
 *   $kommentar          — behandler-kommentar
 *   $stegnavn           — steg.Stegnavn
 *   $rolle              — rolle-streng (f.eks. "Emneansvarlig(CBU2501)")
 *   $tidspunkt          — dato/tid (ISO eller lokalisert)
 *   $navn               — UTGÅTT, se kommentaren ved erstatningen under
 *   $frist              — frist-dato hvis satt
 *   $dagerTilFrist      — antall dager
 *
 * Feltreferanser:
 *   {N-NN}   posisjonell (seksjon-felt)
 *   {UUID}   stabil Id
 *
 * Feltreferanser settes inn som visningsverdi, ikke som lagret verdi. For
 * Dato-felter er de to ikke like: `<input type="date">` lagrer YYYY-MM-DD, som
 * er et maskinformat ingen skriver på norsk. Se `visningsverdi()` under.
 *
 * VIKTIG: $lenke beholdes uendret hvis kontekst.lenke ikke er eksplisitt satt
 * (undefined). Da kan kaller f.eks. bake per-mottaker-URL senere. Sett null
 * for å fjerne den.
 */

// Felttyper der `Svar` er flere selvstendige verdier. Postnummer lagrer
// [postnr, poststed] og Opplasting en filliste — der er element 0 fortsatt
// den ene verdien, ikke det første av flere valg.
const FLERVALGSTYPER = new Set(['Flervalg-dropdown', 'Flervalg-knapper']);

function finnFeltViaRef(seksjoner, seksjonNummer, feltNummer) {
    const sekNr = String(seksjonNummer);
    const seksjon = (seksjoner || []).find(s =>
        String(s.Seksjon_nummer) === sekNr || String(s.Nummer) === sekNr
    );
    if (!seksjon) return null;
    const feltNrPadded = String(feltNummer).padStart(2, '0');
    return (seksjon.Felter || []).find(f => String(f.Nummer).padStart(2, '0') === feltNrPadded) || null;
}

function finnFeltViaId(seksjoner, id) {
    if (!id) return null;
    for (const s of (seksjoner || [])) {
        for (const f of (s.Felter || [])) {
            if (f.Id === id) return f;
        }
    }
    return null;
}

function forsteSvar(felt) {
    if (!felt) return null;
    if (Array.isArray(felt.Svar) && felt.Svar.length > 0 && felt.Svar[0] !== '') {
        return felt.Svar[0];
    }
    return null;
}

/**
 * Alle besvarte verdier i et felt.
 *
 * Et flervalgsfelt kan ha mange — et nedtrekk der kadetten huker av tre klasser
 * gir tre verdier, og alle tre er reelle svar. For alle andre felttyper er det
 * bare den første som er en verdi, så lista kuttes der.
 */
function alleSvarIFelt(felt) {
    if (!Array.isArray(felt?.Svar)) return [];
    const verdier = felt.Svar
        .map(v => (v == null ? '' : String(v)))
        .filter(v => v.trim() !== '');
    return FLERVALGSTYPER.has(String(felt.Type || '')) ? verdier : verdier.slice(0, 1);
}

/**
 * YYYY-MM-DD → DD.MM.YYYY.
 *
 * Holdt identisk med `_formatterDato` i frontend/js/felt-render.js, inkludert
 * prefiks-matchingen: en verdi som bærer klokkeslett bak datoen skal gi samme
 * dato begge steder. Står datoen i et annet format, sendes den uendret videre
 * — en halvtolket dato er verre enn den rå verdien.
 */
function formaterDato(verdi) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(verdi);
    return m ? `${m[3]}.${m[2]}.${m[1]}` : verdi;
}

/**
 * Verdien slik den skal LESES — for e-post, Teams-meldinger og Planner-oppgaver.
 *
 * Skilt fra forsteSvar()/alleSvarIFelt() med vilje. De to brukes også av
 * dynamisk-rolle.js til å slå opp mottakere og av gevinst-sjekk.js til å
 * sammenligne verdier; der må verdien være rå, ellers slutter oppslagene å
 * treffe. Formatering hører bare hjemme der teksten skal leses av et menneske.
 *
 * Bare Dato er dekket. De andre felttypene som pyntes i visningen (Valuta,
 * Fodselsnummer, Kontonummer) lagrer verdier som er lesbare som de er, og
 * ingen har bedt om dem her.
 */
function visningsverdi(felt, verdi) {
    if (verdi == null) return verdi;
    const s = String(verdi);
    return String(felt?.Type || '') === 'Dato' ? formaterDato(s) : s;
}

function finnSvarForFeltRef(seksjoner, seksjonNummer, feltNummer) {
    return forsteSvar(finnFeltViaRef(seksjoner, seksjonNummer, feltNummer));
}

function finnSvarForFeltViaId(seksjoner, id) {
    return forsteSvar(finnFeltViaId(seksjoner, id));
}

function finnAlleSvarForFeltRef(seksjoner, seksjonNummer, feltNummer) {
    return alleSvarIFelt(finnFeltViaRef(seksjoner, seksjonNummer, feltNummer));
}

function finnAlleSvarForFeltViaId(seksjoner, id) {
    return alleSvarIFelt(finnFeltViaId(seksjoner, id));
}

function erstattPlassholdere(streng, kontekst = {}) {
    if (!streng) return '';
    let s = String(streng);

    if (kontekst.lenke !== undefined) {
        s = s.replace(/\$lenke/g, kontekst.lenke == null ? '' : String(kontekst.lenke));
    }

    s = s
        .replace(/\$kommentar/g, kontekst.kommentar || '')
        .replace(/\$beslutning/g, kontekst.beslutning || '')
        .replace(/\$stegnavn/g, kontekst.stegnavn || '')
        .replace(/\$rolle/g, kontekst.rolle || '')
        .replace(/\$skjemanavn/g, kontekst.skjemanavn || '')
        .replace(/\$tidspunkt/g, kontekst.tidspunkt || '')
        .replace(/\$skjema_id/g, kontekst.skjemaId || '')
        .replace(/\$innsender_navn/g, kontekst.innsenderNavn || '')
        .replace(/\$innsender/g, kontekst.innsender || '')
        .replace(/\$dagerTilFrist/g, kontekst.dagerTilFrist == null ? '' : String(kontekst.dagerTilFrist))
        .replace(/\$frist/g, kontekst.frist || '')
        // $navn er utgått. Ingenting har noensinne satt `kontekst.navn`, så
        // den har alltid blitt tom — og den kan ikke fikses her: teksten
        // bygges én gang og går til alle mottakerne i samme flyt-kall.
        //
        // Erstatningen blir likevel stående. Maler skrevet mens den sto i
        // plassholderlista finnes fortsatt, og der er en tom streng bedre enn
        // et rått «$navn» midt i en e-post til en behandler. Den er fjernet
        // fra lista i melding-editoren, så ingen nye maler får den.
        .replace(/\$navn/g, kontekst.navn || '');

    // Feltreferanser — krever kontekst.seksjoner
    if (Array.isArray(kontekst.seksjoner) && kontekst.seksjoner.length > 0) {
        s = s.replace(/\{(\d+)-(\d+)\}/g, (_m, sek, felt) => {
            const f = finnFeltViaRef(kontekst.seksjoner, sek, felt);
            const svar = forsteSvar(f);
            return svar == null ? '' : visningsverdi(f, svar);
        });
        s = s.replace(/\{([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}/gi, (_m, id) => {
            const f = finnFeltViaId(kontekst.seksjoner, id);
            const svar = forsteSvar(f);
            return svar == null ? '' : visningsverdi(f, svar);
        });
    }
    return s;
}

/**
 * Bygg kontekst-objekt fra skjema + skjematype + evt. steg/beslutning.
 * Feltnavnene på skjema.Innsender_Epost/Innsender_Navn kan variere mellom fullt
 * og kompakt format — samleres begge her.
 *
 * $innsender_navn faller tilbake til e-postadressen. Det er ikke pynt:
 * skjemaer lagret før 16.09.2026 har ingen Innsender_Navn i det hele tatt, og
 * eksterne innsendere får aldri et navn — vi kjenner bare adressen deres. Uten
 * fallbacken står det et tomrom midt i en setning i e-posten, og mottakeren har
 * ingen måte å se hvem den gjelder. Adressen er mindre pen og alltid sann.
 */
function byggKontekst({ skjema = {}, skjematype = {}, steg = null, beslutningTekst = null, kommentar = null, lenke = undefined }) {
    const seksjoner = skjema.Seksjoner || [];
    return {
        skjemanavn: skjematype.Skjema_navn || skjema.Skjema_navn || skjema.Overskrift || '',
        skjemaId: skjema.Skjema_id || '',
        innsender: skjema.Innsender_Epost || skjema.Innsender_epost || skjema.Innsender || '',
        innsenderNavn: skjema.Innsender_Navn || skjema.Innsender
            || skjema.Innsender_Epost || skjema.Innsender_epost || '',
        stegnavn: steg?.Stegnavn || '',
        rolle: steg?.Rolle || (Array.isArray(steg?.Roller) ? steg.Roller.join(', ') : ''),
        beslutning: beslutningTekst || '',
        kommentar: kommentar || '',
        tidspunkt: new Date().toLocaleString('no-NO', { timeZone: 'Europe/Oslo' }),
        seksjoner,
        lenke
    };
}

module.exports = {
    erstattPlassholdere,
    byggKontekst,
    finnSvarForFeltRef,
    finnSvarForFeltViaId,
    finnAlleSvarForFeltRef,
    finnAlleSvarForFeltViaId,
    // Eksportert for diagnosen (skjematype-diagnose.js), som må avgjøre om en
    // feltreferanse peker på noe som finnes. Den kunne slått opp selv, men da
    // ville to regler for «hvilket felt er {2-3}?» levd side om side — og den
    // som sjekker ville før eller siden sagt noe annet enn den som henter.
    finnFeltViaRef,
    finnFeltViaId,
    // Eksportert av samme grunn, for feltperson.js: den må se felttypen FØR
    // den leser svarene, og skal lese dem etter nøyaktig samme regel som alle
    // andre — inkludert at bare flervalgstyper gir mer enn én verdi.
    alleSvarIFelt
};
