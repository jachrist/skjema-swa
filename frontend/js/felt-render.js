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
    'Flervalg-dropdown'
    // 'Opplasting' kommer i fase 1.2 (krever Blob-oppsett)
];

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
        case 'Postnummer': return _lagPostnummerInput(feltId, førsteSvar);
        case 'Dato': return _lagDateInput(feltId, førsteSvar);
        case 'Tidspunkt': return _lagTimeInput(feltId, førsteSvar);
        case 'Skala': return _lagSkala(felt, feltId, førsteSvar);
        case 'Flervalg-knapper': return _lagFlervalgKnapper(felt, feltId, initialSvar);
        case 'Flervalg-dropdown': return _lagFlervalgDropdown(felt, feltId, førsteSvar);
        default: return _lagUkjentType(felt.Type);
    }
}

function _lagInformasjon(felt) {
    const div = document.createElement('div');
    div.className = 'informasjon';
    div.textContent = felt.Tekst?.Verdi || '';
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

function _lagPostnummerInput(feltId, verdi) {
    const el = document.createElement('input');
    el.type = 'text';
    el.id = feltId;
    el.name = feltId;
    el.value = verdi;
    el.inputMode = 'numeric';
    el.pattern = '\\d{4}';
    el.maxLength = 4;
    el.placeholder = '0000';
    return el;
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
    for (const valg of (felt.Valg || [])) {
        const label = document.createElement('label');
        label.className = 'skala-valg';
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = feltId;
        input.value = String(valg.Valg_nr ?? valg.Tekst);
        if (String(valgtVerdi) === input.value) input.checked = true;
        const span = document.createElement('span');
        span.textContent = valg.Tekst;
        label.append(input, span);
        container.appendChild(label);
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
            if (cb.checked) { label.classList.add('selected'); antallValgt++; }
            else { label.classList.remove('selected'); antallValgt--; }
            container.querySelectorAll('.flervalg-knapp').forEach(k => {
                const c = k.querySelector('input');
                c.disabled = !c.checked && antallValgt >= maks;
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
export function byggReadonlyVisning(felt, svar = []) {
    if (felt.Type === 'Informasjon') {
        return _lagInformasjon(felt);
    }
    const svarEl = document.createElement('div');
    svarEl.className = 'felt-svar';

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
            if (!/^\d{4}$/.test(String(førsteVerdi))) return { ok: false, feilmelding: 'Postnummer må være 4 siffer' };
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

// ==================== UTILITY ====================

export function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
