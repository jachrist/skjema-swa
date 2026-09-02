/**
 * Tester for Id-basert kobling i kompaktformatet.
 *
 * Bakgrunn: `Nummer` tildeles etter posisjon (`renummererFelter` i editoren),
 * så det forskyves når et felt slettes eller flyttes. Et svar lagret før
 * endringen havner da under nabospørsmålet. Det er verre enn et tomt felt:
 * det ser riktig ut, og ingen oppdager det.
 *
 * Feltets `Id` står stille. Den er nå med i de kompakte radene, og vinner over
 * posisjon ved ekspandering.
 *
 * Målingen mot prod 02.09.2026 viste 6 omnummererte skjematyper og 25 kompakte
 * rader i faresonen — derfor er fallbacken beholdt: de radene har ingen Id.
 *
 * Kjøres med:  node api/test/kompakt-id.test.js
 */
const { komprimerSkjema, ekspanderSkjema } = require('../src/lib/skjema-kompakt');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const A = 'id-a', B = 'id-b', C = 'id-c';

const fullt = (felter) => ({
    Skjema_id: '1', Skjematype_id: '7',
    Seksjoner: [{ Nummer: 1, Seksjon_nummer: 1, Felter: felter }]
});
const svarene = (utvidet) => utvidet.Seksjoner[0].Felter.map(f => f.Svar);

// ---------- komprimering tar med Id ----------
{
    const k = komprimerSkjema(fullt([
        { Id: A, Nummer: '01', Type: 'Tekst', Svar: ['a'] },
        { Id: B, Nummer: '02', Type: 'Tekst', Svar: ['b'] }
    ]));
    sjekk('Id følger med i raden', k.Svar.map(s => s.id), [A, B]);
    sjekk('posisjon er fortsatt med', k.Svar.map(s => `${s.sek}-${s.spm}`), ['1-01', '1-02']);
}

{
    // Felt uten Id skal ikke få nøkkelen «undefined».
    const k = komprimerSkjema(fullt([{ Nummer: '01', Type: 'Tekst', Svar: ['a'] }]));
    sjekk('uten Id settes ingen id-nøkkel', 'id' in k.Svar[0], false);
}

// ---------- kjernen: svar følger feltet, ikke posisjonen ----------
{
    // Lagret da A stod først. Så ble A slettet, og B og C rykket opp.
    const kompakt = komprimerSkjema(fullt([
        { Id: A, Nummer: '01', Type: 'Tekst', Svar: ['svar A'] },
        { Id: B, Nummer: '02', Type: 'Tekst', Svar: ['svar B'] },
        { Id: C, Nummer: '03', Type: 'Tekst', Svar: ['svar C'] }
    ]));

    const nyDef = {
        Seksjoner: [{ Seksjon_nummer: 1, Felter: [
            { Id: B, Nummer: '01', Type: 'Tekst' },
            { Id: C, Nummer: '02', Type: 'Tekst' }
        ] }]
    };

    const ut = ekspanderSkjema(kompakt, nyDef);
    sjekk('B og C beholder sine egne svar', svarene(ut), [['svar B'], ['svar C']]);
    // Uten Id-koblingen ville B fått «svar A» og C fått «svar B» — begge
    // plausible, ingen av dem riktige.
}

// ---------- ett svar kan ikke havne to steder ----------
{
    // A er slettet fra definisjonen. B har rykket opp til A sin gamle posisjon.
    // Svaret til A ligger fortsatt på 1-01, og må IKKE tildeles B i tillegg.
    const kompakt = {
        Skjematype_id: '7',
        Svar: [
            { sek: 1, spm: '01', sva: ['svar A'], id: A },
            { sek: 1, spm: '02', sva: ['svar B'], id: B }
        ]
    };
    const nyDef = { Seksjoner: [{ Seksjon_nummer: 1, Felter: [{ Id: B, Nummer: '01', Type: 'Tekst' }] }] };
    const ut = ekspanderSkjema(kompakt, nyDef);
    sjekk('B får sitt eget svar, ikke A sitt', svarene(ut), [['svar B']]);
}

// ---------- bakoverkompatibilitet: rader uten Id ----------
{
    // De 25 prod-radene i faresonen ser slik ut. De skal fortsatt virke.
    const kompakt = {
        Skjematype_id: '7',
        Svar: [{ sek: 1, spm: '01', sva: ['gammelt'] }, { sek: 1, spm: '02', sva: ['også gammelt'] }]
    };
    const def = { Seksjoner: [{ Seksjon_nummer: 1, Felter: [
        { Id: A, Nummer: '01', Type: 'Tekst' }, { Id: B, Nummer: '02', Type: 'Tekst' }
    ] }] };
    sjekk('posisjon brukes når Id mangler', svarene(ekspanderSkjema(kompakt, def)),
        [['gammelt'], ['også gammelt']]);
}

{
    // Blandet: én rad har Id, én har ikke. Begge skal treffe riktig felt.
    const kompakt = {
        Skjematype_id: '7',
        Svar: [{ sek: 1, spm: '02', sva: ['med id'], id: B }, { sek: 1, spm: '01', sva: ['uten id'] }]
    };
    const def = { Seksjoner: [{ Seksjon_nummer: 1, Felter: [
        { Id: A, Nummer: '01', Type: 'Tekst' }, { Id: B, Nummer: '02', Type: 'Tekst' }
    ] }] };
    sjekk('blandet rad kobles riktig', svarene(ekspanderSkjema(kompakt, def)), [['uten id'], ['med id']]);
}

// ---------- felt uten svar ----------
{
    const kompakt = { Skjematype_id: '7', Svar: [{ sek: 1, spm: '01', sva: ['a'], id: A }] };
    const def = { Seksjoner: [{ Seksjon_nummer: 1, Felter: [
        { Id: A, Nummer: '01', Type: 'Tekst' }, { Id: B, Nummer: '02', Type: 'Tekst' }
    ] }] };
    sjekk('ubesvart felt får tom array', svarene(ekspanderSkjema(kompakt, def)), [['a'], []]);
}

// ---------- SvarTekst følger svaret ----------
{
    const fulltMedTekst = fullt([{ Id: A, Nummer: '01', Type: 'Flervalg', Svar: ['ING2308'], SvarTekst: ['Kull 23'] }]);
    const kompakt = komprimerSkjema(fulltMedTekst);
    sjekk('visningstekst komprimeres', kompakt.Svar[0].svt, ['Kull 23']);

    // Feltet har flyttet posisjon — visningsteksten må følge med Id-en.
    const nyDef = { Seksjoner: [{ Seksjon_nummer: 1, Felter: [
        { Id: 'annen', Nummer: '01', Type: 'Tekst' },
        { Id: A, Nummer: '02', Type: 'Flervalg' }
    ] }] };
    const ut = ekspanderSkjema(kompakt, nyDef);
    sjekk('visningstekst følger feltet', ut.Seksjoner[0].Felter[1].SvarTekst, ['Kull 23']);
    sjekk('og svaret gjør det også', ut.Seksjoner[0].Felter[1].Svar, ['ING2308']);
}

// ---------- Informasjon-felt røres ikke ----------
{
    const kompakt = { Skjematype_id: '7', Svar: [{ sek: 1, spm: '02', sva: ['a'], id: A }] };
    const def = { Seksjoner: [{ Seksjon_nummer: 1, Felter: [
        { Nummer: '01', Type: 'Informasjon', Tekst: { Verdi: 'hei' } },
        { Id: A, Nummer: '02', Type: 'Tekst' }
    ] }] };
    const ut = ekspanderSkjema(kompakt, def);
    sjekk('Informasjon får ingen Svar-array', 'Svar' in ut.Seksjoner[0].Felter[0], false);
    sjekk('spørsmålet under får sitt svar', ut.Seksjoner[0].Felter[1].Svar, ['a']);
}

// ---------- rundtur ----------
{
    const original = fullt([
        { Id: A, Nummer: '01', Type: 'Tekst', Svar: ['x'] },
        { Id: B, Nummer: '02', Type: 'Tekst', Svar: [] },
        { Id: C, Nummer: '03', Type: 'Tekst', Svar: ['z'] }
    ]);
    const def = { Seksjoner: [{ Seksjon_nummer: 1, Felter: [
        { Id: A, Nummer: '01', Type: 'Tekst' },
        { Id: B, Nummer: '02', Type: 'Tekst' },
        { Id: C, Nummer: '03', Type: 'Tekst' }
    ] }] };
    sjekk('komprimer → ekspander bevarer svarene',
        svarene(ekspanderSkjema(komprimerSkjema(original), def)), [['x'], [], ['z']]);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
