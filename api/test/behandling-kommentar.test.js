/**
 * Behandlerens kommentar må finnes igjen alle steder behandlingen dokumenteres.
 *
 * Kommentaren lagres to steder, avhengig av modus:
 *
 *   Standard («første behandler avgjør») → `steg.Kommentar`
 *   «Alle må avgjøre»                    → `steg.Beslutninger[].Kommentar`
 *
 * Fram til 19.09.2026 var det verre enn som så: standardmodus lagret den
 * ALDRI. Kommentaren ble sendt inn, brukt i `$kommentar` i varselet til
 * innsenderen, og så kastet. Den som skrev en begrunnelse for et avslag kunne
 * ikke finne den igjen noe sted.
 *
 * Og hver leser kjente bare den ene formen:
 *
 *   PDF-en leste `steg.Kommentar`          → tom i «alle må avgjøre»
 *   evaluering og datauttrekk leste `Beslutninger[]` → tom i standardmodus
 *
 * Til sammen betydde det at en kommentar aldri var synlig alle stedene den
 * skulle være — og at hvilken halvdel som manglet, avhang av modus. Det er
 * derfor feilen overlevde testing: den modusen man prøvde, virket.
 *
 * Regelen ligger nå ett sted. Den finnes riktignok i to FILER — sidene kan
 * ikke importere fra `api/` — og siste del av denne testen kjører begge mot
 * de samme tilfellene. En kopi som får lov til å drive fra originalen er
 * verre enn to ulike funksjoner, fordi den ser ut som den ene.
 *
 * Kjøres med:  node api/test/behandling-kommentar.test.js
 */
const fs = require('fs');
const path = require('path');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const { kommentarerFor, kommentarLinje } = require('../src/lib/behandling-kommentar');
const { utenKommentarer } = require('../../scripts/test-kilde.js');

// Tilfellene begge kopiene må være enige om.
const TILFELLER = {
    'standardmodus': { Kommentar: 'Avslått fordi vedlegget mangler', BehandletAv: 'kari@fhs.no' },
    'alle må avgjøre': { Beslutninger: [
        { Aktor: 'kari@fhs.no', Kommentar: 'Enig' },
        { Aktor: 'ola@fhs.no', Kommentar: 'Med forbehold' }
    ] },
    'alle, bare én skrev': { Beslutninger: [
        { Aktor: 'kari@fhs.no', Kommentar: 'Enig' },
        { Aktor: 'ola@fhs.no', Kommentar: '' }
    ] },
    'ingen kommentar': { BehandletAv: 'kari@fhs.no', Beslutning: 1 },
    'bare mellomrom': { Kommentar: '   ', BehandletAv: 'kari@fhs.no' },
    'tomme beslutninger': { Beslutninger: [] },
    'begge former satt': { Kommentar: 'på steget', BehandletAv: 'a@b.no',
        Beslutninger: [{ Aktor: 'c@d.no', Kommentar: 'per aktør' }] },
    'uten behandler': { Kommentar: 'skrevet av en flyt' },
    'tomt steg': {},
    'null': null
};

// ---------- standardmodus ----------
{
    sjekk('standard: kommentaren finnes',
        kommentarerFor(TILFELLER['standardmodus']),
        [{ aktor: 'kari@fhs.no', kommentar: 'Avslått fordi vedlegget mangler' }]);
    // Én behandler: navnet er unødvendig inne i teksten, det står i UtfallAv.
    sjekk('standard: linja er bare teksten',
        kommentarLinje(TILFELLER['standardmodus']), 'Avslått fordi vedlegget mangler');
    sjekk('standard: uten behandler',
        kommentarerFor(TILFELLER['uten behandler']), [{ aktor: '', kommentar: 'skrevet av en flyt' }]);
}

// ---------- alle må avgjøre ----------
{
    sjekk('alle: begge er med', kommentarerFor(TILFELLER['alle må avgjøre']).length, 2);
    sjekk('alle: merkes med hvem',
        kommentarLinje(TILFELLER['alle må avgjøre']),
        'kari@fhs.no: Enig | ola@fhs.no: Med forbehold');
    // Bare én skrev: da er det ingen å skille fra, og navnet er overflødig.
    sjekk('alle, én skrev: står alene',
        kommentarLinje(TILFELLER['alle, bare én skrev']), 'Enig');
}

// ---------- ingenting å vise ----------
{
    for (const navn of ['ingen kommentar', 'bare mellomrom', 'tomme beslutninger', 'tomt steg', 'null']) {
        sjekk(`${navn}: tom liste`, kommentarerFor(TILFELLER[navn]), []);
        sjekk(`${navn}: tom linje`, kommentarLinje(TILFELLER[navn]), '');
    }
}

// ---------- når begge former er satt ----------
{
    // Beslutninger[] vinner. Den er den mest spesifikke: den sier hvem som
    // skrev hva. steg.Kommentar er fallbacken for standardmodus.
    sjekk('per aktør går foran',
        kommentarLinje(TILFELLER['begge former satt']), 'per aktør');
}

// ---------- lagres den i det hele tatt? ----------
{
    // Det var her hullet var. Begge grenene i beslutnings-endepunktet må
    // skrive kommentaren ned; ellers finnes det ingenting for leserne å vise.
    const kilde = fs.readFileSync(path.join(__dirname, '..', 'src', 'functions', 'skjemaer.js'), 'utf8');
    const kode = utenKommentarer(kilde);
    sjekk('standardgrenen lagrer kommentaren',
        /stegObj\.Kommentar\s*=\s*body\?\.kommentar/.test(kode), true);
    sjekk('alle-grenen lagrer per aktør',
        /Kommentar:\s*body\?\.kommentar/.test(kode), true);
}

// ---------- leserne bruker den delte regelen ----------
{
    const les = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');

    // Se etter KALLET, ikke etter navnet. Et navn som bare står i en import
    // eller en kommentar beviser ingenting — og en tidligere utgave av denne
    // testen bestod da PDF-en var lagt tilbake til sin egen filtrering,
    // fordi importlinja fortsatt sto der.
    for (const [fil, kall] of [
        ['api/src/lib/pdf-generator.js', /kommentarerFor\(/],
        ['api/src/lib/datauttrekk.js', /kommentarLinje\(/],
        ['frontend/visning.html', /kommentarerFor\(steg\)/],
        ['frontend/register.html', /kommentarerSomHtml\(steg/],
        ['frontend/evaluering.html', /kommentarer\(steg\)/]
    ]) {
        const kode = les(fil).replace(/^\s*import .*$/gm, '').replace(/^\s*const \{[^}]*\} = require\(.*$/gm, '');
        sjekk(`${fil}: kaller den delte regelen`, kall.test(kode), true);
    }
    // Og ingen av dem skal ha sin egen kopi av filteret igjen.
    for (const fil of ['api/src/lib/pdf-generator.js', 'api/src/lib/datauttrekk.js']) {
        const kode = utenKommentarer(les(fil));
        sjekk(`${fil}: ingen egen Beslutninger-filtrering`,
            /Beslutninger[\s\S]{0,40}Kommentar/.test(kode), false);
    }
}

// ---------- de to kopiene skal si det samme ----------
async function parity() {
    const { pathToFileURL } = require('url');
    const front = await import(pathToFileURL(
        path.join(__dirname, '..', '..', 'frontend', 'js', 'behandling-kommentar.js')).href);

    for (const [navn, steg] of Object.entries(TILFELLER)) {
        sjekk(`kopiene er enige: ${navn}`,
            front.kommentarerFor(steg), kommentarerFor(steg));
    }

    console.log(`\n${ok} OK, ${feil} feil  (${Object.keys(TILFELLER).length} tilfeller)`);
    process.exit(feil ? 1 : 0);
}

parity().catch(e => { console.error(e); process.exit(1); });
