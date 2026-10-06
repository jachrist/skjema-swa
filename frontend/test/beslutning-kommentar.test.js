/**
 * Kommentarene som følger en beslutning.
 *
 * API-et har lagret `Kommentar` på beslutningen siden endepunktet ble skrevet
 * (`api/src/functions/skjemaer.js`), og PDF-en har skrevet den ut
 * (`pdf-generator.js:198`). Grensesnittet hadde hverken felt for å skrive den
 * eller plass til å vise den — den som ga en kommentar kunne altså bare se den
 * igjen i en PDF.
 *
 * `kommentarerSomHtml` bygger HTML som settes med `innerHTML`. Derfor er
 * escaping-testen her ikke kosmetikk: en kommentar er fritekst skrevet av en
 * behandler, og den vises for alle som har tilgang til saken.
 *
 * Funksjonen lå i `evaluering.html` fram til 06.10.2026. Nå er den i
 * `js/behandling-kommentar.js`, og registeret og visningen bruker den samme —
 * sammen med stilen, som ikke lenger er en klasse ingen side hadde en regel
 * for. Testen kjører derfor den delte funksjonen direkte.
 *
 * Kjøres med:  node frontend/test/beslutning-kommentar.test.js
 */
const fs = require('fs');
const path = require('path');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

// ---------- den ekte funksjonen, med den ekte escapingen ----------
const { kommentarerSomHtml } = require('../js/behandling-kommentar.js');

// Samme escapeHtml som sidene sender inn, klipt ut av felt-render.js. En
// escape-funksjon oppfunnet her ville testet testen, ikke koden.
const felt = fs.readFileSync(path.join(__dirname, '..', 'js', 'felt-render.js'), 'utf8');
const eStart = felt.indexOf('export function escapeHtml(');
if (eStart === -1) throw new Error('Fant ikke escapeHtml i felt-render.js');
const eSlutt = felt.indexOf('\n}', eStart) + 2;
const escapeHtml = new Function(
    `${felt.slice(eStart, eSlutt).replace('export function', 'function')}\nreturn escapeHtml;`)();

const kommentarerFor = (steg) => kommentarerSomHtml(steg, escapeHtml);

// ---------- ingenting å vise ----------
{
    sjekk('steg uten beslutninger', kommentarerFor({}), '');
    sjekk('tom liste', kommentarerFor({ Beslutninger: [] }), '');
    sjekk('beslutning uten kommentar',
        kommentarerFor({ Beslutninger: [{ Aktor: 'a@b.no', Beslutning: 1 }] }), '');
    // API-et lagrer `body?.kommentar || ''`, så tomme strenger ER normalen.
    // Uten trim ville et mellomrom gitt en tom, innrykket boks i oversikten.
    sjekk('bare mellomrom', kommentarerFor({ Beslutninger: [{ Kommentar: '   ' }] }), '');
}

// ---------- én kommentar ----------
{
    const ut = kommentarerFor({ Beslutninger: [{ Aktor: 'kari@fhs.no', Kommentar: 'Godkjent med forbehold' }] });
    sjekk('teksten er med', ut.includes('Godkjent med forbehold'), true);
    sjekk('aktøren er med', ut.includes('kari@fhs.no'), true);
}

// ---------- flere, som i «alle må avgjøre» ----------
{
    const ut = kommentarerFor({ Beslutninger: [
        { Aktor: 'kari@fhs.no', Kommentar: 'Enig' },
        { Aktor: 'ola@fhs.no', Kommentar: 'Uenig, se vedlegg' },
        { Aktor: 'per@fhs.no' }
    ] });
    sjekk('begge kommentarene vises', ut.includes('Enig') && ut.includes('Uenig, se vedlegg'), true);
    sjekk('den uten kommentar gir ingen boks', ut.includes('per@fhs.no'), false);
}

// ---------- fritekst er fritekst ----------
{
    const ut = kommentarerFor({ Beslutninger: [{
        Aktor: '<b>meg</b>',
        Kommentar: '<img src=x onerror="alert(1)">'
    }] });
    sjekk('ingen rå tagg fra kommentaren', ut.includes('<img'), false);
    sjekk('ingen rå tagg fra aktøren', ut.includes('<b>'), false);
    sjekk('innholdet er beholdt, bare escapet', ut.includes('&lt;img'), true);
}

// ---------- kommentaren får en linje for seg selv ----------
{
    // Stegraden er en flex-boks på alle tre sidene. Uten bredde ble
    // kommentaren klemt inn ved siden av stegnavnet — den sto i markupen, men
    // var ikke til å se. Det var slik den manglet i registeret.
    const ut = kommentarerFor({ Beslutninger: [{ Aktor: 'kari@fhs.no', Kommentar: 'Ja' }] });
    sjekk('stilen følger med', ut.includes('style="'), true);
    sjekk('og gir full bredde', /width:\s*100%/.test(ut), true);
    sjekk('ingen klasse uten regel', ut.includes('beh-kommentar'), false);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
