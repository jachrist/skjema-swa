/**
 * md-editor.js — liten Markdown-editor for skjemaeditoren.
 *
 * Bruk:
 *   const ed = byggMdEditor(container, {
 *       verdi: '...',
 *       plassholder: 'Informasjonstekst…',
 *       visVerktoy: true,            // false = bare et voksende tekstfelt
 *       onEndring: (tekst) => { ... }
 *   });
 *   ed.settVerdi('ny tekst');        // uten å utløse onEndring
 *
 * Tekstfeltet vokser med innholdet og kan i tillegg dras større manuelt.
 * Forhåndsvisningen bruker samme parseMarkdown som utfyllingssiden, så det
 * som vises her er det brukeren faktisk får se.
 *
 * Widgeten bygges i JS med inline stiler og CSS-variabler — samme mønster som
 * tilgang-editor.js, slik at den fungerer på sider uten felles stilark.
 */
import { parseMarkdown } from './felt-render.js';

const MAKS_AUTOHOYDE = 520; // px — over dette får tekstfeltet egen rullefelt

const VERKTOY = [
    { navn: 'F',    tittel: 'Fet (**tekst**)',            type: 'omslutt', for: '**', etter: '**', stil: 'font-weight: 800;' },
    { navn: 'K',    tittel: 'Kursiv (*tekst*)',           type: 'omslutt', for: '*',  etter: '*',  stil: 'font-style: italic;' },
    { navn: 'H',    tittel: 'Overskrift (## tekst)',      type: 'linje',   prefiks: '## ' },
    { navn: '•',    tittel: 'Punktliste (- tekst)',       type: 'linje',   prefiks: '- ' },
    { navn: '1.',   tittel: 'Nummerert liste (1. tekst)', type: 'nummer' },
    { navn: '🔗',   tittel: 'Lenke ([tekst](url))',       type: 'lenke' },
    { navn: '‹›',   tittel: 'Kode (`tekst`)',             type: 'omslutt', for: '`',  etter: '`' }
];

function knapp(tekst, tittel, ekstraStil = '') {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = tekst;
    b.title = tittel;
    b.style.cssText = 'min-width: 26px; height: 24px; padding: 0 6px; font-size: 12px; line-height: 1;' +
        'border: 1px solid var(--input-border, #d1d1d6); background: var(--bg-input, #fff);' +
        'color: var(--text-primary, #1c1c1e); border-radius: 5px; cursor: pointer;' + ekstraStil;
    b.addEventListener('mouseenter', () => { b.style.borderColor = 'var(--accent, #0a84ff)'; });
    b.addEventListener('mouseleave', () => { b.style.borderColor = 'var(--input-border, #d1d1d6)'; });
    return b;
}

export function byggMdEditor(container, opsjoner = {}) {
    const {
        verdi = '',
        plassholder = '',
        visVerktoy = true,
        minHoyde = 90,
        onEndring = () => {}
    } = opsjoner;

    container.textContent = '';
    const rot = document.createElement('div');
    rot.style.cssText = 'display: flex; flex-direction: column; gap: 6px;';

    const tekstfelt = document.createElement('textarea');
    tekstfelt.value = verdi || '';
    tekstfelt.placeholder = plassholder;
    tekstfelt.spellcheck = true;
    tekstfelt.style.cssText = `width: 100%; min-height: ${minHoyde}px; max-height: ${MAKS_AUTOHOYDE}px;` +
        'padding: 8px 10px; font-family: inherit; font-size: 13px; line-height: 1.5;' +
        'border: 1px solid var(--input-border, #d1d1d6); border-radius: 8px;' +
        'background: var(--bg-input, #fff); color: var(--text-primary, #1c1c1e);' +
        'resize: vertical; box-sizing: border-box; overflow-y: auto;';

    const forhandsvisning = document.createElement('div');
    forhandsvisning.style.cssText = `display: none; min-height: ${minHoyde}px; padding: 8px 12px; font-size: 13px;` +
        'border: 1px dashed var(--accent, #0a84ff); border-radius: 8px;' +
        'background: var(--accent-light, rgba(10,132,255,0.08)); color: var(--text-primary, #1c1c1e);' +
        'overflow-wrap: anywhere;';

    /** Voks med innholdet, men bare til brukeren selv har dratt i håndtaket. */
    let manueltHoyde = false;
    function juster() {
        if (manueltHoyde) return;
        tekstfelt.style.height = 'auto';
        tekstfelt.style.height = Math.max(minHoyde, Math.min(tekstfelt.scrollHeight + 2, MAKS_AUTOHOYDE)) + 'px';
    }
    // Tar brukeren tak i størrelseshåndtaket nede til høyre, slutter vi å
    // overstyre høyden. (En ResizeObserver ville sett vår egen justering som
    // en brukerendring og slått av autovoksingen med én gang.)
    tekstfelt.addEventListener('mousedown', (e) => {
        const r = tekstfelt.getBoundingClientRect();
        if (e.clientX > r.right - 18 && e.clientY > r.bottom - 18) manueltHoyde = true;
    });

    function endret() {
        juster();
        onEndring(tekstfelt.value);
    }

    tekstfelt.addEventListener('input', endret);

    if (visVerktoy) {
        const linje = document.createElement('div');
        linje.style.cssText = 'display: flex; gap: 4px; align-items: center; flex-wrap: wrap;';

        for (const v of VERKTOY) {
            const b = knapp(v.navn, v.tittel, v.stil || '');
            b.addEventListener('click', () => {
                if (v.type === 'omslutt') omslutt(tekstfelt, v.for, v.etter);
                else if (v.type === 'linje') linjePrefiks(tekstfelt, v.prefiks);
                else if (v.type === 'nummer') nummerliste(tekstfelt);
                else if (v.type === 'lenke') settInnLenke(tekstfelt);
                endret();
            });
            linje.appendChild(b);
        }

        const skille = document.createElement('span');
        skille.style.cssText = 'flex: 1;';
        linje.appendChild(skille);

        const visKnapp = knapp('👁 Forhåndsvis', 'Vis hvordan teksten blir seende ut');
        let viser = false;
        visKnapp.addEventListener('click', () => {
            viser = !viser;
            if (viser) {
                forhandsvisning.innerHTML = parseMarkdown(tekstfelt.value) || '<em style="opacity:.6">(tom)</em>';
                forhandsvisning.style.display = '';
                tekstfelt.style.display = 'none';
                visKnapp.textContent = '✎ Rediger';
            } else {
                forhandsvisning.style.display = 'none';
                tekstfelt.style.display = '';
                visKnapp.textContent = '👁 Forhåndsvis';
                juster();
            }
        });
        linje.appendChild(visKnapp);
        rot.appendChild(linje);
    }

    rot.append(tekstfelt, forhandsvisning);
    container.appendChild(rot);
    // Høyden kan først regnes ut når elementet er i dokumentet
    requestAnimationFrame(juster);

    return {
        settVerdi(v) {
            if (tekstfelt.value === (v || '')) return;
            tekstfelt.value = v || '';
            juster();
        },
        hentVerdi() { return tekstfelt.value; },
        fokus() { tekstfelt.focus(); },
        element: tekstfelt
    };
}

// ---------- redigeringshjelpere ----------

function omslutt(ta, for_, etter_) {
    const { selectionStart: a, selectionEnd: b, value } = ta;
    const hadde = a !== b;
    const valgt = hadde ? value.slice(a, b) : 'tekst';
    ta.value = value.slice(0, a) + for_ + valgt + etter_ + value.slice(b);
    ta.selectionStart = a + for_.length;
    ta.selectionEnd = a + for_.length + valgt.length;
    ta.focus();
}

/** Legg prefiks på hver linje i utvalget (eller på linja markøren står i). */
function linjePrefiks(ta, prefiks) {
    const { selectionStart: a, selectionEnd: b, value } = ta;
    const start = value.lastIndexOf('\n', a - 1) + 1;
    const sluttIdx = value.indexOf('\n', b);
    const slutt = sluttIdx === -1 ? value.length : sluttIdx;
    const blokk = value.slice(start, slutt) || 'tekst';
    const ny = blokk.split('\n')
        .map(l => l.startsWith(prefiks) ? l.slice(prefiks.length) : prefiks + l)
        .join('\n');
    ta.value = value.slice(0, start) + ny + value.slice(slutt);
    ta.selectionStart = start;
    ta.selectionEnd = start + ny.length;
    ta.focus();
}

function nummerliste(ta) {
    const { selectionStart: a, selectionEnd: b, value } = ta;
    const start = value.lastIndexOf('\n', a - 1) + 1;
    const sluttIdx = value.indexOf('\n', b);
    const slutt = sluttIdx === -1 ? value.length : sluttIdx;
    const blokk = value.slice(start, slutt) || 'tekst';
    const ny = blokk.split('\n')
        .map((l, i) => /^\d+\.\s/.test(l) ? l.replace(/^\d+\.\s/, '') : `${i + 1}. ${l}`)
        .join('\n');
    ta.value = value.slice(0, start) + ny + value.slice(slutt);
    ta.selectionStart = start;
    ta.selectionEnd = start + ny.length;
    ta.focus();
}

function settInnLenke(ta) {
    const { selectionStart: a, selectionEnd: b, value } = ta;
    const valgt = value.slice(a, b);
    const tekst = valgt || 'lenketekst';
    const bit = `[${tekst}](https://)`;
    ta.value = value.slice(0, a) + bit + value.slice(b);
    // Marker url-en så brukeren kan skrive rett over den
    ta.selectionStart = a + tekst.length + 3;
    ta.selectionEnd = a + bit.length - 1;
    ta.focus();
}
