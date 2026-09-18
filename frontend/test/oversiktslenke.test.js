/**
 * Lenken til skjemaoversikten skal bare vises for admin, skjemaskapere og
 * eiere.
 *
 * «Velg skjema» er ikke en side alle skal innom, og en innsender som nettopp
 * har sendt inn et skjema fikk den servert som primærknapp på kvitteringen.
 *
 * To ting kan gå galt, og begge ser helt normale ut:
 *
 *   **En lenke blir ikke merket.** Den samme URL-en brukes også som «Avbryt»
 *   midt i utfyllingen, så et selektor-søk på href ville tatt begge — derfor
 *   merkes oversiktslenkene eksplisitt med `data-oversiktslenke`. Prisen er at
 *   en ny lenke kan bli stående umerket, og da vises den for alle.
 *
 *   **En side merker lenken, men kaller aldri hjelperen.** Da står lenken
 *   framme, akkurat som før.
 *
 * Testen holder på begge: hver merket lenke krever et kall, og hvert kall
 * krever en merket lenke.
 *
 * Kjøres med:  node frontend/test/oversiktslenke.test.js
 */
const fs = require('fs');
const path = require('path');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const mappe = path.join(__dirname, '..');
const sider = fs.readdirSync(mappe).filter(f => f.endsWith('.html')).sort();

/**
 * Sider der en lenke til «Velg skjema» IKKE er en oversiktslenke.
 *
 * `index.html` har en «Avbryt» som går samme sted — den avbryter utfyllingen
 * og skal virke for alle.
 *
 * `ingen-tilgang.html` er siden man havner på når man ikke har tilgang til
 * noe. Der er lenken den eneste veien videre, og å skjule den ville satt
 * brukeren i en blindgate.
 */
const UNNTAK = { 'index.html': 1, 'ingen-tilgang.html': 1 };

let merkede = 0;

for (const fil of sider) {
    const kilde = fs.readFileSync(path.join(mappe, fil), 'utf8');

    const lenker = [...kilde.matchAll(/<a\b[^>]*href="\/velgskjematype\.html"[^>]*>/g)].map(m => m[0]);

    // Lenker som får href-en sin fra JS.
    //
    // Dette leddet manglet først, og feilen slapp gjennom: `visning.html` har
    // en «← Tilbake» som peker til oversikten eller til registeret avhengig av
    // hvor du kom fra, og href-en settes ved kjøring. Testen så bare i
    // markupen, fant ingen href der, og meldte grønt — mens lenken sto framme
    // for innsendere. Hullet i testen hadde nøyaktig samme form som feilen.
    //
    // `location.href = ...` er en NAVIGERING, ikke en lenke som står og venter
    // på å bli klikket. Den skal ikke merkes, og den filtreres bort her.
    const dynamiske = [...kilde.matchAll(/(\w+)\.href\s*=\s*['"`]\/velgskjematype\.html['"`]/g)]
        .filter(m => !/^location$/.test(m[1]) && !/window\.location\.href\s*=$/.test(
            kilde.slice(Math.max(0, m.index - 10), m.index + m[1].length + 6)));
    for (const d of dynamiske) {
        const el = d[1];
        // Elementet må merkes i den grenen som peker dit ...
        sjekk(`${fil}: ${el} merkes når den peker på oversikten`,
            new RegExp(`${el}\\.setAttribute\\('data-oversiktslenke'`).test(kilde), true);
        // ... og umerkes i grenen som peker et annet sted, ellers blir den
        // stående skjult når den er en helt vanlig tilbake-lenke.
        sjekk(`${fil}: ${el} umerkes når den peker et annet sted`,
            new RegExp(`${el}\\.removeAttribute\\('data-oversiktslenke'`).test(kilde), true);
        // Regelen må kjøres PÅ NYTT etterpå: modulen kjørte før href-en fantes.
        sjekk(`${fil}: regelen kjøres etter at href er satt`,
            kilde.lastIndexOf('styrOversiktslenker(') > d.index, true);
    }

    if (lenker.length === 0 && dynamiske.length === 0) continue;

    const merket = lenker.filter(l => l.includes('data-oversiktslenke'));
    const umerket = lenker.length - merket.length;
    merkede += merket.length;

    // Alt utover de kjente unntakene skal være merket.
    sjekk(`${fil}: umerkede lenker`, umerket, UNNTAK[fil] || 0);

    // Merket lenke uten kall er en lenke som står framme uansett.
    if (merket.length > 0) {
        sjekk(`${fil}: kaller styrOversiktslenker`, /styrOversiktslenker\(/.test(kilde), true);
    }
    // ... og et kall uten merket lenke er død kode som ser ut som en regel.
    if (/styrOversiktslenker\(/.test(kilde)) {
        sjekk(`${fil}: har en merket lenke`, merket.length > 0, true);
    }
}

sjekk('fant merkede lenker', merkede > 3, true);

// ---------- selve hjelperen ----------
{
    const auth = fs.readFileSync(path.join(mappe, 'js', 'auth.js'), 'utf8');
    const start = auth.indexOf('export async function styrOversiktslenker');
    sjekk('hjelperen finnes', start !== -1, true);
    const kode = auth.slice(start).replace(/\/\/.*$/gm, '');

    // Avgjørelsen tas på serveren. Setter klienten den sammen av roller selv,
    // ligger regelen to steder og kan gli fra hverandre.
    sjekk('leser serverens avgjørelse', /serSkjemaoversikt/.test(kode), true);
    sjekk('setter ikke sammen roller selv',
        /erAdmin|kanOppretteSkjematype/.test(kode), false);

    // Skjuler først, spør etterpå: et glimt av noe man ikke skal ha, er verre
    // enn at lenken kommer et halvt sekund senere.
    const skjul = kode.indexOf('hidden = true');
    const spor = kode.indexOf('api.get');
    sjekk('skjuler før den spør', skjul !== -1 && skjul < spor, true);

    // Feiler kallet, skal lenken forbli skjult.
    sjekk('feiler lukket', /catch[\s\S]*return false/.test(kode), true);
}

console.log(`\n${ok} OK, ${feil} feil  (${merkede} merkede lenker)`);
process.exit(feil ? 1 : 0);
