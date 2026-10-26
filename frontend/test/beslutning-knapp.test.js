/**
 * Bekreft-knappen i beslutningsdialogen.
 *
 * Meldt fra opplæringen 18.09.2026: knappen sto med bare beslutningens navn,
 * og leste som «godta kommentaren» for den som nettopp hadde skrevet i
 * kommentarfeltet rett over. Et valg som heter «Godkjenn» er en uheldig
 * knappetekst når kommentaren gjelder et avslag.
 *
 * To ting testes:
 *
 *   **Knappen sier hva den gjør.** «Registrer «Avvis»» kan ikke leses som noe
 *   annet enn det den er. Bare «Avvis» kan det.
 *
 *   **Fargen følger valget.** Et avslag bekreftes med rød knapp. Fargen leses
 *   før teksten, og dette er siste stopp før beslutningen er registrert.
 *
 * `erAvvisning` brukes to steder — beslutningsknappen på siden og
 * bekreft-knappen i dialogen. Testen finnes fordi de to aldri skal si ulike
 * ting om samme valg; før 18.09.2026 lå heuristikken inline ett av stedene.
 *
 * Kjøres med:  node frontend/test/beslutning-knapp.test.js
 */
const fs = require('fs');
const path = require('path');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const kilde = fs.readFileSync(path.join(__dirname, '..', 'evaluering.html'), 'utf8');

// ---------- erAvvisning ----------
const start = kilde.indexOf('function erAvvisning(');
sjekk('fant erAvvisning', start !== -1, true);
const slutt = kilde.indexOf('\n        }', start) + '\n        }'.length;
// `erAvvisning` delegerer til `typeFor` i js/behandling-utfall.js siden
// 26.10.2026 — den var en fjerde kopi av «hva er negativt», og den smaleste.
// Den EKTE typeFor sendes inn, ikke en etterligning: en håndskrevet kopi her
// ville vært enda en kopi, og testen ville sluttet å si noe om den som
// faktisk kjører.
const typeForKilde = fs.readFileSync(
    path.join(__dirname, '..', 'js', 'behandling-utfall.js'), 'utf8');
const tfStart = typeForKilde.indexOf('export function typeFor(');
const tfSlutt = typeForKilde.indexOf('\n}', tfStart) + 2;
const typeFor = new Function(
    `${typeForKilde.slice(tfStart, tfSlutt).replace('export ', '')}\nreturn typeFor;`)();
const erAvvisning = new Function(
    `const typeFor = arguments[0];\n${kilde.slice(start, slutt)}\nreturn erAvvisning;`)(typeFor);

sjekk('avslå', erAvvisning('Avslått'), true);
sjekk('avvis', erAvvisning('Avvis'), true);
sjekk('stor forbokstav spiller ingen rolle', erAvvisning('AVVIST'), true);
sjekk('godkjenn er ikke avvisning', erAvvisning('Godkjenn'), false);
// «Send tilbake» avslutter ikke saken negativt — den ber om mer. Rød knapp
// der ville sagt noe annet enn det som skjer.
sjekk('send tilbake er ikke avvisning', erAvvisning('Send tilbake'), false);
// Kom til med modulen: et skjema med «Anbefalt»/«Ikke anbefalt» fikk blå
// knapp på avslaget, fordi den gamle regelen bare kjente «avslå» og «avvis».
sjekk('ikke anbefalt er avvisning', erAvvisning('Ikke anbefalt'), true);
sjekk('ikke godkjent er avvisning', erAvvisning('Ikke godkjent'), true);
// Men ikke alt som begynner på «ikke» er et avslag.
sjekk('ikke relevant er ikke avvisning', erAvvisning('Ikke relevant'), false);
sjekk('tom tekst', erAvvisning(''), false);
sjekk('undefined', erAvvisning(undefined), false);

// ---------- knappeteksten ----------
{
    // Klipp ut kallet slik det står, og les argumentene ut av det.
    const kall = kilde.slice(kilde.indexOf('async function taBeslutning('));
    const bekreftTekst = /bekreftTekst:\s*(.+),/.exec(kall)?.[1] || '';
    const bekreftStil = /bekreftStil:\s*(.+),/.exec(kall)?.[1] || '';

    // Verbet må være der. Uten det er knappen bare valgets navn igjen.
    sjekk('knappeteksten har et verb', /Registrer/.test(bekreftTekst), true);
    // ... og valget må fortsatt være med: du skal kunne lese knappen alene og
    // vite hva du er i ferd med å registrere.
    sjekk('knappeteksten har med valget', /\$\{tekst\}/.test(bekreftTekst), true);

    sjekk('stilen avgjøres av erAvvisning', /erAvvisning\(tekst\)/.test(bekreftStil), true);
    sjekk('avvisning gir danger', /danger/.test(bekreftStil), true);
}

// ---------- stilene finnes ----------
{
    // bekreftStil settes som klassenavn på knappen. Er klassen ikke definert,
    // blir knappen umerket uten at noe feiler.
    sjekk('.modal-knapp.danger finnes', /\.modal-knapp\.danger\s*\{/.test(kilde), true);
    sjekk('.modal-knapp.primær finnes', /\.modal-knapp\.primær\s*\{/.test(kilde), true);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
