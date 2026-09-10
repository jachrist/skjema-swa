/**
 * Tester for skillet mellom «flyten kom aldri fram» og «flyten feilet».
 *
 * Purringen markerte alle kandidater som purret også når flyten feilet, «så vi
 * ikke spammer neste kjøring». Den begrunnelsen forutsetter at flyten kan ha
 * rukket å sende noe. Med en slettet flyt-adresse — som var tilfellet i alle
 * miljøer 10.09.2026 — stemte det ikke: purringen ble brukt opp i stillhet,
 * ingen fikk e-post, og cron-jobben forble grønn fordi endepunktet svarte 200.
 *
 * Skillet må derfor være riktig begge veier, og feilene er ikke like alvorlige:
 *
 *   Sier vi «kom ikke fram» om noe som faktisk kom fram → doble purringer.
 *   Sier vi «kom fram» om noe som ikke gjorde det       → tapt purring, stille.
 *
 * Den siste er den vi kom fra, og den ingen oppdager.
 *
 * Kjøres med:  node api/test/flyt-utfall.test.js
 */
const { svarKomFram, feilKomFram } = require('../src/lib/flyt-utfall');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

// ---------- avvist før flyten kjørte ----------
{
    // 404/410: flyten finnes ikke. Dette var den faktiske situasjonen.
    sjekk('404 kom ikke fram', svarKomFram(404), false);
    sjekk('410 kom ikke fram', svarKomFram(410), false);
    // 401/403: signaturen i adressen ble avvist — flyten startet aldri.
    sjekk('401 kom ikke fram', svarKomFram(401), false);
    sjekk('403 kom ikke fram', svarKomFram(403), false);
}

// ---------- flyten kjørte, og feilet ----------
{
    // En flyt som svarer 500 kan ha sendt til halve lista før den stoppet.
    // Vi vet ikke til hvem, så en ny runde ville truffet noen to ganger.
    sjekk('500 kom fram', svarKomFram(500), true);
    sjekk('502 kom fram', svarKomFram(502), true);
    sjekk('429 kom fram', svarKomFram(429), true);
    sjekk('400 kom fram', svarKomFram(400), true);
}

{
    // Statusen kommer fra fetch som tall, men skal tåle en streng.
    sjekk('streng-status teller likt', svarKomFram('404'), false);
    sjekk('og for en som kom fram', svarKomFram('500'), true);
}

// ---------- feil uten svar ----------
{
    // Vår EGEN tidsavbrytelse. Flyten har fått forespørselen og kan holde på
    // å sende — behandler vi det som «ikke sendt», får trege flyter doble
    // purringer hver gang.
    sjekk('timeout regnes som framme', feilKomFram({ name: 'AbortError' }), true);
}

{
    // Nettverksfeil: forespørselen nådde aldri en flyt.
    for (const e of [new Error('ENOTFOUND'), new TypeError('fetch failed'),
                     { name: 'FetchError', message: 'ECONNREFUSED' }]) {
        sjekk(`${e.name || 'ukjent'} kom ikke fram`, feilKomFram(e), false);
    }
    sjekk('uten feilobjekt i det hele tatt', feilKomFram(null), false);
    sjekk('undefined likeså', feilKomFram(undefined), false);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
