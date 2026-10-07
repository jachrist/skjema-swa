/**
 * Rapportsiden: radvalg, søk, utskriftsretning og Markdown i beskrivelsen.
 *
 * Fire ønsker fra testing av rapportfunksjonen, og de henger sammen i at de
 * alle handler om hva som havner på papiret og hva brukeren ser underveis.
 *
 *   **Avkryssing per rad.** Fjernet kryss skal dempe raden på SKJERMEN og
 *   fjerne den fra UTSKRIFTEN. Ikke skjule den begge steder: en rad som
 *   forsvinner fra visningen kan ikke hentes tilbake, og da er avkryssingen
 *   en enveisdør.
 *
 *   **«inneholder» er et søk.** Et filter man fyller ut og bekrefter er noe
 *   annet enn et felt der treffene vokser fram mens man skriver. Bare
 *   `contains` behandles slik — «er lik» og datointervaller gir ikke mening
 *   halvveis inntastet.
 *
 *   **Utskriftsretningen må skrives inn i et stilark.** `@page { size: … }`
 *   kan ikke settes med inline style. En implementasjon som prøver på et
 *   element ville sett riktig ut i koden og ikke gjort noe.
 *
 *   **Beskrivelsen er Markdown, med bilder.** Og da må BEGGE ender endres:
 *   editoren som skriver den, og visningen som leser den. Én av dem alene
 *   gir enten en tekst ingen kan skrive, eller en kode ingen ser.
 *
 * Kjøres med:  node frontend/test/rapport-visning.test.js
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

const les = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const rapport = les('rapport.html');
const editor = les('rapporteditor.html');

// ---------- Markdown med bilder ----------
{
    // Den ekte parseren, klipt ut av felt-render.js.
    const fr = les('js', 'felt-render.js');
    const biter = ['escapeHtml', 'parseMarkdown'].map(navn => {
        const i = fr.indexOf(`export function ${navn}(`);
        if (i === -1) throw new Error(`Fant ikke ${navn} i felt-render.js`);
        return fr.slice(i, fr.indexOf('\n}', i) + 2).replace('export function', 'function');
    });
    const parseMarkdown = new Function(`${biter.join('\n')}\nreturn parseMarkdown;`)();

    sjekk('relativt bilde',
        parseMarkdown('![Logo](/bilder/logo.png)'),
        '<p><img class="md-bilde" src="/bilder/logo.png" alt="Logo" loading="lazy"></p>');
    sjekk('absolutt bilde',
        /<img class="md-bilde" src="https:\/\/x\.no\/a\.png"/.test(parseMarkdown('![](https://x.no/a.png)')), true);

    // Bildet må tolkes FØR lenka. Ellers treffer lenkeregelen `[alt](url)`
    // inne i bildet, og utropstegnet blir stående alene.
    const begge = parseMarkdown('![kart](https://x.no/k.png) og [lenke](https://x.no)');
    sjekk('bilde og lenke side om side',
        [/<img /.test(begge), /<a class="md-lenke"/.test(begge), begge.includes('!')],
        [true, true, false]);

    // Samme skjema-godkjenning som lenker.
    sjekk('javascript: blokkeres', /<img/.test(parseMarkdown('![x](javascript:alert(1))')), false);
    sjekk('data: blokkeres', /<img/.test(parseMarkdown('![x](data:text/html,x)')), false);
    // Alt-teksten er escapet før regelen kjører, så den kan ikke bære markup.
    sjekk('alt-tekst er escapet',
        /alt="&quot;&gt;&lt;script&gt;/.test(parseMarkdown('![">?<script>x</script>](/a.png)'.replace('?', ''))), true);

    // Editoren må kunne skrive det visningen kan lese.
    const md = les('js', 'md-editor.js');
    sjekk('editoren har en bildeknapp', /id: 'bilde'/.test(md), true);
    sjekk('som setter inn bildesyntaks', /!\[\$\{alt\}\]\(https:\/\/\)/.test(md), true);

    // Begge ender: editoren lagrer Markdown, rapporten tolker den.
    sjekk('rapporteditoren bruker Markdown-editoren',
        /byggMdEditor\(vert, \{[\s\S]{0,200}verdi: data\.Beskrivelse/.test(utenKommentarer(editor)), true);
    sjekk('og tilbyr bildeknappen', /'lenke', 'bilde'/.test(editor), true);
    sjekk('rapporten tolker beskrivelsen',
        /beskrivelse'\)\.innerHTML = parseMarkdown\(rapporttype\.Beskrivelse/.test(rapport), true);
    // Den gamle veien skal være borte — ellers vises Markdown-koden rå.
    sjekk('ingen rå tekstvisning igjen',
        /beskrivelse'\)\.textContent = rapporttype\.Beskrivelse/.test(rapport), false);
}

// ---------- avkryssing per rad ----------
{
    const kode = utenKommentarer(rapport);

    sjekk('hver rad har en boks', /<td class="velgkol"><input type="checkbox" checked/.test(kode), true);
    sjekk('og den er på som standard', /type="checkbox" checked/.test(kode), true);
    sjekk('Vis alle finnes', /settAlleRader\(true\)/.test(kode), true);
    sjekk('Skjul alle finnes', /settAlleRader\(false\)/.test(kode), true);

    // Dette er kjernen: dempet på skjermen, borte i utskriften.
    sjekk('utelatt rad dempes på skjermen',
        /table\.rapport tr\.utelatt td \{ opacity: 0\.4; text-decoration: line-through; \}/.test(kode), true);
    sjekk('og faller bort i utskriften',
        /table\.rapport tr\.utelatt \{ display: none !important; \}/.test(kode), true);
    // Men ikke skjult i visningen — da kunne den ikke hentes tilbake.
    sjekk('ikke skjult i visningen',
        /tr\.utelatt \{ display: none(?! !important)/.test(kode.split('@media print')[0]), false);
    // Selve avkryssingskolonnen hører ikke hjemme på papiret.
    sjekk('kolonnen skjules i utskriften',
        /th\.velgkol, table\.rapport td\.velgkol \{ display: none !important; \}/.test(kode), true);
    // colspan må telle med den nye kolonnen, ellers blir «Ingen data» feil bred.
    sjekk('colspan teller med boksen', /colspan="\$\{kolonner\.length \+ 1\}"/.test(kode), true);
}

// ---------- søk ----------
{
    const kode = utenKommentarer(rapport);
    // Bare «inneholder». De andre operatorene gir ikke mening halvveis skrevet.
    sjekk('bare contains er søk', /return f\?\.operator === 'contains';/.test(kode), true);
    sjekk('reagerer på input', /addEventListener\('input'/.test(kode), true);
    // Uten forsinkelse ville hvert tegn gitt et serverkall.
    sjekk('med forsinkelse', /setTimeout\(\(\) => \{ if \(harKjort\) kjor\(\{ stille: true \}\); \}, 300\)/.test(kode), true);
    sjekk('og avbryter den forrige', /clearTimeout\(sokTimer\)/.test(kode), true);
    // Filtreringen skal fortsatt skje i motoren, ikke i en kopi i nettleseren.
    sjekk('ingen egen contains-filtrering i siden',
        /toLowerCase\(\)\.includes\(/.test(kode.split('function erSokefilter').pop()), false);
    // Stille kjøring blanker ikke resultatet mellom tastetrykkene.
    sjekk('stille kjøring finnes', /if \(!opts\.stille\) \{/.test(kode), true);
}

// ---------- utskriftsretning ----------
{
    const kode = utenKommentarer(rapport);
    sjekk('valget finnes', /id="utskriftsretning"/.test(kode), true);
    sjekk('liggende og stående', [/value="landscape"/.test(kode), /value="portrait"/.test(kode)], [true, true]);

    // `@page { size }` må i et stilark — et forsøk på et element ville sett
    // riktig ut og ikke gjort noe.
    sjekk('regelen skrives i et stilark',
        /stil\.textContent = `@media print \{ @page \{ size: A4 \$\{gyldig\}; \} \}`/.test(kode), true);
    sjekk('ingen fast retning igjen i CSS-en', /@page \{ size: A4 landscape; margin/.test(kode), false);
    sjekk('valget huskes', /localStorage\.setItem\(RETNING_LS/.test(kode), true);

    // Brede tabeller: celler som bryter, og mindre skrift på papiret.
    sjekk('celler brytes', /overflow-wrap: anywhere/.test(kode), true);
    sjekk('mindre skrift i utskrift', /table\.rapport \{ font-size: 10px; \}/.test(kode), true);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
