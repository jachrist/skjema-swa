/**
 * Enkeltvalg skal kunne byttes med ETT klikk.
 *
 * Et flervalgsfelt med `Max_valg = 1` tegnes som knapper med avkrysningsbokser
 * under. Låsen som håndhever taket fantes i to eksemplarer, og de var uenige:
 *
 *     endringslytteren:   c.disabled = !c.checked && antallValgt >= maks && maks > 1;
 *     initialtilstanden:  if (antallValgt >= maks) { lås alle ukryssede }
 *
 * Et ja/nei-felt med et svar fra før var altså låst når siden ble tegnet, og
 * åpnet seg først etter at brukeren hadde klikket bort sitt eget svar. Skulle
 * «Ja» bli «Nei», måtte man klikke to ganger — først på «Ja» for å nullstille,
 * så på «Nei». Ved revidering er det nettopp det man kommer for å gjøre.
 *
 * Testen kjører den EKTE widgeten mot et lite DOM-stubb, og klikker slik
 * nettleseren gjør: et klikk på en låst boks gjør ingenting, et klikk på en
 * åpen boks snur den og utløser `change`. Uten `disabled`-sjekken i klikket
 * ville testen bestått på en widget som er låst fast.
 *
 * Fire ting testes:
 *
 *   **Ett klikk bytter svar** — både for knappene og for dropdownen. Det er
 *   ønsket fra oppdragsgiver.
 *
 *   **Taket holder likevel.** `Max_valg = 3` skal fortsatt låse den fjerde.
 *   Fikser man byttefeilen ved å fjerne låsen, er grensen borte.
 *
 *   **Enkeltvalg kan fortsatt tømmes.** Et valgfritt felt må kunne stå ubesvart
 *   igjen; det er forskjellen på en avkrysningsboks og en radioknapp.
 *
 *   **Låsen settes ett sted.** Widgeten skal ikke ha en egen `disabled`-regel
 *   ved siden av funksjonen.
 *
 * Kjøres med:  node frontend/test/enkeltvalg-ui.test.js
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

// ---------- minimal DOM ----------
function delAvSelektor(del) {
    const pseudo = /:not\(:checked\)/.test(del) ? 'ukrysset'
        : /:checked/.test(del) ? 'krysset' : null;
    const base = del.replace(/:not\(:checked\)/g, '').replace(/:checked/g, '');
    return {
        tag: (base.match(/^[a-zA-Z]+/) || [null])[0],
        klasser: [...base.matchAll(/\.([a-zA-Z0-9_-]+)/g)].map(m => m[1]),
        pseudo
    };
}

function passer(node, del) {
    if (del.tag && node.tagName !== del.tag) return false;
    if (del.klasser.some(k => !node.classList.contains(k))) return false;
    if (del.pseudo === 'krysset' && !node.checked) return false;
    if (del.pseudo === 'ukrysset' && node.checked) return false;
    return true;
}

function lagNode(tag) {
    const node = {
        tagName: String(tag).toLowerCase(), barn: [], forelder: null,
        type: '', name: '', value: '', placeholder: '', autocomplete: '',
        checked: false, disabled: false, hidden: false,
        dataset: {}, style: { cssText: '' }, _tekst: '', _attr: {}, _lyttere: {},
        classList: {
            _s: new Set(),
            add(...c) { for (const x of c) for (const k of String(x).split(' ')) if (k) this._s.add(k); },
            remove(...c) { for (const x of c) this._s.delete(x); },
            toggle(c, på) { if (på === undefined) på = !this._s.has(c); på ? this._s.add(c) : this._s.delete(c); },
            contains(c) { return this._s.has(c); }
        },
        get textContent() {
            return this.barn.length ? this.barn.map(b => b.textContent).join('') : this._tekst;
        },
        set textContent(v) { this._tekst = String(v); this.barn = []; },
        appendChild(b) { b.forelder = this; this.barn.push(b); return b; },
        append(...b) { for (const x of b) this.appendChild(x); },
        setAttribute(k, v) { this._attr[k] = String(v); },
        getAttribute(k) { return this._attr[k] ?? null; },
        addEventListener(n, f) { (this._lyttere[n] ||= []).push(f); },
        dispatchEvent(e) { this.utløs(e?.type || 'change'); return true; },
        utløs(n, arg) { for (const f of [...(this._lyttere[n] || [])]) f(arg || { preventDefault() {} }); },
        etterkommere(ut = []) { for (const b of this.barn) { ut.push(b); b.etterkommere(ut); } return ut; },
        querySelectorAll(sel) {
            const deler = String(sel).trim().split(/\s+/).map(delAvSelektor);
            const siste = deler[deler.length - 1];
            const foran = deler.slice(0, -1);
            return this.etterkommere().filter(n => {
                if (!passer(n, siste)) return false;
                let i = foran.length - 1, f = n.forelder;
                while (f && i >= 0) { if (passer(f, foran[i])) i--; f = f.forelder; }
                return i < 0;
            });
        },
        querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
        closest(sel) {
            const del = delAvSelektor(String(sel).trim());
            for (let n = this; n; n = n.forelder) if (passer(n, del)) return n;
            return null;
        }
    };
    let _cn = '';
    Object.defineProperty(node, 'className', {
        get: () => _cn,
        set: (v) => { _cn = String(v); node.classList._s = new Set(_cn.split(' ').filter(Boolean)); }
    });
    return node;
}

const dokument = {
    createElement: (t) => lagNode(t),
    getElementById: () => null,
    head: lagNode('head')
};
function HendelseStub(type) { return { type }; }

// ---------- de ekte widgetene ----------
const kildeMedKommentarer = fs.readFileSync(path.join(__dirname, '..', 'js', 'felt-render.js'), 'utf8');
function klippUt(navn) {
    const start = kildeMedKommentarer.indexOf(`function ${navn}(`);
    if (start === -1) throw new Error(`Fant ikke ${navn} i felt-render.js`);
    const slutt = kildeMedKommentarer.indexOf('\n}', start) + 2;
    return kildeMedKommentarer.slice(start, slutt);
}
const lagWidget = new Function('document', 'Event', `
${klippUt('_lagFlervalgKnapper')}
${klippUt('_lagFlervalgDropdown')}
function _sikreDropdownStil() {}
return { knapper: _lagFlervalgKnapper, dropdown: _lagFlervalgDropdown };
`)(dokument, HendelseStub);

// ---------- klikk, slik nettleseren gjør det ----------
/**
 * Et klikk på etiketten snur boksen og utløser `change`. En LÅST boks gjør
 * ingenting — det er hele forskjellen testen handler om, og uten denne
 * sjekken ville den bestått på en widget brukeren ikke kommer forbi.
 */
function klikk(label) {
    const cb = label.querySelector('input');
    if (cb.disabled) return false;
    cb.checked = !cb.checked;
    cb.utløs('change');
    return true;
}
const knapp = (c, tekst) => c.querySelectorAll('.flervalg-knapp').find(l => l.textContent === tekst);
const valgte = (c) => c.querySelectorAll('.flervalg-knapp input:checked').map(i => i.value);
const laast = (c) => c.querySelectorAll('.flervalg-knapp input').filter(i => i.disabled).map(i => i.value);

const JA_NEI = { Type: 'Flervalg', Max_valg: 1, Valg: [{ Tekst: 'Ja' }, { Tekst: 'Nei' }] };
const FIRE = {
    Type: 'Flervalg', Max_valg: 3,
    Valg: [{ Tekst: 'A' }, { Tekst: 'B' }, { Tekst: 'C' }, { Tekst: 'D' }]
};

// ---------- ett klikk bytter svar (knapper) ----------
{
    const c = lagWidget.knapper(JA_NEI, '1-01', ['Ja']);
    sjekk('starter med Ja', valgte(c), ['Ja']);
    // Dette er regresjonen: med et svar fra før var ALT annet låst.
    sjekk('ingenting er låst ved enkeltvalg', laast(c), []);

    sjekk('klikket går gjennom', klikk(knapp(c, 'Nei')), true);
    sjekk('ett klikk ga Nei', valgte(c), ['Nei']);
    sjekk('Ja er markert bort', knapp(c, 'Ja').classList.contains('selected'), false);
    sjekk('Nei er markert', knapp(c, 'Nei').classList.contains('selected'), true);

    // Og tilbake igjen, like direkte.
    sjekk('tilbake til Ja', klikk(knapp(c, 'Ja')) && valgte(c), ['Ja']);
}

// ---------- fra ubesvart, og tømming ----------
{
    const c = lagWidget.knapper(JA_NEI, '1-01', []);
    sjekk('ubesvart: ingenting låst', laast(c), []);
    klikk(knapp(c, 'Ja'));
    sjekk('første klikk velger', valgte(c), ['Ja']);
    // Et valgfritt felt må kunne stå ubesvart igjen — det er forskjellen på en
    // avkrysningsboks og en radioknapp, og den beholder vi med vilje.
    klikk(knapp(c, 'Ja'));
    sjekk('klikk på eget svar tømmer', valgte(c), []);
}

// ---------- taket holder fortsatt ----------
{
    const c = lagWidget.knapper(FIRE, '1-02', ['A', 'B', 'C']);
    sjekk('tre valgt', valgte(c), ['A', 'B', 'C']);
    sjekk('den fjerde er låst', laast(c), ['D']);
    sjekk('klikk på låst gjør ingenting', klikk(knapp(c, 'D')), false);
    sjekk('fortsatt tre', valgte(c), ['A', 'B', 'C']);

    klikk(knapp(c, 'A'));
    sjekk('etter å ha fjernet ett er D åpen', laast(c), []);
    klikk(knapp(c, 'D'));
    sjekk('nå kan D velges', valgte(c), ['B', 'C', 'D']);
    sjekk('og A er låst igjen', laast(c), ['A']);
}

// ---------- taket nås ved klikking, ikke bare fra lagret svar ----------
{
    const c = lagWidget.knapper({ ...FIRE, Max_valg: 2 }, '1-03', []);
    klikk(knapp(c, 'A'));
    sjekk('ett valgt: ingen lås', laast(c), []);
    klikk(knapp(c, 'B'));
    sjekk('ved taket låses resten', laast(c), ['C', 'D']);
}

// ---------- MerkAlle opphever taket ----------
{
    const c = lagWidget.knapper({ ...FIRE, MerkAlle: true }, '1-04', ['A', 'B', 'C']);
    sjekk('MerkAlle: ingenting låst', laast(c), []);
    klikk(knapp(c, 'D'));
    sjekk('alle fire kan velges', valgte(c), ['A', 'B', 'C', 'D']);
}

// ---------- dropdownen: samme forventning ----------
{
    const c = lagWidget.dropdown(JA_NEI, '2-01', ['Ja']);
    const valg = (t) => c.querySelectorAll('.dropdown-option').find(o => o.textContent === t);
    sjekk('dropdown starter med Ja', c._valgte, ['Ja']);
    sjekk('ingen opsjon er sperret ved enkeltvalg',
        c.querySelectorAll('.dropdown-option').filter(o => o.classList.contains('disabled')).length, 0);
    valg('Nei').utløs('click');
    sjekk('ett klikk ga Nei', c._valgte, ['Nei']);
    sjekk('Nei er markert', valg('Nei').classList.contains('selected'), true);
    sjekk('Ja er ikke markert', valg('Ja').classList.contains('selected'), false);
}

// ---------- dropdownen: taket holder ----------
{
    const c = lagWidget.dropdown({ ...FIRE, Max_valg: 2 }, '2-02', ['A', 'B']);
    const valg = (t) => c.querySelectorAll('.dropdown-option').find(o => o.textContent === t);
    sjekk('ved taket sperres resten',
        c.querySelectorAll('.dropdown-option').filter(o => o.classList.contains('disabled')).map(o => o.textContent),
        ['C', 'D']);
    valg('C').utløs('click');
    sjekk('og valget slipper ikke gjennom', c._valgte, ['A', 'B']);
}

// ---------- låsen bor ett sted ----------
{
    const kilde = utenKommentarer(kildeMedKommentarer);
    const start = kilde.indexOf('function _lagFlervalgKnapper(');
    const slutt = kilde.indexOf('\n}', start);
    const widget = kilde.slice(start, slutt);
    // Én funksjon eier regelen. Alle andre `disabled`-tilordninger i widgeten
    // ville vært en kopi som kan svare noe annet.
    sjekk('regelen finnes', /c\.disabled = !c\.checked && maks > 1 && antallValgt >= maks;/.test(widget), true);
    // Verktøyknappene «Velg alle»/«Opphev alle» har sin egen disabled — den
    // handler om knappen, ikke om taket. Alt annet skal gå gjennom funksjonen.
    const tilordninger = (widget.match(/([a-zA-Z]+)\.disabled\s*=/g) || [])
        .map(t => t.replace(/\.disabled\s*=/, ''))
        .filter(v => v !== 'merkAlle' && v !== 'fjernAlle');
    sjekk('bare én lås-tilordning, og den står i funksjonen', tilordninger, ['c']);
    sjekk('kalt fra lytteren og fra initialtilstanden',
        (widget.match(/oppdaterLaas\(\)/g) || []).length >= 3, true);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
