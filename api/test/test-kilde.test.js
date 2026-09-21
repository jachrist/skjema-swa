/**
 * Verktøyet tolv andre tester hviler på.
 *
 * Mange tester leser kode som tekst og sjekker at en regel finnes eller ikke
 * finnes. Kommentarene må da bort, ellers kan en test bestå på sin egen
 * forklaring. Strippingen var kopiert inn i hver test, og alle kopiene hadde
 * samme feil:
 *
 *     linjekommentarer først, så alt mellom skråstrek-stjerne og
 *     stjerne-skråstrek, uansett hvor de sto.
 *
 * I `admin.html` står `accept="image/*,.pdf,.txt,…"`. Skråstrek-stjernen i
 * `image/` + stjerne er ikke en kommentar, men regexen leste den som starten
 * på én og spiste 17 490 tegn fram til neste kommentarslutt. `editor.html`
 * mistet 11 974 tegn på samme måte.
 *
 * Testene leste altså en fil med hull i, og en sjekk på at noe IKKE finnes
 * besto fordi teksten var borte. Grønn test, ingen dekning.
 *
 * Derfor denne: hjelperen er nå felles, og den må selv være testet. Kravene
 * står i begge retninger — ekte kommentarer SKAL bort, kode SKAL bli stående.
 *
 * Kjøres med:  node api/test/test-kilde.test.js
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

// ---------- kommentarer skal bort ----------
{
    sjekk('linjekommentar', utenKommentarer('const a = 1; // hemmelig\n').includes('hemmelig'), false);
    sjekk('men koden står', utenKommentarer('const a = 1; // x\n').includes('const a = 1;'), true);

    sjekk('blokkkommentar', utenKommentarer('/* hemmelig */ const a = 1;').includes('hemmelig'), false);
    sjekk('flerlinjes blokk',
        utenKommentarer('/**\n * hemmelig\n */\nconst a = 1;').includes('hemmelig'), false);
    sjekk('og koden står igjen',
        utenKommentarer('/**\n * x\n */\nconst a = 1;').includes('const a = 1;'), true);

    sjekk('HTML-kommentar', utenKommentarer('<div></div><!-- hemmelig -->').includes('hemmelig'), false);
    sjekk('CSS-kommentar', utenKommentarer('.a { /* hemmelig */ color: red; }').includes('hemmelig'), false);
    sjekk('men CSS-regelen står', utenKommentarer('.a { /* x */ color: red; }').includes('color: red'), true);
}

// ---------- kode skal IKKE bort ----------
{
    // Feilen som utløste hele denne fila.
    const accept = '<input accept="image/*,.pdf,.txt">\nconst etterpå = 1;\n/** ekte */\nconst enda = 2;';
    const ut = utenKommentarer(accept);
    sjekk('image/* overlever', ut.includes('image/*'), true);
    sjekk('og koden etter den også', ut.includes('const etterpå = 1;'), true);
    sjekk('og koden etter den ekte kommentaren', ut.includes('const enda = 2;'), true);
    sjekk('mens den ekte kommentaren er borte', ut.includes('ekte'), false);

    // URL-er i kode er ikke kommentarer.
    sjekk('https:// overlever',
        utenKommentarer("const u = 'https://x.no/a';").includes('https://x.no/a'), true);
    sjekk('protokoll-relativ URL overlever',
        utenKommentarer("const u = '//x.no/a';").includes('//x.no/a'), true);

    // Regex og strenger med skråstrek-stjerne.
    sjekk('glob-mønster overlever',
        utenKommentarer('const g = "src/*.js";').includes('src/*.js'), true);
    sjekk('media-type med joker overlever',
        utenKommentarer('accept="application/*"').includes('application/*'), true);
}

// ---------- mot de ekte filene ----------
{
    const rot = path.join(__dirname, '..', '..');
    const les = (p) => fs.readFileSync(path.join(rot, p), 'utf8');

    // Den gamle strippingen, til sammenligning. Den skal tape mot den nye på
    // nettopp de to filene som utløste feilen.
    const gammel = (s) => s.replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');

    for (const f of ['frontend/admin.html', 'frontend/editor.html']) {
        const raa = les(f);
        sjekk(`${f}: den nye beholder mer`, utenKommentarer(raa).length > gammel(raa).length, true);
        sjekk(`${f}: image/* står igjen`, utenKommentarer(raa).includes('image/*'), true);
        // Og den fjerner fortsatt ekte kommentarer — ellers hadde vi bare
        // byttet én feil mot en annen.
        sjekk(`${f}: noe ble faktisk strippet`, utenKommentarer(raa).length < raa.length, true);
    }

    // Kodemarkører som MÅ overleve på hver side testene leser. Forsvinner en
    // av dem igjen, feiler denne testen før de tolv andre blir upålitelige.
    const markorer = [
        ['frontend/admin.html', "api.get('/api/team-synk')"],
        ['frontend/admin.html', 'id="team-navn"'],
        ['frontend/editor.html', 'id="maks-svar"'],
        ['frontend/editor.html', 'data-panel-id="tilgjengelighet"'],
        ['frontend/evaluering.html', "div.id = 'samtale'"],
        ['frontend/index.html', 'svargrenseTillater'],
        ['frontend/kvittering.html', 'byggSamtale('],
        ['api/src/functions/skjemaer.js', 'svargrense.maaSjekkes('],
        ['api/src/functions/team-synk.js', 'kallTeamSynkFlyt(']
    ];
    for (const [f, m] of markorer) {
        sjekk(`${f}: «${m}» overlever`, utenKommentarer(les(f)).includes(m), true);
    }
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
