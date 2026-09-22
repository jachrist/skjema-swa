/**
 * E-postikonet i skjemaeditoren (ønske 72).
 *
 * Teams (💬), Planner (📋) og Teams-kanal (📢) var merket; e-post var det
 * ikke. Den som satte opp en skjematype kunne ikke se hvilke knapper som
 * faktisk sendte e-post — og dermed heller ikke at muligheten fantes.
 *
 * Merkingen er verdiløs i det den er ufullstendig. Står ikonet på tre av fire
 * knapper, lærer man at «knapper uten ikon sender ikke e-post», og det er da
 * den fjerde gjør skade. Testen sjekker derfor ikke at fire bestemte knapper
 * har ikonet — den finner SELV hver funksjon i editor.html som åpner
 * meldingsmodalen, og krever at knappen som kaller den bærer ikonet. En femte
 * e-postmelding kan ikke legges til umerket uten at dette blir rødt.
 *
 * Ikonet leses ut av melding-editor.js, ikke skrevet inn her. Ellers ville to
 * kopier av «hvilket ikon» levd side om side, og testen bestått mens
 * grensesnittet viste noe annet.
 *
 * Til slutt kontrollen andre veien: de tre andre kanalene skal IKKE ha
 * e-postikonet. Et ikon alle har, skiller ingenting.
 *
 * Kjøres med:  node frontend/test/epost-ikon.test.js
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

const modulKilde = fs.readFileSync(path.join(__dirname, '..', 'js', 'melding-editor.js'), 'utf8');
const ikonTreff = /export const EPOST_IKON = '(.+?)'/.exec(modulKilde);
sjekk('EPOST_IKON er definert ett sted', !!ikonTreff, true);
const IKON = ikonTreff ? ikonTreff[1] : '\u0000';

const kode = utenKommentarer(fs.readFileSync(path.join(__dirname, '..', 'editor.html'), 'utf8'));

// Klippingen må ha gitt oss noe. En tom streng ville bestått alt under som
// ikke er en «finnes»-sjekk — og det har skjedd før i dette repoet.
sjekk('editor.html ble lest', kode.length > 50000, true);
sjekk('modalen importeres med ikonet', /import \{[^}]*EPOST_IKON[^}]*\} from '\.\/js\/melding-editor\.js'/.test(kode), true);

// ---------- hvilke funksjoner åpner meldingsmodalen? ----------
// Gå bakover fra hvert kall til nærmeste «window.navn =». Det er
// tilordningen som gjør funksjonen kallbar fra en onclick, så det er den
// knappen må peke på.
const åpnere = [];
for (const m of kode.matchAll(/apneMeldingModal\(/g)) {
    const før = kode.slice(0, m.index);
    const navn = [...før.matchAll(/window\.(\w+)\s*=/g)].pop();
    if (navn && !åpnere.includes(navn[1])) åpnere.push(navn[1]);
}
sjekk('fant e-postredigererne', åpnere.length >= 4, true);

/** Knappe-elementet som kaller `navn(` — hele taggen med innhold. */
function knappFor(navn) {
    const i = kode.indexOf(`onclick="${navn}(`);
    if (i === -1) return null;
    const start = kode.lastIndexOf('<button', i);
    const slutt = kode.indexOf('</button>', i);
    return start === -1 || slutt === -1 ? null : kode.slice(start, slutt);
}

/**
 * Bærer knappen ikonet?
 *
 * Enten direkte, eller gjennom én variabel: `${tbTekst}` der `tbTekst`
 * settes av et template-literal som inneholder EPOST_IKON. Ett ledd er nok
 * for koden slik den står, og mer ville vært å skrive en tolk.
 */
function harIkon(markup) {
    if (markup.includes(IKON) || markup.includes('${EPOST_IKON}')) return true;
    for (const v of markup.matchAll(/\$\{(\w+)\}/g)) {
        const tilordning = new RegExp(`const ${v[1]} = \`[^\`]*EPOST_IKON[^\`]*\``);
        if (tilordning.test(kode)) return true;
    }
    return false;
}

for (const navn of åpnere) {
    const markup = knappFor(navn);
    sjekk(`${navn}: knappen finnes`, !!markup, true);
    if (markup) sjekk(`${navn}: knappen er merket med e-postikonet`, harIkon(markup), true);
}

// ---------- kontrollen andre veien ----------
{
    // De tre andre kanalene har sine egne ikoner og skal ikke ha dette.
    for (const [navn, eget] of [
        ['apneTeamsMeldingEditor', '💬'],
        ['apnePlannerEditor', '📋'],
        ['apneTeamskanalEditor', '📢']
    ]) {
        const markup = knappFor(navn);
        sjekk(`${navn}: knappen finnes`, !!markup, true);
        if (markup) {
            sjekk(`${navn}: har sitt eget ikon`, markup.includes(eget), true);
            sjekk(`${navn}: har IKKE e-postikonet`, harIkon(markup), false);
        }
    }
}

// ---------- modalen sier det også ----------
{
    sjekk('modaltittelen bærer ikonet',
        /const tittel = `\$\{EPOST_IKON\} \$\{options\.tittel/.test(utenKommentarer(modulKilde)), true);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
