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
// Samme streng som `IDAG_REF` i vilkar.js. Den leses derfra, ikke skrevet
// opp på nytt — editoren og motoren skal ikke kunne bli uenige om hva
// «dagens dato» heter.
import { IDAG_REF } from './vilkar.js';

const OPERATORER_VILKAR = ['=', '!=', '<', '<=', '>', '>=', 'tom', 'ikke_tom', 'inneholder'];
const OPERATORER_FASTE_DATA = ['=', '!=', 'inneholder']; // enklere sett for filter

// Symbolene sier lite for den som ikke skriver kode til daglig, og «!=» er
// særlig lett å lese feil. Teksten vises i nedtrekket; symbolet blir stående
// som en kort etikett når valget er gjort.
const OPERATOR_FORKLARING = {
    '=': 'er lik',
    '!=': 'er forskjellig fra',
    '<': 'er mindre enn',
    '<=': 'er mindre enn eller lik',
    '>': 'er større enn',
    '>=': 'er større enn eller lik',
    'tom': 'er ikke besvart',
    'ikke_tom': 'er besvart',
    'inneholder': 'inneholder teksten'
};

export function byggDNFEditor(container, initial, options) {
    const modus = options.modus || 'vilkår';
    // Høyresiden som feltreferanse er et VALG, ikke standard: `Vises` og
    // `ObligatoriskHvis` har klart seg med faste verdier, og en ekstra
    // nedtrekksliste i hver rad der ville vært støy. Validering trenger det.
    const høyresideFelt = options.høyresideFelt === true;
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
        // classList.add, ikke className =.
        //
        // Med tilordning forsvant kallerens egne klasser, og `.dnf-slot` var
        // en av dem. Editoren i skjematypen skjuler vilkårspanelene med
        // `.felt.kollapset > .dnf-slot`, og den regelen sluttet å treffe i det
        // øyeblikket panelet ble bygget — så et sammenslått felt viste
        // fortsatt «Felt vises kun hvis», «Obligatorisk hvis» og
        // datakilde-panelet.
        //
        // Render kjøres på nytt ved hver endring, så klassen legges til mange
        // ganger. classList er et sett; det er uproblematisk.
        container.classList.add('dnf-editor');

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
                if (dk.beskrivelse) o.title = dk.beskrivelse;
                if (dk.navn === state.Datakilde) o.selected = true;
                sel.appendChild(o);
            }
            // En lagret datakilde som ikke lenger tilbys skal LIKEVEL vises.
            // Uten dette står selecten på «— velg —», som ser ut som om
            // ingenting er satt opp, og første klikk nullstiller filtrene
            // som faktisk ligger der. Oppsettet blir ikke borte av at vi
            // sluttet å anbefale kilden.
            const kjentKilde = datakilder.some(d => d.navn === state.Datakilde);
            if (state.Datakilde && !kjentKilde) {
                const o = document.createElement('option');
                o.value = state.Datakilde;
                o.textContent = `${state.Datakilde} (tilbys ikke lenger)`;
                o.selected = true;
                o.title = 'Oppsettet virker fortsatt. Velger du noe annet, nullstilles filtrene.';
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

            // En ukjent kilde er IKKE det samme som en kilde uten filtre.
            // Begge falt tidligere hit og fikk teksten «ingen filtre — henter
            // alle rader». For et lagret oppsett med filtre var det en ren
            // løgn: filtrene lå der, de ble bare ikke vist, og den som leste
            // skjermen fikk vite det motsatte av hva som ville skje.
            if (!dkValgt) {
                const t = document.createElement('div');
                t.style.cssText = 'color: var(--warning, #b86e00); font-size: 12px; line-height: 1.5;';
                const vilkar = (state.EllerAv || [])
                    .map(g => (g.OgAv || [])
                        .map(b => `${b.Kolonne || '?'} ${b.Operator || '='} ${b.Verdi || ''}`.trim())
                        .join(' OG '))
                    .filter(Boolean)
                    .join('  ELLER  ');
                t.textContent = `Datakilden «${state.Datakilde}» tilbys ikke lenger i editoren, men `
                    + 'oppsettet virker som før.'
                    + (vilkar ? ` Lagret filter: ${vilkar}.` : ' Ingen filtre — henter alle rader.')
                    + ' Bytter du datakilde, nullstilles filtrene.';
                wrap.appendChild(t);
                container.appendChild(wrap);
                return;
            }

            if (!(dkValgt.filtre || []).length) {
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

    /**
     * Høyresiden: fast verdi ELLER et annet felt, med valgfri forskyvning.
     *
     * Formen i data avgjør hva som vises: er `Verdi` et objekt, er det en
     * feltreferanse. Det er samme regel `vilkar.js` bruker når den leser
     * den, så editoren og motoren kan ikke bli uenige om hva en verdi ER.
     */
    function byggHoyreside(betingelse) {
        const boks = document.createElement('span');
        boks.style.cssText = 'display: flex; gap: 6px; align-items: center; flex: 1 1 200px; flex-wrap: wrap;';

        const erFeltRef = !!(betingelse.Verdi && typeof betingelse.Verdi === 'object'
            && !Array.isArray(betingelse.Verdi));

        const typeSel = document.createElement('select');
        typeSel.style.cssText = 'padding: 3px 6px; font-size: 12px; width: 108px;';
        for (const [v, t] of [['verdi', 'fast verdi'], ['felt', 'et annet felt']]) {
            const o = document.createElement('option');
            o.value = v;
            o.textContent = t;
            if ((v === 'felt') === erFeltRef) o.selected = true;
            typeSel.appendChild(o);
        }
        typeSel.addEventListener('change', () => {
            // Verdien kastes ved bytte: en tekst og en feltreferanse er ikke
            // det samme, og å forsøke å oversette ville gitt en referanse som
            // ser satt ut uten å peke på noe.
            betingelse.Verdi = typeSel.value === 'felt' ? { Felt: '' } : '';
            ferdig();
            render();
        });
        boks.appendChild(typeSel);

        if (!erFeltRef) {
            const inp = document.createElement('input');
            inp.type = 'text';
            inp.style.cssText = 'flex: 1 1 90px; min-width: 70px; padding: 3px 6px; font-size: 12px;';
            inp.placeholder = 'verdi';
            inp.value = betingelse.Verdi == null ? '' : String(betingelse.Verdi);
            inp.addEventListener('input', () => {
                betingelse.Verdi = inp.value;
                ferdig();
            });
            boks.appendChild(inp);
            return boks;
        }

        const feltSel = document.createElement('select');
        feltSel.style.cssText = 'flex: 1 1 130px; min-width: 120px; padding: 3px 6px; font-size: 12px;';
        const tom = document.createElement('option');
        tom.value = '';
        tom.textContent = '— felt —';
        feltSel.appendChild(tom);

        const idag = document.createElement('option');
        idag.value = IDAG_REF;
        idag.textContent = 'Dagens dato';
        idag.title = 'Datoen skjemaet fylles ut';
        feltSel.appendChild(idag);

        for (const f of feltOptions) {
            const o = document.createElement('option');
            o.value = f.ref;
            o.textContent = f.tekst;
            feltSel.appendChild(o);
        }
        feltSel.value = String(betingelse.Verdi.Felt || '');
        feltSel.addEventListener('change', () => {
            betingelse.Verdi = { ...betingelse.Verdi, Felt: feltSel.value };
            ferdig();
        });
        boks.appendChild(feltSel);

        const dager = document.createElement('input');
        dager.type = 'number';
        dager.style.cssText = 'width: 86px; padding: 3px 6px; font-size: 12px;';
        dager.placeholder = '± dager';
        dager.title = 'Forskyvning i dager. «14» betyr 14 dager ETTER feltet, '
            + '«-30» betyr 30 dager før. Virker bare på datoer.';
        dager.value = betingelse.Verdi.PlussDager == null ? '' : String(betingelse.Verdi.PlussDager);
        dager.addEventListener('input', () => {
            const n = dager.value === '' ? null : Number(dager.value);
            const ny = { ...betingelse.Verdi };
            // Null dagers forskyvning er det samme som ingen. Lagres den
            // likevel, bærer skjematypen en nøkkel som ikke betyr noe.
            if (n === null || !Number.isFinite(n) || n === 0) delete ny.PlussDager;
            else ny.PlussDager = n;
            betingelse.Verdi = ny;
            ferdig();
        });
        boks.appendChild(dager);

        return boks;
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
                if (typeof f === 'object' && f.beskrivelse) o.title = f.beskrivelse;
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
        // Bredere enn før: teksten skal få plass uten å bli kuttet.
        opSel.style.cssText = 'padding: 3px 6px; font-size: 12px; width: 190px;';
        const opts = modus === 'faste-data' ? OPERATORER_FASTE_DATA : OPERATORER_VILKAR;
        for (const op of opts) {
            const o = document.createElement('option');
            o.value = op;
            const forklaring = OPERATOR_FORKLARING[op];
            o.textContent = forklaring ? `${op}  —  ${forklaring}` : op;
            o.title = forklaring || op;
            if (op === (betingelse.Operator || '=')) o.selected = true;
            opSel.appendChild(o);
        }
        opSel.title = OPERATOR_FORKLARING[betingelse.Operator || '='] || '';
        opSel.addEventListener('change', () => {
            betingelse.Operator = opSel.value;
            opSel.title = OPERATOR_FORKLARING[opSel.value] || '';
            ferdig();
            render(); // så verdi-input evt skjules for tom/ikke_tom
        });
        rad.appendChild(opSel);

        // Verdi (skjules for tom/ikke_tom)
        //
        // I modus `vilkår` kan høyresiden være ET ANNET FELT, ikke bare en
        // fast verdi: «sluttdato etter startdato» er ikke uttrykkbart med en
        // literal. Formen er { Felt: "<ref>", PlussDager: n } — se vilkar.js.
        //
        // `faste-data` beholder den faste verdien: der sammenlignes mot en
        // kolonne i en ekstern datakilde, og et felt i skjemaet gir ikke
        // mening som filter.
        if (betingelse.Operator !== 'tom' && betingelse.Operator !== 'ikke_tom'
            && modus !== 'faste-data' && høyresideFelt) {
            rad.appendChild(byggHoyreside(betingelse));
        } else if (betingelse.Operator !== 'tom' && betingelse.Operator !== 'ikke_tom') {
            const inp = document.createElement('input');
            inp.type = 'text';
            inp.style.cssText = 'flex: 1 1 100px; min-width: 80px; padding: 3px 6px; font-size: 12px;';
            // Bruk filter-beskrivelse som placeholder + tooltip når filter er valgt
            let ph = 'verdi';
            if (modus === 'faste-data' && nåværendeRef) {
                const dk = datakilder.find(d => d.navn === state.Datakilde);
                const filt = (dk?.filtre || []).find(f => (f.navn || f) === nåværendeRef);
                if (filt && typeof filt === 'object' && filt.beskrivelse) {
                    ph = filt.beskrivelse;
                    inp.title = filt.beskrivelse;
                }
            }
            inp.placeholder = ph;
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

/**
 * Valideringsregler på et felt — en liste av { Vilkar, Melding }.
 *
 * Hver regel er en DNF-editor med høyresiden satt til feltmodus, pluss et
 * meldingsfelt. Vilkåret leses som GYLDIG HVIS, og det står i panelet: uten
 * den setningen er retningen en gjetning, og en snudd regel ser ut som en
 * regel som ikke virker.
 *
 * Bruk:
 *   byggValideringEditor(container, felt.Validering, {
 *       feltOptions: [{ ref, tekst }, ...],
 *       onEndring: (ny) => { if (ny) felt.Validering = ny; else delete felt.Validering; }
 *   });
 */
export function byggValideringEditor(container, initial, options) {
    const feltOptions = options.feltOptions || [];
    // Feltet reglene står PÅ. Venstresiden i en ny regel peker på det.
    const egetFelt = options.egetFelt || '';
    const onEndring = options.onEndring || (() => {});

    let regler = Array.isArray(initial) ? JSON.parse(JSON.stringify(initial)) : [];

    function ferdig() {
        // En regel uten vilkår er ingen regel. Den slipper ikke ut.
        const rene = regler.filter(r => r && r.Vilkar);
        onEndring(rene.length ? rene : null);
    }

    function render() {
        container.innerHTML = '';
        container.classList.add('dnf-editor');

        const wrap = document.createElement('div');
        wrap.style.cssText = 'border: 1px solid var(--border-color, #d0d7de); border-radius: 8px; padding: 10px 12px; background: rgba(0,0,0,0.02); margin-top: 6px;';

        const header = document.createElement('div');
        header.style.cssText = 'display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;';
        const t = document.createElement('div');
        t.style.cssText = 'font-weight: 600; font-size: 13px;';
        t.textContent = 'Validering';
        header.appendChild(t);
        wrap.appendChild(header);

        const forklaring = document.createElement('div');
        forklaring.style.cssText = 'font-size: 11px; color: var(--text-secondary); margin-bottom: 8px; line-height: 1.5;';
        forklaring.textContent = 'Vilkåret sier når svaret er GYLDIG. Holder det ikke, '
            + 'vises meldingen og skjemaet kan ikke sendes inn. En regel hopper over '
            + 'seg selv til alle feltene den viser til er fylt ut.';
        wrap.appendChild(forklaring);

        regler.forEach((regel, i) => wrap.appendChild(byggRegel(regel, i)));

        const ny = document.createElement('button');
        ny.type = 'button';
        ny.style.cssText = 'margin-top: 6px; padding: 4px 10px; font-size: 12px; border: 1px solid var(--accent); background: transparent; color: var(--accent); border-radius: 4px; cursor: pointer;';
        ny.textContent = '+ Legg til regel';
        ny.addEventListener('click', () => {
            regler.push({
                Vilkar: { EllerAv: [{ OgAv: [{ Felt: egetFelt, Operator: '=', Verdi: '' }] }] },
                Melding: ''
            });
            ferdig();
            render();
        });
        wrap.appendChild(ny);

        container.appendChild(wrap);
    }

    function byggRegel(regel, i) {
        const div = document.createElement('div');
        div.style.cssText = 'padding: 8px 10px; border: 1px solid var(--border-color); border-radius: 6px; background: white; margin: 6px 0;';

        const topp = document.createElement('div');
        topp.style.cssText = 'display: flex; gap: 6px; align-items: center; margin-bottom: 6px;';

        const melding = document.createElement('input');
        melding.type = 'text';
        melding.style.cssText = 'flex: 1; padding: 4px 8px; font-size: 12px;';
        melding.placeholder = 'Melding når regelen ikke holder';
        melding.title = 'Dette er teksten den som fyller ut skjemaet får se. '
            + 'Skriv hva som MÅ være sant, ikke hva som er galt.';
        melding.value = regel.Melding || '';
        melding.addEventListener('input', () => {
            regel.Melding = melding.value;
            ferdig();
        });
        topp.appendChild(melding);

        const fjern = document.createElement('button');
        fjern.type = 'button';
        fjern.style.cssText = 'padding: 3px 8px; font-size: 12px; border: 1px solid var(--danger); background: transparent; color: var(--danger); border-radius: 4px; cursor: pointer;';
        fjern.textContent = '×';
        fjern.title = 'Fjern regel';
        fjern.addEventListener('click', () => {
            regler.splice(i, 1);
            ferdig();
            render();
        });
        topp.appendChild(fjern);
        div.appendChild(topp);

        const slot = document.createElement('div');
        div.appendChild(slot);
        byggDNFEditor(slot, regel.Vilkar, {
            modus: 'vilkår',
            feltOptions,
            høyresideFelt: true,
            tittel: 'Gyldig hvis',
            onEndring: (ny) => {
                if (ny) regel.Vilkar = ny; else delete regel.Vilkar;
                ferdig();
            }
        });

        return div;
    }

    render();
    return { destroy: () => { container.innerHTML = ''; } };
}
