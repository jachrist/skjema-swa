/**
 * Escaping og Content-Security-Policy.
 *
 * To ting holdes fast her, og begge er funn fra gjennomgangen 13.10.2026:
 *
 * **Én escape-funksjon per formål.** Fram til da hadde åtte filer hver sin
 * kopi, under navnene `escapeHtml`, `escHtml`, `escAttr` og `escapeAttr` —
 * og de svarte ikke likt. Den ene varianten escapet ikke `'`, den andre
 * ikke `\`. Navnene var nesten like, så ingen kunne se forskjell på dem der
 * de ble brukt.
 *
 * **CSP-en finnes, og den matcher det sidene faktisk laster.** Legger noen
 * inn et skript fra et CDN, slutter `default-src 'self'` å stemme, og da
 * skal denne testen si fra — ikke nettleseren hos en bruker.
 *
 * Kjøres med:  node frontend/test/escaping.test.js
 */
const fs = require('fs');
const path = require('path');
const { hentEksport, utenKommentarer } = require('../../scripts/test-kilde.js');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const rot = path.join(__dirname, '..', '..');
const les = (...p) => fs.readFileSync(path.join(rot, ...p), 'utf8');
const escapeKilde = les('frontend', 'js', 'escape.js');
const escapeHtml = hentEksport(escapeKilde, 'escapeHtml');
const escapeJsIAttributt = hentEksport(escapeKilde, 'escapeJsIAttributt');

// ---------- bare én kopi ----------
{
    const filer = [
        ...fs.readdirSync(path.join(rot, 'frontend')).filter(n => n.endsWith('.html')).map(n => ['frontend', n]),
        ...fs.readdirSync(path.join(rot, 'frontend', 'js')).filter(n => n.endsWith('.js')).map(n => ['frontend', 'js', n])
    ];
    // Et navn som ser ut som en escape-funksjon, definert utenfor escape.js.
    const DEF = /(?:function|const|let)\s+(esc[A-ZÆØÅa-zæøå]\w*|escapeHtml|escapeAttr|escAttr)\s*[=(]/g;
    const kopier = [];
    for (const deler of filer) {
        const rel = deler.join('/');
        if (rel === 'frontend/js/escape.js') continue;
        const kode = utenKommentarer(les(...deler));
        for (const m of kode.matchAll(DEF)) {
            // `function esc(e)` som tastaturlytter er ikke en escape-funksjon.
            const etter = kode.slice(m.index, m.index + 400);
            if (!/replace\s*\(\s*\//.test(etter.slice(0, 200))) continue;
            kopier.push(`${rel}: ${m[1]}`);
        }
    }
    sjekk('ingen lokal kopi av en escape-funksjon', kopier, []);

    // Og alle som bruker navnene må importere dem.
    const manglerImport = [];
    for (const deler of filer) {
        const rel = deler.join('/');
        if (rel === 'frontend/js/escape.js') continue;
        const kode = utenKommentarer(les(...deler));
        for (const navn of ['escapeHtml', 'escHtml', 'escapeJsIAttributt']) {
            if (!new RegExp(`\\$\\{\\s*${navn}\\s*\\(`).test(kode)) continue;
            const importert = new RegExp(`import[^;]*\\b(?:${navn}\\b|as\\s+${navn}\\b)[^;]*;`).test(kode);
            if (!importert) manglerImport.push(`${rel}: ${navn}`);
        }
    }
    sjekk('hvert brukt navn er importert', manglerImport, []);
}

// ---------- de gamle navnene skal være borte ----------
//
// `escAttr` og `escapeAttr` fantes i fire filer med to ulike oppførsler. Blir
// ett av navnene stående igjen et sted, er det enten en kopi som overlevde
// eller et kall til noe som ikke finnes lenger — og det siste er en
// ReferenceError første gang den kodestien kjøres, ikke ved innlasting.
{
    const filer = [
        ...fs.readdirSync(path.join(rot, 'frontend')).filter(n => n.endsWith('.html')).map(n => ['frontend', n]),
        ...fs.readdirSync(path.join(rot, 'frontend', 'js')).filter(n => n.endsWith('.js')).map(n => ['frontend', 'js', n])
    ];
    const igjen = [];
    for (const deler of filer) {
        const kode = utenKommentarer(les(...deler));
        for (const m of kode.matchAll(/\b(escAttr|escapeAttr)\b/g)) {
            igjen.push(`${deler.join('/')}: ${m[1]}`);
        }
    }
    sjekk('ingen bruk av de gamle navnene', [...new Set(igjen)], []);
}

// ---------- escapeHtml ----------
{
    sjekk('escapeHtml tar alle fem tegnene',
        escapeHtml(`<a href="x" title='y'>&</a>`),
        '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
    sjekk('ampersand først', escapeHtml('&lt;'), '&amp;lt;');
    sjekk('null og undefined blir tom', [escapeHtml(null), escapeHtml(undefined)], ['', '']);
    sjekk('tall overlever', escapeHtml(42), '42');
}

// ---------- escapeJsIAttributt: det gamle hullet ----------
//
// Verdien tolkes av TO lag etter hverandre: nettleseren HTML-dekoder
// attributten, og kjører resultatet som JavaScript. Testen gjør det samme, og
// ser om det kommer ut mer enn ett funksjonskall.
{
    function kjørSomOnclick(escapet) {
        const attributt = `slett('${escapet}')`;
        // Lag 1: HTML-dekoding av attributtverdien.
        const js = attributt
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
            .replace(/&amp;/g, '&');
        // Lag 2: JavaScript.
        const kall = [];
        try {
            new Function('slett', 'angrep', js)((...a) => kall.push(a), () => kall.push('ANGREP'));
        } catch (e) {
            return { feil: e.message, kall };
        }
        return { kall };
    }

    const ondt = `\\');angrep();//`;

    // Den gamle implementasjonen, bevart her som referanse. Den skal fortsatt
    // slippe angrepet gjennom — ellers tester vi ingenting.
    const gammel = (s) => String(s ?? '').replace(/"/g, '&quot;').replace(/'/g, "\\'");
    sjekk('den gamle escAttr slapp angrepet gjennom',
        kjørSomOnclick(gammel(ondt)).kall.includes('ANGREP'), true);

    const nå = kjørSomOnclick(escapeJsIAttributt(ondt));
    sjekk('den nye slipper det ikke', nå.kall.includes('ANGREP'), false);
    sjekk('og verdien kommer fram hel', nå.kall, [[ondt]]);

    // Apostrof, anførselstegn og vinkelparenteser skal overleve som tekst.
    for (const verdi of [`O'Hara`, `han sa "hei"`, `<script>`, `a\\b`, `&amp;`, `'); angrep(); ('`]) {
        const r = kjørSomOnclick(escapeJsIAttributt(verdi));
        sjekk(`uendret gjennom begge lag: ${JSON.stringify(verdi)}`, r.kall, [[verdi]]);
    }
}

// ---------- Content-Security-Policy ----------
{
    const PÅKREVD = {
        'default-src': "'self'",
        'object-src': "'none'",
        'base-uri': "'self'",
        'form-action': "'self'",
        'frame-ancestors': "'none'",
        'connect-src': "'self'"
    };
    const csper = {};
    for (const miljo of ['pilot', 'prod']) {
        const j = JSON.parse(les(`staticwebapp.config.${miljo}.json`));
        const csp = j.globalHeaders?.['Content-Security-Policy'];
        sjekk(`${miljo}: har en CSP`, typeof csp === 'string' && csp.length > 0, true);
        csper[miljo] = csp || '';
        const direktiver = Object.fromEntries((csp || '').split(';')
            .map(d => d.trim()).filter(Boolean)
            .map(d => [d.split(/\s+/)[0], d.split(/\s+/).slice(1).join(' ')]));
        for (const [navn, verdi] of Object.entries(PÅKREVD)) {
            sjekk(`${miljo}: ${navn} ${verdi}`, direktiver[navn], verdi);
        }
        // `script-src` har fortsatt 'unsafe-inline', fordi 275 inline
        // event-handlere ikke kan fjernes uten å skrive om sidene. Testen
        // krever derfor ikke at den er borte — men den krever at 'self' står
        // der, så et skript fra et annet opphav fortsatt blokkeres.
        sjekk(`${miljo}: script-src har 'self'`, /(^|\s)'self'(\s|$)/.test(direktiver['script-src'] || ''), true);
        sjekk(`${miljo}: script-src tillater ikke et annet opphav`,
            /https?:|\*/.test(direktiver['script-src'] || ''), false);
    }
    sjekk('pilot og prod har samme CSP', csper.pilot, csper.prod);
}

// ---------- CSP-en må matche det sidene faktisk laster ----------
//
// `default-src 'self'` holder bare så lenge ingenting hentes utenfra. Legger
// noen inn et skript eller en font fra et CDN, blir det blokkert i
// nettleseren hos en bruker — med mindre denne testen sier fra først.
{
    const filer = [
        ...fs.readdirSync(path.join(rot, 'frontend')).filter(n => n.endsWith('.html')).map(n => ['frontend', n]),
        ...fs.readdirSync(path.join(rot, 'frontend', 'js')).filter(n => n.endsWith('.js')).map(n => ['frontend', 'js', n])
    ];
    const eksterne = [];
    for (const deler of filer) {
        const kode = utenKommentarer(les(...deler));
        for (const m of kode.matchAll(/\b(?:src|href)\s*=\s*["'](https?:)?\/\/([^"']+)["']/g)) {
            eksterne.push(`${deler.join('/')}: ${m[0].slice(0, 60)}`);
        }
        for (const m of kode.matchAll(/@import\s+url\(|url\(\s*["']?https?:/g)) {
            eksterne.push(`${deler.join('/')}: ${m[0]}`);
        }
    }
    sjekk('ingen ekstern ressurs i frontend', eksterne, []);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
