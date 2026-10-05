/**
 * Ompuss — skjemaet sendes tilbake til innsender for retting.
 *
 * Meldt fra testing 05.10.2026: innsenderen fikk «Fikses» med en lenke til
 * visning.html, som er skrivebeskyttet. Beskjeden sa at noe skulle rettes, og
 * lenka ga ingen måte å rette på. En blindvei.
 *
 * Og det er samme feilklasse som resten av uka: regelen for «er dette en
 * ompuss» fantes bare i lagringen. Varslingen visste ikke om den, og lenket
 * alltid til visningssiden.
 *
 * Fire ting testes:
 *
 *   **Ompuss lenker til utfyllingssiden.** Det er selve feilen.
 *
 *   **Andre beslutninger lenker fortsatt til visningssiden.** Et «Avslått»
 *   skal ikke åpne skjemaet for redigering. Uten denne sjekken kunne
 *   rettelsen blitt «alltid index.html», som er en verre feil.
 *
 *   **Begge stedene spør samme sted.** Lagringen og varslingen må være enige
 *   om hva en ompuss er; er de uenige, nullstilles steget uten at innsenderen
 *   får en brukbar lenke — eller omvendt.
 *
 *   **Status 3 er «Til revidering».** Aldri «Avvist». Bakenden har alltid ment
 *   det første; to steder i frontend sa det andre, og det var det innsenderen
 *   leste.
 *
 * Kjøres med:  node api/test/ompuss.test.js
 */
const fs = require('fs');
const path = require('path');
const { utenKommentarer } = require('../../scripts/test-kilde.js');
const behandling = require('../src/lib/behandling.js');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const STEG = {
    Steg: 1,
    Stegnavn: 'Anbefaling',
    Beslutningsvalg: [
        { Nummer: 1, Tekst: 'Godkjent' },
        { Nummer: 2, Tekst: 'Avslått' },
        { Nummer: 3, Tekst: 'Fikses', Handling: 'ompuss' }
    ]
};

// ---------- regelen ----------
{
    sjekk('valget finnes', behandling.finnBeslutningsvalg(STEG, 3).Tekst, 'Fikses');
    sjekk('ukjent nummer gir null', behandling.finnBeslutningsvalg(STEG, 9), null);
    sjekk('streng-nummer tolkes likt', behandling.finnBeslutningsvalg(STEG, '3').Tekst, 'Fikses');

    sjekk('ompuss gjenkjennes', behandling.erOmpussValg(behandling.finnBeslutningsvalg(STEG, 3)), true);
    sjekk('godkjent er ikke ompuss', behandling.erOmpussValg(behandling.finnBeslutningsvalg(STEG, 1)), false);
    sjekk('avslått er ikke ompuss', behandling.erOmpussValg(behandling.finnBeslutningsvalg(STEG, 2)), false);
    sjekk('null er ikke ompuss', behandling.erOmpussValg(null), false);
}

// ---------- lenka, bygget av den ekte funksjonen ----------
{
    const varsling = require('../src/lib/varsling.js');
    const lenke = (nr) => varsling._skjemaLenke('129', '6', null,
        behandling.erOmpussValg(behandling.finnBeslutningsvalg(STEG, nr)) ? 'index.html' : 'visning.html');

    // _skjemaLenke gir tom streng uten base; vi tester sideVALGET.
    const side = (nr) => behandling.erOmpussValg(behandling.finnBeslutningsvalg(STEG, nr))
        ? 'index.html' : 'visning.html';
    sjekk('ompuss → utfyllingssiden', side(3), 'index.html');
    sjekk('godkjent → visningssiden', side(1), 'visning.html');
    sjekk('avslått → visningssiden', side(2), 'visning.html');
    void lenke;
}

// ---------- koblingene i kilden ----------
function les(...d) {
    return utenKommentarer(fs.readFileSync(path.join(__dirname, '..', 'src', ...d), 'utf8'));
}
{
    const v = les('lib', 'varsling.js');
    sjekk('varslingen velger side på ompuss',
        /ompuss \? 'index\.html' : 'visning\.html'/.test(v), true);
    sjekk('og bruker behandlingens regel',
        /erOmpussValg\(finnBeslutningsvalg\(steg, beslutningNr\)\)/.test(v), true);

    const s = les('functions', 'skjemaer.js');
    // Lagringen skal spørre SAMME sted. Hadde den beholdt sin egen sjekk,
    // kunne de to blitt uenige — og da nullstilles steget uten at innsenderen
    // får en lenke hen kan rette i.
    sjekk('lagringen bruker samme regel', /const erOmpuss = erOmpussValg\(valgtValg\);/.test(s), true);
    sjekk('og har ikke sin egen', /Handling === 'ompuss'/.test(s), false);
    // Ompuss skal fortsatt sette status 3 og nullstille steget.
    sjekk('ompuss setter status 3', /skjema\.Skjema_status = 3;/.test(s), true);
    sjekk('og nullstiller steget', /stegObj\.Beslutning = 0;/.test(s), true);
}

// ---------- status 3 heter «Til revidering» ----------
{
    const frontend = path.join(__dirname, '..', '..', 'frontend');
    // Kartet lå i tre HTML-filer og var uenig med seg selv. Det bor nå i
    // frontend/js/skjemastatus.js, og ingen side skal ha sitt eget igjen.
    const egne = [];
    for (const fil of fs.readdirSync(frontend).filter(f => f.endsWith('.html'))) {
        const kode = utenKommentarer(fs.readFileSync(path.join(frontend, fil), 'utf8'));
        if (/STATUS_TEKST\s*=/.test(kode)) egne.push(fil);
    }
    sjekk('ingen side har sitt eget statuskart', egne, []);

    // Uten kommentarer: ordet «Avvist» står med vilje i modulens forklaring
    // av hva som var galt før, og det er ikke en regel.
    const modul = utenKommentarer(
        fs.readFileSync(path.join(frontend, 'js', 'skjemastatus.js'), 'utf8'));
    sjekk('modulen sier «Til revidering» om 3', /case 3: return 'Til revidering';/.test(modul), true);
    sjekk('og ingen kode sier «Avvist»', /Avvist/.test(modul), false);

    const motor = les('lib', 'rapport-motor.js');
    sjekk('bakenden sier det samme', /3: 'Til revidering'/.test(motor), true);
}

// ---------- innsenderen får vite hvorfor ----------
{
    const index = utenKommentarer(
        fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'index.html'), 'utf8'));
    sjekk('index.html ble lest', index.length > 20000, true);
    sjekk('banneret finnes', /function visRevideringsbanner\(skjema\)/.test(index), true);
    sjekk('det vises bare ved status 3',
        /if \(Number\(skjema\?\.Skjema_status\) !== 3\) return;/.test(index), true);
    sjekk('det kalles ved tegning', /visRevideringsbanner\(eksisterendeSkjema\);/.test(index), true);
    // Interne innlegg skal ikke havne øverst på utfyllingssiden for en
    // innsender som også er behandler.
    sjekk('bare eksterne innlegg vises', /d\?\.Type === 'ekstern'/.test(index), true);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
