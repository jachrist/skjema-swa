/**
 * Markdown → HTML: backend (api/src/lib/markdown.js) mot frontend
 * (`parseMarkdown` i frontend/js/felt-render.js, `escapeHtml` i
 * frontend/js/escape.js).
 *
 * Backend trenger regelen fordi e-posten til utsending og purring nå kan
 * bygges i API-et, og skjemabeskrivelsen skal se lik ut i e-posten som på
 * utfyllingssiden. To kopier som svarer ulikt er feilklassen dette repoet
 * har sett oftest — denne testen kjører begge og krever likt svar.
 *
 * Kjøres med:  node api/test/markdown-tvilling.test.js
 */
const fs = require('fs');
const path = require('path');
const { hentEksport } = require('../../scripts/test-kilde.js');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const rot = path.join(__dirname, '..', '..');
const les = (...p) => fs.readFileSync(path.join(rot, ...p), 'utf8');
const front = les('frontend', 'js', 'escape.js') + '\n' + les('frontend', 'js', 'felt-render.js');
const fParse = hentEksport(front, 'parseMarkdown', ['escapeHtml']);
const fEsc = hentEksport(front, 'escapeHtml');
const bak = require('../src/lib/markdown');

const TEKSTER = [
    '', 'Ren tekst', 'To\nlinjer', 'Avsnitt\n\nTo',
    '# Overskrift\nTekst', '## Under\n### Tredje',
    '- en\n- to\nEtter lista', '1. en\n2. to\n\nAvsnitt',
    '**fet** og *kursiv* og `kode`',
    '[lenke](https://fhs.no) og [rel](/side) og [frag](#x)',
    '[farlig](javascript:alert(1))', '![bilde](https://x.no/a.png)', '![data](data:image/png;base64,AAA)',
    '<script>alert(1)</script> & "sitat" \'enkel\'',
    'Æ ø å — «sitat»', '- punkt med **fet**\n- og [lenke](https://a.no)\n\n# Slutt'
];

const ulike = TEKSTER.filter(t => fParse(t) !== bak.parseMarkdown(t));
sjekk('parseMarkdown: tvillingene svarer likt på alle tekstene', ulike, []);
const ulikeEsc = TEKSTER.filter(t => fEsc(t) !== bak.escapeHtml(t));
sjekk('escapeHtml: tvillingene svarer likt', ulikeEsc, []);

// Og reglene skiller — likt svar fordi begge svarer tomt, ville vært verdiløst.
sjekk('fet blir strong', bak.parseMarkdown('**x**'), '<p><strong>x</strong></p>');
sjekk('script escapes', /<script>/.test(bak.parseMarkdown('<script>x</script>')), false);
sjekk('javascript:-lenke blir ikke lenke', /href="javascript/.test(bak.parseMarkdown('[a](javascript:alert(1))')), false);

// tekstSomHtml: ren tekst, escapet, avsnitt og linjeskift bevart.
sjekk('ren tekst: avsnitt og linjeskift', bak.tekstSomHtml('a\nb\n\nc'), '<p>a<br>b</p><p>c</p>');
sjekk('ren tekst: escapet', bak.tekstSomHtml('<b>x</b>'), '<p>&lt;b&gt;x&lt;/b&gt;</p>');
sjekk('ren tekst: tom', bak.tekstSomHtml(''), '');

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
