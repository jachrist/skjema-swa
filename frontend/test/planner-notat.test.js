/**
 * Forhåndsvisningen av Planner-notatet må stemme med det Planner faktisk får.
 *
 * Notat-feltet i editoren er en Markdown-editor med BARE lenkeknappen, fordi
 * beskrivelsen i Planner bare viser lenker og avsnitt. Hadde feltet brukt
 * parseMarkdown til forhåndsvisning, ville fet skrift og lister vist seg her
 * og forsvunnet der — og det er verre enn ingen forhåndsvisning.
 *
 * Prisen er at logikken finnes to steder: `notatForhandsvisning` i editor.html
 * og `notatSomHtml` i api/src/lib/varsling.js. Denne testen er det som holder
 * dem sammen — den kjører begge på de samme tekstene og krever samme utfall.
 * Endrer du én uten den andre, ryker den.
 *
 * Kjøres med:  node frontend/test/planner-notat.test.js
 */
const fs = require('fs');
const path = require('path');
const { notatSomHtml } = require('../../api/src/lib/varsling');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

// ---------- klipp funksjonen ut av editor.html ----------
const kilde = fs.readFileSync(path.join(__dirname, '..', 'editor.html'), 'utf8');
function klipp(navn) {
    const start = kilde.indexOf(`function ${navn}(`);
    if (start === -1) throw new Error(`Fant ikke ${navn} i editor.html`);
    const slutt = kilde.indexOf('\n        }', start) + '\n        }'.length;
    return kilde.slice(start, slutt);
}

const EKS = /const NOTAT_EKSEMPELLENKE = '([^']+)'/.exec(kilde);
if (!EKS) throw new Error('Fant ikke NOTAT_EKSEMPELLENKE i editor.html');
const L = EKS[1];

const notatForhandsvisning = new Function(
    'NOTAT_EKSEMPELLENKE',
    `${klipp('notatForhandsvisning')}\nreturn notatForhandsvisning;`
)(L);

// ---------- de to skal si det samme ----------
const TEKSTER = [
    '',
    '   \n  ',
    'Husk fristen',
    '$lenke',
    '[Åpne skjemaet for behandling]($lenke)',      // standardinnholdet
    'Skjemaet finner du her: $lenke',
    'Husk fristen. [Åpne]($lenke) når du er klar.',
    `Se "${'$lenke'}" her`,
    'Se $lenke.',
    'Se $lenke, og les',
    'Se ($lenke)',
    '<b>Se</b> $lenke',
    '<script>alert(1)</script>',
    'Ås & Co',
    'Han sa "hei"',
    'Linje 1\nLinje 2',
    'Første\n\nAndre',
    'Første\r\n\r\nAndre',
    'Én\n\n\n\nTo',
    '[<b>Hei</b>]($lenke)',
    '[Klikk](javascript:alert(1))',
    '[Klikk](data:text/html,<script>)',
    '[Klikk](/lokal/sti)',
    '[Åpne]($lenke) eller https://e.net/b'
];

for (const t of TEKSTER) {
    // Backend får $lenke ferdig løst — det er erstattPlassholdere som gjør det
    // før notatSomHtml kalles. Forhåndsvisningen løser den selv, mot samme
    // eksempeladresse.
    const fasit = notatSomHtml(t.split('$lenke').join(L), L);
    sjekk(`samme utfall: ${JSON.stringify(t).slice(0, 46)}`, notatForhandsvisning(t), fasit);
}

// ---------- og forhåndsvisningen skal faktisk vise en lenke ----------
{
    // Uten $lenke-erstatningen ville standardinnholdet stått som ren tekst,
    // og lenkeformen sett ut som om den ikke virket.
    const ut = notatForhandsvisning('[Åpne skjemaet for behandling]($lenke)');
    sjekk('standardinnholdet blir en anker', ut.includes('<a href='), true);
    sjekk('med brukerens tekst', ut.includes('>Åpne skjemaet for behandling</a>'), true);
    sjekk('og ingen synlig $lenke', ut.includes('$lenke'), false);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
