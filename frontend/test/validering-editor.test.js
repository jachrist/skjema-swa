/**
 * Editor-UI-et for valideringsregler.
 *
 * Steg 3 av brukerønsket fra 22.10.2026. Motoren (vilkar.js) og
 * håndhevingen (felt-render.js) er på plass; dette er det som gjør at noen
 * kan SETTE OPP en regel uten å skrive JSON.
 *
 * Fire ting holdes fast:
 *
 *   **Navnet på «dagens dato» står ett sted.** Editoren bygger nedtrekket
 *   av `IDAG_REF` importert fra vilkar.js. En egen streng her ville gitt en
 *   regel som ser riktig ut i editoren og aldri slår til — og det er den
 *   dyreste varianten, for den oppdages av en bruker, ikke av en test.
 *
 *   **Høyresiden som feltreferanse er et VALG.** `Vises` og
 *   `ObligatoriskHvis` skal ikke få en ekstra nedtrekksliste i hver rad;
 *   de har klart seg med faste verdier. Validering ber om det eksplisitt.
 *
 *   **Feltlista er ALLE felter**, ikke bare de foran. Validering kjører ved
 *   innsending, når hele skjemaet er fylt ut, så «sluttdato» kan stå etter
 *   «startdato». `Vises` må kunne avgjøres mens man blar nedover og bruker
 *   `samleFelterFør` — to ulike spørsmål, to ulike lister.
 *
 *   **Retningen står i panelet.** Vilkåret leses som «gyldig hvis», og en
 *   snudd regel ser ut som en regel som ikke virker. Står ikke setningen
 *   der, er retningen en gjetning.
 *
 * Kjøres med:  node frontend/test/validering-editor.test.js
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

const rot = path.join(__dirname, '..', '..');
const les = (...p) => fs.readFileSync(path.join(rot, ...p), 'utf8');

const editorKilde = les('frontend', 'js', 'dnf-editor.js');
const editorRen = utenKommentarer(editorKilde);
const sideRen = utenKommentarer(les('frontend', 'editor.html'));

// ---------- 1. «dagens dato» har ett navn ----------
{
    const vilkarKilde = les('frontend', 'js', 'vilkar.js');
    const m = /export const IDAG_REF = '([^']+)';/.exec(vilkarKilde);
    sjekk('IDAG_REF er eksportert fra vilkar.js', !!m, true);

    sjekk('dnf-editor importerer den',
        /import \{[^}]*\bIDAG_REF\b[^}]*\} from '\.\/vilkar\.js'/.test(editorRen), true);

    // Og skriver den ikke opp på nytt.
    if (m) {
        const egne = editorRen.split(`'${m[1]}'`).length - 1;
        sjekk('og har ingen egen kopi av strengen', egne, 0);
    }
}

// ---------- 2. høyresiden er et valg, ikke standard ----------
{
    sjekk('dnf-editor har et valg for høyresiden',
        /høyresideFelt\s*=\s*options\.høyresideFelt === true/.test(editorRen), true);

    // Valideringseditoren ber om det.
    const vi = editorRen.slice(editorRen.indexOf('export function byggValideringEditor'));
    sjekk('valideringseditoren ber om feltmodus',
        /høyresideFelt:\s*true/.test(vi), true);

    // Og de tre andre bruksstedene gjør det IKKE — en ekstra nedtrekksliste
    // i hver rad der ville vært støy.
    for (const kall of ['felt.Vises', 'felt.ObligatoriskHvis', 'seksjon.Vises']) {
        const i = sideRen.indexOf(`byggDNFEditor(`);
        sjekk(`${kall} ber ikke om feltmodus`,
            new RegExp(`byggDNFEditor\\([^;]*${kall.replace('.', '\\.')}[^;]*høyresideFelt`).test(sideRen),
            false);
    }
}

// ---------- 3. feltlista er alle felter ----------
{
    sjekk('editoren har en egen samler for alle felter',
        /function samleAlleFelter\(\)/.test(sideRen), true);
    sjekk('og den er uttrykt gjennom samleFelterFør',
        /samleAlleFelter\(\)\s*\{\s*return samleFelterFør\(/.test(sideRen), true);

    // Valideringspanelet bruker den; Vises og ObligatoriskHvis gjør det ikke.
    const valKall = /byggValideringEditor\([\s\S]{0,900}?\}\);/.exec(sideRen);
    sjekk('valideringspanelet monteres', !!valKall, true);
    if (valKall) {
        sjekk('og får ALLE felter',
            /feltOptions:\s*samleAlleFelter\(\)/.test(valKall[0]), true);
    }
    sjekk('Vises bruker fortsatt samleFelterFør',
        /feltOptions:\s*samleFelterFør\(/.test(sideRen), true);
}

// ---------- 4. retningen står i panelet ----------
{
    const vi = editorRen.slice(editorRen.indexOf('export function byggValideringEditor'));
    sjekk('panelet sier når svaret er gyldig',
        /når svaret er GYLDIG/.test(vi), true);
    sjekk('og at regelen hopper over seg selv til feltene er fylt ut',
        /hopper over[\s\S]{0,140}fylt ut/.test(vi), true);
    sjekk('vilkårsboksen heter «Gyldig hvis»',
        /tittel:\s*'Gyldig hvis'/.test(vi), true);
}

// ---------- 5. en regel uten vilkår slipper ikke ut ----------
{
    const vi = editorRen.slice(editorRen.indexOf('export function byggValideringEditor'));
    sjekk('tomme regler filtreres bort',
        /filter\(r => r && r\.Vilkar\)/.test(vi), true);
    // Tom liste skal bli null, ikke [] — ellers bærer skjematypen en tom
    // nøkkel som ser ut som et oppsett.
    sjekk('tom liste blir null', /rene\.length \? rene : null/.test(vi), true);
}

// ---------- 6. null dagers forskyvning lagres ikke ----------
{
    sjekk('PlussDager = 0 fjernes',
        /n === 0\) delete ny\.PlussDager/.test(editorRen), true);
}

// ---------- 7. felttyper uten svar får ikke panelet ----------
{
    sjekk('kanValideres finnes', /function kanValideres\(type\)/.test(sideRen), true);
    const m = /function kanValideres\(type\)\s*\{([\s\S]{0,200}?)\}/.exec(sideRen);
    if (m) {
        for (const type of ['Informasjon', 'Opplasting']) {
            sjekk(`${type} er utelatt`, m[1].includes(type), true);
        }
    }
    sjekk('og sloten tegnes bare da',
        /kanValideres\(felt\.Type\) \? `<div class="dnf-slot" data-slot="felt-validering/.test(sideRen), true);
}

// ---------- 8. venstresiden er feltet selv ----------
//
// 22.10.2026: «Burde ikke venstresiden automatisk være gjeldende felt?»
// Jo — en regel PÅ et felt handler nesten alltid om DET feltet. Uten dette
// er første valg i hver nye regel å finne seg selv i en liste over alle
// felter, og en tom venstreside gir en regel som ser ferdig ut og ikke
// gjør noe.
{
    const vi = editorRen.slice(editorRen.indexOf('export function byggValideringEditor'));
    sjekk('valideringseditoren tar imot feltets egen referanse',
        /egetFelt = options\.egetFelt/.test(vi), true);
    sjekk('og en ny regel starter med den på venstresiden',
        /OgAv: \[\{ Felt: egetFelt,/.test(vi), true);

    sjekk('og editoren sender den inn',
        /egetFelt:\s*feltRef\(seksjon, felt\)/.test(sideRen), true);
}

// ---------- 9. etiketten i feltvelgeren bygges ETT sted ----------
//
// Nedtrekket sa «(uten tekst)» for et felt som nettopp var navngitt:
// velgerne fikk etiketten da panelet ble bygget, og tittelfeltet tegner
// ikke om ved hvert tastetrykk — det ville tatt fokus ut av feltet.
//
// Rettelsen flytter bare teksten på de opsjonene som peker på feltet. Da
// bygges etiketten to steder, og de må være samme funksjon.
{
    sjekk('etiketten har en egen funksjon',
        /function feltEtikett\(seksjon, felt\)/.test(sideRen), true);
    sjekk('og referansen likeså',
        /function feltRef\(seksjon, felt\)/.test(sideRen), true);

    // Feltlista bruker dem.
    const samler = /function samleFelterFør\(sIdx, fIdx\)[\s\S]{0,1400}?\n        \}/.exec(sideRen);
    sjekk('fant feltsamleren', !!samler, true);
    if (samler) {
        sjekk('feltlista bruker feltRef', /ref:\s*feltRef\(/.test(samler[0]), true);
        sjekk('og feltEtikett', /tekst:\s*feltEtikett\(/.test(samler[0]), true);
        // Og bygger dem IKKE selv.
        sjekk('og bygger ikke etiketten selv',
            /S\$\{seksjon\.Seksjon_nummer\}-F\$\{felt\.Nummer\}/.test(samler[0]), false);
    }

    // setFeltTekst oppdaterer de åpne velgerne, med samme funksjon.
    const sett = /window\.setFeltTekst = [\s\S]{0,1600}?\n        \};/.exec(sideRen);
    sjekk('fant setFeltTekst', !!sett, true);
    if (sett) {
        sjekk('tittelendring oppdaterer åpne feltvelgere',
            /querySelectorAll\('\.dnf-editor select option'\)/.test(sett[0]), true);
        sjekk('og bruker samme etikettfunksjon',
            /feltEtikett\(seksjon, felt\)/.test(sett[0]), true);
        sjekk('og samme referansefunksjon',
            /feltRef\(seksjon, felt\)/.test(sett[0]), true);

        // Den skal IKKE tegne om: da forsvinner markøren ut av tittelfeltet
        // midt i skrivingen, og det var grunnen til at etiketten ble stående.
        sjekk('og tegner ikke om',
            /rendrerSeksjoner\(\)/.test(sett[0]), false);
    }
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
