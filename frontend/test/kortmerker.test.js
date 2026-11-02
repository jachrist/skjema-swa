/**
 * Merkene i tittelraden på skjematypekortene, i kompakt form.
 *
 * Ønsket 03.11.2026: tekstmerkene tok mye plass, men informasjonen er nyttig.
 *
 *   saker til behandling — 🔔 og tallet, tooltip «N saker til behandling»
 *   mangler nullpunkt    — bare 📉, tooltip «Mangler nullpunkt for gevinst»
 *   fase                 — farget prikk, tooltip med fasenavnet
 *
 * Det som forsvinner fra teksten, skal stå i title OG aria-label. En prikk
 * uten aria-label er usynlig for skjermleser, og ingen kan holde musa over
 * den på en telefon.
 *
 * Funksjonen klippes ut av velgskjematype.html og kjøres — den ekte koden.
 *
 * Kjøres med:  node frontend/test/kortmerker.test.js
 */
const fs = require('fs');
const path = require('path');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const kilde = fs.readFileSync(path.join(__dirname, '..', 'velgskjematype.html'), 'utf8');
const start = kilde.indexOf('function kortMerkerHtml(');
if (start === -1) { console.log('FEIL  fant ikke kortMerkerHtml i velgskjematype.html'); process.exit(1); }
const slutt = kilde.indexOf('\n        }\n', start) + '\n        }'.length;
const { escapeHtml } = require('../js/escape.js');
const kortMerkerHtml = new Function('escapeHtml', `${kilde.slice(start, slutt)}\nreturn kortMerkerHtml;`)(escapeHtml);

/** Attributtene på span-ene, i rekkefølge. */
function merker(html) {
    return [...html.matchAll(/<span class="([^"]+)"([^>]*)>([^<]*)<\/span>/g)].map(m => ({
        klasse: m[1],
        title: (/title="([^"]*)"/.exec(m[2]) || [])[1] || null,
        aria: (/aria-label="([^"]*)"/.exec(m[2]) || [])[1] || null,
        tekst: m[3]
    }));
}

// ---------- 1. saker til behandling ----------
{
    const to = merker(kortMerkerHtml({ Fase: 'Produksjon' }, 2, false));
    sjekk('behandling: ikon og tall', to[0].tekst, '🔔 2');
    sjekk('behandling: tooltip', to[0].title, '2 saker til behandling');
    sjekk('behandling: skjermleser får det samme', to[0].aria, '2 saker til behandling');

    const en = merker(kortMerkerHtml({ Fase: 'Produksjon' }, 1, false));
    sjekk('behandling: entall', en[0].title, '1 sak til behandling');

    const ingen = merker(kortMerkerHtml({ Fase: 'Produksjon' }, 0, false));
    sjekk('behandling: ingen saker gir intet merke', ingen.some(m => m.klasse === 'merke-beh'), false);
}

// ---------- 2. mangler nullpunkt ----------
{
    const m = merker(kortMerkerHtml({ Fase: 'Produksjon' }, 0, true));
    const nullpunkt = m.find(x => x.tekst === '📉');
    sjekk('nullpunkt: bare ikonet', !!nullpunkt, true);
    sjekk('nullpunkt: tooltip', nullpunkt && nullpunkt.title, 'Mangler nullpunkt for gevinst');
    sjekk('nullpunkt: skjermleser', nullpunkt && nullpunkt.aria, 'Mangler nullpunkt for gevinst');
    sjekk('nullpunkt: ingen tekst ved siden av',
        /MANGLER|Mangler nullpunkt<\/span>/.test(kortMerkerHtml({}, 0, true)), false);
}

// ---------- 3. fasen som prikk ----------
{
    for (const [fase, klasse] of [['Utvikling', 'utvikling'], ['Produksjon', 'produksjon'], ['Test', 'test'], ['Mal', 'mal']]) {
        const prikk = merker(kortMerkerHtml({ Fase: fase }, 0, false)).find(x => x.klasse.startsWith('fase-prikk'));
        sjekk(`${fase}: prikk med fargeklasse`, prikk && prikk.klasse, `fase-prikk ${klasse}`);
        sjekk(`${fase}: tooltip er fasenavnet`, prikk && prikk.title, fase);
        sjekk(`${fase}: skjermleser`, prikk && prikk.aria, `Fase: ${fase}`);
        sjekk(`${fase}: ingen synlig tekst`, prikk && prikk.tekst, '');
    }
    // Uten fase er det produksjon — samme standard som resten av siden.
    const standard = merker(kortMerkerHtml({}, 0, false)).find(x => x.klasse.startsWith('fase-prikk'));
    sjekk('uten fase: produksjon', standard && standard.title, 'Produksjon');

    // Hver fase har en farge i CSS-en. En ny fase uten regel ville vært en
    // usynlig prikk.
    for (const k of ['produksjon', 'utvikling', 'test', 'mal']) {
        sjekk(`CSS har farge for ${k}`, new RegExp(`\\.fase-prikk\\.${k}\\s*\\{[^}]*background`).test(kilde), true);
    }
}

// ---------- 4. fasenavnet escapes ----------
{
    const html = kortMerkerHtml({ Fase: '<img src=x onerror=alert(1)>' }, 0, false);
    sjekk('fasenavnet escapes i title', html.includes('<img'), false);
}

// ---------- 5. kortet bruker funksjonen, og de gamle tekstmerkene er borte ----------
{
    sjekk('kortHtml kaller kortMerkerHtml', /kortMerkerHtml\(t,\s*antBeh,\s*manglerNullpunkt\(t\)\)/.test(kilde), true);
    sjekk('ingen tekstmerke «Mangler nullpunkt» igjen', /📉 Mangler nullpunkt/.test(kilde), false);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
