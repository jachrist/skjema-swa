/**
 * Behandlerlinja i oppsummeringen — formatering og innkobling.
 *
 * Navnet skal stå sammen med adressen, og regelen for hvordan bor ett sted
 * fordi TO sider viser den: visning.html (innsenderens oppsummering) og
 * evaluering.html (behandlerens side). To kopier ville før eller siden vist
 * samme person på to måter i samme sak.
 *
 * Fire ting testes:
 *
 *   **Navnet kan mangle, og da står adressen alene.** Brukernavn-tabellen
 *   fylles ved innlogging, så en behandler som aldri har logget inn har bare
 *   en adresse. «(ola@x.no)» etter et tomt navn ser ut som en feil — for det
 *   er det.
 *
 *   **Avgjort går foran.** Er steget behandlet, er det hvem som gjorde det
 *   som skal stå, ikke hvem som kunne.
 *
 *   **Ingenting å si gir ingen linje.** En tom «Behandlere:» er verre enn
 *   ingen.
 *
 *   **Begge sidene bruker modulen.** Det er hele grunnen til at den finnes.
 *   Og visning.html må beholde fallbacken til `steg.Personer` — en
 *   oppsummering uten navn er bedre enn en som krasjer om berikelsen mangler.
 *
 * Kjøres med:  node frontend/test/behandler-visning-ui.test.js
 */
const fs = require('fs');
const path = require('path');
const { utenKommentarer } = require('../../scripts/test-kilde.js');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

// Modulen er ESM. Testene skal kjøre uten node_modules, så den evalueres som
// tekst med `export` strippet — samme grep som de andre frontend-testene.
const kilde = fs.readFileSync(path.join(__dirname, '..', 'js', 'behandler-visning.js'), 'utf8');
const { formaterBehandler, behandlerlinje } = (function () {
    const modul = {};
    // eslint-disable-next-line no-eval
    eval(kilde.replace(/^export /gm, '') + '\nmodul.formaterBehandler = formaterBehandler; modul.behandlerlinje = behandlerlinje;');
    return modul;
})();

// ---------- formatering ----------
{
    sjekk('navn og adresse', formaterBehandler({ epost: 'ola@x.no', navn: 'Ola Nordmann' }),
        'Ola Nordmann (ola@x.no)');
    sjekk('uten navn står adressen alene', formaterBehandler({ epost: 'per@x.no', navn: '' }), 'per@x.no');
    sjekk('tomt navn gir ingen tom parentes',
        formaterBehandler({ epost: 'per@x.no' }).includes('('), false);
    sjekk('mellomrom teller ikke som navn', formaterBehandler({ epost: 'p@x.no', navn: '  ' }), 'p@x.no');
    sjekk('tomt inn gir tomt ut', formaterBehandler(undefined), '');
}

// ---------- linja ----------
{
    sjekk('avgjort går foran kandidatene', behandlerlinje({
        behandletAv: [{ epost: 'ola@x.no', navn: 'Ola Nordmann' }],
        kandidater: [{ epost: 'kari@x.no', navn: 'Kari H' }]
    }), 'Behandlet av: Ola Nordmann (ola@x.no)');

    sjekk('uavgjort viser kandidatene', behandlerlinje({
        behandletAv: [],
        kandidater: [{ epost: 'kari@x.no', navn: 'Kari H' }, { epost: 'per@x.no', navn: '' }]
    }), 'Behandlere: Kari H (kari@x.no), per@x.no');

    sjekk('flere aktører listes', behandlerlinje({
        behandletAv: [{ epost: 'a@x.no', navn: 'A' }, { epost: 'b@x.no', navn: 'B' }]
    }), 'Behandlet av: A (a@x.no), B (b@x.no)');

    sjekk('ingenting gir ingen linje', behandlerlinje({ behandletAv: [], kandidater: [] }), null);
    sjekk('manglende rad gir ingen linje', behandlerlinje(undefined), null);
    // En oppføring uten adresse er ikke en behandler.
    sjekk('tomme oppføringer filtreres bort',
        behandlerlinje({ behandletAv: [{ navn: 'Uten adresse' }], kandidater: [] }), null);
}

// ---------- innkoblingen ----------
{
    const visning = utenKommentarer(fs.readFileSync(path.join(__dirname, '..', 'visning.html'), 'utf8'));
    const evaluering = utenKommentarer(fs.readFileSync(path.join(__dirname, '..', 'evaluering.html'), 'utf8'));
    sjekk('visning.html ble lest', visning.length > 10000, true);
    sjekk('evaluering.html ble lest', evaluering.length > 10000, true);

    sjekk('visning importerer linja',
        /import \{ behandlerlinje \} from '\.\/js\/behandler-visning\.js'/.test(visning), true);
    sjekk('evaluering importerer formateringen',
        /import \{ formaterBehandler \} from '\.\/js\/behandler-visning\.js'/.test(evaluering), true);

    sjekk('visning leser berikelsen', /skjema\._behandlere \|\| \{\}/.test(visning), true);
    sjekk('evaluering leser berikelsen', /skjema\?\._behandlere \|\| \{\}/.test(evaluering), true);

    // Å lese berikelsen er ikke det samme som å VISE den. Uten disse to
    // sjekkene kunne begge sidene falle tilbake til rå UPN i markupen mens
    // importen og oppslaget sto igjen som pynt — og testen var grønn.
    // (Fanget ved mutasjonstesting 23.09.2026: nettopp det slapp gjennom.)
    sjekk('evaluering VISER det oppløste navnet',
        /Behandlet av \$\{escapeHtml\(behandlerNavn\(steg\)\)\}/.test(evaluering), true);
    sjekk('og ikke rå BehandletAv',
        /Behandlet av \$\{escapeHtml\(steg\.BehandletAv\)\}/.test(evaluering), false);
    sjekk('visning VISER linja fra modulen',
        /beh\.textContent = linje;/.test(visning), true);

    // Fallbacken skal bli stående: mangler berikelsen, er den gamle lesingen
    // bedre enn ingenting.
    sjekk('visning faller tilbake til Personer',
        /behandlerlinje\(behandlereForSteg\[String\(steg\.Steg\)\]\)\s*\|\|/.test(visning), true);

    // Og den gamle lesingen skal IKKE lenger være den eneste kilden.
    const gammel = /beh\.textContent = 'Behandlere: ' \+ steg\.Personer\.join/.test(visning);
    sjekk('den gamle linja er ikke lenger eneste kilde', gammel, false);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
