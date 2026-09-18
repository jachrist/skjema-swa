/**
 * Hvilken vei kom denne requesten inn?
 *
 * Tre autentiseringsveier, og rekkefølgen mellom dem er en regel som må finnes
 * ett sted:
 *   1. utsendings-token — en konkret invitasjon til én mottaker
 *   2. OTP-token       — brukeren har verifisert seg som ekstern
 *   3. SWA-cookie      — det som ligger igjen
 *
 * Lå i `functions/skjemaer.js` og gjaldt bare der. Samtale-endepunktene
 * trenger den samme regelen, og en kopi nummer to ville før eller siden tatt
 * en annen avgjørelse enn den første — akkurat slik dialogfilteret gjorde,
 * med en lekkasje som resultat.
 */
const otpToken = require('./otp-token');
const skjemaStorage = require('./skjema-storage');

/**
 * Har requesten et OTP-token?
 *
 * Et `x-otp-token` er et eksplisitt valg: brukeren har nettopp verifisert seg
 * som ekstern innsender for denne skjematypen. En SWA-cookie i samme nettleser
 * er derimot bare noe som ligger der — typisk fordi den som tester flyten også
 * er innlogget som seg selv.
 *
 * Derfor må tokenet gå foran cookien. Uten det ble ekstern innsending avvist
 * med «Ingen tilgang til denne skjematypen» så snart nettleseren hadde en
 * SWA-sesjon — og feilen traff bare dem som testet fra egen maskin, altså
 * nesten alltid oss selv og aldri den eksterne brukeren.
 */
function harOtpToken(request) {
    return !!request?.headers?.get?.('x-otp-token');
}

/** 'utsending' | 'ekstern' | 'innlogget' */
function velgAuthvei(request, upn) {
    if (request?.headers?.get?.('x-utsending-token')) return 'utsending';
    if (harOtpToken(request)) return 'ekstern';
    return upn ? 'innlogget' : 'ekstern';
}

async function autentiserEkstern(request, skjematypeId) {
    const token = request?.headers?.get?.('x-otp-token');
    if (!token) return { ok: false };
    const v = otpToken.valider(token);
    if (!v.gyldig) return { ok: false, melding: v.melding };
    const st = await skjemaStorage.hentSkjematype(skjematypeId);
    if (!st?.JSON?.EksternTilgang) return { ok: false, melding: 'Skjematype tillater ikke ekstern innsender' };
    return { ok: true, mottaker: v.mottaker, kanal: v.kanal };
}

/**
 * Identiteten en ekstern innsender får i innsender-feltet.
 *
 * E-post går rett inn; mobilnummer merkes med prefiks for å ikke forveksles
 * med en reell e-postadresse i register, PDF og samtale.
 */
function eksternInnsenderUpn(mottaker, kanal) {
    return kanal === 'sms' ? `mobil:${mottaker}` : String(mottaker).toLowerCase();
}

module.exports = { harOtpToken, velgAuthvei, autentiserEkstern, eksternInnsenderUpn };
