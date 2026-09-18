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
 * Samtale-innstillingen på skjematypen (`Skjematype.Samtale`).
 *
 *   'Av'         — ingen samtale på denne skjematypen
 *   'Behandlere' — bare behandlere kan skrive det FØRSTE innlegget.
 *                  Innsender kan svare når tråden finnes.
 *   'Alle'       — innsender kan også starte, via kvitteringen
 *
 * `Av` er standard, og det er et bevisst valg: skjematypene som allerede
 * ligger i produksjon skal ikke plutselig få en samtaleflate fordi vi rullet
 * ut en ny funksjon. Eieren av skjematypen slår den på.
 *
 * Uten behandlingssteg er svaret alltid `Av`, uansett hva som står lagret.
 * En samtale mellom innsender og behandlere krever at det finnes en behandler
 * — ellers er det en meldingsboks ingen leser.
 */
const INNSTILLINGER = ['Av', 'Behandlere', 'Alle'];

function samtaleInnstilling(skjematype) {
    const steg = skjematype?.Behandling;
    if (!Array.isArray(steg) || steg.length === 0) return 'Av';
    const valgt = String(skjematype?.Samtale || '').trim();
    return INNSTILLINGER.includes(valgt) ? valgt : 'Av';
}

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

/**
 * Kan denne deltakeren skrive akkurat nå?
 *
 * `antallInnlegg` er det som avgjør «hvem kan starte». I en gruppechat finnes
 * det ikke noe eget startpunkt — det første innlegget ER starten. Så regelen
 * er ikke «hvem kan opprette en tråd», men «hvem kan skrive når tråden er
 * tom».
 *
 * Behandlere, eiere og administratorer kan alltid skrive i en åpen samtale.
 * Innsenderen kan svare så snart noen har skrevet, og kan starte selv bare når
 * skjematypen står på `Alle`.
 */
function kanSkrive({ rolle, innstilling, antallInnlegg = 0, apen = true }) {
    if (innstilling === 'Av' || !apen || !rolle) return false;
    if (rolle !== 'innsender') return true;
    return innstilling === 'Alle' || Number(antallInnlegg) > 0;
}

/**
 * Skal samtalen vises for denne deltakeren i det hele tatt?
 *
 * En innsender som verken kan skrive eller har noe å lese, skal ikke se en
 * låst boks. Da lurer hen på hva den er og hvorfor den ikke virker — og det
 * er verre enn at den ikke er der.
 *
 * En LUKKET samtale med innhold vises fortsatt, for begge parter. Det er hele
 * poenget med at den følger saken.
 */
function samtaleErSynlig({ rolle, innstilling, antallInnlegg = 0, apen = true }) {
    if (innstilling === 'Av' || !rolle) return false;
    if (Number(antallInnlegg) > 0) return true;
    return kanSkrive({ rolle, innstilling, antallInnlegg, apen });
}

module.exports = {
    samtaleErAapen, eksternErInnsender, kanDempe, finnDeltaker,
    samtaleInnstilling, kanSkrive, samtaleErSynlig, INNSTILLINGER
};
