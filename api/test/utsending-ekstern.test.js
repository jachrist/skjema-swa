/**
 * Tester for kravet om at skjematypen tillater ekstern innsending før en
 * masseutsending kan opprettes.
 *
 * Bakgrunn: en utsendingslenke gir tilgang uten Entra-pålogging. Den er ikke
 * OTP-basert — `lib/utsending-token.js` utsteder et HMAC-signert token bundet
 * til (batch, mottaker, skjematype) — og den virker derfor like godt for en
 * ekstern mottaker som for en ansatt. Det er samme tillit som ekstern
 * innsender, og styres av samme flagg.
 *
 * Sjekken hører hjemme ved OPPRETTELSEN. Der er det én skjematype å ta
 * stilling til, og svaret gjelder hele batchen. Ved utsendingen ville hver
 * mottaker måttet klassifiseres som intern eller ekstern — og en blandet
 * batch, for eksempel et spørreskjema til forelesere, er helt vanlig.
 *
 * Konsekvensen testene holder fast ved: finnes batchen, har skjematypen
 * tillatt ekstern innsending. Purreflyten kan derfor alltid sende ut av
 * organisasjonen uten å spørre om noe mer.
 *
 * Kjøres med:  node api/test/utsending-ekstern.test.js
 */
const { sjekkEksternUtsending } = require('../src/lib/utsending-storage');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

// ---------- slipper gjennom ----------
{
    sjekk('EksternTilgang=true slipper gjennom', sjekkEksternUtsending({ EksternTilgang: true }).ok, true);
    sjekk('og har ingen melding', sjekkEksternUtsending({ EksternTilgang: true }).melding, undefined);
}

// ---------- avvises ----------
{
    // Bare ekte true. En streng eller et tall som «ser sant ut» er like gjerne
    // et lagringsuhell som et valg, og dette flagget åpner en dør.
    for (const verdi of [false, undefined, null, 0, '', 'true', 1, 'ja']) {
        sjekk(`EksternTilgang=${JSON.stringify(verdi)} avvises`,
            sjekkEksternUtsending({ EksternTilgang: verdi }).ok, false);
    }
    sjekk('uten feltet i det hele tatt', sjekkEksternUtsending({}).ok, false);
}

{
    // Meldinga skal si hva man gjør med det, ikke bare at det gikk galt —
    // den vises for den som prøver å opprette utsendingen.
    const m = sjekkEksternUtsending({}).melding;
    sjekk('meldinga navngir problemet', m.includes('ikke tilgjengelig for ekstern utsendelse'), true);
    sjekk('og peker på avkryssingsboksen', m.includes('Tillat innsending fra eksterne'), true);
}

// ---------- skjematypen finnes ikke ----------
{
    // Uten sjekken kunne en batch opprettes mot en skjematype som ikke finnes.
    // Lenkene ville vært gyldige og pekt på ingenting.
    sjekk('null gir egen melding', sjekkEksternUtsending(null).melding, 'Fant ikke skjematypen');
    sjekk('undefined likeså', sjekkEksternUtsending(undefined).ok, false);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
