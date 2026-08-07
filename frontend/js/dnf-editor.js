/**
 * DNF-editor — gjenbrukbar widget for redigering av vilkår i DNF-form.
 *
 * Brukes til:
 *   - Vises på seksjon/felt
 *   - ObligatoriskHvis på felt
 *   - FasteData på felt (dropdown-oppslag)
 *
 * DNF-format:
 *   { EllerAv: [{ OgAv: [{ Felt/Kolonne, Operator, Verdi }, ...] }, ...] }
 *
 * Tolkning: (A1 AND A2 …) OR (B1 AND B2 …) OR …
 *
 * Bruk:
 *   const editor = byggDNFEditor(container, felt.Vises, {
 *       modus: 'vilkår',                          // eller 'faste-data'
 *       feltOptions: [{ ref, tekst }, ...],       // for modus 'vilkår'
 *       datakilder: [{ navn, filtre: [...] }],    // for modus 'faste-data'
 *       tittel: 'Vises hvis',                     // valgfri
 *       onEndring: (nyDNF) => { felt.Vises = nyDNF; }
 *   });
 *   // editor.destroy()  — fjerner DOM og handlers
 */

const OPERATORER_VILKAR = ['=', '!=', '<', '<=', '>', '>=', 'tom', 'ikke_tom', 'inneholder'];
const OPERATORER_FASTE_DATA = ['=', '!=', 'inneholder']; // enklere sett for filter

export function byggDNFEditor(container, initial, options) {
    const modus = options.modus || 'vilkår';
    const feltOptions = options.feltOptions || [];
    const datakilder = options.datakilder || [];
    const tittel = options.tittel || (modus === 'faste-data' ? 'Hent verdier fra datakilde' : 'Vilkår');
    const onEndring = options.onEndring || (() => {});

    // Kloningsstate — muterer ikke initial-objektet
    let state = initial ? JSON.parse(JSON.stringify(initial)) : null;

    function tomState() {
        if (modus === 'faste-data') {
            return { Datakilde: '', EllerAv: [] };
        }
        return { EllerAv: [] };
    }

    function normaliser() {
        if (!state) state = tomState();
        if (!Array.isArray(state.EllerAv)) state.EllerAv = [];
    }

    function ferdig() {
        // Send oppdatert DNF til kaller. Null hvis tom/fjernet.
        const rent = renset();
        onEndring(rent);
    }

    function renset() {
        if (!state) return null;
        if (modus === 'faste-data') {
            if (!state.Datakilde) return null;
            // Behold selv om ingen filter — betyr "hent alle"
            return {
                Datakilde: state.Datakilde,
                EllerAv: (state.EllerAv || []).filter(g => Array.isArray(g?.OgAv) && g.OgAv.length > 0)
            };
        }
        // vilkår
        const rene = (state.EllerAv || []).filter(g => Array.isArray(g?.OgAv) && g.OgAv.length > 0);
        return rene.length > 0 ? { EllerAv: rene } : null;
    }

    function render() {
        container.innerHTML = '';
        container.className = 'dnf-editor';

        const wrap = document.createElement('div');
        wrap.style.cssText = 'border: 1px solid var(--border-color, #d0d7de); border-radius: 8px; padding: 10px 12px; background: rgba(0,0,0,0.02); margin-top: 6px;';

        // Header med tittel + toggle-knapp
        const header = document.createElement('div');
        header.style.cssText = 'display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;';

        const t = document.createElement('div');
        t.style.cssText = 'font-weight: 600; font-size: 13px;';
        t.textContent = tittel;
        header.appendChild(t);

        const knapp = document.createElement('button');
        knapp.type = 'button';
        knapp.className = 'knapp mini';
        knapp.style.cssText = 'padding: 3px 10px; font-size: 12px; border: 1px solid var(--danger, #ff3b30); background: transparent; color: var(--danger, #ff3b30); border-radius: 4px; cursor: pointer;';
        const harInnhold = state && (modus === 'faste-data' ? state.Datakilde : (state.EllerAv || []).some(g => g?.OgAv?.length));
        knapp.textContent = harInnhold ? 'Fjern hele' : 'Legg til';
        knapp.addEventListener('click', () => {
            if (harInnhold) {
                state = null;
            } else {
                state = tomState();
                if (modus !== 'faste-data') {
                    state.EllerAv.push({ OgAv: [{ Felt: '', Operator: '=', Verdi: '' }] });
                }
            }
            ferdig();
            render();
        });
        header.appendChild(knapp);
        wrap.appendChild(header);

        if (!state || (modus === 'vilkår' && (!state.EllerAv || state.EllerAv.length === 0))) {
            const t = document.createElement('div');
            t.style.cssText = 'color: var(--text-secondary, #666); font-size: 12px; font-style: italic;';
            t.textContent = modus === 'faste-data' ? '(ingen datakilde)' : '(ingen vilkår — feltet vises alltid)';
            wrap.appendChild(t);
            container.appendChild(wrap);
            return;
        }

        // FASTE-DATA: øverst en Datakilde-dropdown
        if (modus === 'faste-data') {
            const rad = document.createElement('div');
            rad.style.cssText = 'display: flex; gap: 8px; align-items: center; margin-bottom: 8px;';
            const lab = document.createElement('label');
            lab.style.cssText = 'font-size: 12px; font-weight: 600; min-width: 70px;';
            lab.textContent = 'Datakilde:';
            rad.appendChild(lab);

            const sel = document.createElement('select');
            sel.style.cssText = 'flex: 1; padding: 4px 8px; font-size: 13px;';
            const tomOpt = document.createElement('option');
            tomOpt.value = '';
            tomOpt.textContent = '— velg —';
            sel.appendChild(tomOpt);
            for (const dk of datakilder) {
                const o = document.createElement('option');
                o.value = dk.navn;
                o.textContent = dk.navn;
                if (dk.navn === state.Datakilde) o.selected = true;
                sel.appendChild(o);
            }
            sel.addEventListener('change', () => {
                state.Datakilde = sel.value;
                state.EllerAv = []; // nullstill filtre når datakilde byttes
                // Auto-opprett tom filter-gruppe hvis datakilden har filtre — så bruker slipper å lete etter "Legg til"
                const dk = datakilder.find(d => d.navn === sel.value);
                const filtre = dk?.filtre || [];
                if (sel.value && filtre.length > 0) {
                    const førsteFilter = typeof filtre[0] === 'string' ? filtre[0] : (filtre[0]?.navn || '');
                    state.EllerAv.push({ OgAv: [{ Kolonne: førsteFilter, Operator: '=', Verdi: '' }] });
                }
                ferdig();
                render();
            });
            rad.appendChild(sel);
            wrap.appendChild(rad);
            if (!state.Datakilde) {
                container.appendChild(wrap);
                return;
            }
            const dkValgt = datakilder.find(d => d.navn === state.Datakilde);
            if (!dkValgt || !(dkValgt.filtre || []).length) {
                // Datakilde uten filtre — vis hint og avslutt
                const t = document.createElement('div');
                t.style.cssText = 'color: var(--text-secondary, #666); font-size: 12px; font-style: italic;';
                t.textContent = '(datakilden har ingen filtre — henter alle rader)';
                wrap.appendChild(t);
                container.appendChild(wrap);
                return;
            }
        }

        // AND-grupper
        for (let gIdx = 0; gIdx < state.EllerAv.length; gIdx++) {
            const gruppe = state.EllerAv[gIdx];
            if (gIdx > 0) {
                const sep = document.createElement('div');
                sep.style.cssText = 'text-align: center; font-weight: 700; font-size: 12px; color: var(--text-secondary); margin: 4px 0;';
                sep.textContent = 'ELLER';
                wrap.appendChild(sep);
            }
            wrap.appendChild(byggGruppe(gruppe, gIdx));
        }

        // + Legg til alternativ
        const nyOrKnapp = document.createElement('button');
        nyOrKnapp.type = 'button';
        nyOrKnapp.style.cssText = 'margin-top: 6px; padding: 4px 10px; font-size: 12px; border: 1px solid var(--accent); background: transparent; color: var(--accent); border-radius: 4px; cursor: pointer;';
        nyOrKnapp.textContent = modus === 'faste-data' ? '+ Legg til ELLER-alternativ' : '+ Legg til alternativ (ELLER)';
        nyOrKnapp.addEventListener('click', () => {
            if (modus === 'faste-data') {
                const dk = datakilder.find(d => d.navn === state.Datakilde);
                const filtre = dk?.filtre || [];
                const førsteFilter = filtre.length > 0
                    ? (typeof filtre[0] === 'string' ? filtre[0] : (filtre[0]?.navn || ''))
                    : '';
                state.EllerAv.push({ OgAv: [{ Kolonne: førsteFilter, Operator: '=', Verdi: '' }] });
            } else {
                state.EllerAv.push({ OgAv: [{ Felt: '', Kolonne: '', Operator: '=', Verdi: '' }] });
            }
            ferdig();
            render();
        });
        wrap.appendChild(nyOrKnapp);

        container.appendChild(wrap);
    }

    function byggGruppe(gruppe, gIdx) {
        const div = document.createElement('div');
        div.style.cssText = 'padding: 8px 10px; border: 1px solid var(--border-color); border-radius: 6px; background: white; margin: 4px 0;';

        const overskrift = document.createElement('div');
        overskrift.style.cssText = 'font-size: 11px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; margin-bottom: 6px;';
        overskrift.textContent = state.EllerAv.length > 1
            ? `Alternativ ${gIdx + 1} — alle vilkår må være sanne (OG)`
            : 'Alle vilkår må være sanne (OG)';
        div.appendChild(overskrift);

        const og = Array.isArray(gruppe.OgAv) ? gruppe.OgAv : [];
        for (let bIdx = 0; bIdx < og.length; bIdx++) {
            div.appendChild(byggBetingelse(og[bIdx], gIdx, bIdx));
        }

        const knapperad = document.createElement('div');
        knapperad.style.cssText = 'display: flex; gap: 6px; margin-top: 6px;';

        const nyAnd = document.createElement('button');
        nyAnd.type = 'button';
        nyAnd.style.cssText = 'padding: 3px 8px; font-size: 12px; border: 1px solid var(--accent); background: transparent; color: var(--accent); border-radius: 4px; cursor: pointer;';
        nyAnd.textContent = '+ Legg til (OG)';
        nyAnd.addEventListener('click', () => {
            state.EllerAv[gIdx].OgAv.push({ Felt: '', Kolonne: '', Operator: '=', Verdi: '' });
            ferdig();
            render();
        });
        knapperad.appendChild(nyAnd);

        if (state.EllerAv.length > 1) {
            const fjernGr = document.createElement('button');
            fjernGr.type = 'button';
            fjernGr.style.cssText = 'padding: 3px 8px; font-size: 12px; border: 1px solid var(--danger); background: transparent; color: var(--danger); border-radius: 4px; cursor: pointer;';
            fjernGr.textContent = 'Fjern alternativ';
            fjernGr.addEventListener('click', () => {
                state.EllerAv.splice(gIdx, 1);
                ferdig();
                render();
            });
            knapperad.appendChild(fjernGr);
        }
        div.appendChild(knapperad);
        return div;
    }

    function byggBetingelse(betingelse, gIdx, bIdx) {
        const rad = document.createElement('div');
        rad.style.cssText = 'display: flex; gap: 6px; align-items: center; margin: 4px 0; flex-wrap: wrap;';

        // Referanse (Felt eller Kolonne)
        const refSel = document.createElement('select');
        refSel.style.cssText = 'flex: 1; min-width: 140px; padding: 3px 6px; font-size: 12px;';
        const tomOpt = document.createElement('option');
        tomOpt.value = '';
        tomOpt.textContent = modus === 'faste-data' ? '— filter —' : '— felt —';
        refSel.appendChild(tomOpt);

        const nåværendeRef = modus === 'faste-data' ? (betingelse.Kolonne || '') : (betingelse.Felt || '');

        if (modus === 'faste-data') {
            const dk = datakilder.find(d => d.navn === state.Datakilde);
            const filtre = dk?.filtre || [];
            for (const f of filtre) {
                const o = document.createElement('option');
                o.value = f.navn || f;
                o.textContent = f.navn || f;
                if (o.value === nåværendeRef) o.selected = true;
                refSel.appendChild(o);
            }
        } else {
            for (const f of feltOptions) {
                const o = document.createElement('option');
                o.value = f.ref;
                o.textContent = f.tekst;
                if (o.value === nåværendeRef) o.selected = true;
                refSel.appendChild(o);
            }
        }
        refSel.addEventListener('change', () => {
            if (modus === 'faste-data') betingelse.Kolonne = refSel.value;
            else betingelse.Felt = refSel.value;
            ferdig();
        });
        rad.appendChild(refSel);

        // Operator
        const opSel = document.createElement('select');
        opSel.style.cssText = 'padding: 3px 6px; font-size: 12px; width: 100px;';
        const opts = modus === 'faste-data' ? OPERATORER_FASTE_DATA : OPERATORER_VILKAR;
        for (const op of opts) {
            const o = document.createElement('option');
            o.value = op;
            o.textContent = op;
            if (op === (betingelse.Operator || '=')) o.selected = true;
            opSel.appendChild(o);
        }
        opSel.addEventListener('change', () => {
            betingelse.Operator = opSel.value;
            ferdig();
            render(); // så verdi-input evt skjules for tom/ikke_tom
        });
        rad.appendChild(opSel);

        // Verdi (skjules for tom/ikke_tom)
        if (betingelse.Operator !== 'tom' && betingelse.Operator !== 'ikke_tom') {
            const inp = document.createElement('input');
            inp.type = 'text';
            inp.style.cssText = 'flex: 1 1 100px; min-width: 80px; padding: 3px 6px; font-size: 12px;';
            inp.placeholder = 'verdi';
            inp.value = betingelse.Verdi || '';
            inp.addEventListener('input', () => {
                betingelse.Verdi = inp.value;
                ferdig();
            });
            rad.appendChild(inp);
        }

        // Fjern
        const fjern = document.createElement('button');
        fjern.type = 'button';
        fjern.style.cssText = 'padding: 3px 8px; font-size: 12px; border: 1px solid var(--danger); background: transparent; color: var(--danger); border-radius: 4px; cursor: pointer;';
        fjern.textContent = '×';
        fjern.title = 'Fjern vilkår';
        fjern.addEventListener('click', () => {
            state.EllerAv[gIdx].OgAv.splice(bIdx, 1);
            if (state.EllerAv[gIdx].OgAv.length === 0) {
                state.EllerAv.splice(gIdx, 1);
            }
            ferdig();
            render();
        });
        rad.appendChild(fjern);

        return rad;
    }

    normaliser();
    render();
    return {
        destroy: () => { container.innerHTML = ''; }
    };
}
