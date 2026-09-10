/**
 * Kom kallet fram til flyten, eller ikke?
 *
 * Purringen markerer alle kandidater som purret også når flyten feiler, «så vi
 * ikke spammer neste kjøring». Den begrunnelsen holder bare hvis flyten kan ha
 * rukket å sende noe. En adresse som ikke finnes har ikke sendt noe — og da
 * betyr markeringen at purringen er brukt opp uten at noen fikk beskjed.
 *
 * Skillet er derfor ikke «gikk det bra», men «ble flyten utført i det hele
 * tatt»:
 *
 *   Kom IKKE fram   ingenting er sendt. Ikke marker — la radene stå til neste
 *                   kjøring, og la jobben feile synlig.
 *   Kom fram        flyten kan ha sendt noe, kanskje til bare halve lista.
 *                   Marker som før; en tapt purring er bedre enn en dobbel.
 *
 * Modulen er ren og uten avhengigheter, så den kan testes uten node_modules —
 * det er dette skillet som avgjør om en purring går tapt i stillhet.
 */

/**
 * HTTP-statuser der Power Automate avviser kallet FØR flyten kjører.
 *
 * 404/410 — flyten finnes ikke (slettet, eller adressen er feil).
 * 401/403 — signaturen i adressen ble avvist.
 *
 * Alt annet, 500 inkludert, betyr at flyten faktisk startet. Da kan den ha
 * sendt til noen før den feilet, og vi vet ikke til hvem.
 */
const AVVIST_FOER_KJORING = new Set([401, 403, 404, 410]);

function svarKomFram(status) {
    return !AVVIST_FOER_KJORING.has(Number(status));
}

/**
 * Feil der kallet aldri nådde fram — DNS, nektet tilkobling, brutt forbindelse.
 *
 * Unntaket er vår egen tidsavbrytelse. `AbortController` stopper kallet på VÅR
 * side etter 35 sekunder; flyten har da fått forespørselen og kan godt holde
 * på å sende. Å behandle det som «ikke sendt» ville gitt doble purringer hver
 * gang flyten er treg.
 */
function feilKomFram(error) {
    return error?.name === 'AbortError';
}

module.exports = { svarKomFram, feilKomFram, AVVIST_FOER_KJORING };
