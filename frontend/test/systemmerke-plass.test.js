/**
 * Graderingsmerket skal ikke legge seg oppå tittelen.
 *
 * Meldt fra mobilvisning 23.09.2026: «Gaveprotokoll FHS» lå tvers over
 * «Kun for UGRADERT».
 *
 * Mekanikken er verdt å skrive ned, for den er ikke åpenbar. Merket har
 * `flex: 0 0 auto` og krymper ikke — og det skal det ikke, en graderings-
 * merking presset sammen til ukjennelighet er verre enn ingen. Følgen er at
 * alt annet i raden må gi etter. `.tittelrad` har `min-width: 0`, så
 * h1-BOKSEN krympet pent — men et langt ord uten bindestrek kan ikke brytes,
 * så TEKSTEN fløt utenfor boksen og malte seg oppå merket.
 *
 * Tre ting testes:
 *
 *   **Raden får brekke.** Da kan merket gå ned på egen linje.
 *
 *   **Tittelen får brytes inne i et ord.** Uten dette hjelper ikke brekkingen
 *   når ett enkelt ord er bredere enn skjermen.
 *
 *   **Begge stiene dekkes.** Merket plasseres enten i `#systemmerke-plass`
 *   eller i en rad modulen lager selv. Rettes bare den ene, gjelder feilen
 *   fortsatt for halvparten av sidene.
 *
 * Kjøres mot stubbet DOM — det er plasseringslogikken som testes, ikke
 * hvordan nettleseren tegner den.
 *
 * Kjøres med:  node frontend/test/systemmerke-plass.test.js
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

const rå = fs.readFileSync(path.join(__dirname, '..', 'js', 'systemtopp.js'), 'utf8');
const kode = utenKommentarer(rå);

// ---------- funksjonen kjøres ekte, mot stubbet DOM ----------
const sikreRad = (function () {
    const m = /function sikreRad\(rad\) \{[\s\S]*?\n\}/.exec(rå);
    if (!m) return null;
    // eslint-disable-next-line no-eval
    return eval(`(${m[0]})`);
})();
sjekk('sikreRad lot seg hente ut', typeof sikreRad, 'function');

function lagH1() { return { style: {} }; }
function lagRad(h1er) {
    return { style: {}, querySelectorAll: (v) => (v === 'h1' ? h1er : []) };
}

if (sikreRad) {
    const h1 = lagH1();
    const rad = lagRad([h1]);
    sikreRad(rad);
    sjekk('raden får brekke', rad.style.flexWrap, 'wrap');
    // Uten denne hjelper ikke brekkingen: ett ord bredere enn skjermen
    // flyter ut av sin egen boks og maler seg oppå merket.
    sjekk('tittelen kan brytes inne i et ord', h1.style.overflowWrap, 'anywhere');
    sjekk('og h1-boksen kan krympe', h1.style.minWidth, '0');

    // Flere overskrifter i samme rad skal alle dekkes.
    const a = lagH1(), b = lagH1();
    sikreRad(lagRad([a, b]));
    sjekk('alle overskrifter dekkes', [a.style.overflowWrap, b.style.overflowWrap],
        ['anywhere', 'anywhere']);

    // Ingen rad å røre skal ikke kaste — merket plasseres uansett.
    let kastet = false;
    try { sikreRad(null); } catch (_) { kastet = true; }
    sjekk('tom rad tåles', kastet, false);
}

// ---------- begge plasseringsstiene ----------
{
    // Sider med egen beholder: raden er beholderens forelder.
    sjekk('beholder-stien sikres',
        /plass\.appendChild\(merke\);\s*sikreRad\(plass\.parentElement\);/.test(kode), true);
    // Sider uten: modulen lager raden selv.
    sjekk('fallback-stien sikres', /rad\.append\(merke, h1\);[\s\S]{0,80}sikreRad\(rad\);/.test(kode), true);

    // Merket skal fortsatt IKKE krympe. Det er hele grunnen til at resten må
    // gi etter — fjernes den, er det merket som blir uleselig i stedet.
    sjekk('merket krymper ikke', /flex: 0 0 auto/.test(kode), true);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
