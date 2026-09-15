/**
 * Banneret i admin som sier at miljøet ikke sender varslinger.
 *
 * Bakgrunnen: `VARSLING_DEAKTIVERT=true` sto igjen fra en tidligere test på
 * dev 15.09.2026. Koden bygde payloaden, logget den, og sendte aldri — og i
 * grensesnittet så det ut som en vellykket sending. Det kostet en
 * feilsøkingsrunde på en Planner-oppgave som aldri ble opprettet.
 *
 * Banneret skal si fra av seg selv. Da må to ting holde, og de trekker i
 * hver sin retning:
 *
 *   Er sendingen av, SKAL det stå der — det er hele poenget.
 *   Er den på, skal det IKKE stå der. Et banner som står støtt i prod
 *   slutter å bli lest, og da hjelper det ingen den dagen det gjelder.
 *
 * Testen klipper funksjonen ut av admin.html og kjører den direkte, uten
 * DOM — `bannerTekst` er skilt fra `visVarselbanner` nettopp for å kunne
 * prøves slik.
 *
 * Kjøres med:  node frontend/test/varselbanner.test.js
 */
const fs = require('fs');
const path = require('path');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const kilde = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
const start = kilde.indexOf('function bannerTekst(');
if (start === -1) throw new Error('Fant ikke bannerTekst i admin.html');
const slutt = kilde.indexOf('\n        }', start) + '\n        }'.length;
const bannerTekst = new Function(`${kilde.slice(start, slutt)}\nreturn bannerTekst;`)();

// ---------- skal vises ----------
{
    const t = bannerTekst({ varsling_av: true, sender_ikke: true });
    sjekk('tørrkjøring gir banner', typeof t === 'string' && t.length > 0, true);
    sjekk('nevner bryteren', t.includes('VARSLING_DEAKTIVERT'), true);

    const u = bannerTekst({ varsling_av: false, sender_ikke: true });
    sjekk('manglende URL gir banner', typeof u === 'string' && u.length > 0, true);
    sjekk('nevner URL-en', u.includes('VARSLING_FLOW_URL'), true);

    // De to årsakene skal ikke gi samme tekst — den som leser banneret skal
    // vite hvilken av dem det er uten å åpne Azure.
    sjekk('ulik tekst for de to årsakene', t !== u, true);
}

// ---------- skal IKKE vises ----------
{
    sjekk('alt i orden', bannerTekst({ varsling_av: false, sender_ikke: false }), null);
    sjekk('tomt svar', bannerTekst({}), null);
    sjekk('ingen diagnose', bannerTekst(null), null);
    sjekk('undefined', bannerTekst(undefined), null);
}

// ---------- tørrkjøring vinner over manglende URL ----------
{
    // Er begge sanne, er bryteren den mest presise forklaringen: URL-en kan
    // være satt helt riktig, og likevel sendes ingenting.
    const t = bannerTekst({ varsling_av: true, sender_ikke: true });
    sjekk('bryteren nevnes først', t.includes('VARSLING_DEAKTIVERT'), true);
    sjekk('og ikke URL-en', t.includes('VARSLING_FLOW_URL'), false);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
