/**
 * Plassholderlista i meldings-editoren er et løfte.
 *
 * Alt som står i lista presenteres for den som setter opp en mal som noe hen
 * kan bruke. Står det noe der som koden ikke kan bytte ut med en verdi, blir
 * det tom streng i en e-post — og det ser ut som en datafeil, ikke en
 * mangel i systemet.
 *
 * Det var nettopp det som skjedde med to av dem:
 *
 *   `$innsender_navn` ble substituert riktig hele tiden, men feltet den leste
 *   fra ble aldri skrevet. Fikset 16.09.2026.
 *
 *   `$navn` («mottaker-navn») hadde aldri noen kilde i det hele tatt, og
 *   kunne ikke få en: teksten bygges én gang og går til alle mottakerne i
 *   samme flyt-kall. Fjernet fra lista samme dag.
 *
 * Testen fyller en kontekst der ALT er satt, og krever at hver plassholder i
 * lista da gir en verdi. En plassholder uten kilde kan ikke bestå den —
 * uansett hvor riktig substitusjonen i seg selv er.
 *
 * Kjøres med:  node frontend/test/plassholderliste.test.js
 */
const path = require('path');
const { pathToFileURL } = require('url');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

// Alt satt, og hver verdi er unik og gjenkjennelig, så vi ser hvilken
// plassholder som havnet hvor.
const KONTEKST = {
    lenke: 'https://eksempel.no/skjema',
    skjemanavn: 'Reiseregning',
    skjemaId: '42',
    innsender: 'kari@fhs.no',
    innsenderNavn: 'Kari Nordmann',
    stegnavn: 'Godkjenning',
    rolle: 'Emneansvarlig(CBU2501)',
    beslutning: 'Godkjent',
    kommentar: 'Dette var bra.',
    tidspunkt: '16.9.2026, 21:05',
    frist: '2026-10-01',
    dagerTilFrist: 14
};

async function kjor() {
    const modul = pathToFileURL(path.join(__dirname, '..', 'js', 'melding-editor.js')).href;
    const { STANDARD_PLASSHOLDERE } = await import(modul);
    const { erstattPlassholdere } = require('../../api/src/lib/placeholder');

    sjekk('lista er eksportert og ikke tom', STANDARD_PLASSHOLDERE?.length > 0, true);

    for (const p of STANDARD_PLASSHOLDERE) {
        // Klammene gjør det synlig om resultatet er tomt eller bare kort.
        const ut = erstattPlassholdere(`[${p.navn}]`, KONTEKST);

        sjekk(`${p.navn}: blir byttet ut`, ut !== `[${p.navn}]`, true);
        sjekk(`${p.navn}: gir en verdi`, ut !== '[]', true);
        // Navnet i lista er det brukeren skriver i malen. Er det feilstavet,
        // blir det stående som rå tekst i e-posten.
        sjekk(`${p.navn}: starter med $`, p.navn.startsWith('$'), true);
        sjekk(`${p.navn}: har en forklaring`, (p.tekst || '').length > 0, true);
    }

    // $navn skal ikke tilbake i lista uten at noen først bygger meldingen per
    // mottaker. Kommer den, faller den på «gir en verdi» over — men denne
    // linja sier hvorfor.
    sjekk('$navn er ute av lista',
        STANDARD_PLASSHOLDERE.some(p => p.navn === '$navn'), false);

    // Kontrollprøve: hadde testen godtatt en plassholder uten kilde, ville
    // den ikke fanget noe. Den skal ikke det.
    const utenKilde = erstattPlassholdere('[$navn]', KONTEKST);
    sjekk('en plassholder uten kilde gir tomt', utenKilde, '[]');

    console.log(`\n${ok} OK, ${feil} feil  (${STANDARD_PLASSHOLDERE.length} plassholdere)`);
    process.exit(feil ? 1 : 0);
}

kjor().catch(e => { console.error(e); process.exit(1); });
