/**
 * Tilgang-editor — gjenbrukbar chip-basert widget for tilgangsstrukturer
 * {Personer, Roller, Team}. Brukes for Publikum, Eiere og Behandlere.
 *
 * Bruk:
 *   const editor = byggTilgangEditor(container, verdi, {
 *       kompakt: false,           // true = mindre padding, mindre tekst
 *       onEndring: (ny) => { data.Publikum = ny; },
 *       rolleGrupper: [...]       // fra /api/roller/grupper (cachet)
 *   });
 *
 * Personer: fritt-tekst chip-liste (e-postadresser)
 * Roller:   dropdown fra rolleGrupper + chip-liste (format: "Rolle" eller "Rolle(Omfang)")
 * Team:     fritt-tekst chip-liste (kommer med Graph API — foreløpig manuell tekst)
 */

let _rolleGrupperCache = null;

export async function hentRolleGrupper(api) {
    if (_rolleGrupperCache) return _rolleGrupperCache;
    try {
        _rolleGrupperCache = await api.get('/api/roller/grupper');
    } catch (_) {
        _rolleGrupperCache = [];
    }
    return _rolleGrupperCache;
}

export function invaliderRolleCache() { _rolleGrupperCache = null; }

export function byggTilgangEditor(container, verdi, options = {}) {
    const kompakt = options.kompakt === true;
    const onEndring = options.onEndring || (() => {});
    const rolleGrupper = options.rolleGrupper || [];
    // visAlleTilgang: true → viser en 'Åpen for alle innloggede'-checkbox
    // øverst som overstyrer person/rolle/team-sjekker. Kun meningsfull for
    // Publikum-tilgang (ellers ville alle blitt eiere/behandlere).
    const visAlleTilgang = options.visAlleTilgang === true;

    // Kloningsstate — muter aldri innkommende
    let state = normaliserVerdi(verdi);

    function normaliserVerdi(v) {
        return {
            Personer: Array.isArray(v?.Personer) ? [...v.Personer].filter(Boolean) : [],
            Roller:   Array.isArray(v?.Roller)   ? [...v.Roller].filter(Boolean)   : [],
            Team:     Array.isArray(v?.Team)     ? [...v.Team].filter(Boolean)     : [],
            AlleTilgang: v?.AlleTilgang === true
        };
    }

    function rolleTilVisning(r) {
        // "Emneansvarlig(CBU2501)" → "Emneansvarlig — CBU2501"
        const m = /^(.+?)\((.+)\)$/.exec(String(r || '').trim());
        return m ? `${m[1].trim()} — ${m[2].trim()}` : String(r);
    }

    function grupperTilRolleStreng(g) {
        return g.Omfang ? `${g.Rolle}(${g.Omfang})` : g.Rolle;
    }

    function ferdig() { onEndring({ ...state }); }

    function render() {
        container.innerHTML = '';
        container.className = 'tilgang-editor';
        const wrap = document.createElement('div');
        wrap.style.cssText = 'display: flex; flex-direction: column; gap: 10px;';

        if (visAlleTilgang) {
            wrap.appendChild(byggAlleTilgangCheckbox());
        }

        const kroppen = document.createElement('div');
        kroppen.style.cssText = `display: flex; flex-direction: column; gap: 10px; ${state.AlleTilgang ? 'opacity: 0.4; pointer-events: none;' : ''}`;
        kroppen.appendChild(byggPersonerSeksjon());
        kroppen.appendChild(byggRollerSeksjon());
        kroppen.appendChild(byggTeamSeksjon());
        wrap.appendChild(kroppen);

        container.appendChild(wrap);
    }

    function byggAlleTilgangCheckbox() {
        const box = document.createElement('label');
        box.style.cssText = `display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid ${state.AlleTilgang ? 'var(--accent)' : 'var(--border-color)'}; border-radius: 8px; background: ${state.AlleTilgang ? 'var(--accent-light)' : 'transparent'}; cursor: pointer; font-size: ${kompakt ? '12px' : '13px'};`;
        const inp = document.createElement('input');
        inp.type = 'checkbox';
        inp.checked = state.AlleTilgang;
        inp.addEventListener('change', () => {
            state.AlleTilgang = inp.checked;
            ferdig();
            render();
        });
        const tekst = document.createElement('span');
        tekst.innerHTML = '<strong>Åpen for alle innloggede</strong> <span style="color: var(--text-secondary);">— overstyrer Personer/Roller/Team</span>';
        box.appendChild(inp);
        box.appendChild(tekst);
        return box;
    }

    // ==================== Personer ====================
    function byggPersonerSeksjon() {
        const sek = seksjon('Personer', '(e-postadresser)');
        sek.appendChild(byggChipListe('Personer', state.Personer, (verdi) => {
            const trimmet = String(verdi || '').trim().toLowerCase();
            if (!trimmet || state.Personer.includes(trimmet)) return false;
            state.Personer.push(trimmet);
            ferdig();
            return true;
        }, 'ola@example.no'));
        return sek;
    }

    // ==================== Roller ====================
    function byggRollerSeksjon() {
        const sek = seksjon('Roller', '(fra rolle-adm — henter innehavere dynamisk)');

        // Dropdown-velger
        const velger = document.createElement('div');
        velger.style.cssText = 'display: flex; gap: 6px; margin-bottom: 6px;';

        const sel = document.createElement('select');
        sel.style.cssText = 'flex: 1; padding: 4px 8px; font-size: 13px;';
        const tomOpt = document.createElement('option');
        tomOpt.value = '';
        tomOpt.textContent = rolleGrupper.length === 0 ? '(ingen roller registrert — bruk rolle-adm)' : '— velg rolle —';
        sel.appendChild(tomOpt);
        for (const g of rolleGrupper) {
            const rolleStr = grupperTilRolleStreng(g);
            if (state.Roller.includes(rolleStr)) continue;
            const o = document.createElement('option');
            o.value = rolleStr;
            o.textContent = rolleTilVisning(rolleStr);
            sel.appendChild(o);
        }
        sel.addEventListener('change', () => {
            const v = sel.value;
            if (v && !state.Roller.includes(v)) {
                state.Roller.push(v);
                ferdig();
                render();
            }
        });
        velger.appendChild(sel);
        sek.appendChild(velger);

        // Chip-liste for valgte roller
        sek.appendChild(byggChipListe('Roller', state.Roller, () => false, null, {
            visning: rolleTilVisning
        }));
        return sek;
    }

    // ==================== Team ====================
    function byggTeamSeksjon() {
        const sek = seksjon('Team', '(krever Graph API — foreløpig manuell tekst)');
        sek.appendChild(byggChipListe('Team', state.Team, (verdi) => {
            const trimmet = String(verdi || '').trim();
            if (!trimmet || state.Team.includes(trimmet)) return false;
            state.Team.push(trimmet);
            ferdig();
            return true;
        }, 'Teamnavn'));
        return sek;
    }

    // ==================== Bygg-helpere ====================
    function seksjon(tittel, hint) {
        const div = document.createElement('div');
        div.style.cssText = `padding: ${kompakt ? '6px 8px' : '8px 10px'}; border: 1px solid var(--border-color); border-radius: 8px; background: rgba(0,0,0,0.02);`;

        const h = document.createElement('div');
        h.style.cssText = `font-weight: 600; font-size: ${kompakt ? '11px' : '12px'}; margin-bottom: 6px;`;
        h.textContent = tittel;
        if (hint) {
            const s = document.createElement('span');
            s.style.cssText = 'font-weight: 400; color: var(--text-secondary); margin-left: 6px;';
            s.textContent = hint;
            h.appendChild(s);
        }
        div.appendChild(h);
        return div;
    }

    function byggChipListe(navn, liste, onLeggTil, placeholder, opts = {}) {
        const div = document.createElement('div');
        div.style.cssText = 'display: flex; flex-wrap: wrap; gap: 6px; align-items: center;';

        const visning = opts.visning || (x => x);

        for (let i = 0; i < liste.length; i++) {
            const chip = document.createElement('span');
            chip.style.cssText = `display: inline-flex; align-items: center; gap: 4px; padding: 3px 4px 3px 10px; background: var(--accent-light); color: var(--accent); border-radius: 12px; font-size: ${kompakt ? '11px' : '12px'};`;
            const t = document.createElement('span');
            t.textContent = visning(liste[i]);
            chip.appendChild(t);

            const fjern = document.createElement('button');
            fjern.type = 'button';
            fjern.textContent = '×';
            fjern.title = 'Fjern';
            fjern.style.cssText = 'border: none; background: transparent; color: inherit; cursor: pointer; padding: 0 4px; font-size: 14px; line-height: 1;';
            fjern.addEventListener('click', () => {
                liste.splice(i, 1);
                ferdig();
                render();
            });
            chip.appendChild(fjern);
            div.appendChild(chip);
        }

        if (placeholder !== null) {
            const inp = document.createElement('input');
            inp.type = 'text';
            inp.placeholder = placeholder;
            inp.style.cssText = `flex: 1; min-width: 140px; padding: 3px 8px; font-size: ${kompakt ? '12px' : '13px'}; border: 1px solid var(--input-border, #d1d1d6); border-radius: 6px;`;
            const forsokLeggTil = () => {
                const raw = inp.value;
                if (!raw.trim()) return;
                const deler = raw.split(/[,;\n]/).map(s => s.trim()).filter(Boolean);
                let noeLagtTil = false;
                for (const d of deler) if (onLeggTil(d)) noeLagtTil = true;
                if (noeLagtTil) render();
                else inp.value = '';
            };
            inp.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
                    e.preventDefault();
                    forsokLeggTil();
                }
            });
            inp.addEventListener('blur', forsokLeggTil);
            div.appendChild(inp);
        }

        return div;
    }

    render();
    return {
        oppdater: (nyVerdi) => { state = normaliserVerdi(nyVerdi); render(); },
        destroy: () => { container.innerHTML = ''; }
    };
}
