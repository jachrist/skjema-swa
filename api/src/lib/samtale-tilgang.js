/**
 * Hvem er deltaker i samtalen, og når er den åpen?
 *
 * Samtalen er en gruppechat mellom innsenderen og behandlerne. Det finnes
 * ingen interne innlegg — alt en deltaker skriver, ser alle deltakerne. Derfor
 * er det bare ett tilgangsspørsmål her: er du deltaker eller ikke.
 *
 * Regelen for hvem som er deltaker er den samme som for saken selv
 * (`tilgangsRolle` i `dialog-tilgang.js`). Har du tilgang til skjemaet, er du
 * med. Det inkluderer behandlere fra tidligere steg: én tråd per skjema betyr
 * at den som avgjorde steg 1 fortsatt kan lese og skrive på steg 3.
 * Alternativet — å kaste folk ut av en samtale de har deltatt i — er verre, og
 * PDF-tilgangen fungerer allerede slik.
 */
const { tilgangsRolle } = require('./dialog-tilgang');

/**
 * Er samtalen åpen for nye innlegg?
 *
 *   1 Mellomlagret     — skjemaet er ikke sendt inn. Ingen behandler finnes
 *                        ennå, så det er ingen å snakke med.
 *   2 Under behandling — åpen
 *   3 Til revidering   — åpen. Dette er nettopp når det er mest å snakke om.
 *   5 Avsluttet        — lukket. Samtalen følger saken i PDF-en.
 *
 * Ukjent status regnes som lukket. Skulle en ny statuskode dukke opp, skal den
 * ikke åpne en samtale ved et uhell.
 */
function samtaleErAapen(skjema) {
    const status = Number(skjema?.Skjema_status || 0);
    return status === 2 || status === 3;
}

/** Er denne eksterne identiteten innsenderen på saken? */
function eksternErInnsender(skjema, eksternId) {
    const id = String(eksternId || '').trim().toLowerCase();
    if (!id) return false;
    const innsender = String(skjema?.Innsender_Epost || skjema?.Innsender_epost || '').trim().toLowerCase();
    return !!innsender && innsender === id;
}

/**
 * Hvem kan dempe varsling for en sak?
 *
 * Behandlere, eiere og administratorer. Ikke innsenderen: hen har ett varsel å
 * forholde seg til om sin egen sak, og må være mulig å nå. En innsender som
 * demper seg selv og siden lurer på hvorfor ingen svarte, er en verre feil enn
 * ett varsel for mye.
 */
function kanDempe(rolle) {
    return rolle === 'behandler' || rolle === 'eier' || rolle === 'admin';
}

/**
 * Finn deltakeren bak denne requesten, eller null.
 *
 * `eksternId` kommer fra et OTP- eller utsendings-token og er allerede
 * verifisert av kalleren. Den gir kun innsender-rollen, og bare på den saken
 * identiteten faktisk er innsender på — et gyldig token for én sak skal ikke
 * gi innpass i en annen.
 */
async function finnDeltaker({ skjema, skjematypeId, upn = null, eksternId = null, navn = '', kilde = 'swa' }) {
    if (eksternId) {
        if (!eksternErInnsender(skjema, eksternId)) return null;
        return { id: String(eksternId).toLowerCase(), navn: navn || '', rolle: 'innsender', kilde };
    }
    if (!upn) return null;
    const rolle = await tilgangsRolle(skjema, skjematypeId, upn);
    if (!rolle) return null;
    return { id: String(upn).toLowerCase(), navn: navn || '', rolle, kilde: 'swa' };
}

module.exports = { samtaleErAapen, eksternErInnsender, kanDempe, finnDeltaker };
