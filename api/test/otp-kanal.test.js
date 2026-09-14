/**
 * Tester for hvilke kanaler en engangskode kan sendes på.
 *
 * Bare e-post. SMS var tilbudt i grensesnittet fram til 14.09.2026, men
 * tjenesten ble aldri innført, og kanalen regnes som usikker for engangskoder.
 *
 * Det som gjorde dette verdt en sperre i koden — og ikke bare i grensesnittet
 * — er at feilen var usynlig for den den gjaldt. `/api/otp/be-om-kode` er
 * anonymt og svarer ALLTID `status: "ok"` for å hindre enumerasjon. Den som
 * valgte SMS fikk altså kvittering, ventet på en kode som ikke fantes, og
 * traff rate-begrensningen ved neste forsøk. Ingen feilmelding noe sted.
 *
 * `kanal` blir værende som felt: RowKey er `hash(kanal + ':' + mottaker)`, og
 * eldre rader kan ha andre verdier som fortsatt må kunne slås opp ved
 * verifisering. Det er derfor testene under sjekker inngangsporten, ikke at
 * ordet «sms» er borte fra modulen.
 *
 * Kjøres med:  node api/test/otp-kanal.test.js
 */
const { gyldigKanal, KANALER, normaliserMottaker } = require('../src/lib/otp');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

// ---------- bare e-post slipper inn ----------
{
    sjekk('epost er gyldig', gyldigKanal('epost'), true);
    sjekk('store bokstaver teller likt', gyldigKanal('EPOST'), true);
    // Ikke trimming: en kanal med mellomrom er malformert input, ikke et valg.
    sjekk('mellomrom rundt er ikke gyldig', gyldigKanal(' epost '), false);
}

{
    // Dette er hele poenget med testen.
    sjekk('sms avvises', gyldigKanal('sms'), false);
    sjekk('SMS med store bokstaver også', gyldigKanal('SMS'), false);
    sjekk('mobil avvises', gyldigKanal('mobil'), false);
}

{
    for (const v of ['', null, undefined, 0, 'teams', 'whatsapp']) {
        sjekk(`ukjent kanal avvises: ${JSON.stringify(v)}`, gyldigKanal(v), false);
    }
}

{
    // Lista skal være eksplisitt. Vokser den, er det et valg noen tok.
    sjekk('nøyaktig én kanal', [...KANALER], ['epost']);
}

// ---------- eldre rader må fortsatt kunne slås opp ----------
{
    // Kanalen inngår i RowKey. Fjernet vi håndteringen av 'sms' nedover i
    // modulen, ville en utestående kode fra før ikke latt seg verifisere.
    sjekk('sms normaliseres fortsatt', typeof normaliserMottaker('sms', '+47 412 34 567'), 'string');
    sjekk('normalisering av epost er fortsatt lowercase',
        normaliserMottaker('epost', ' Ola@Example.NO '), 'ola@example.no');
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
