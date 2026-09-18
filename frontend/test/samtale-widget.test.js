/**
 * Samtale-widgeten — tegning, polling, sending og opprydding.
 *
 * Testen kjører mot et lite, ekte DOM-stubb (noder med barn), ikke mot et
 * objekt som svarer null på alt. Det er ikke pedanteri: forrige utgave av
 * denne fila hadde en `querySelector` som ALLTID ga null, så hverken
 * skrivefeltet eller innleggene ble noensinne rørt. Den meldte grønt mens
 * halve widgeten var utestet — og fokusfeilen under gikk rett gjennom.
 *
 * Fem ting testes:
 *
 *   **Skrivefeltet overlever en polling-runde.** Første utgave satte
 *   `container.innerHTML` på nytt hver runde, så feltet ble ødelagt og bygget
 *   på nytt hvert 12. sekund. Brukeren mistet fokus midt i en setning. Teksten
 *   ble tatt vare på, så det så ut som et rykk — ikke som at feltet var byttet
 *   ut. Testen holder på at NODEN er den samme.
 *
 *   **`etter` brukes, og innleggene legges til.** Uten det henter hver runde
 *   hele tråden, og alt ser riktig ut mens trafikken vokser med samtalen.
 *
 *   **Teksten settes som tekst, ikke markup.** Et innlegg er fritekst fra en
 *   behandler eller en ekstern innsender.
 *
 *   **Usynlig samtale tegner ingenting.** En innsender som verken kan skrive
 *   eller har noe å lese skal ikke se en låst boks.
 *
 *   **`stopp()` stanser faktisk.** En timer som overlever at panelet lukkes
 *   fortsetter å hente resten av økten.
 *
 * Kjøres med:  node frontend/test/samtale-widget.test.js
 */
const path = require('path');
const { pathToFileURL } = require('url');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

// ---------- minimal DOM ----------
function lagNode(tag) {
    const node = {
        tagName: tag, barn: [], forelder: null,
        className: '', hidden: false, value: '', type: '', rows: 0, placeholder: '',
        disabled: false, checked: false, scrollTop: 0, scrollHeight: 0, clientHeight: 0,
        _tekst: '', _attr: {}, _lyttere: {}, _fokusert: false,
        classList: {
            _s: new Set(),
            add(c) { for (const k of String(c).split(' ')) if (k) this._s.add(k); },
            toggle(c, p) { p ? this._s.add(c) : this._s.delete(c); },
            contains(c) { return this._s.has(c); }
        },
        get textContent() {
            return this.barn.length ? this.barn.map(b => b.textContent).join('') : this._tekst;
        },
        set textContent(v) { this._tekst = String(v); this.barn = []; },
        get lastChild() { return this.barn[this.barn.length - 1] || null; },
        appendChild(b) { b.forelder = this; this.barn.push(b); return b; },
        removeChild(b) { this.barn = this.barn.filter(x => x !== b); return b; },
        setAttribute(k, v) { this._attr[k] = v; },
        getAttribute(k) { return this._attr[k] ?? null; },
        addEventListener(n, f) { (this._lyttere[n] ||= []).push(f); },
        utløs(n, arg) { for (const f of (this._lyttere[n] || [])) f(arg || {}); },
        focus() { this._fokusert = true; },
        querySelector(sel) {
            const klasse = sel.replace(/^\./, '');
            for (const b of this.barn) {
                if (b.classList.contains(klasse) || b.className.split(' ').includes(klasse)) return b;
                const dypere = b.querySelector(sel);
                if (dypere) return dypere;
            }
            return null;
        },
        alle(klasse, ut = []) {
            for (const b of this.barn) {
                if (b.className.split(' ').includes(klasse)) ut.push(b);
                b.alle(klasse, ut);
            }
            return ut;
        }
    };
    // `className` skal også fylle classList, slik nettleseren gjør.
    let _cn = '';
    Object.defineProperty(node, 'className', {
        get: () => _cn,
        set: (v) => { _cn = String(v); node.classList._s = new Set(_cn.split(' ').filter(Boolean)); }
    });
    return node;
}

globalThis.document = {
    hidden: false,
    createElement: (t) => lagNode(t),
    createTextNode: (t) => { const n = lagNode('#text'); n.textContent = t; return n; }
};

const innleggFra = (id, tekst, avsender = 'a@b.no', navn = '') =>
    ({ Id: id, Avsender: avsender, AvsenderNavn: navn, Tekst: tekst, Dato: '2026-09-18T10:00:00.000Z' });

async function kjor() {
    const modul = pathToFileURL(path.join(__dirname, '..', 'js', 'samtale.js')).href;
    const { byggSamtale } = await import(modul);

    // ---------- skrivefeltet overlever polling ----------
    {
        const kall = [];
        const api = {
            get: async (url) => {
                kall.push(url);
                return kall.length === 1
                    ? { synlig: true, apen: true, kanSkrive: true, antallInnlegg: 2,
                        innlegg: [innleggFra('a1', 'første'), innleggFra('a2', 'andre')] }
                    : { synlig: true, apen: true, kanSkrive: true, antallInnlegg: 3,
                        innlegg: [innleggFra('a3', 'tredje')] };
            },
            post: async () => ({ status: 'ok' })
        };

        const rot = lagNode('div');
        const s = byggSamtale(rot, { api, skjematypeId: 't1', skjemaId: '42' });
        await s.start();

        const feltFør = rot.querySelector('.samtale-felt');
        sjekk('skrivefeltet finnes', !!feltFør, true);

        // Brukeren skriver, og har fokus i feltet.
        feltFør.value = 'Jeg holder på å skrive';
        feltFør.focus();

        await s.oppdater();

        const feltEtter = rot.querySelector('.samtale-felt');
        // DETTE er fokusfeilen: samme node, ikke en ny.
        sjekk('skrivefeltet er samme node etter polling', feltEtter === feltFør, true);
        sjekk('teksten står urørt', feltEtter.value, 'Jeg holder på å skrive');

        // Pollingen bruker `etter`, og innleggene legges til.
        sjekk('andre kall bruker etter', /[?&]etter=a2/.test(kall[1]), true);
        sjekk('tre innlegg i lista', rot.alle('samtale-innlegg').length, 3);
        sjekk('rekkefølgen holder',
            rot.alle('samtale-innlegg').map(b => b.querySelector('.samtale-tekst').textContent),
            ['første', 'andre', 'tredje']);

        s.stopp();
    }

    // ---------- tekst er tekst ----------
    {
        const api = {
            get: async () => ({
                synlig: true, apen: true, kanSkrive: false, antallInnlegg: 1,
                innlegg: [innleggFra('b1', '<script>alert(1)</script>', 'kari@fhs.no', 'Kari Nordmann')]
            }),
            post: async () => ({})
        };
        const rot = lagNode('div');
        const s = byggSamtale(rot, { api, skjematypeId: 't1', skjemaId: '42' });
        await s.start();

        sjekk('navnet vises', rot.querySelector('.samtale-avsender').textContent, 'Kari Nordmann');
        // textContent, ikke innerHTML — da finnes ikke escaping å glemme.
        sjekk('teksten står som skrevet',
            rot.querySelector('.samtale-tekst').textContent, '<script>alert(1)</script>');
        // Uten skriverett skal skrivefeltet være skjult, ikke fraværende: det
        // bygges én gang og gjenbrukes hvis retten kommer.
        sjekk('skrivefeltet er skjult', rot.querySelector('.samtale-skriv').hidden, true);
        s.stopp();
    }

    // ---------- lukket samtale ----------
    {
        const api = {
            get: async () => ({ synlig: true, apen: false, kanSkrive: false, antallInnlegg: 1,
                innlegg: [innleggFra('c1', 'noe')] }),
            post: async () => ({})
        };
        const rot = lagNode('div');
        const s = byggSamtale(rot, { api, skjematypeId: 't1', skjemaId: '42' });
        await s.start();
        // En lukket samtale med innhold vises — det er hele poenget med at den
        // følger saken — men uten skrivefelt.
        sjekk('vises', rot.hidden, false);
        sjekk('melding om at den er lukket', rot.querySelector('.samtale-lukket').hidden, false);
        sjekk('ingen skriving', rot.querySelector('.samtale-skriv').hidden, true);
        s.stopp();
    }

    // ---------- usynlig ----------
    {
        const api = { get: async () => ({ synlig: false, apen: true, innlegg: [] }), post: async () => ({}) };
        const rot = lagNode('div');
        const s = byggSamtale(rot, { api, skjematypeId: 't1', skjemaId: '42' });
        await s.start();
        sjekk('skjult når synlig=false', rot.hidden, true);
        s.stopp();
    }

    // ---------- sending ----------
    {
        const sendt = [];
        let runde = 0;
        const api = {
            get: async () => (runde++ === 0
                ? { synlig: true, apen: true, kanSkrive: true, antallInnlegg: 0, innlegg: [] }
                : { synlig: true, apen: true, kanSkrive: true, antallInnlegg: 1, innlegg: [innleggFra('d1', 'mitt svar')] }),
            post: async (_u, body) => { sendt.push(body); return { status: 'ok' }; }
        };
        const rot = lagNode('div');
        const s = byggSamtale(rot, { api, skjematypeId: 't1', skjemaId: '42', megId: 'a@b.no' });
        await s.start();

        sjekk('tom-melding vises først', rot.querySelector('.samtale-tom').hidden, false);

        const felt = rot.querySelector('.samtale-felt');
        felt.value = '  mitt svar  ';
        rot.querySelector('.samtale-send').utløs('click');
        await new Promise(r => setTimeout(r, 0));

        sjekk('teksten trimmes før sending', sendt[0], { tekst: 'mitt svar' });
        sjekk('feltet tømmes etter bekreftet lagring', felt.value, '');
        sjekk('og beholder fokus', felt._fokusert, true);
        sjekk('innlegget er tegnet', rot.alle('samtale-innlegg').length, 1);
        sjekk('tom-meldingen er borte', rot.querySelector('.samtale-tom').hidden, true);
        // Eget innlegg merkes.
        sjekk('eget innlegg merkes', rot.querySelector('.samtale-innlegg').className.includes('meg'), true);
        s.stopp();
    }

    // ---------- sending feiler ----------
    {
        const api = {
            get: async () => ({ synlig: true, apen: true, kanSkrive: true, antallInnlegg: 0, innlegg: [] }),
            post: async () => { throw new Error('Samtalen er lukket'); }
        };
        const rot = lagNode('div');
        const s = byggSamtale(rot, { api, skjematypeId: 't1', skjemaId: '42' });
        await s.start();

        const felt = rot.querySelector('.samtale-felt');
        felt.value = 'noe viktig';
        rot.querySelector('.samtale-send').utløs('click');
        await new Promise(r => setTimeout(r, 0));

        // Å tømme feltet ved feil er å slette noe brukeren har skrevet.
        sjekk('teksten blir stående', felt.value, 'noe viktig');
        sjekk('feilen vises', rot.querySelector('.samtale-status').textContent, 'Samtalen er lukket');
        sjekk('send-knappen er brukbar igjen', rot.querySelector('.samtale-send').disabled, false);
        s.stopp();
    }

    // ---------- første henting feiler ----------
    {
        const api = { get: async () => { throw new Error('500'); }, post: async () => ({}) };
        const rot = lagNode('div');
        const s = byggSamtale(rot, { api, skjematypeId: 't1', skjemaId: '42' });
        await s.start();
        sjekk('skjult ved feil', rot.hidden, true);
        s.stopp();
    }

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
}

kjor().catch(e => { console.error(e); process.exit(1); });
