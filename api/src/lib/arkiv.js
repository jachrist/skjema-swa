/**
 * Arkivering av skjemaer: eksporter, verifiser, slett.
 *
 * Formålet er å FRIGJØRE LAGRING. Arkivet er ikke et tillegg til slettingen —
 * det er det som gjør slettingen forsvarlig, og derfor må det være komplett.
 * Table Storage har hverken soft delete eller point-in-time restore. Det som
 * slettes her, finnes etterpå bare i fila brukeren lastet ned.
 *
 * En sak ligger tre steder, og et arkiv som bare tar det første er ikke et
 * arkiv:
 *
 *   Skjemaer-tabellen   svarene, behandlingen, Dialog
 *   Samtale-tabellen    gruppechatten (egen tabell siden 18.09.2026)
 *   vedlegg-containeren filene
 *
 * Vedleggene er dessuten trolig det som faktisk tar plass: et skjema er
 * titusener av tegn, et vedlegg kan være megabyte. Slettes bare tabellradene,
 * er lagringsgevinsten liten — og vedleggene blir foreldreløse.
 *
 * KLARTEKST. Arkivet skrives dekryptert. Det følger av formålet: fila skal
 * kunne leses av rapportmotoren og av Power BI, og en kryptert blob kan ingen
 * av dem. Nøklene roteres dessuten (`nokkel.js`), så et kryptert arkiv ville
 * blitt uleselig av seg selv over tid. Følgen må sies høyt: fila inneholder
 * personopplysninger i klartekst og må behandles deretter.
 */
const crypto = require('crypto');

/** Skjemastatus 5 = Avsluttet. Bare ferdigbehandlede saker kan arkiveres. */
const AVSLUTTET = 5;

/**
 * Kan dette skjemaet arkiveres?
 *
 * To krav, og det andre er det som gjør operasjonen forutsigbar:
 *
 *   Saken må være avsluttet. Et skjema under behandling har en behandler som
 *   venter på det, og en innsender som følger det.
 *
 *   Den må være eldre enn grensen. Uten en dato ville «arkiver» betydd
 *   «slett alt som er ferdig», inkludert saken som ble avsluttet i går og
 *   som noen fortsatt ser på.
 *
 * Mangler datoen på skjemaet, arkiveres det ikke. Vi vet da ikke hvor gammelt
 * det er, og «vet ikke» skal ikke bety «slett».
 */
function kanArkiveres(skjema, foerDato) {
    if (Number(skjema?.Skjema_status || 0) !== AVSLUTTET) return false;
    const dato = String(skjema?.Sist_endret || skjema?.Oppdatert || '');
    if (!dato) return false;
    if (!foerDato) return false;
    return dato < String(foerDato);
}

/**
 * Sjekksum over innholdet i et arkiv.
 *
 * Brukes til å binde slettingen til fila brukeren faktisk har. Den beregnes
 * over skjema-ID-ene og antallet, ikke over hele JSON-en: nøkkelrekkefølge og
 * mellomrom skal ikke kunne gjøre en gyldig fil ugyldig.
 */
function sjekksum(skjemaIder) {
    const sortert = [...new Set((skjemaIder || []).map(String))].sort();
    return crypto.createHash('sha256')
        .update(sortert.length + ':' + sortert.join(','))
        .digest('hex')
        .slice(0, 32);
}

/** Arkiv-ID: tidsstempel først, så skjematype. Sorterer kronologisk i tabellen. */
function arkivId(skjematypeId, dato = new Date()) {
    return `${dato.toISOString().replace(/[:.]/g, '-')}_${skjematypeId}`;
}

/**
 * Sett sammen arkivet.
 *
 * `vedlegg` er et kart fra skjema-ID til `[{ filnavn, innhold }]` (base64).
 * Er det tomt, står `MedVedlegg: false` i manifestet — og da skal slettingen
 * la vedleggene ligge. Et arkiv som ikke inneholder vedleggene, gir ikke rett
 * til å slette dem.
 */
function byggArkiv({ skjematype, skjemaer, samtaler = {}, vedlegg = {}, foerDato, arkivertAv, dato = new Date() }) {
    const ider = (skjemaer || []).map(s => String(s.Skjema_id));
    const medVedlegg = Object.values(vedlegg).some(v => (v || []).length > 0);
    return {
        Manifest: {
            ArkivId: arkivId(skjematype?.Skjematype_id ?? '', dato),
            Skjematype_id: String(skjematype?.Skjematype_id ?? ''),
            Skjema_navn: skjematype?.JSON?.Skjema_navn || '',
            Arkivert: dato.toISOString(),
            ArkivertAv: String(arkivertAv || ''),
            FoerDato: String(foerDato || ''),
            Antall: ider.length,
            AntallSamtaleinnlegg: Object.values(samtaler).reduce((n, v) => n + (v || []).length, 0),
            AntallVedlegg: Object.values(vedlegg).reduce((n, v) => n + (v || []).length, 0),
            MedVedlegg: medVedlegg,
            Sjekksum: sjekksum(ider),
            // Sies i selve fila, ikke bare i grensesnittet: den som finner
            // arkivet om to år har ikke sett skjermbildet.
            Merknad: 'Inneholder personopplysninger i klartekst. Skjemaene er slettet fra systemet.'
        },
        Skjematype: skjematype?.JSON || null,
        Skjemaer: skjemaer || [],
        Samtaler: samtaler,
        Vedlegg: vedlegg
    };
}

/**
 * Er dette arkivet det manifestet beskriver?
 *
 * Kalles før sletting, med sjekksummen klienten har lest ut av den nedlastede
 * fila. Uten den kunne noen slette på grunnlag av et arkiv som aldri kom fram
 * — og det er nettopp den feilen som ikke kan rettes etterpå.
 */
function verifiser(manifest, oppgittSjekksum, skjemaIder) {
    if (!manifest) return { ok: false, grunn: 'Arkivet finnes ikke' };
    if (!oppgittSjekksum) return { ok: false, grunn: 'Mangler sjekksum fra den nedlastede fila' };
    if (String(manifest.Sjekksum) !== String(oppgittSjekksum)) {
        return { ok: false, grunn: 'Sjekksummen stemmer ikke med arkivet' };
    }
    // Radene som faktisk står i tabellen nå, mot dem arkivet tok. Er det kommet
    // til nye siden eksporten, skal de ikke slettes med.
    const iArkiv = new Set((manifest.SkjemaIder || []).map(String));
    const uventet = (skjemaIder || []).map(String).filter(id => !iArkiv.has(id));
    if (uventet.length > 0) {
        return { ok: false, grunn: `${uventet.length} skjema er ikke med i arkivet`, uventet };
    }
    return { ok: true };
}

module.exports = { kanArkiveres, sjekksum, arkivId, byggArkiv, verifiser, AVSLUTTET };
