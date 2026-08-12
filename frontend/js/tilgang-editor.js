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
let _teamNavnCache = null;

export async function hentRolleGrupper(api) {
    if (_rolleGrupperCache) return _rolleGrupperCache;
    try {
        _rolleGrupperCache = await api.get('/api/roller/grupper');
    } catch (_) {
        _rolleGrupperCache = [];
    }
    return _rolleGrupperCache;
}

export async function hentTeamNavn(api) {
    if (_teamNavnCache) return _teamNavnCache;
    try {
        _teamNavnCache = await api.get('/api/cache/teammedlemskap/team-navn');
    } catch (_) {
        _teamNavnCache = [];
    }
    return _teamNavnCache;
}

export function invaliderRolleCache() { _rolleGrupperCache = null; }
export function invaliderTeamCache() { _teamNavnCache = null; }

export function byggTilgangEditor(container, verdi, options = {}) {
    const kompakt = options.kompakt === true;
    const onEndring = options.onEndring || (() => {});
    const rolleGrupper = options.rolleGrupper || [];
    const teamNavn = options.teamNavn || [];
    const api = options.api || null; // brukes for Søk eksternt-flyten
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

        const tilgjengelige = rolleGrupper
            .map(g => ({ verdi: grupperTilRolleStreng(g), visning: rolleTilVisning(grupperTilRolleStreng(g)) }))
            .filter(o => !state.Roller.includes(o.verdi));
        const placeholder = rolleGrupper.length === 0
            ? '(ingen roller registrert — bruk rolle-adm)'
            : 'Søk og velg rolle…';
        sek.appendChild(byggSokDropdown({
            placeholder,
            alternativer: tilgjengelige,
            onVelg: (v) => {
                if (!state.Roller.includes(v)) {
                    state.Roller.push(v);
                    ferdig();
                    render();
                }
            }
        }));

        // Chip-liste for valgte roller
        sek.appendChild(byggChipListe('Roller', state.Roller, () => false, null, {
            visning: rolleTilVisning
        }));
        return sek;
    }

    // ==================== Team ====================
    function byggTeamSeksjon() {
        const sek = seksjon('Team', '(fra Teammedlemskap-cache — oppdatert av PA-flyt)');

        const velger = document.createElement('div');
        velger.style.cssText = 'display: flex; gap: 6px; margin-bottom: 6px;';

        const tilgjengelige = teamNavn
            .filter(t => !state.Team.includes(t))
            .map(t => ({ verdi: t, visning: t }));
        const placeholder = teamNavn.length === 0
            ? '(ingen team i cachen — søk eksternt)'
            : 'Søk og velg team…';

        const dropdown = byggSokDropdown({
            placeholder,
            alternativer: tilgjengelige,
            onVelg: (v) => {
                if (!state.Team.includes(v)) {
                    state.Team.push(v);
                    ferdig();
                    render();
                }
            }
        });
        dropdown.style.flex = '1';
        velger.appendChild(dropdown);

        if (api) {
            const sokBtn = document.createElement('button');
            sokBtn.type = 'button';
            sokBtn.textContent = 'Søk eksternt…';
            sokBtn.style.cssText = 'padding: 4px 10px; font-size: 12px; border: 1px solid var(--accent); background: transparent; color: var(--accent); border-radius: 4px; cursor: pointer;';
            sokBtn.title = 'Søk i Graph og last team-medlemmer inn i cachen';
            sokBtn.addEventListener('click', () => sokEksterntTeam(sokBtn));
            velger.appendChild(sokBtn);
        }
        sek.appendChild(velger);

        sek.appendChild(byggChipListe('Team', state.Team, () => false, null));
        return sek;
    }

    // ==================== Søkbar dropdown ====================
    // Gjenbrukbar helper: input-felt som viser filtrerbar liste under.
    // { placeholder, alternativer: [{verdi, visning}], onVelg(verdi) }
    function byggSokDropdown({ placeholder, alternativer, onVelg }) {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'position: relative;';

        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = placeholder || 'Søk…';
        input.style.cssText = `width: 100%; padding: 4px 8px; font-size: 13px; border: 1px solid var(--input-border, #d1d1d6); border-radius: 6px; box-sizing: border-box;`;
        input.readOnly = alternativer.length === 0;
        wrap.appendChild(input);

        const liste = document.createElement('div');
        liste.style.cssText = `position: absolute; top: 100%; left: 0; right: 0; z-index: 100;
            background: var(--bg-input, white); border: 1px solid var(--input-border, #d1d1d6);
            border-radius: 6px; max-height: 240px; overflow-y: auto; display: none;
            box-shadow: 0 4px 12px rgba(0,0,0,0.08); margin-top: 2px;`;
        wrap.appendChild(liste);

        function renderListe() {
            const q = input.value.trim().toLowerCase();
            const filtrert = q
                ? alternativer.filter(a => a.visning.toLowerCase().includes(q))
                : alternativer;
            liste.innerHTML = '';
            if (filtrert.length === 0) {
                const tom = document.createElement('div');
                tom.style.cssText = 'padding: 8px 10px; color: var(--text-secondary); font-size: 12px; font-style: italic;';
                tom.textContent = q ? 'Ingen treff.' : '(tom)';
                liste.appendChild(tom);
                return;
            }
            for (const a of filtrert.slice(0, 100)) {
                const rad = document.createElement('div');
                rad.textContent = a.visning;
                rad.style.cssText = 'padding: 6px 10px; font-size: 13px; cursor: pointer;';
                rad.addEventListener('mouseenter', () => { rad.style.background = 'var(--accent-light)'; });
                rad.addEventListener('mouseleave', () => { rad.style.background = ''; });
                rad.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    liste.style.display = 'none';
                    onVelg(a.verdi);
                });
                liste.appendChild(rad);
            }
        }

        input.addEventListener('focus', () => {
            renderListe();
            liste.style.display = 'block';
        });
        input.addEventListener('input', () => {
            renderListe();
            liste.style.display = 'block';
        });
        input.addEventListener('blur', () => {
            // Kort delay så mousedown på rad rekker å registrere
            setTimeout(() => { liste.style.display = 'none'; }, 150);
        });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { input.blur(); }
        });

        return wrap;
    }

    async function sokEksterntTeam(knapp) {
        const sok = prompt('Skriv team-navn eller del av navn å søke etter i Graph:');
        if (!sok || !sok.trim()) return;
        const opprinneligTekst = knapp.textContent;
        knapp.textContent = 'Søker…';
        knapp.disabled = true;
        try {
            const treff = await api.post('/api/team/sok-eksternt', { sok: sok.trim() });
            if (!Array.isArray(treff) || treff.length === 0) {
                alert('Ingen treff.');
                return;
            }
            const linjer = treff.map((t, i) => `${i + 1}. ${t.DisplayName || t.navn || t.Navn || t.Id}`).join('\n');
            const valg = prompt(`Fant ${treff.length} team. Skriv nummeret på det du vil laste inn:\n\n${linjer}`);
            const idx = Number(valg) - 1;
            if (!(idx >= 0 && idx < treff.length)) return;
            const valgtTeam = treff[idx];
            const teamId = valgtTeam.Id || valgtTeam.id || '';
            const teamNavnValgt = valgtTeam.DisplayName || valgtTeam.navn || valgtTeam.Navn || '';
            knapp.textContent = 'Laster medlemmer…';
            const res = await api.post('/api/team/last-medlemmer', { teamId, teamNavn: teamNavnValgt });
            invaliderTeamCache();
            const nye = await hentTeamNavn(api);
            teamNavn.length = 0;
            teamNavn.push(...nye);
            if (!state.Team.includes(res.Team)) state.Team.push(res.Team);
            ferdig();
            render();
            alert(`Lastet ${res.antallMedlemmer} medlemmer for "${res.Team}".`);
        } catch (e) {
            alert('Feil: ' + e.message);
        } finally {
            knapp.textContent = opprinneligTekst;
            knapp.disabled = false;
        }
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
