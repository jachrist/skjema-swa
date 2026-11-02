/**
 * «Felt vises kun hvis» på informasjonsfelt.
 *
 * Ønsket 03.11.2026: en forklaring som bare gjelder ett svar, skal kunne
 * skjules for de andre. Utfyllingssiden har alltid tatt hensyn til `Vises` på
 * alle felttyper — det var bare editoren som ikke tilbød valget for
 * informasjonsfelt.
 *
 * Tre ledd må henge sammen, i hver sin fil, og testen leser alle tre:
 *
 *   editor.html   tegner vilkårsfeltet og kobler det opp for informasjonsfelt
 *   index.html    merker informasjonsfeltet med data-felt-nummer, som er
 *                 selektoren oppdaterVises() bruker
 *   index.html    oppdaterVises() hopper ikke over noen felttype
 *
 * «Obligatorisk hvis» skal derimot IKKE tilbys: et informasjonsfelt har ikke
 * noe svar.
 *
 * Kjøres med:  node frontend/test/informasjon-vises.test.js
 */
const fs = require('fs');
const path = require('path');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const les = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const editor = les('editor.html');
const index = les('index.html');

/** Kroppen til en funksjon på toppnivå i script-blokka (åtte mellomrom inn). */
function funksjon(kilde, navn) {
    const start = kilde.indexOf(`function ${navn}(`);
    if (start === -1) return '';
    return kilde.slice(start, kilde.indexOf('\n        }\n', start));
}

// ---------- 1. editoren tegner vilkårsfeltet for alle felttyper ----------
{
    const vises = /<div class="dnf-slot" data-slot="felt-vises-\$\{sIdx\}-\$\{fIdx\}"/.exec(editor);
    sjekk('felt-vises-sporet finnes', !!vises, true);
    // Står det inne i en betingelse på Informasjon, får informasjonsfelt det ikke.
    const linje = vises ? editor.slice(editor.lastIndexOf('\n', vises.index), editor.indexOf('\n', vises.index)) : '';
    sjekk('felt-vises tegnes uten unntak for Informasjon', /Informasjon/.test(linje), false);

    // Malen, ikke oppkoblingen i byggAlleDNFEditorer — den står først i fila.
    const oblig = /<div class="dnf-slot" data-slot="felt-oblig-/.exec(editor);
    const obligLinje = oblig ? editor.slice(editor.lastIndexOf('\n', oblig.index), editor.indexOf('\n', oblig.index)) : '';
    sjekk('felt-oblig tegnes IKKE for Informasjon', /felt\.Type !== 'Informasjon'/.test(obligLinje), true);
}

// ---------- 2. editoren kobler opp vilkåret før den hopper over ----------
{
    const bygg = funksjon(editor, 'byggAlleDNFEditorer');
    sjekk('fant byggAlleDNFEditorer', bygg.length > 0, true);
    const iVises = bygg.indexOf('felt-vises-');
    const iUnntak = bygg.indexOf("if (felt.Type === 'Informasjon') return;");
    const iOblig = bygg.indexOf('felt-oblig-');
    sjekk('Vises-editoren bygges før unntaket for Informasjon', iVises > -1 && iUnntak > iVises, true);
    sjekk('og Obligatorisk hvis etter', iOblig > iUnntak, true);
}

// ---------- 3. utfyllingssiden merker og skjuler informasjonsfelt ----------
{
    const byggFelt = funksjon(index, 'byggFelt');
    sjekk('fant byggFelt', byggFelt.length > 0, true);
    const iMerke = byggFelt.indexOf('div.dataset.feltNummer = felt.Nummer');
    const iGren = byggFelt.indexOf("if (felt.Type !== 'Informasjon')");
    sjekk('data-felt-nummer settes for alle felt, før typegrenen', iMerke > -1 && iMerke < iGren, true);

    const oppdater = funksjon(index, 'oppdaterVises');
    sjekk('fant oppdaterVises', oppdater.length > 0, true);
    // Bare løkka for Felt-Vises. Stjerna for obligatoriske felt lenger ned
    // hopper over informasjonsfelt, og det skal den.
    const fra = oppdater.indexOf('// Felt-Vises');
    const løkke = oppdater.slice(fra, oppdater.indexOf('// ObligatoriskHvis', fra));
    sjekk('fant Felt-Vises-løkka', fra > -1 && løkke.length > 0, true);
    sjekk('Felt-Vises hopper ikke over Informasjon', /Informasjon/.test(løkke), false);
    sjekk('og bruker data-felt-nummer', /\.felt\[data-felt-nummer=/.test(løkke), true);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
