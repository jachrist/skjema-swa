/**
 * Placeholder-substitusjon for meldingsutforming.
 *
 * Støttede plassholdere (samme som legacy):
 *   $lenke              — URL til skjema/kvittering (kontekst.lenke)
 *   $innsender          — e-post
 *   $innsender_navn     — navn
 *   $skjemanavn         — Skjema_navn / Overskrift
 *   $skjema_id          — Skjema_id
 *   $beslutning         — beslutning-tekst
 *   $kommentar          — behandler-kommentar
 *   $stegnavn           — steg.Stegnavn
 *   $rolle              — rolle-streng (f.eks. "Emneansvarlig(CBU2501)")
 *   $tidspunkt          — dato/tid (ISO eller lokalisert)
 *   $navn               — mottakerens navn (per mottaker)
 *   $frist              — frist-dato hvis satt
 *   $dagerTilFrist      — antall dager
 *
 * Feltreferanser:
 *   {N-NN}   posisjonell (seksjon-felt)
 *   {UUID}   stabil Id
 *
 * VIKTIG: $lenke beholdes uendret hvis kontekst.lenke ikke er eksplisitt satt
 * (undefined). Da kan kaller f.eks. bake per-mottaker-URL senere. Sett null
 * for å fjerne den.
 */

function finnSvarForFeltRef(seksjoner, seksjonNummer, feltNummer) {
    const sekNr = String(seksjonNummer);
    const seksjon = (seksjoner || []).find(s =>
        String(s.Seksjon_nummer) === sekNr || String(s.Nummer) === sekNr
    );
    if (!seksjon) return null;
    const feltNrPadded = String(feltNummer).padStart(2, '0');
    const felt = (seksjon.Felter || []).find(f => String(f.Nummer).padStart(2, '0') === feltNrPadded);
    if (!felt) return null;
    if (Array.isArray(felt.Svar) && felt.Svar.length > 0 && felt.Svar[0] !== '') {
        return felt.Svar[0];
    }
    return null;
}

function finnSvarForFeltViaId(seksjoner, id) {
    if (!id) return null;
    for (const s of (seksjoner || [])) {
        for (const f of (s.Felter || [])) {
            if (f.Id === id) {
                if (Array.isArray(f.Svar) && f.Svar.length > 0 && f.Svar[0] !== '') return f.Svar[0];
                return null;
            }
        }
    }
    return null;
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
        .replace(/\$navn/g, kontekst.navn || '');

    // Feltreferanser — krever kontekst.seksjoner
    if (Array.isArray(kontekst.seksjoner) && kontekst.seksjoner.length > 0) {
        s = s.replace(/\{(\d+)-(\d+)\}/g, (_m, sek, felt) => {
            const svar = finnSvarForFeltRef(kontekst.seksjoner, sek, felt);
            return svar == null ? '' : String(svar);
        });
        s = s.replace(/\{([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}/gi, (_m, id) => {
            const svar = finnSvarForFeltViaId(kontekst.seksjoner, id);
            return svar == null ? '' : String(svar);
        });
    }
    return s;
}

/**
 * Bygg kontekst-objekt fra skjema + skjematype + evt. steg/beslutning.
 * Feltnavnene på skjema.Innsender_Epost/Innsender_Navn kan variere mellom fullt
 * og kompakt format — samleres begge her.
 */
function byggKontekst({ skjema = {}, skjematype = {}, steg = null, beslutningTekst = null, kommentar = null, lenke = undefined }) {
    const seksjoner = skjema.Seksjoner || [];
    return {
        skjemanavn: skjematype.Skjema_navn || skjema.Skjema_navn || skjema.Overskrift || '',
        skjemaId: skjema.Skjema_id || '',
        innsender: skjema.Innsender_Epost || skjema.Innsender_epost || skjema.Innsender || '',
        innsenderNavn: skjema.Innsender_Navn || skjema.Innsender || '',
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
    finnSvarForFeltViaId
};
