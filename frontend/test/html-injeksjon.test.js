/**
 * Ingen verdi skal skrives til HTML uten escaping, uten at noen har sagt
 * hvorfor.
 *
 * `scripts/html-injeksjon.js` leser hver `innerHTML`, `outerHTML`,
 * `insertAdjacentHTML` og `document.write` i frontend og vurderer hver
 * `${...}` som havner der. Denne testen krever at lista over uforklarte
 * treff er tom.
 *
 * Hvorfor en unntaksliste og ikke bare «escape alt»: en god del av det som
 * settes inn er tall API-et har regnet ut, klassenavn koden selv velger, og
 * faste tabeller i samme fil. Å pakke dem i escapeHtml ville vært støy, og
 * støy er grunnen til at den slags skript slutter å bli kjørt. Men hvert av
 * dem skal være VURDERT, og vurderingen skal stå i koden.
 *
 * Testen sjekker også at lista ikke forfaller: en erklæring for et uttrykk
 * som ikke lenger finnes, er en erklæring ingen tør stole på.
 *
 * Kjøres med:  node frontend/test/html-injeksjon.test.js
 */
const fs = require('fs');
const path = require('path');
const skanner = require('../../scripts/html-injeksjon.js');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const { funn, sinker, filer } = skanner.skann();

// ---------- skanneren må faktisk ha lest noe ----------
//
// Testens eget nullpunkt. Slutter sink-mønsteret å treffe, blir «ingen
// uforklarte treff» sant fordi ingenting ble lest — og det er den farligste
// formen for grønn.
{
    sjekk('skanneren fant filene', filer.length > 25, true);
    sjekk('og sinkene i dem', sinker > 200, true);
}

// ---------- hovedregelen ----------
{
    const uerklært = funn
        .filter(f => !(`${f.fil}:${f.uttrykk}` in skanner.GODTATT))
        .map(f => `${f.fil}:${f.linje}  ${f.uttrykk}`);
    sjekk('ingen uescapet interpolasjon uten begrunnelse', uerklært, []);
    if (uerklært.length) console.log('      (kjør: node scripts/html-injeksjon.js)');
}

// ---------- unntakslista skal ikke forfalle ----------
{
    const funnet = new Set(funn.map(f => `${f.fil}:${f.uttrykk}`));
    const døde = Object.keys(skanner.GODTATT).filter(n => !funnet.has(n));
    // En erklæring for noe som ikke lenger finnes er enten ryddet opp (bra,
    // men da skal erklæringen bort) eller et uttrykk som har endret form
    // (ikke bra — da dekker erklæringen ikke lenger det den tror).
    sjekk('ingen død oppføring i GODTATT', døde, []);

    const tynne = Object.entries(skanner.GODTATT).filter(([, g]) => (g || '').length < 40).map(([n]) => n);
    sjekk('hver begrunnelse sier noe', tynne, []);
}

// ---------- erklærte HTML-produsenter må finnes ----------
//
// Et navn på lista som ikke finnes i koden er en vakt som ikke vokter noe.
// Det farlige er omvendt: døpes `kommentarerSomHtml` om, slutter navnet å
// treffe, og alt den returnerte blir flagget. Det er riktig retning — men en
// oppføring som ikke treffer NOE skal uansett bort.
{
    const rot = path.join(__dirname, '..', '..');
    const kilder = [
        ...fs.readdirSync(path.join(rot, 'frontend')).filter(n => n.endsWith('.html'))
            .map(n => fs.readFileSync(path.join(rot, 'frontend', n), 'utf8')),
        ...fs.readdirSync(path.join(rot, 'frontend', 'js')).filter(n => n.endsWith('.js'))
            .map(n => fs.readFileSync(path.join(rot, 'frontend', 'js', n), 'utf8'))
    ].join('\n');
    const ukjente = skanner.HTML_PRODUSENTER.filter(n =>
        !new RegExp(`function ${n}\\s*\\(`).test(kilder));
    sjekk('hver erklært HTML-produsent finnes i koden', ukjente, []);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
