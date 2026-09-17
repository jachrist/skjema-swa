/**
 * Datofelt i plassholdere skrives på norsk form.
 *
 * `<input type="date">` lagrer YYYY-MM-DD. Det er et maskinformat: i en e-post
 * eller en Planner-oppgave leses «2026-09-17» som en feil, ikke som 17.
 * september. Visningen har alltid formattert det (felt-render.js), men
 * meldingene gikk ut med den rå verdien.
 *
 * Den andre halvdelen av testen er den viktige på sikt: verdien skal IKKE
 * formatteres der den brukes til oppslag. dynamisk-rolle.js bygger
 * rollestrenger av feltverdier og gevinst-sjekk.js sammenligner dem — punktum
 * i stedet for bindestrek gjør at de slutter å treffe, stille, uten at noe
 * feiler. Derfor går formateringen bare gjennom erstattPlassholdere().
 *
 * Kjøres med:  node api/test/plassholder-dato.test.js
 */
const {
    erstattPlassholdere,
    finnSvarForFeltRef,
    finnSvarForFeltViaId,
    finnAlleSvarForFeltRef
} = require('../src/lib/placeholder');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const DATO_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

const seksjoner = [{
    Seksjon_nummer: 1,
    Felter: [
        { Id: DATO_ID, Nummer: '01', Type: 'Dato', Svar: ['2026-09-17'] },
        { Nummer: '02', Type: 'Tekst', Svar: ['2026-09-17'] },
        { Nummer: '03', Type: 'Dato', Svar: ['2026-09-17T08:30:00Z'] },
        { Nummer: '04', Type: 'Dato', Svar: ['17. september'] },
        { Nummer: '05', Type: 'Dato', Svar: [] },
        { Nummer: '06', Type: 'Flervalg-dropdown', Svar: ['ING2501', 'ING2502'] }
    ]
}];
const k = { seksjoner };

// ---------- formateres i meldingstekst ----------
sjekk('dato via posisjon', erstattPlassholdere('Reisedato: {1-01}', k), 'Reisedato: 17.09.2026');
sjekk('dato via felt-Id', erstattPlassholdere(`Dato: {${DATO_ID}}`, k), 'Dato: 17.09.2026');

// Et Tekst-felt som tilfeldigvis inneholder en dato er ikke et datofelt.
// Innsenderen skrev den selv, og skal få den tilbake slik den ble skrevet.
sjekk('tekstfelt røres ikke', erstattPlassholdere('{1-02}', k), '2026-09-17');

// Samme prefiks-matching som frontend: klokkeslett bak datoen skal gi samme
// dato begge steder, ikke falle tilbake til rå verdi.
sjekk('dato med klokkeslett', erstattPlassholdere('{1-03}', k), '17.09.2026');

// En verdi som ikke er YYYY-MM-DD sendes uendret videre. En halvtolket dato er
// verre enn den rå verdien.
sjekk('ukjent datoformat beholdes', erstattPlassholdere('{1-04}', k), '17. september');

sjekk('ubesvart datofelt blir tomt', erstattPlassholdere('[{1-05}]', k), '[]');
sjekk('ukjent felt blir tomt', erstattPlassholdere('[{1-09}]', k), '[]');

// ---------- oppslagsverdiene forblir rå ----------
sjekk('finnSvarForFeltRef er uformattert', finnSvarForFeltRef(seksjoner, 1, '01'), '2026-09-17');
sjekk('finnSvarForFeltViaId er uformattert', finnSvarForFeltViaId(seksjoner, DATO_ID), '2026-09-17');
sjekk('finnAlleSvarForFeltRef er uformattert', finnAlleSvarForFeltRef(seksjoner, 1, '01'), ['2026-09-17']);

// Flervalg er den ene typen der alle verdiene er svar — den listen er det
// dynamisk-rolle.js ekspanderer til én rolle per verdi.
sjekk('flervalg uendret', finnAlleSvarForFeltRef(seksjoner, 1, '06'), ['ING2501', 'ING2502']);

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
