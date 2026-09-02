/**
 * Tester for byggSvarOppslag() — koblingen visningene bruker.
 *
 * Fullformat-skjemaer bærer feltets Id på hvert felt, også i prod. Oppslaget
 * bruker den før posisjonen, slik at et svar følger sitt eget spørsmål når
 * skjematypen omnummereres.
 *
 * Fallbacken til posisjon er ikke pynt: målingen mot prod 02.09.2026 fant 9
 * svar uten Id blant fullformat-radene, og 25 kompakte rader som ikke har Id
 * i det hele tatt.
 *
 * Kjøres med:  node frontend/test/svar-oppslag.test.js
 */
const fs = require('fs');
const path = require('path');

// felt-render.js er en ES-modul med DOM-avhengigheter. Vi klipper ut de to
// funksjonene vi trenger — samme mønster som de andre frontend-testene.
const kilde = fs.readFileSync(path.join(__dirname, '..', 'js', 'felt-render.js'), 'utf8');
function klipp(navn) {
    const start = kilde.indexOf(`export function ${navn}`);
    if (start === -1) throw new Error(`Fant ikke ${navn} i felt-render.js`);
    const slutt = kilde.indexOf('\n}', start) + 2;
    return kilde.slice(start, slutt).replace('export function', 'function');
}
const { byggSvarOppslag } = (new Function(
    klipp('svarNokkel') + '\n' + klipp('byggSvarOppslag') + '\nreturn { byggSvarOppslag };'
))();

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const A = 'id-a', B = 'id-b', C = 'id-c';

// ---------- Id vinner over posisjon ----------
{
    // Lagret skjema: A på 01, B på 02, C på 03.
    const lagret = [{ Seksjon_nummer: 1, Nummer: 1, Felter: [
        { Id: A, Nummer: '01', Svar: ['svar A'] },
        { Id: B, Nummer: '02', Svar: ['svar B'] },
        { Id: C, Nummer: '03', Svar: ['svar C'] }
    ] }];
    // Definisjonen etter at A ble slettet: B og C har rykket opp.
    const def = [{ Seksjon_nummer: 1, Felter: [{ Id: B, Nummer: '01' }, { Id: C, Nummer: '02' }] }];
    const o = byggSvarOppslag(lagret, def);

    const sek = { Seksjon_nummer: 1 };
    sjekk('B beholder sitt svar', o.svar(sek, { Id: B, Nummer: '01' }), ['svar B']);
    sjekk('C beholder sitt svar', o.svar(sek, { Id: C, Nummer: '02' }), ['svar C']);
}

// ---------- nytt felt satt inn foran skal være BLANKT ----------
{
    // Dette er feilen som ble observert i produksjon 02.09.2026: et nytt felt
    // ble satt inn foran et eksisterende, og begge viste det gamle svaret.
    //
    // Det gamle feltet fant svaret sitt på Id — riktig. Det NYE feltet stod nå
    // på svarets gamle posisjon og plukket det opp via fallbacken — galt. Ett
    // svar, to steder, og det ene av dem plausibelt nok til å bli trodd.
    const lagret = [{ Seksjon_nummer: 1, Felter: [
        { Id: A, Nummer: '01', Svar: ['Emne'] },
        { Id: B, Nummer: '02', Svar: ['Banan'] }
    ] }];
    // Nytt felt C satt inn på plass 02; B har rykket ned til 03.
    const def = [{ Seksjon_nummer: 1, Felter: [
        { Id: A, Nummer: '01' }, { Id: C, Nummer: '02' }, { Id: B, Nummer: '03' }
    ] }];
    const o = byggSvarOppslag(lagret, def);
    const sek = { Seksjon_nummer: 1 };

    sjekk('nytt felt er blankt', o.svar(sek, { Id: C, Nummer: '02' }), []);
    sjekk('gammelt felt beholder svaret', o.svar(sek, { Id: B, Nummer: '03' }), ['Banan']);
    sjekk('første felt urørt', o.svar(sek, { Id: A, Nummer: '01' }), ['Emne']);
}

// ---------- et svar kan ikke vises to steder ----------
{
    const lagret = [{ Seksjon_nummer: 1, Felter: [{ Id: B, Nummer: '02', Svar: ['bare her'] }] }];
    const def = [{ Seksjon_nummer: 1, Felter: [{ Id: C, Nummer: '02' }, { Id: B, Nummer: '03' }] }];
    const o = byggSvarOppslag(lagret, def);
    const sek = { Seksjon_nummer: 1 };
    const treff = [
        o.svar(sek, { Id: C, Nummer: '02' }),
        o.svar(sek, { Id: B, Nummer: '03' })
    ].filter(s => s.length > 0);
    sjekk('svaret finnes nøyaktig ett sted', treff.length, 1);
}

// ---------- visningstekst følger samme regel ----------
{
    const lagret = [{ Seksjon_nummer: 1, Felter: [
        { Id: B, Nummer: '02', Svar: ['ING2308'], SvarTekst: ['Kull 23'] }
    ] }];
    const def = [{ Seksjon_nummer: 1, Felter: [{ Id: C, Nummer: '02' }, { Id: B, Nummer: '03' }] }];
    const o = byggSvarOppslag(lagret, def);
    const sek = { Seksjon_nummer: 1 };
    sjekk('nytt felt har ingen visningstekst', o.tekst(sek, { Id: C, Nummer: '02' }), null);
    sjekk('teksten følger sitt eget felt', o.tekst(sek, { Id: B, Nummer: '03' }), ['Kull 23']);
}

// ---------- felt som har mistet Id-en beholder posisjonsveien ----------
{
    // Definisjonen kjenner ikke lenger denne id-en, så svaret ville vært
    // uoppnåelig via Id. Da må posisjonen fortsatt gjelde.
    const lagret = [{ Seksjon_nummer: 1, Felter: [{ Id: 'foreldet', Nummer: '01', Svar: ['x'] }] }];
    const def = [{ Seksjon_nummer: 1, Felter: [{ Id: A, Nummer: '01' }] }];
    const o = byggSvarOppslag(lagret, def);
    sjekk('ukjent lagret id faller til posisjon',
        o.svar({ Seksjon_nummer: 1 }, { Id: A, Nummer: '01' }), ['x']);
}

// ---------- posisjon når Id mangler ----------
{
    const lagret = [{ Seksjon_nummer: 1, Felter: [{ Nummer: '01', Svar: ['gammelt'] }] }];
    const o = byggSvarOppslag(lagret);
    sjekk('faller tilbake til posisjon',
        o.svar({ Seksjon_nummer: 1 }, { Id: A, Nummer: '01' }), ['gammelt']);
}

{
    // Feltet i definisjonen har ingen Id heller — ren posisjonskobling.
    const lagret = [{ Seksjon_nummer: 1, Felter: [{ Nummer: '02', Svar: ['x'] }] }];
    const o = byggSvarOppslag(lagret);
    sjekk('helt uten Id på begge sider',
        o.svar({ Seksjon_nummer: 1 }, { Nummer: '02' }), ['x']);
}

// ---------- legacy-formen ----------
{
    // Skjemaer fra den opprinnelige appen har bare Seksjon_nummer på seksjonen.
    const lagret = [{ Seksjon_nummer: 2, Felter: [{ Nummer: '03', Svar: ['legacy'] }] }];
    const o = byggSvarOppslag(lagret);
    sjekk('legacy-seksjon treffer', o.svar({ Seksjon_nummer: 2 }, { Nummer: '03' }), ['legacy']);
}

// ---------- ubesvart og manglende ----------
{
    const o = byggSvarOppslag([{ Seksjon_nummer: 1, Felter: [{ Id: A, Nummer: '01', Svar: [] }] }]);
    sjekk('ubesvart gir tom array', o.svar({ Seksjon_nummer: 1 }, { Id: A, Nummer: '01' }), []);
    sjekk('ukjent felt gir tom array', o.svar({ Seksjon_nummer: 1 }, { Id: C, Nummer: '09' }), []);
    sjekk('tomt skjema velter ingenting', byggSvarOppslag(null).svar({ Seksjon_nummer: 1 }, { Nummer: '01' }), []);
}

// ---------- visningstekst ----------
{
    const lagret = [{ Seksjon_nummer: 1, Felter: [
        { Id: A, Nummer: '01', Svar: ['ING2308'], SvarTekst: ['Kull 23'] },
        { Id: B, Nummer: '02', Svar: ['x'] }
    ] }];
    const o = byggSvarOppslag(lagret);
    // Feltet har flyttet seg — teksten skal følge Id-en, ikke posisjonen.
    sjekk('visningstekst følger feltet', o.tekst({ Seksjon_nummer: 1 }, { Id: A, Nummer: '05' }), ['Kull 23']);
    sjekk('uten visningstekst gir null', o.tekst({ Seksjon_nummer: 1 }, { Id: B, Nummer: '02' }), null);
}

// ---------- seksjonsnummer som rent tall ----------
{
    // index.html har seksjonsnummeret som tall der widgeten bygges.
    const o = byggSvarOppslag([{ Seksjon_nummer: 3, Felter: [{ Nummer: '02', Svar: ['y'] }] }]);
    sjekk('tall som seksjon', o.svar(3, { Nummer: '02' }), ['y']);
}

// ---------- padding ----------
{
    const o = byggSvarOppslag([{ Seksjon_nummer: 1, Felter: [{ Nummer: 1, Svar: ['upadded'] }] }]);
    sjekk('upadded lagret, padded slått opp',
        o.svar({ Seksjon_nummer: 1 }, { Nummer: '01' }), ['upadded']);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
