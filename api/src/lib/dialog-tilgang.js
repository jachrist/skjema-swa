/**
 * Hvem er denne brukeren i denne saken — og hva får hen se av dialogen?
 *
 * Regelen lå inne i `skjemaer.js` og gjaldt bare der. PDF-endepunktet hentet
 * det samme skjemaet, dekrypterte det og sendte det uavkortet til
 * `pdf-generator.js`, som skriver en egen «Intern dialog»-seksjon. Innsender
 * har tilgang til PDF-en for sin egen sak. Resultatet var at behandlernes
 * interne drøfting var skjult i grensesnittet og utlevert i PDF-en.
 *
 * Det er ikke to ulike regler som var uenige — det var én regel som bare fantes
 * ett av stedene. Derfor ligger den her nå, og begge veiene kaller den.
 *
 * Rekkefølgen i `tilgangsRolle` er bevisst: innsender sjekkes FØR eier og
 * behandler. Er man begge deler, regnes man som innsender, og ser mindre. Det
 * er riktig vei å ta feil på.
 */
const { erAdmin } = require('./auth');
const skjemaStorage = require('./skjema-storage');
const { filtrerTyperPåTilgang } = require('./tilgang');
const { brukerErBehandlerAsync } = require('./behandling');

/** 'admin' | 'innsender' | 'eier' | 'behandler' | null */
async function tilgangsRolle(skjema, skjematypeId, upn) {
    if (!upn) return null;
    if (erAdmin(upn)) return 'admin';
    const upnLower = String(upn).toLowerCase();
    if ((skjema?.Innsender_Epost || '').toLowerCase() === upnLower) return 'innsender';

    const st = await skjemaStorage.hentSkjematype(skjematypeId);
    if (!st) return null;
    const eier = await filtrerTyperPåTilgang([st], upn, 'Eiere');
    if (eier.length > 0) return 'eier';

    if (Array.isArray(skjema?.Behandling)) {
        for (const steg of skjema.Behandling) {
            if (await brukerErBehandlerAsync(steg, upn)) return 'behandler';
        }
    }
    return null;
}

/**
 * Fjern interne dialog-innlegg hvis rollen ikke skal se dem.
 *
 * Endrer skjemaet på stedet — det er allerede en kopi lest fra lagringen, og
 * en ny kopi her ville bare gitt to objekter der det ene er farlig å bruke.
 *
 * Ukjent rolle (null) behandles som innsender. Skulle noen slippe forbi
 * tilgangssjekken uten en rolle vi kjenner, skal de ikke få MER enn innsender.
 */
function skjulInterneInnlegg(skjema, rolle) {
    if (rolle && rolle !== 'innsender') return skjema;
    if (Array.isArray(skjema?.Dialog) && skjema.Dialog.length > 0) {
        skjema.Dialog = skjema.Dialog.filter(d => (d.Type || d.DialogType) !== 'intern');
    }
    return skjema;
}

module.exports = { tilgangsRolle, skjulInterneInnlegg };
