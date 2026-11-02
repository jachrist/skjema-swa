/**
 * Frontenden laster bare skript CSP-en tillater — og venter på det den viser.
 *
 * To feil i AI-importen 02.11.2026, med samme kode i v2-prod og v3-prod:
 *
 *   **pdf.js ble importert fra cdn.jsdelivr.net.** CSP-en i alle
 *   `staticwebapp.config*.json` har `script-src 'self' 'unsafe-inline'`, så
 *   nettleseren avviste importen — «Failed to fetch dynamically imported
 *   module». PDF-import hadde aldri virket i noe miljø. Kommentaren over
 *   importen påsto at CSP-en tillot den. Testen her leser CSP-en i stedet for
 *   å tro på kommentaren.
 *
 *   **«Importer med AI» kom ikke i v3-prod.** Editoren hentet `/api/whoami`
 *   uten å vente på svaret før første tegning. Svarte API-et for sent, var
 *   admin-statusen null, og knappen ble aldri tegnet.
 *
 * Kjøres med:  node frontend/test/csp-skript.test.js
 */
const fs = require('fs');
const path = require('path');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const rot = path.join(__dirname, '..', '..');

// ---------- 1. CSP-ens script-src, lest fra alle konfigurasjonene ----------
const konfiger = fs.readdirSync(rot).filter(f => /^staticwebapp\.config.*\.json$/.test(f));
sjekk('fant SWA-konfigurasjonene', konfiger.length >= 3, true);

/** Opprinnelsene en script-src tillater utover 'self' og nøkkelord. */
function tillatteOpprinnelser(fil) {
    const json = JSON.parse(fs.readFileSync(path.join(rot, fil), 'utf8'));
    const csp = json?.globalHeaders?.['Content-Security-Policy'] || '';
    const direktiv = csp.split(';').map(d => d.trim()).find(d => d.startsWith('script-src')) || '';
    return { csp, kilder: direktiv.split(/\s+/).slice(1).filter(k => !k.startsWith("'")) };
}

const perKonfig = konfiger.map(f => ({ fil: f, ...tillatteOpprinnelser(f) }));
for (const k of perKonfig) {
    sjekk(`${k.fil}: har en CSP med script-src`, /script-src/.test(k.csp), true);
}

// ---------- 2. ingen skript lastes fra en opprinnelse CSP-en avviser ----------
//
// Leser frontend/*.html og frontend/js/*.js — ikke dokumentasjonsmappa, som
// er generert og har sin egen side.
const filer = [
    ...fs.readdirSync(path.join(rot, 'frontend')).filter(f => f.endsWith('.html')).map(f => path.join('frontend', f)),
    ...fs.readdirSync(path.join(rot, 'frontend', 'js')).filter(f => f.endsWith('.js')).map(f => path.join('frontend', 'js', f))
];
sjekk('fant frontend-filer å lese', filer.length > 5, true);

const MØNSTRE = [
    /\bimport\s*\(\s*['"`](https?:\/\/[^'"`]+)/g,                 // dynamisk import
    /\bfrom\s+['"](https?:\/\/[^'"]+)/g,                           // statisk import
    /<script[^>]*\bsrc\s*=\s*['"](https?:\/\/[^'"]+)/gi,           // <script src>
    /\bworkerSrc\s*=\s*['"`](https?:\/\/[^'"`]+)/g,                // pdf.js-mønsteret
    /new\s+Worker\s*\(\s*['"`](https?:\/\/[^'"`]+)/g
];

const avvist = [];
for (const fil of filer) {
    const kilde = fs.readFileSync(path.join(rot, fil), 'utf8');
    for (const m of MØNSTRE) {
        for (const treff of kilde.matchAll(m)) {
            const opprinnelse = new URL(treff[1]).origin;
            for (const k of perKonfig) {
                if (!k.kilder.some(t => opprinnelse === t || opprinnelse.startsWith(t))) {
                    avvist.push(`${fil}: ${opprinnelse} (avvist av ${k.fil})`);
                }
            }
        }
    }
}
sjekk('ingen skript fra en opprinnelse CSP-en avviser', [...new Set(avvist)], []);

// ---------- 3. editoren venter på admin-statusen før første tegning ----------
{
    const editor = fs.readFileSync(path.join(rot, 'frontend', 'editor.html'), 'utf8');
    const start = editor.indexOf('async function init()');
    sjekk('fant init() i editoren', start > -1, true);
    const init = editor.slice(start, editor.indexOf('\n        }\n', start));

    // `meg` skal settes av det samme Promise.all som init venter på — ikke av
    // en .then() som kan komme etter at siden er tegnet.
    sjekk('meg hentes i det Promise.all init venter på',
        /\[\s*meg\s*,[^\]]*\]\s*=\s*await\s+Promise\.all\(/.test(init), true);
    sjekk('og settes ikke i en løs .then()',
        /api\.get\('\/api\/whoami'\)\.then\(\s*w\s*=>\s*\{\s*meg\s*=/.test(init), false);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
