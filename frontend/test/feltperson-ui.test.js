/**
 * Feltreferanse som mottaker, i tilgang-editoren (ønske 73).
 *
 * «{2-01}» i personlista betyr «adressen innsenderen skrev i det feltet».
 * Regelen for hva som ER en slik referanse finnes nå to steder: i
 * api/src/lib/feltperson.js, som løser den opp, og i tilgang-editoren, som
 * viser den fram. To regler for samme spørsmål er mønsteret som har bitt oss
 * flere ganger i dette repoet — derfor kjøres BEGGE regexene mot de samme
 * tilfellene og må svare likt. Endrer noen den ene, blir dette rødt.
 *
 * Ellers tre ting:
 *
 *   **Velgeren vises bare der den betyr noe.** Publikum og Eiere får ingen
 *   feltreferanser inn, og skal ikke tilbys en mottaker som først finnes ved
 *   innsending.
 *
 *   **Hele oppføringen blir referansen.** Velgeren skal legge inn «{2-01}»,
 *   ikke flette den inn i noe. Begrunnelsen står i feltperson.js.
 *
 *   **Chipen viser feltet, ikke koden.** «{2-01}» sier ingenting til den som
 *   setter opp skjemaet, og forveksling mellom to felter er nettopp det
 *   visningen skal hindre.
 *
 * Kjøres med:  node frontend/test/feltperson-ui.test.js
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

const uiRå = fs.readFileSync(path.join(__dirname, '..', 'js', 'tilgang-editor.js'), 'utf8');
const ui = utenKommentarer(uiRå);
const api = utenKommentarer(
    fs.readFileSync(path.join(__dirname, '..', '..', 'api', 'src', 'lib', 'feltperson.js'), 'utf8'));

// ---------- samme regel to steder ----------
{
    const uiRe = /function erFeltperson\(p\) \{\s*return (\/.+?\/)\.test/.exec(ui);
    const apiRe = /const HEL_REFERANSE = (\/.+?\/);/.exec(api);
    sjekk('editoren har en regel', !!uiRe, true);
    sjekk('api-et har en regel', !!apiRe, true);

    if (uiRe && apiRe) {
        // eslint-disable-next-line no-eval
        const a = eval(uiRe[1]);
        // eslint-disable-next-line no-eval
        const b = eval(apiRe[1]);
        const tilfeller = [
            '{2-01}', '  {2-01} ', '{3f7a1c2e-0000-0000-0000-000000000000}',
            'ola@example.no', 'sjef-{2-01}@x.no', 'Klassesjef({2-01})',
            '{}', '{a}{b}', '', '{2-01} og {2-02}'
        ];
        const ulike = tilfeller.filter(t => a.test(t) !== b.test(t));
        sjekk('reglene svarer likt på alle tilfellene', ulike, []);

        // At de er like er ikke nok — de kan være like og begge gale.
        sjekk('ren referanse er en referanse', a.test('{2-01}'), true);
        sjekk('innfletting er det ikke', a.test('sjef-{2-01}@x.no'), false);
        sjekk('rollestreng er det ikke', a.test('Klassesjef({2-01})'), false);
    }
}

// ---------- velgeren finnes, og bare der den betyr noe ----------
{
    sjekk('velgeren bygges', /function byggFeltperson\(\)/.test(ui), true);
    sjekk('den vises bare med feltreferanser',
        /if \(feltReferanser\.length > 0\) sek\.appendChild\(byggFeltperson\(\)\);/.test(ui), true);
    sjekk('hele oppføringen blir referansen', /const streng = `\{\$\{ref\}\}`;/.test(ui), true);
    sjekk('duplikat legges ikke til', /if \(!state\.Personer\.includes\(streng\)\)/.test(ui), true);
    sjekk('tomt valg avvises', /Velg et felt f/.test(ui), true);

    // Publikum og Eiere sender ingen feltReferanser — kontrollen på at
    // editoren faktisk kalles uten dem, ligger i editor.html.
    const editor = utenKommentarer(fs.readFileSync(path.join(__dirname, '..', 'editor.html'), 'utf8'));
    sjekk('editor.html ble lest', editor.length > 50000, true);
    const pub = editor.slice(editor.indexOf('const pubEl'), editor.indexOf('const eiEl'));
    sjekk('Publikum får ingen feltreferanser', /feltReferanser/.test(pub), false);
    sjekk('mottakervelgerne får dem', /const felles = \{[^}]*feltReferanser: felter/.test(editor), true);
}

// ---------- chipen viser feltet, ikke koden ----------
{
    const kilde = /function personTilVisning\(p\) \{[\s\S]*?\n    \}/.exec(ui);
    sjekk('visningen finnes', !!kilde, true);
    if (kilde) {
        const feltReferanser = [{ ref: '2-01', tekst: 'S2-F1: Din e-post' }];
        const erFeltperson = (p) => /^\s*\{[^{}]+\}\s*$/.test(String(p || ''));
        // eslint-disable-next-line no-eval
        const vis = eval(`(${kilde[0].replace(/^function /, 'function ')})`);

        sjekk('kjent felt vises med tekst', vis('{2-01}'), 'E-post fra «S2-F1: Din e-post»');
        sjekk('koden står ikke i visningen', vis('{2-01}').includes('2-01'), false);
        sjekk('ukjent felt vises som svar', vis('{9-99}'), 'E-post fra svar {9-99}');
        sjekk('vanlig adresse vises uendret', vis('ola@x.no'), 'ola@x.no');
        void erFeltperson; void feltReferanser;
    }
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
