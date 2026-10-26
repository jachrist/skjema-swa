/**
 * Feltreferanse-velgeren, KJØRT — ikke lest.
 *
 * 26.10.2026 ble et behandlingssteg lagret uten behandler i prod, med valget
 * synlig i nedtrekket. `feltperson-ui.test.js` var grønn hele tiden: den leser
 * kildeteksten, og kildeteksten var riktig. Feilen lå i at kontrollen krevde
 * et ekstra klikk på en knapp ved siden av, mens Roller og Team i det SAMME
 * panelet legger til med én gang man velger.
 *
 * En test som leser kilden kan ikke se den forskjellen. Denne bygger
 * editoren, velger i nedtrekket og ser etter hva som havnet i `Personer`.
 *
 * Fire tilfeller, og det tredje er det som kostet en prod-runde:
 *
 *   - E-post-felt            → legges til (veien som alltid har virket)
 *   - persondatakilde-felt   → legges til (veien som kom 26.10.2026)
 *   - tomt valg              → legger ikke til noe
 *   - felt med feil datakilde → avvises, og nedtrekket nullstilles
 *
 * DOM-en er stubbet. Modulen bygger mange elementer, men rører få egenskaper.
 *
 * Kjøres med:  node frontend/test/feltperson-velger.test.js
 */
const path = require('path');
const { pathToFileURL } = require('url');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

function lagNode(tag = 'div') {
    const n = {
        tagName: String(tag).toUpperCase(), children: [], style: { cssText: '' }, dataset: {},
        _k: new Set(), textContent: '', value: '', innerHTML: '', title: '', type: '',
        disabled: false, placeholder: '', _lyttere: {},
        classList: {
            add: (...c) => c.forEach(x => n._k.add(x)),
            remove: (...c) => c.forEach(x => n._k.delete(x)),
            contains: (c) => n._k.has(c),
            toggle: (c, p) => (p ? n._k.add(c) : n._k.delete(c))
        },
        appendChild: (c) => { n.children.push(c); c.parentNode = n; return c; },
        append: (...cs) => { for (const c of cs) if (c && typeof c === 'object') { n.children.push(c); c.parentNode = n; } },
        addEventListener: (e, f) => { (n._lyttere[e] = n._lyttere[e] || []).push(f); },
        removeEventListener: () => {}, remove() {}, focus() {}, blur() {},
        setAttribute: (k, v) => { n[k] = v; }, getAttribute: (k) => n[k],
        querySelector: () => null, querySelectorAll: () => [],
        utlos(hendelse) { for (const f of (n._lyttere[hendelse] || [])) f({ preventDefault() {}, stopPropagation() {} }); }
    };
    Object.defineProperty(n, 'className', {
        get: () => [...n._k].join(' '),
        set: (v) => { n._k = new Set(String(v).split(/\s+/).filter(Boolean)); }
    });
    return n;
}

global.document = { createElement: lagNode, addEventListener() {}, body: lagNode() };
let sisteAlert = null;
global.alert = (m) => { sisteAlert = m; };
global.confirm = () => true;

function alleNoder(n, ut = []) { ut.push(n); for (const c of (n.children || [])) alleNoder(c, ut); return ut; }

(async () => {
    const { byggTilgangEditor } = await import(
        pathToFileURL(path.join(__dirname, '..', 'js', 'tilgang-editor.js')).href);

    /** Bygg editoren med ett felt, velg det, og returner hva som skjedde. */
    function velg(felt, { settVerdi = true } = {}) {
        sisteAlert = null;
        const cont = lagNode();
        const state = { Personer: [], Roller: [], Team: [] };
        let endret = null;
        byggTilgangEditor(cont, state, {
            kompakt: true, rolleGrupper: [], teamNavn: [], api: { get: async () => [] },
            feltReferanser: [felt], onEndring: (ny) => { endret = ny; }
        });
        // Feltperson-nedtrekket kjennes på sitt tomme alternativ. To former:
        // «e-post fra felt…» når noe kan velges, og forklaringen når ingenting
        // kan. Dynamisk rolle har sitt eget, med «omfang fra felt…».
        const erFeltperson = (t) => t.startsWith('e-post fra felt')
            || t.includes('ingen E-post-felt');
        const nedtrekk = alleNoder(cont).find(n => n.tagName === 'SELECT'
            && (n.children || []).some(o => erFeltperson(String(o.textContent))));
        if (!nedtrekk) return { nedtrekk: null, personer: [], alternativer: [], etterValg: null, alert: sisteAlert };
        if (settVerdi) nedtrekk.value = felt.ref;
        nedtrekk.utlos('change');
        return {
            nedtrekk,
            personer: (endret || state).Personer,
            etterValg: nedtrekk.value,
            alert: sisteAlert,
            alternativer: (nedtrekk.children || []).map(o => o.textContent)
        };
    }

    // ---------- veien som alltid har virket ----------
    {
        const r = velg({ ref: '1-04', type: 'E-post', fasteData: '', tekst: 'S1-F04: Din e-post' });
        sjekk('E-post: nedtrekket finnes', !!r.nedtrekk, true);
        sjekk('E-post: valget legger til referansen', r.personer, ['{1-04}']);
        sjekk('E-post: nedtrekket nullstilles', r.etterValg, '');
    }

    // ---------- veien som kom 26.10.2026 ----------
    {
        const r = velg({
            ref: '1-03', type: 'Flervalg-dropdown',
            fasteData: { Datakilde: 'Studenter', EllerAv: [] },
            tekst: 'S1-F03: Hvem er klassesjef?'
        });
        sjekk('Studenter: valget legger til referansen', r.personer, ['{1-03}']);
        sjekk('Studenter: datakilden står i etiketten',
            r.alternativer.some(t => t.includes('(Studenter)')), true);
        sjekk('Studenter: ingen alert', r.alert, null);
    }

    // ---------- det som kostet prod-runden ----------
    //
    // Her er selve regresjonen: står valget i nedtrekket uten at noe er lagt
    // til, ser kontrollen ferdig ut mens steget lagres uten behandler.
    {
        const r = velg({
            ref: '1-03', type: 'Flervalg-dropdown',
            fasteData: { Datakilde: 'Studenter', EllerAv: [] }, tekst: 'S1-F03: Klassesjef'
        });
        sjekk('et valg etterlater ALDRI en tom personliste', r.personer.length > 0, true);
        sjekk('og etterlater ingen valgt verdi som ser ut som et svar', r.etterValg, '');
    }

    // ---------- tomt valg ----------
    {
        const r = velg({ ref: '1-04', type: 'E-post', fasteData: '', tekst: 'S1-F04: E-post' },
            { settVerdi: false });
        sjekk('tomt valg legger ikke til noe', r.personer, []);
        sjekk('tomt valg gir ingen alert', r.alert, null);
    }

    // ---------- feil datakilde slipper ikke inn i nedtrekket ----------
    {
        const r = velg({
            ref: '1-07', type: 'Flervalg-dropdown',
            fasteData: { Datakilde: 'Klasser', EllerAv: [] }, tekst: 'S1-F07: Klasse'
        });
        sjekk('feil datakilde er ikke et alternativ',
            r.alternativer.some(t => t.includes('S1-F07')), false);
        sjekk('og kan derfor ikke legges til', r.personer, []);
    }

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
})();
