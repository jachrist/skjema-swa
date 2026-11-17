#!/usr/bin/env node
/**
 * Lag et JSON-skjema fra en datafil — uten at en eneste verdi kommer med ut.
 *
 * Skrevet 17.11.2026 for HR-filene (strukturdata og persondata). Formatet
 * trengs for å skrive HR-kilden mot masterdata-kontrakten
 * (`docs/FORSLAG-MASTERDATA.md`), men filene er persondata og skal ikke deles.
 * Dette verktøyet gir formen og ingenting annet.
 *
 * ## Hva som kommer ut
 *
 * Et JSON Schema (draft 2020-12) med feltnavn, typer, format og hvilke felt som
 * alltid er med. Under `x-statistikk` per felt: antall forekomster, tomme,
 * distinkte og lengste verdi — tall, aldri innhold. Under `x-mistanke`: felt
 * som ser ut som fødselsnummer, e-post, telefon eller navn, slik at
 * klassifiseringen har noe å starte på.
 *
 * Ingen eksempelverdier, ingen `enum`, ingen `default`. `api/test/hr-skjema.test.js`
 * kjører verktøyet på oppdiktede data og krever at ingen av verdiene finnes i
 * utdataene.
 *
 * ## Hva det ikke gjør
 *
 * - Ingen nettverk. Fila bruker bare `fs` og `path`, og testen krever det.
 * - Skriver ingenting annet enn skjemaet (til skjermen, eller til `--ut`).
 * - Nekter å lese en fil som ligger inni et git-repo: der er den ett
 *   `git add .` fra å bli publisert. Flytt fila ut, eller bruk
 *   `--tillat-i-repo` hvis du vet hva du gjør.
 *
 * ## Bruk
 *
 *   node scripts/hr-skjema.js <fil> [--navn Person] [--ut person.schema.json]
 *
 * Leser CSV (skilletegn ; , tab eller | gjettes fra overskriftsraden) og JSON
 * (en liste, eller et objekt med lister inni). Tegnkoding: UTF-8 med eller
 * uten BOM, UTF-16 LE med BOM, ellers Windows-1252 — det står i `x-kilde`
 * hvilken som ble brukt.
 *
 * Krever bare Node 18 eller nyere, ingen `npm install`.
 */
const fs = require('fs');
const path = require('path');

// ---------- lesing ----------

function dekod(buf) {
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { tekst: buf.subarray(3).toString('utf8'), tegnkoding: 'utf-8 med BOM' };
    if (buf[0] === 0xff && buf[1] === 0xfe) return { tekst: new TextDecoder('utf-16le').decode(buf.subarray(2)), tegnkoding: 'utf-16le' };
    try {
        return { tekst: new TextDecoder('utf-8', { fatal: true }).decode(buf), tegnkoding: 'utf-8' };
    } catch (_) {
        return { tekst: new TextDecoder('windows-1252').decode(buf), tegnkoding: 'windows-1252' };
    }
}

function gjettSkilletegn(forsteLinje) {
    let best = ',', flest = -1;
    for (const s of [';', ',', '\t', '|']) {
        const n = forsteLinje.split(s).length - 1;
        if (n > flest) { best = s; flest = n; }
    }
    return best;
}

/** CSV med anførselstegn, doble anførselstegn og linjeskift inni felt. */
function parseCsv(tekst, skille) {
    const rader = [];
    let rad = [], felt = '', iAnf = false;
    for (let i = 0; i < tekst.length; i++) {
        const c = tekst[i];
        if (iAnf) {
            if (c === '"') {
                if (tekst[i + 1] === '"') { felt += '"'; i++; } else iAnf = false;
            } else felt += c;
        } else if (c === '"' && felt === '') iAnf = true;
        else if (c === skille) { rad.push(felt); felt = ''; }
        else if (c === '\n' || c === '\r') {
            if (c === '\r' && tekst[i + 1] === '\n') i++;
            rad.push(felt); felt = '';
            if (rad.length > 1 || rad[0] !== '') rader.push(rad);
            rad = [];
        } else felt += c;
    }
    if (felt !== '' || rad.length) { rad.push(felt); rader.push(rad); }
    return rader;
}

// ---------- tolkning av en enkelt verdi ----------

const FORMATER = [
    ['date-time', /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/],
    ['date', /^\d{4}-\d{2}-\d{2}$/],
    ['dato-norsk', /^\d{2}\.\d{2}\.\d{4}$/],
    ['email', /^[^@\s]+@[^@\s]+\.[^@\s]+$/],
    ['telefon', /^(\+47 ?)?\d{8}$/],
    ['sifre', /^\d+$/]
];

function format(s) {
    for (const [navn, re] of FORMATER) if (re.test(s)) return navn;
    return null;
}

/** Kontrollsifrene i et fødsels- eller D-nummer. */
function erFnr(s) {
    if (!/^\d{11}$/.test(s)) return false;
    const d = [...s].map(Number);
    const k = (vekter, n) => {
        const r = 11 - (vekter.reduce((sum, v, i) => sum + v * d[i], 0) % 11);
        return r === 11 ? 0 : r;
    };
    const k1 = k([3, 7, 6, 1, 8, 9, 4, 5, 2], 9);
    const k2 = k([5, 4, 3, 2, 7, 6, 5, 4, 3, 2], 10);
    return k1 !== 10 && k2 !== 10 && k1 === d[9] && k2 === d[10];
}

/** En CSV-verdi er alltid tekst. Gjett hva den egentlig er. */
function csvVerdi(s) {
    const t = s.trim();
    if (t === '') return null;
    // Åtte sifre eller flere er en identifikator (telefon, fødselsnummer,
    // organisasjonsnummer), ikke en mengde — den blir stående som tekst.
    if (/^-?(0|[1-9]\d*)$/.test(t) && t.length < 8) return Number(t);
    if (/^-?(0|[1-9]\d*)[.,]\d+$/.test(t)) return Number(t.replace(',', '.'));
    if (/^(true|false)$/i.test(t)) return t.toLowerCase() === 'true';
    return t;
}

// ---------- innsamling ----------

const MAKS_DISTINKTE = 100000;

function nyNode() {
    return { typer: {}, formater: {}, fnr: 0, strenger: 0, maksLengde: 0, distinkte: new Set(), tomme: 0, forekomster: 0, egenskaper: null, nokler: null, objekter: 0, elementer: null };
}

function typeAv(v) {
    if (v === null || v === undefined || v === '') return 'null';
    if (Array.isArray(v)) return 'array';
    if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
    return typeof v;
}

function observer(node, v) {
    node.forekomster++;
    const t = typeAv(v);
    node.typer[t] = (node.typer[t] || 0) + 1;
    if (t === 'null') { node.tomme++; return; }
    if (t === 'object') {
        node.objekter++;
        node.egenskaper ||= {};
        node.nokler ||= {};
        for (const [k, verdi] of Object.entries(v)) {
            node.egenskaper[k] ||= nyNode();
            node.nokler[k] = (node.nokler[k] || 0) + 1;
            observer(node.egenskaper[k], verdi);
        }
        return;
    }
    if (t === 'array') {
        node.elementer ||= nyNode();
        for (const e of v) observer(node.elementer, e);
        return;
    }
    const s = String(v);
    if (node.distinkte.size < MAKS_DISTINKTE) node.distinkte.add(s);
    node.maksLengde = Math.max(node.maksLengde, s.length);
    if (t === 'string') {
        node.strenger++;
        const f = format(s);
        if (f) node.formater[f] = (node.formater[f] || 0) + 1;
        if (erFnr(s)) node.fnr++;
    } else if (t === 'integer' && v >= 1e9 && erFnr(String(v).padStart(11, '0'))) {
        // Et fødselsnummer lest som tall har mistet nullen foran.
        node.fnr++;
    }
}

// ---------- fra innsamling til skjema ----------

const NAVNEMISTANKE = [
    ['fødselsnummer', /f(ø|o|oe)dsels?n|personn|ssn|fnr|d-?nummer/i],
    ['fødselsdato', /f(ø|o|oe)dsels?dato|birth/i],
    ['navn', /(^|_)(for|etter|mellom|full|visnings)?navn$|^name$|first.?name|last.?name|given|surname/i],
    ['e-post', /e-?post|e-?mail|mail$/i],
    ['telefon', /telefon|mobil|phone|tlf/i],
    ['adresse', /adresse|address|gate|postnr|postnummer|poststed/i],
    // Lagt til etter første HR-uttrekk 17.11.2026: feltene som sier noe om
    // hvem en person er eller hvordan vedkommende skal beskyttes, ikke bare
    // hvordan hen kontaktes.
    ['nasjonalitet', /nasjonalitet|nationality|statsborger/i],
    ['folkeregister', /^dsf|folkereg/i],
    ['skjerming', /skjermet|anonymisert|fortrolig/i]
];

function tilSkjema(node, feltnavn = '') {
    const ut = {};
    const typer = Object.keys(node.typer).filter(t => t !== 'null');
    if (typer.includes('integer') && typer.includes('number')) typer.splice(typer.indexOf('integer'), 1);
    if (node.tomme > 0 || typer.length === 0) typer.push('null');
    ut.type = typer.length === 1 ? typer[0] : typer;

    if (node.egenskaper) {
        ut.properties = {};
        for (const [k, barn] of Object.entries(node.egenskaper)) ut.properties[k] = tilSkjema(barn, k);
        const pakrevd = Object.keys(node.egenskaper).filter(k => node.nokler[k] === node.objekter);
        if (pakrevd.length) ut.required = pakrevd;
    }
    // En liste som var tom i hver eneste rad, sier ingenting om elementene.
    // Før ble det `items: { type: 'null' }` — som påstår at elementene er null.
    if (node.elementer && node.elementer.forekomster > 0) ut.items = tilSkjema(node.elementer, feltnavn);
    else if (node.elementer) ut['x-alltid-tom'] = true;

    // Format: bare når ALLE ikke-tomme strengene har det.
    const formater = Object.entries(node.formater);
    if (node.strenger > 0 && formater.length) {
        const [f, n] = formater.sort((a, b) => b[1] - a[1])[0];
        if (n === node.strenger) {
            if (['date', 'date-time', 'email'].includes(f)) ut.format = f;
            else ut['x-format'] = f;
        }
    }

    const ikkeTomme = node.forekomster - node.tomme;
    if (!node.egenskaper && !node.elementer && feltnavn) {
        ut['x-statistikk'] = {
            forekomster: node.forekomster,
            tomme: node.tomme,
            distinkte: node.distinkte.size >= MAKS_DISTINKTE ? `≥${MAKS_DISTINKTE}` : node.distinkte.size,
            unik: ikkeTomme > 1 && node.distinkte.size === ikkeTomme,
            maksLengde: node.maksLengde
        };
        const mistanke = new Set();
        if (ikkeTomme > 0 && node.fnr / ikkeTomme >= 0.9) mistanke.add('fødselsnummer');
        if (ut.format === 'email') mistanke.add('e-post');
        if (ut['x-format'] === 'telefon') mistanke.add('telefon');
        for (const [hva, re] of NAVNEMISTANKE) if (re.test(feltnavn)) mistanke.add(hva);
        if (mistanke.size) ut['x-mistanke'] = [...mistanke];
    }
    return ut;
}

// ---------- hele fila ----------

function lagSkjema(buf, { navn = 'Data', filnavn = '' } = {}) {
    const { tekst, tegnkoding } = dekod(buf);
    const start = tekst.trimStart()[0];
    const rot = nyNode();
    const kilde = { tegnkoding };

    if (start === '[' || start === '{') {
        let data;
        try { data = JSON.parse(tekst); } catch (e) {
            // Feilmeldingen fra JSON.parse siterer innholdet. Den skal ikke ut.
            throw new Error('Fila ser ut som JSON, men lar seg ikke lese som JSON.');
        }
        kilde.format = 'json';
        observer(rot, data);
        if (Array.isArray(data)) kilde.rader = data.length;
    } else if (start === '<') {
        throw new Error('Fila ser ut som XML. Det leser ikke verktøyet ennå — si fra, så legges det til.');
    } else {
        const forste = tekst.split(/\r?\n/, 1)[0];
        const skille = gjettSkilletegn(forste);
        const rader = parseCsv(tekst, skille);
        const hode = rader.shift() || [];
        kilde.format = 'csv';
        kilde.skilletegn = skille === '\t' ? 'tab' : skille;
        kilde.rader = rader.length;
        const avvik = rader.filter(r => r.length !== hode.length).length;
        if (avvik) kilde.raderMedFeilAntallFelt = avvik;
        const liste = rader.map(r => Object.fromEntries(hode.map((h, i) => [h.trim(), csvVerdi(r[i] ?? '')])));
        observer(rot, liste);
    }

    return {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        title: navn,
        'x-kilde': { fil: path.basename(filnavn), ...kilde },
        ...tilSkjema(rot)
    };
}

/** Ligger fila inni et git-repo? Da er den ett `git add .` fra å bli publisert. */
function iGitRepo(fil) {
    let mappe = path.dirname(path.resolve(fil));
    for (;;) {
        if (fs.existsSync(path.join(mappe, '.git'))) return mappe;
        const opp = path.dirname(mappe);
        if (opp === mappe) return null;
        mappe = opp;
    }
}

function main(argv) {
    const args = argv.slice(2);
    const valg = (n) => { const i = args.indexOf(n); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
    const flagg = (n) => { const i = args.indexOf(n); if (i >= 0) args.splice(i, 1); return i >= 0; };
    const ut = valg('--ut');
    const navn = valg('--navn');
    const tillat = flagg('--tillat-i-repo');
    const fil = args[0];
    if (!fil) {
        console.error('Bruk: node scripts/hr-skjema.js <fil> [--navn Person] [--ut person.schema.json]');
        return 2;
    }
    const repo = iGitRepo(fil);
    if (repo && !tillat) {
        console.error(`Fila ligger i et git-repo (${repo}). Flytt den ut før du kjører, så den ikke blir committet ved et uhell.`);
        return 2;
    }
    const skjema = lagSkjema(fs.readFileSync(fil), { navn: navn || path.parse(fil).name, filnavn: fil });
    const json = JSON.stringify(skjema, null, 2) + '\n';
    if (ut) {
        fs.writeFileSync(ut, json);
        console.error(`Skrev ${ut}: ${skjema['x-kilde'].rader ?? '?'} rader, ${Object.keys(skjema.items?.properties || skjema.properties || {}).length} felt.`);
    } else process.stdout.write(json);
    return 0;
}

if (require.main === module) {
    try { process.exitCode = main(process.argv); } catch (e) { console.error(e.message); process.exitCode = 1; }
}

module.exports = { lagSkjema, parseCsv, erFnr, csvVerdi, iGitRepo, main };
