/**
 * Vilkårspanelene skal fortsatt være `.dnf-slot` etter at de er bygget.
 *
 * Editoren skjuler panelene på et sammenslått felt med CSS-regelen
 * `.felt.kollapset > .dnf-slot` (`frontend/editor.html:169`). `byggDNFEditor`
 * satte tidligere `container.className = 'dnf-editor'`, som **erstattet**
 * kallerens klasser — og regelen sluttet å treffe i det øyeblikket panelet ble
 * bygget.
 *
 * Utslaget (punkt 62): et felt som var slått sammen viste fortsatt «Felt vises
 * kun hvis», «Obligatorisk hvis» og datakilde-panelet.
 *
 * Testen er skrevet mot kontrakten, ikke mot implementasjonen: den sier at
 * klassene kalleren ga skal overleve. Om det løses med classList eller på
 * annen måte er likegyldig — det er det å miste dem som er feilen.
 *
 * DOM-en er stubbet. Modulen bygger en del elementer, men rører bare noen få
 * egenskaper på hver.
 *
 * Kjøres med:  node frontend/test/dnf-slot-klasse.test.js
 */
const path = require('path');
const { pathToFileURL } = require('url');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

/** Minste node som holder for det dnf-editor.js faktisk gjør. */
function lagNode(tag = 'div') {
    const node = {
        tagName: String(tag).toUpperCase(),
        children: [],
        style: { cssText: '' },
        dataset: {},
        _klasser: new Set(),
        textContent: '',
        value: '',
        innerHTML: '',
        title: '',
        type: '',
        disabled: false,
        appendChild(barn) { this.children.push(barn); return barn; },
        addEventListener() {},
        querySelector() { return null; },
        querySelectorAll() { return []; },
        remove() {},
        get className() { return [...this._klasser].join(' '); },
        set className(v) { this._klasser = new Set(String(v).split(/\s+/).filter(Boolean)); },
        classList: {
            add(...n) { n.forEach(x => node._klasser.add(x)); },
            remove(...n) { n.forEach(x => node._klasser.delete(x)); },
            contains(x) { return node._klasser.has(x); }
        }
    };
    return node;
}

global.document = {
    createElement: (tag) => lagNode(tag),
    createDocumentFragment: () => lagNode('fragment')
};

async function kjor() {
    const modul = pathToFileURL(path.join(__dirname, '..', 'js', 'dnf-editor.js')).href;
    const { byggDNFEditor } = await import(modul);

    // ---------- vilkårspanel ----------
    {
        const slot = lagNode();
        slot.className = 'dnf-slot';
        slot.dataset.slot = 'felt-vises-0-1';

        byggDNFEditor(slot, null, {
            modus: 'vilkår',
            feltOptions: [{ verdi: 'f1', tekst: 'Felt 1' }],
            tittel: 'Felt vises kun hvis',
            onEndring: () => {}
        });

        sjekk('dnf-slot overlever byggingen', slot.classList.contains('dnf-slot'), true);
        sjekk('og dnf-editor er lagt til', slot.classList.contains('dnf-editor'), true);
    }

    // ---------- datakildepanel ----------
    {
        const slot = lagNode();
        slot.className = 'dnf-slot';
        byggDNFEditor(slot, null, {
            modus: 'faste-data',
            datakilder: [{ navn: 'Avdelinger' }],
            tittel: 'Hent Valg-liste fra datakilde',
            onEndring: () => {}
        });
        sjekk('gjelder også faste-data', slot.classList.contains('dnf-slot'), true);
    }

    // ---------- flere klasser fra kalleren ----------
    {
        // Ingen bruker to klasser i dag, men regelen er at kallerens klasser
        // er kallerens. Blir den brutt igjen, er det like stille som sist.
        const slot = lagNode();
        slot.className = 'dnf-slot noe-annet';
        byggDNFEditor(slot, null, { modus: 'vilkår', tittel: 'T', onEndring: () => {} });
        sjekk('alle kallerens klasser beholdes',
            ['dnf-slot', 'noe-annet'].every(k => slot.classList.contains(k)), true);
    }

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
}

kjor().catch(e => { console.error(e); process.exit(1); });
