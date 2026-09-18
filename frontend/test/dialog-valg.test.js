/**
 * Innsenderen skal ikke tilbys et valg API-et avviser.
 *
 * `POST .../dialog` svarer 403 på `type: 'intern'` fra innsenderen
 * (`skjemaer.js`: «Innsender kan ikke skrive interne innlegg»). Likevel sto
 * «Intern (til andre behandlere)» i nedtrekkslista for alle — som FØRSTE og
 * dermed forvalgte alternativ.
 *
 * Følgen: innsenderen skriver et innlegg, trykker send, og får en feilmelding
 * om noe hen aldri ba om. Regelen fantes, den ble håndhevet, og grensesnittet
 * visste ingenting om den.
 *
 * Tre ting testes:
 *
 *   **Valget er betinget.** Ikke hardkodet inn i markupen.
 *
 *   **Betingelsen kommer fra serveren.** `_minRolle` settes av `hentSkjema`,
 *   av den SAMME `tilgangsRolle` som avgjør hvilke innlegg brukeren får se.
 *   Regner siden det ut selv, kan de to komme i utakt — og da vises innlegg
 *   etter én regel og tilbys skriving etter en annen.
 *
 *   **«Til innsender» står alltid.** Blir den betinget også, kan en innsender
 *   ende opp uten noen måte å skrive på.
 *
 * Kjøres med:  node frontend/test/dialog-valg.test.js
 */
const fs = require('fs');
const path = require('path');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const side = fs.readFileSync(path.join(__dirname, '..', 'evaluering.html'), 'utf8');
const api = fs.readFileSync(
    path.join(__dirname, '..', '..', 'api', 'src', 'functions', 'skjemaer.js'), 'utf8');

// ---------- grensesnittet ----------
{
    const kode = side.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

    sjekk('intern-valget er betinget', /kanIntern \? '<option value="intern"/.test(kode), true);
    sjekk('betingelsen leser _minRolle', /_minRolle/.test(kode), true);
    sjekk('og sammenligner med innsender', /!==\s*'innsender'/.test(kode), true);

    // «Til innsender» skal stå uansett — ellers mister innsenderen enhver
    // mulighet til å skrive.
    const uten = kode.replace(/\$\{kanIntern \?[^}]*\}/g, '');
    sjekk('«Til innsender» er ubetinget', /<option value="ekstern">/.test(uten), true);

    // Rollen skal ikke regnes ut i nettleseren.
    sjekk('siden gjetter ikke selv',
        /Innsender_Epost.*toLowerCase.*===.*userDetails/.test(kode), false);
}

// ---------- serveren ----------
{
    const kode = api.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

    sjekk('_minRolle settes i svaret', /skjema\._minRolle\s*=/.test(kode), true);

    // Samme kilde som filtreringen av interne innlegg. To oppslag kunne gitt
    // to svar — og da vises innlegg etter én regel og tilbys skriving etter en
    // annen.
    sjekk('samme rolle brukes til å skjule innlegg',
        /skjulInterneInnlegg\(skjema, minRolle\)/.test(kode), true);
    sjekk('rollen hentes fra tilgangsRolle',
        /minRolle\s*=\s*await dialogTilgang\.tilgangsRolle\(/.test(kode), true);

    // Og API-et må fortsatt avvise: grensesnittet er ikke tilgangskontroll.
    sjekk('API-et avviser fortsatt intern fra innsender',
        /type === 'intern' && rolle === 'innsender'/.test(kode), true);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
