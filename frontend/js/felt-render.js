/**
 * Felles felt-rendering brukt av utfylling, visning, register og editor.
 *
 * Alle sider som viser eller redigerer skjemafelter skal gå gjennom denne
 * modulen — nye felttyper legges til her ett sted.
 *
 * Eksport:
 *   FELTTYPER                          — liste over alle støttede typer (for editor)
 *   byggEditWidget(felt, feltId, initialSvar)  → HTMLElement  (input for utfylling/redigering)
 *   byggReadonlyVisning(felt, svar)    → HTMLElement          (formatert visning)
 *   hentSvarFraDom(feltId, type)       → string[]             (samle svar etter utfylling)
 *   formatSvarVerdi(felt, verdi)       → string               (formatter én verdi som tekst)
 *   valider(felt, svar)                → { ok, feilmelding? } (validering av felt-svar)
 *   escapeHtml(s)                      → string               (utility)
 */

export const FELTTYPER = [
    'Informasjon',
    'Tekst',
    'Tall',
    'Valuta',
    'E-post',
    'Fodselsnummer',
    'Kontonummer',
    'Postnummer',
    'Dato',
    'Tidspunkt',
    'Skala',
    'Flervalg-knapper',
    'Flervalg-dropdown',
    'Opplasting'
];

// Maks fil-størrelse (må matche backend-grensen)
const MAX_FIL_STORRELSE = 4 * 1024 * 1024;

// Filtyper som kan velges per Opplasting-felt (Tillatte_filtyper).
// Standard: alle tre grupper hvis feltet ikke spesifiserer noe.
const FILTYPER = {
    Office: {
        ext: ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'],
        mime: [
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/vnd.ms-powerpoint',
            'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        ],
        tekst: 'Office-filer'
    },
    PDF: { ext: ['.pdf'], mime: ['application/pdf'], tekst: 'PDF' },
    Bilder: {
        ext: ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg'],
        mime: ['image/jpeg', 'image/png', 'image/gif', 'image/bmp', 'image/webp', 'image/svg+xml'],
        tekst: 'bilder'
    }
};

function tillatteFiltyperFor(felt) {
    const valgte = Array.isArray(felt?.Tillatte_filtyper) && felt.Tillatte_filtyper.length > 0
        ? felt.Tillatte_filtyper
        : ['Office', 'PDF', 'Bilder'];
    const ext = [], mime = [], tekstDeler = [];
    for (const k of valgte) {
        if (FILTYPER[k]) {
            ext.push(...FILTYPER[k].ext);
            mime.push(...FILTYPER[k].mime);
            tekstDeler.push(FILTYPER[k].tekst);
        }
    }
    return { ext, mime, tekst: tekstDeler.join(', ') };
}

function filErTillatt(fil, tillatte) {
    const navn = String(fil.name || '').toLowerCase();
    const extOk = tillatte.ext.some(e => navn.endsWith(e.toLowerCase()));
    // MIME kan være tom fra noen nettlesere; fall tilbake til extension
    const mimeOk = !fil.type || tillatte.mime.includes(fil.type);
    return extOk && mimeOk;
}

// ==================== EDIT WIDGETS ====================

/**
 * Bygger et input-element (eller wrapper) for utfylling/redigering.
 * Returnerer HTMLElement som skal appendes til .felt-wrapperen etter label.
 * initialSvar er array av strings (kan være tom).
 */
export function byggEditWidget(felt, feltId, initialSvar = []) {
    const førsteSvar = initialSvar && initialSvar.length > 0 ? initialSvar[0] : '';
    switch (felt.Type) {
        case 'Informasjon': return _lagInformasjon(felt);
        case 'Tekst': return felt.Flerlinje ? _lagTextarea(feltId, førsteSvar) : _lagTextInput(feltId, førsteSvar);
        case 'Tall': return _lagNumberInput(feltId, førsteSvar, felt.Min_verdi, felt.Max_verdi);
        case 'Valuta': return _lagValutaInput(feltId, førsteSvar);
        case 'E-post': return _lagEpostInput(feltId, førsteSvar);
        case 'Fodselsnummer': return _lagFodselsnummerInput(feltId, førsteSvar);
        case 'Kontonummer': return _lagKontonummerInput(feltId, førsteSvar);
        case 'Postnummer': return _lagPostnummerInput(feltId, initialSvar);
        case 'Dato': return _lagDateInput(feltId, førsteSvar);
        case 'Tidspunkt': return _lagTimeInput(feltId, førsteSvar);
        case 'Skala': return _lagSkala(felt, feltId, førsteSvar);
        case 'Flervalg-knapper': return _lagFlervalgKnapper(felt, feltId, initialSvar);
        case 'Flervalg-dropdown': return _lagFlervalgDropdown(felt, feltId, førsteSvar);
        case 'Opplasting': return _lagOpplasting(felt, feltId, initialSvar);
        default: return _lagUkjentType(felt.Type);
    }
}

function _lagInformasjon(felt) {
    const div = document.createElement('div');
    div.className = 'informasjon';
    // Rendrer Markdown med levende lenker når Tekst.Format === 'Markdown',
    // ellers plain tekst. renderTekst håndterer HTML-escape.
    if (felt.Tekst?.Format === 'Markdown') {
        div.innerHTML = renderTekst(felt.Tekst);
    } else {
        div.textContent = felt.Tekst?.Verdi || felt.Tekst?.Innhold || '';
    }
    return div;
}

function _lagTextInput(feltId, verdi) {
    const el = document.createElement('input');
    el.type = 'text';
    el.id = feltId;
    el.name = feltId;
    el.value = verdi;
    return el;
}

function _lagTextarea(feltId, verdi) {
    const el = document.createElement('textarea');
    el.id = feltId;
    el.name = feltId;
    el.value = verdi;
    return el;
}

function _lagNumberInput(feltId, verdi, min, maks) {
    const el = document.createElement('input');
    el.type = 'number';
    el.id = feltId;
    el.name = feltId;
    if (verdi !== '' && verdi != null) el.value = verdi;
    if (min != null) el.min = min;
    if (maks != null) el.max = maks;
    return el;
}

function _lagValutaInput(feltId, verdi) {
    const el = _lagNumberInput(feltId, verdi);
    el.step = '0.01';
    el.placeholder = 'kr';
    return el;
}

function _lagEpostInput(feltId, verdi) {
    const el = document.createElement('input');
    el.type = 'email';
    el.id = feltId;
    el.name = feltId;
    el.value = verdi;
    el.placeholder = 'navn@domene.no';
    el.autocomplete = 'email';
    return el;
}

function _lagFodselsnummerInput(feltId, verdi) {
    const el = document.createElement('input');
    el.type = 'text';
    el.id = feltId;
    el.name = feltId;
    el.value = verdi;
    el.inputMode = 'numeric';
    el.pattern = '\\d{11}';
    el.maxLength = 11;
    el.placeholder = '11 siffer';
    return el;
}

function _lagKontonummerInput(feltId, verdi) {
    const el = document.createElement('input');
    el.type = 'text';
    el.id = feltId;
    el.name = feltId;
    el.value = verdi;
    el.inputMode = 'numeric';
    el.pattern = '\\d{11}';
    el.maxLength = 14; // tillat mellomrom/punktum ved skriving; renses ved lagring
    el.placeholder = 'XXXX.XX.XXXXX';
    return el;
}

/**
 * Postnummer med type-ahead mot masterdata.
 * Svar lagres som [postnr, poststed] — frosset for historikk.
 * initialSvar kan være [postnr, poststed] (fra tidligere lagring).
 */
function _lagPostnummerInput(feltId, initialSvar) {
    // initialSvar er array, feltId er unikt
    const initialPostnr = initialSvar && initialSvar.length > 0 ? String(initialSvar[0] || '') : '';
    const initialPoststed = initialSvar && initialSvar.length > 1 ? String(initialSvar[1] || '') : '';

    const wrapper = document.createElement('div');
    wrapper.className = 'postnummer-wrapper';
    wrapper.style.cssText = 'position: relative; display: flex; align-items: center; gap: 8px; max-width: 480px;';

    const input = document.createElement('input');
    input.type = 'text';
    input.id = feltId;
    input.name = feltId;
    input.placeholder = 'Postnr eller poststed';
    input.autocomplete = 'postal-code';
    input.style.cssText = 'flex: 1; min-width: 180px;';
    input.value = initialPostnr && initialPoststed ? `${initialPostnr} ${initialPoststed}` : initialPostnr;
    input.dataset.postnr = initialPostnr;
    input.dataset.poststed = initialPoststed;

    const dropdown = document.createElement('div');
    dropdown.className = 'postnummer-forslag';
    dropdown.style.cssText = 'position: absolute; top: 100%; left: 0; background: var(--bg-input, #fff); border: 1px solid var(--input-border, #ccc); border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.12); max-height: 240px; overflow-y: auto; z-index: 50; display: none; margin-top: 2px; min-width: 260px;';

    wrapper.append(input, dropdown);

    let sokeTimer = null;
    let aktivIndeks = -1;

    async function utforSok(query) {
        try {
            const resp = await fetch(`/api/postnumre/sok?q=${encodeURIComponent(query)}&maks=10`);
            if (!resp.ok) { dropdown.style.display = 'none'; return; }
            const treff = await resp.json();
            visForslag(treff);
        } catch (_) {
            dropdown.style.display = 'none';
        }
    }

    function visForslag(treff) {
        aktivIndeks = -1;
        if (!Array.isArray(treff) || treff.length === 0) {
            dropdown.style.display = 'none';
            return;
        }
        dropdown.innerHTML = '';
        treff.forEach((t, i) => {
            const rad = document.createElement('div');
            rad.style.cssText = 'padding: 8px 12px; cursor: pointer; display: flex; gap: 10px; font-size: 14px;';
            rad.dataset.postnr = t.Postnr;
            rad.dataset.poststed = t.Poststed;
            rad.innerHTML = `<span style="font-variant-numeric: tabular-nums; min-width: 44px; color: var(--text-secondary);">${t.Postnr}</span><span>${t.Poststed}</span>`;
            rad.addEventListener('mouseenter', () => {
                Array.from(dropdown.children).forEach((r, idx) => {
                    r.style.background = idx === i ? 'var(--accent-light, rgba(10,132,255,0.12))' : '';
                });
                aktivIndeks = i;
            });
            rad.addEventListener('mousedown', e => e.preventDefault());
            rad.addEventListener('click', () => velgForslag(t));
            dropdown.appendChild(rad);
        });
        dropdown.style.display = 'block';
    }

    function velgForslag(t) {
        input.value = `${t.Postnr} ${t.Poststed}`;
        input.dataset.postnr = t.Postnr;
        input.dataset.poststed = t.Poststed;
        dropdown.style.display = 'none';
    }

    input.addEventListener('input', () => {
        // Ved endring nullstilles dataset — må velges på nytt for gyldig svar
        input.dataset.postnr = '';
        input.dataset.poststed = '';

        const raa = input.value.trim();
        if (sokeTimer) clearTimeout(sokeTimer);
        if (raa.length === 0) { dropdown.style.display = 'none'; return; }
        const første = raa.split(/\s+/)[0];
        if (/^[A-Za-zÆØÅæøå]/.test(første) && første.length < 2) {
            dropdown.style.display = 'none';
            return;
        }
        sokeTimer = setTimeout(() => utforSok(første), 200);
    });

    input.addEventListener('keydown', e => {
        const rader = dropdown.children;
        if (e.key === 'ArrowDown' && rader.length > 0) {
            e.preventDefault();
            aktivIndeks = Math.min(aktivIndeks + 1, rader.length - 1);
            Array.from(rader).forEach((r, i) => r.style.background = i === aktivIndeks ? 'var(--accent-light, rgba(10,132,255,0.12))' : '');
            rader[aktivIndeks]?.scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'ArrowUp' && rader.length > 0) {
            e.preventDefault();
            aktivIndeks = Math.max(aktivIndeks - 1, 0);
            Array.from(rader).forEach((r, i) => r.style.background = i === aktivIndeks ? 'var(--accent-light, rgba(10,132,255,0.12))' : '');
            rader[aktivIndeks]?.scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'Enter' && aktivIndeks >= 0) {
            e.preventDefault();
            const rad = rader[aktivIndeks];
            if (rad?.dataset.postnr) velgForslag({ Postnr: rad.dataset.postnr, Poststed: rad.dataset.poststed || '' });
        } else if (e.key === 'Escape') {
            dropdown.style.display = 'none';
        }
    });

    input.addEventListener('blur', () => {
        setTimeout(() => dropdown.style.display = 'none', 150);
    });

    return wrapper;
}

function _lagDateInput(feltId, verdi) {
    const el = document.createElement('input');
    el.type = 'date';
    el.id = feltId;
    el.name = feltId;
    el.value = verdi;
    return el;
}

function _lagTimeInput(feltId, verdi) {
    const el = document.createElement('input');
    el.type = 'time';
    el.id = feltId;
    el.name = feltId;
    el.value = verdi;
    return el;
}

function _lagSkala(felt, feltId, valgtVerdi) {
    const container = document.createElement('div');
    container.className = 'skala';
    const valg = (felt.Valg || []).filter(v => v.Valg_nr != null && !isNaN(Number(v.Valg_nr)));
    if (valg.length === 0) return container;

    // Legacy-mønster: rendre ALLE heltall fra min til max — også de uten eksplisitt Tekst.
    // Tekst vises kun for de Valg_nr som har det (typisk endepunkter).
    const nummer = valg.map(v => Number(v.Valg_nr));
    const min = Math.min(...nummer);
    const max = Math.max(...nummer);
    const tekstMap = {};
    for (const v of valg) tekstMap[Number(v.Valg_nr)] = v.Tekst || '';

    for (let i = min; i <= max; i++) {
        const item = document.createElement('label');
        item.className = 'skala-valg';
        const nr = document.createElement('span');
        nr.className = 'skala-nummer';
        nr.textContent = i;
        item.appendChild(nr);

        const input = document.createElement('input');
        input.type = 'radio';
        input.name = feltId;
        input.value = String(i);
        if (String(valgtVerdi) === String(i)) input.checked = true;
        item.appendChild(input);

        if (tekstMap[i]) {
            const t = document.createElement('span');
            t.className = 'skala-tekst';
            t.textContent = tekstMap[i];
            item.appendChild(t);
        }
        container.appendChild(item);
    }
    return container;
}

function _lagFlervalgKnapper(felt, feltId, initialSvar) {
    const container = document.createElement('div');
    container.className = 'flervalg-knapper';
    container.dataset.feltId = feltId;
    const maks = felt.Max_valg || 1;
    let antallValgt = 0;
    for (const valg of (felt.Valg || [])) {
        const label = document.createElement('label');
        label.className = 'flervalg-knapp';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.name = `${feltId}[]`;
        cb.value = valg.Tekst;
        if ((initialSvar || []).includes(valg.Tekst)) {
            cb.checked = true;
            label.classList.add('selected');
            antallValgt++;
        }
        cb.addEventListener('change', () => {
            if (cb.checked) {
                // For Max_valg=1: automatisk uncheke andre (radio-lignende)
                if (maks === 1) {
                    container.querySelectorAll('.flervalg-knapp input:checked').forEach(other => {
                        if (other !== cb) {
                            other.checked = false;
                            other.closest('label').classList.remove('selected');
                        }
                    });
                    antallValgt = 1;
                } else {
                    antallValgt++;
                }
                label.classList.add('selected');
            } else {
                label.classList.remove('selected');
                antallValgt--;
            }
            container.querySelectorAll('.flervalg-knapp').forEach(k => {
                const c = k.querySelector('input');
                c.disabled = !c.checked && antallValgt >= maks && maks > 1;
            });
        });
        const span = document.createElement('span');
        span.textContent = valg.Tekst;
        label.append(cb, span);
        container.appendChild(label);
    }
    // Sett initial disabled-state for de som ikke er valgt hvis grensen er nådd
    if (antallValgt >= maks) {
        container.querySelectorAll('.flervalg-knapp input:not(:checked)').forEach(c => { c.disabled = true; });
    }
    return container;
}

function _lagFlervalgDropdown(felt, feltId, valgtVerdi) {
    const sel = document.createElement('select');
    sel.id = feltId;
    sel.name = feltId;
    const tom = document.createElement('option');
    tom.value = '';
    tom.textContent = '— velg —';
    sel.appendChild(tom);
    for (const valg of (felt.Valg || [])) {
        const opt = document.createElement('option');
        opt.value = valg.Tekst;
        opt.textContent = valg.Tekst;
        if (valg.Tekst === valgtVerdi) opt.selected = true;
        sel.appendChild(opt);
    }
    return sel;
}

/**
 * Opplasting-widget. State holdes på wrapper-elementet:
 *   _eksisterende: array av filnavn (fra initialSvar)
 *   _nyeFiler:     Map<filnavn, File> — filer som er valgt men ikke opplastet ennå
 *   _slettede:     Set<string> — eksisterende filnavn som skal slettes ved lagring
 *
 * Ved submit må kalleren kjøre `preSubmitOpplasting(feltEl, skjematypeId, skjemaId)`
 * for å opplaste/slette filer. Deretter returnerer hentSvarFraDom kombinert liste.
 */
function _lagOpplasting(felt, feltId, initialSvar) {
    const wrapper = document.createElement('div');
    wrapper.className = 'opplasting-wrapper';
    wrapper.dataset.feltId = feltId;
    wrapper.style.cssText = 'display: flex; flex-direction: column; gap: 8px;';

    const maxValg = Math.max(1, Number(felt.Max_valg) || 1);
    const tillatte = tillatteFiltyperFor(felt);

    // Init state
    const eksisterende = Array.isArray(initialSvar) ? initialSvar.filter(s => s && typeof s === 'string') : [];
    wrapper._eksisterende = [...eksisterende];
    wrapper._nyeFiler = new Map();
    wrapper._slettede = new Set();
    wrapper._maxValg = maxValg;

    const liste = document.createElement('div');
    liste.className = 'opplasting-liste';
    liste.style.cssText = 'display: flex; flex-direction: column; gap: 4px;';
    wrapper.appendChild(liste);

    const knapperad = document.createElement('div');
    knapperad.style.cssText = 'display: flex; gap: 8px; align-items: center; flex-wrap: wrap;';

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.multiple = maxValg > 1;
    fileInput.accept = tillatte.ext.join(',');
    fileInput.id = feltId;
    fileInput.name = feltId;
    fileInput.style.cssText = 'position: absolute; left: -9999px; opacity: 0;';

    const velgKnapp = document.createElement('button');
    velgKnapp.type = 'button';
    velgKnapp.className = 'knapp sekundær';
    velgKnapp.style.cssText = 'padding: 6px 14px; font-size: 13px;';
    velgKnapp.textContent = maxValg > 1 ? 'Velg filer…' : 'Velg fil…';
    velgKnapp.addEventListener('click', () => fileInput.click());

    const beskrivelse = document.createElement('small');
    beskrivelse.style.cssText = 'color: var(--text-secondary);';
    beskrivelse.textContent = `${tillatte.tekst || 'Ingen filtyper tillatt'} (maks ${maxValg} ${maxValg === 1 ? 'fil' : 'filer'})`;

    fileInput.addEventListener('change', () => {
        for (const fil of fileInput.files) {
            if (!filErTillatt(fil, tillatte)) {
                alert(`"${fil.name}" er ikke en tillatt filtype (${tillatte.tekst}).`);
                continue;
            }
            if (fil.size > MAX_FIL_STORRELSE) {
                alert(`"${fil.name}" er for stor (maks ${MAX_FIL_STORRELSE / 1024 / 1024} MB)`);
                continue;
            }
            // Håndhev antall: eksisterende (ikke-slettede) + valgte nye ≤ maxValg
            const nåværende = wrapper._eksisterende.filter(n => !wrapper._slettede.has(n)).length
                + wrapper._nyeFiler.size;
            if (nåværende >= maxValg) {
                alert(`Maks ${maxValg} ${maxValg === 1 ? 'fil' : 'filer'} tillatt for dette feltet.`);
                break;
            }
            wrapper._nyeFiler.set(fil.name, fil);
            wrapper._slettede.delete(fil.name); // hvis re-lagt til
        }
        fileInput.value = ''; // gjør at samme fil kan velges igjen
        _renderOpplastingListe(wrapper);
    });

    knapperad.appendChild(velgKnapp);
    knapperad.appendChild(fileInput);
    knapperad.appendChild(beskrivelse);
    wrapper.appendChild(knapperad);

    _renderOpplastingListe(wrapper);
    return wrapper;
}

function _renderOpplastingListe(wrapper) {
    const liste = wrapper.querySelector('.opplasting-liste');
    liste.innerHTML = '';
    const rader = [];

    // Eksisterende filer (evt. markert for sletting)
    for (const filnavn of wrapper._eksisterende) {
        const erSlettet = wrapper._slettede.has(filnavn);
        rader.push({ navn: filnavn, ny: false, slettet: erSlettet });
    }
    // Nye filer valgt i denne økten
    for (const [navn] of wrapper._nyeFiler) {
        rader.push({ navn, ny: true, slettet: false });
    }

    if (rader.length === 0) {
        const tom = document.createElement('div');
        tom.style.cssText = 'color: var(--text-secondary, #666); font-size: 13px; font-style: italic;';
        tom.textContent = 'Ingen vedlegg';
        liste.appendChild(tom);
        return;
    }

    for (const rad of rader) {
        const el = document.createElement('div');
        el.style.cssText = 'display: flex; align-items: center; gap: 8px; padding: 6px 10px; border: 1px solid var(--input-border, #ccc); border-radius: 6px; font-size: 13px;';
        if (rad.slettet) el.style.opacity = '0.5';

        const ikon = document.createElement('span');
        ikon.textContent = rad.ny ? '📎' : '📄';
        el.appendChild(ikon);

        const navn = document.createElement('span');
        navn.style.cssText = 'flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
        navn.textContent = rad.navn + (rad.ny ? ' (ny)' : '') + (rad.slettet ? ' — vil slettes' : '');
        el.appendChild(navn);

        const knapp = document.createElement('button');
        knapp.type = 'button';
        knapp.style.cssText = 'padding: 2px 8px; font-size: 12px; border: 1px solid var(--danger, #ff3b30); background: transparent; color: var(--danger, #ff3b30); border-radius: 4px; cursor: pointer;';

        if (rad.ny) {
            knapp.textContent = 'Fjern';
            knapp.addEventListener('click', () => {
                wrapper._nyeFiler.delete(rad.navn);
                _renderOpplastingListe(wrapper);
            });
        } else if (rad.slettet) {
            knapp.textContent = 'Angre';
            knapp.style.borderColor = 'var(--accent, #0a84ff)';
            knapp.style.color = 'var(--accent, #0a84ff)';
            knapp.addEventListener('click', () => {
                wrapper._slettede.delete(rad.navn);
                _renderOpplastingListe(wrapper);
            });
        } else {
            knapp.textContent = 'Slett';
            knapp.addEventListener('click', () => {
                wrapper._slettede.add(rad.navn);
                _renderOpplastingListe(wrapper);
            });
        }
        el.appendChild(knapp);
        liste.appendChild(el);
    }
}

/**
 * Opplast nye filer og slett merkede filer for ett Opplasting-felt.
 * Må kalles av sidene FØR de sender skjemaet, når Skjema_id er kjent.
 *
 * @param {HTMLElement} feltEl — .felt-wrapperen som inneholder Opplasting-widgeten
 * @param {string} skjematypeId
 * @param {string} skjemaId
 * @returns {Promise<void>}
 */
export async function preSubmitOpplasting(feltEl, skjematypeId, skjemaId) {
    const wrapper = feltEl.querySelector('.opplasting-wrapper');
    if (!wrapper) return;

    // Slett merkede først
    for (const filnavn of wrapper._slettede) {
        try {
            await fetch(`/api/vedlegg-fil/${encodeURIComponent(skjematypeId)}/${encodeURIComponent(skjemaId)}/${encodeURIComponent(filnavn)}`, {
                method: 'DELETE'
            });
        } catch (_) { /* ignorer enkeltfeil, best-effort */ }
    }
    // Fjern slettede fra eksisterende-listen
    wrapper._eksisterende = wrapper._eksisterende.filter(f => !wrapper._slettede.has(f));
    wrapper._slettede.clear();

    // Opplast nye
    const nyeNavn = [];
    for (const [filnavn, fil] of wrapper._nyeFiler) {
        const formData = new FormData();
        formData.append('fil', fil, filnavn);
        const resp = await fetch(`/api/vedlegg/${encodeURIComponent(skjematypeId)}/${encodeURIComponent(skjemaId)}`, {
            method: 'POST',
            body: formData
        });
        if (!resp.ok) {
            const feil = await resp.text();
            throw new Error(`Kunne ikke laste opp "${filnavn}": ${feil}`);
        }
        const data = await resp.json();
        nyeNavn.push(data.filnavn);
    }
    // Merge til eksisterende og tøm nye-lista
    wrapper._eksisterende = [...wrapper._eksisterende, ...nyeNavn];
    wrapper._nyeFiler.clear();
    _renderOpplastingListe(wrapper);
}

function _byggVedleggsVisning(svar, ctx) {
    const boks = document.createElement('div');
    boks.className = 'felt-svar';
    if (!Array.isArray(svar) || svar.length === 0) {
        boks.classList.add('tomt');
        boks.textContent = '(ingen vedlegg)';
        return boks;
    }
    if (!ctx?.skjematypeId || !ctx?.skjemaId) {
        // Uten kontekst kan vi ikke lage nedlastingslenker — bare vis navn
        boks.textContent = svar.filter(Boolean).join(', ');
        return boks;
    }
    boks.style.display = 'flex';
    boks.style.flexDirection = 'column';
    boks.style.gap = '4px';
    for (const filnavn of svar) {
        if (!filnavn) continue;
        const a = document.createElement('a');
        a.href = `/api/vedlegg-fil/${encodeURIComponent(ctx.skjematypeId)}/${encodeURIComponent(ctx.skjemaId)}/${encodeURIComponent(filnavn)}`;
        a.textContent = `📄 ${filnavn}`;
        a.style.color = 'var(--accent, #0a84ff)';
        a.style.textDecoration = 'none';
        boks.appendChild(a);
    }
    return boks;
}

function _lagUkjentType(type) {
    const p = document.createElement('p');
    p.style.color = 'var(--text-secondary)';
    p.style.fontStyle = 'italic';
    p.textContent = `[Felttypen "${type}" er ikke støttet]`;
    return p;
}

// ==================== READONLY VISNING ====================

/**
 * Bygger read-only visning av felt + svar.
 * Returnerer HTMLElement (typisk div med felt-svar-boks).
 */
/**
 * @param {object} felt — feltdefinisjon
 * @param {array}  svar — svar-array (Opplasting krever ekstra kontekst — bruk byggReadonlyVisningOpplasting)
 * @param {object} [ctx] — { skjematypeId, skjemaId } for Opplasting-type
 */
export function byggReadonlyVisning(felt, svar = [], ctx = null) {
    if (felt.Type === 'Informasjon') {
        return _lagInformasjon(felt);
    }

    // Opplasting: bygg lenker (krever ctx)
    if (felt.Type === 'Opplasting') {
        return _byggVedleggsVisning(svar, ctx);
    }

    const svarEl = document.createElement('div');
    svarEl.className = 'felt-svar';

    // Postnummer lagres som [postnr, poststed] — vis begge sammen
    if (felt.Type === 'Postnummer' && Array.isArray(svar) && svar.length >= 1 && svar[0]) {
        svarEl.textContent = `${svar[0]}${svar[1] ? ' ' + svar[1] : ''}`;
        return svarEl;
    }

    if (!svar || svar.length === 0 || (svar.length === 1 && svar[0] === '')) {
        svarEl.classList.add('tomt');
        svarEl.textContent = '(ikke besvart)';
    } else if (svar.length === 1) {
        svarEl.textContent = formatSvarVerdi(felt, svar[0]);
    } else {
        const ul = document.createElement('ul');
        for (const v of svar) {
            const li = document.createElement('li');
            li.textContent = formatSvarVerdi(felt, v);
            ul.appendChild(li);
        }
        svarEl.appendChild(ul);
    }
    return svarEl;
}

/**
 * Formatterer én svar-verdi som lesbar tekst.
 */
export function formatSvarVerdi(felt, verdi) {
    if (verdi === null || verdi === undefined || verdi === '') return '';
    const s = String(verdi);
    switch (felt.Type) {
        case 'Skala':
            if (Array.isArray(felt.Valg)) {
                const treff = felt.Valg.find(v => String(v.Valg_nr) === s || v.Tekst === s);
                if (treff) return treff.Tekst;
            }
            return s;
        case 'Dato': return _formatterDato(s);
        case 'Tidspunkt': return _formatterTid(s);
        case 'Valuta': return _formatterValuta(s);
        case 'Fodselsnummer': return _formatterFodselsnummer(s);
        case 'Kontonummer': return _formatterKontonummer(s);
        default: return s;
    }
}

function _formatterDato(iso) {
    // Input er YYYY-MM-DD; vis som DD.MM.YYYY
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}
function _formatterTid(hhmm) {
    // Input er HH:MM
    return hhmm;
}
function _formatterValuta(v) {
    const n = Number(v);
    if (isNaN(n)) return String(v);
    return 'kr ' + n.toLocaleString('nb-NO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function _formatterFodselsnummer(v) {
    const rensa = String(v).replace(/\D/g, '');
    if (rensa.length !== 11) return v;
    return rensa.slice(0, 6) + ' ' + rensa.slice(6);
}
function _formatterKontonummer(v) {
    const rensa = String(v).replace(/\D/g, '');
    if (rensa.length !== 11) return v;
    return rensa.slice(0, 4) + '.' + rensa.slice(4, 6) + '.' + rensa.slice(6);
}

// ==================== SAMLE SVAR FRA DOM ====================

/**
 * Henter felt-verdi fra DOM. Returnerer alltid array av strings.
 * Kontonummer og Fødselsnummer renses for ikke-siffer.
 */
export function hentSvarFraDom(feltId, type) {
    if (type === 'Flervalg-knapper') {
        const checked = document.querySelectorAll(`input[name="${feltId}[]"]:checked`);
        return Array.from(checked).map(cb => cb.value);
    }
    if (type === 'Skala') {
        const valgt = document.querySelector(`input[name="${feltId}"]:checked`);
        return valgt ? [valgt.value] : [];
    }
    if (type === 'Postnummer') {
        // Postnummer lagres som [postnr, poststed] fra dataset — gyldig kun etter valg fra dropdown
        const el = document.getElementById(feltId);
        if (!el) return [];
        const pnr = (el.dataset.postnr || '').trim();
        const pst = (el.dataset.poststed || '').trim();
        return pnr ? [pnr, pst] : [];
    }
    if (type === 'Opplasting') {
        // Union: allerede opplastede (minus slettede) + nyvalgte (ikke opplastet ennå).
        // Nødvendig for validering FØR preSubmitOpplasting kjører (obligatorisk-sjekk).
        const wrapper = document.querySelector(`.opplasting-wrapper[data-felt-id="${feltId}"]`);
        if (!wrapper) return [];
        const eksist = (wrapper._eksisterende || []).filter(n => !(wrapper._slettede || new Set()).has(n));
        const nye = wrapper._nyeFiler ? [...wrapper._nyeFiler.keys()] : [];
        return [...eksist, ...nye];
    }
    const el = document.getElementById(feltId);
    if (!el) return [];
    let v = el.value;
    if (v === '' || v == null) return [];
    if (type === 'Fodselsnummer' || type === 'Kontonummer') {
        v = String(v).replace(/\D/g, '');
    }
    return [String(v)];
}

// ==================== VALIDERING ====================

/**
 * Validerer felt-svar. Returnerer { ok: true } eller { ok: false, feilmelding: string }.
 * Håndterer obligatorisk-sjekk + type-spesifikk validering.
 */
export function valider(felt, svar) {
    // Obligatorisk-sjekk
    const erTom = !svar || svar.length === 0 || (svar.length === 1 && (svar[0] === '' || svar[0] == null));
    if (felt.Obligatorisk && erTom) {
        return { ok: false, feilmelding: 'Dette feltet er obligatorisk' };
    }
    if (erTom) return { ok: true }; // Ikke-obligatorisk + tomt = greit

    const førsteVerdi = svar[0];
    switch (felt.Type) {
        case 'E-post':
            if (!_erGyldigEpost(førsteVerdi)) return { ok: false, feilmelding: 'Ugyldig e-postadresse' };
            break;
        case 'Fodselsnummer':
            if (!_erGyldigFodselsnummer(førsteVerdi)) return { ok: false, feilmelding: 'Ugyldig fødselsnummer (feil kontrollsiffer)' };
            break;
        case 'Kontonummer':
            if (!_erGyldigKontonummer(førsteVerdi)) return { ok: false, feilmelding: 'Ugyldig kontonummer (feil kontrollsiffer)' };
            break;
        case 'Postnummer':
            if (!/^\d{4}$/.test(String(førsteVerdi))) return { ok: false, feilmelding: 'Velg et postnummer fra forslagslisten' };
            break;
        case 'Tall':
        case 'Valuta': {
            const n = Number(førsteVerdi);
            if (isNaN(n)) return { ok: false, feilmelding: 'Må være et tall' };
            if (felt.Min_verdi != null && n < felt.Min_verdi) return { ok: false, feilmelding: `Må være minst ${felt.Min_verdi}` };
            if (felt.Max_verdi != null && n > felt.Max_verdi) return { ok: false, feilmelding: `Må være maks ${felt.Max_verdi}` };
            break;
        }
    }
    return { ok: true };
}

function _erGyldigEpost(s) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s).trim());
}

/**
 * Mod-11-sjekk for fødselsnummer (11 siffer).
 * Kilder: standard norsk mod-11 med vektene 3,7,6,1,8,9,4,5,2 og 5,4,3,2,7,6,5,4,3,2.
 */
function _erGyldigFodselsnummer(s) {
    const n = String(s).replace(/\D/g, '');
    if (n.length !== 11) return false;
    const v1 = [3, 7, 6, 1, 8, 9, 4, 5, 2];
    const v2 = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
    let sum1 = 0;
    for (let i = 0; i < 9; i++) sum1 += parseInt(n[i], 10) * v1[i];
    let k1 = 11 - (sum1 % 11);
    if (k1 === 11) k1 = 0;
    if (k1 === 10) return false;
    if (k1 !== parseInt(n[9], 10)) return false;
    let sum2 = 0;
    for (let i = 0; i < 10; i++) sum2 += parseInt(n[i], 10) * v2[i];
    let k2 = 11 - (sum2 % 11);
    if (k2 === 11) k2 = 0;
    if (k2 === 10) return false;
    return k2 === parseInt(n[10], 10);
}

/**
 * Mod-11-sjekk for kontonummer (11 siffer).
 */
function _erGyldigKontonummer(s) {
    const n = String(s).replace(/\D/g, '');
    if (n.length !== 11) return false;
    const v = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < 10; i++) sum += parseInt(n[i], 10) * v[i];
    let k = 11 - (sum % 11);
    if (k === 11) k = 0;
    if (k === 10) return false;
    return k === parseInt(n[10], 10);
}

// ==================== SEKSJONER FRA DOM ====================

/**
 * Bygger en normalisert seksjoner-struktur fra det som er utfylt i DOM.
 * Formatet matcher hva vilkar.evaluerVilkar forventer: hver felt har
 * { Id, Nummer, Type, Svar }. Brukes til dynamisk Vises-evaluering.
 *
 * @param {object[]} seksjoner  — fra skjemadefinisjonen
 * @returns {object[]}
 */
export function samleSeksjonerFraDom(seksjoner) {
    return (seksjoner || []).map(sek => ({
        Seksjon_nummer: sek.Seksjon_nummer,
        Nummer: sek.Seksjon_nummer,
        Felter: (sek.Felter || []).map(felt => {
            const feltId = `felt-${sek.Seksjon_nummer}-${felt.Nummer}`;
            const svar = felt.Type === 'Informasjon' ? [] : hentSvarFraDom(feltId, felt.Type);
            return { Id: felt.Id, Nummer: felt.Nummer, Type: felt.Type, Svar: svar };
        })
    }));
}

// ==================== MARKDOWN ====================

/**
 * Enkel Markdown-parser for skjemaforklaring. Støtter:
 *   **bold**  *italic*  [tekst](url)  `kode`
 *   Overskrifter (# ## ###)
 *   Punktlister (- item)
 *   Nummererte lister (1. item)
 *   Linjeskift → <br>, avsnittsskift → <p>
 *
 * Escape HTML før prosessering for sikkerhet. Ingen ekstern parser trengs.
 */
export function parseMarkdown(tekst) {
    if (!tekst) return '';
    let s = escapeHtml(tekst);

    // Overskrifter (må komme før andre transformasjoner)
    s = s.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    s = s.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    s = s.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // Lister — samle sammenhengende linjer
    s = s.replace(/(^|\n)((?:- .+(?:\n|$))+)/g, (_m, pre, blokk) => {
        const items = blokk.trim().split(/\n/).map(l => '<li>' + l.replace(/^- /, '') + '</li>').join('');
        return pre + '<ul>' + items + '</ul>';
    });
    s = s.replace(/(^|\n)((?:\d+\. .+(?:\n|$))+)/g, (_m, pre, blokk) => {
        const items = blokk.trim().split(/\n/).map(l => '<li>' + l.replace(/^\d+\. /, '') + '</li>').join('');
        return pre + '<ol>' + items + '</ol>';
    });

    // Inline: bold, italic, kode, lenke
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Lenker: [tekst](url) — aksepterer http(s), relative (/), og fragmenter (#).
    // Blokkerer javascript:/data: for XSS. Egen class md-lenke for lenkestil.
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+|\/[^)]*|#[^)]*)\)/g,
        '<a class="md-lenke" href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

    // Avsnitt/linjeskift — dobbel newline til </p><p>, enkel til <br>
    // Men ikke inne i eksisterende blokk-tags (h1-h3, ul, ol, li)
    s = s.split(/\n\n+/).map(par => {
        const trimmed = par.trim();
        if (!trimmed) return '';
        // Hopp innpakking hvis allerede blokk-nivå
        if (/^<(h[1-6]|ul|ol|li|p|blockquote)/i.test(trimmed)) return trimmed;
        return '<p>' + trimmed.replace(/\n/g, '<br>') + '</p>';
    }).join('');
    return s;
}

/**
 * Render Skjemaforklaring/felt-tekst basert på Format-flagget.
 * Returnerer HTML-string (allerede escape'd der det passer).
 */
export function renderTekst(tekstObj) {
    if (!tekstObj) return '';
    // Skjemaforklaring bruker .Innhold, felt-Tekst/Undertittel bruker .Verdi.
    // Migrerte skjematyper fra legacy kan ha begge — prioriter Verdi, fall tilbake til Innhold.
    const verdi = tekstObj.Verdi ?? tekstObj.Innhold ?? '';
    if (!verdi) return '';
    if (tekstObj.Format === 'Markdown') return parseMarkdown(verdi);
    return escapeHtml(verdi);
}

/**
 * Inline-variant av renderTekst — for label/tittel-kontekster hvor blokk-
 * elementer (<p>, <ul>, <h1-3>) ville ødelagt layout. Støtter bold, italic,
 * code, lenker. Ingen paragraph-wrapping.
 */
export function renderTekstInline(tekstObj) {
    if (!tekstObj) return '';
    const verdi = tekstObj.Verdi ?? tekstObj.Innhold ?? '';
    if (!verdi) return '';
    if (tekstObj.Format !== 'Markdown') return escapeHtml(verdi);
    let s = escapeHtml(verdi);
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+|\/[^)]*|#[^)]*)\)/g,
        '<a class="md-lenke" href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return s;
}

// ==================== UTILITY ====================

export function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
