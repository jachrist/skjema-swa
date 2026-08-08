/**
 * Melding-editor — gjenbrukbar modal for HTML-meldinger med plassholdere.
 *
 * Brukes til:
 *   Innsenderkvittering, TilBehandler (per steg), FraBehandler (per beslutningsvalg)
 *
 * Struktur:
 *   { Emne, Tekst, Format? }   Format defaultes til 'HTML'
 *
 * Bruk:
 *   const ny = await apneMeldingModal(mal, {
 *       tittel: 'Melding til behandler',
 *       forslag: {Emne, Tekst},                 // default hvis mal er tom
 *       plassholdere: [{navn, tekst?}, ...],     // vises som chips
 *       feltreferanser: [{ref, tekst}, ...]      // dropdown
 *   });
 *   // returnerer { Emne, Tekst, Format } eller null hvis avbrutt
 */

const STANDARD_PLASSHOLDERE = [
    { navn: '$lenke',           tekst: 'Lenke til skjemaet' },
    { navn: '$skjemanavn',      tekst: 'Skjematype-navn' },
    { navn: '$skjema_id',       tekst: 'Skjema-ID' },
    { navn: '$innsender',       tekst: 'Innsender e-post' },
    { navn: '$innsender_navn',  tekst: 'Innsender-navn' },
    { navn: '$stegnavn',        tekst: 'Steg-navn (per steg)' },
    { navn: '$rolle',           tekst: 'Rolle(r) på steget' },
    { navn: '$beslutning',      tekst: 'Beslutning (i FraBehandler)' },
    { navn: '$kommentar',       tekst: 'Behandler-kommentar' },
    { navn: '$navn',            tekst: 'Mottaker-navn' },
    { navn: '$tidspunkt',       tekst: 'Dato/tid' },
    { navn: '$frist',           tekst: 'Frist-dato' },
    { navn: '$dagerTilFrist',   tekst: 'Dager til frist' }
];

/**
 * Åpne modal for å redigere en melding. Returnerer Promise<{Emne,Tekst,Format}|null>.
 */
export function apneMeldingModal(mal, options = {}) {
    return new Promise(resolve => {
        const tittel = options.tittel || 'Rediger melding';
        const forslag = options.forslag || { Emne: '', Tekst: '' };
        const plassholdere = options.plassholdere || STANDARD_PLASSHOLDERE;
        const feltreferanser = options.feltreferanser || [];

        const startEmne = mal?.Emne || '';
        const startTekst = mal?.Tekst || '';

        // Bygg DOM
        const bakgrunn = document.createElement('div');
        bakgrunn.className = 'meldingsmodal-bakgrunn';
        bakgrunn.innerHTML = `
            <div class="meldingsmodal-boks">
                <div class="meldingsmodal-topp">
                    <h3 class="meldingsmodal-tittel"></h3>
                    <button class="meldingsmodal-lukk" title="Avbryt (Esc)">✕</button>
                </div>

                <label class="meldingsmodal-label">Emne <small>(én linje — plassholdere støttes)</small></label>
                <input type="text" class="meldingsmodal-emne" placeholder="Emne-linje">

                <label class="meldingsmodal-label">Melding</label>
                <div class="meldingsmodal-toolbar">
                    <button data-cmd="bold" title="Fet">B</button>
                    <button data-cmd="italic" title="Kursiv">I</button>
                    <button data-cmd="underline" title="Understreket">U</button>
                    <span class="meldingsmodal-sep"></span>
                    <button data-cmd="insertUnorderedList" title="Punktliste">•</button>
                    <button data-cmd="insertOrderedList" title="Nummerert liste">1.</button>
                    <button data-cmd="lenke" title="Sett inn lenke">🔗</button>
                    <span class="meldingsmodal-sep"></span>
                    <button data-cmd="html-toggle" title="Vis/rediger HTML-kilde">&lt;/&gt;</button>
                </div>
                <div class="meldingsmodal-body" contenteditable="true"></div>
                <textarea class="meldingsmodal-html" style="display: none;"></textarea>

                <label class="meldingsmodal-label" style="margin-top: 12px;">Plassholdere <small>(klikk for å sette inn)</small></label>
                <div class="meldingsmodal-chips"></div>

                <div class="meldingsmodal-feltref" style="margin-top: 10px;">
                    <label class="meldingsmodal-label">Feltreferanse <small>(hentes fra svar ved sending)</small></label>
                    <select class="meldingsmodal-feltdropdown">
                        <option value="">— velg felt —</option>
                    </select>
                </div>

                <div class="meldingsmodal-knapper">
                    <button class="modal-knapp" data-svar="avbryt">Avbryt</button>
                    <button class="modal-knapp" data-svar="tom">Bruk standard</button>
                    <button class="modal-knapp primær" data-svar="lagre">Lagre</button>
                </div>
            </div>
        `;
        document.body.appendChild(bakgrunn);

        const boks = bakgrunn.querySelector('.meldingsmodal-boks');
        boks.querySelector('.meldingsmodal-tittel').textContent = tittel;
        const emneInp = boks.querySelector('.meldingsmodal-emne');
        const body = boks.querySelector('.meldingsmodal-body');
        const htmlArea = boks.querySelector('.meldingsmodal-html');
        const chipsDiv = boks.querySelector('.meldingsmodal-chips');
        const feltDropdown = boks.querySelector('.meldingsmodal-feltdropdown');
        const feltrefWrap = boks.querySelector('.meldingsmodal-feltref');

        emneInp.value = startEmne || forslag.Emne || '';
        body.innerHTML = startTekst || forslag.Tekst || '';

        let modus = 'wysiwyg'; // 'wysiwyg' | 'html'

        // Plassholder-chips
        for (const p of plassholdere) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'meldingsmodal-chip';
            chip.textContent = p.navn;
            chip.title = p.tekst || '';
            chip.addEventListener('click', () => settInn(p.navn));
            chipsDiv.appendChild(chip);
        }

        // Feltreferanse-dropdown
        if (feltreferanser.length > 0) {
            for (const f of feltreferanser) {
                const o = document.createElement('option');
                o.value = f.ref;
                o.textContent = f.tekst;
                feltDropdown.appendChild(o);
            }
            feltDropdown.addEventListener('change', () => {
                const v = feltDropdown.value;
                if (v) {
                    settInn(`{${v}}`);
                    feltDropdown.value = '';
                }
            });
        } else {
            feltrefWrap.style.display = 'none';
        }

        // Sette inn tekst der markøren står — i body eller emne alt etter fokus
        let sistFokusertElement = body;
        emneInp.addEventListener('focus', () => { sistFokusertElement = emneInp; });
        body.addEventListener('focus', () => { sistFokusertElement = body; });

        function settInn(tekst) {
            if (modus === 'html') {
                // Sett inn i html-textarea på markørposisjon
                const t = htmlArea;
                const start = t.selectionStart, slutt = t.selectionEnd;
                t.value = t.value.slice(0, start) + tekst + t.value.slice(slutt);
                t.selectionStart = t.selectionEnd = start + tekst.length;
                t.focus();
                return;
            }
            if (sistFokusertElement === emneInp) {
                const start = emneInp.selectionStart ?? emneInp.value.length;
                const slutt = emneInp.selectionEnd ?? start;
                emneInp.value = emneInp.value.slice(0, start) + tekst + emneInp.value.slice(slutt);
                emneInp.selectionStart = emneInp.selectionEnd = start + tekst.length;
                emneInp.focus();
                return;
            }
            body.focus();
            document.execCommand('insertText', false, tekst);
        }

        // Toolbar
        boks.querySelectorAll('.meldingsmodal-toolbar button').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const cmd = btn.dataset.cmd;
                if (cmd === 'html-toggle') {
                    if (modus === 'wysiwyg') {
                        htmlArea.value = body.innerHTML;
                        htmlArea.style.display = 'block';
                        body.style.display = 'none';
                        modus = 'html';
                    } else {
                        body.innerHTML = htmlArea.value;
                        body.style.display = '';
                        htmlArea.style.display = 'none';
                        modus = 'wysiwyg';
                    }
                    return;
                }
                if (cmd === 'lenke') {
                    const url = prompt('URL:', 'https://');
                    if (url) {
                        body.focus();
                        document.execCommand('createLink', false, url);
                    }
                    return;
                }
                body.focus();
                document.execCommand(cmd, false, null);
            });
        });

        // Knapper
        const lukk = (svar) => {
            document.body.removeChild(bakgrunn);
            document.removeEventListener('keydown', escLytter);
            if (svar === 'lagre') {
                const html = modus === 'html' ? htmlArea.value : body.innerHTML;
                resolve({
                    Emne: emneInp.value.trim(),
                    Tekst: html.trim(),
                    Format: 'HTML'
                });
            } else if (svar === 'tom') {
                resolve({ Emne: '', Tekst: '', Format: 'HTML' }); // signaliserer "bruk standard" (bakenden fyller inn)
            } else {
                resolve(null);
            }
        };
        boks.querySelectorAll('button[data-svar]').forEach(b => {
            b.addEventListener('click', () => lukk(b.dataset.svar));
        });
        boks.querySelector('.meldingsmodal-lukk').addEventListener('click', () => lukk('avbryt'));
        bakgrunn.addEventListener('click', (e) => { if (e.target === bakgrunn) lukk('avbryt'); });

        function escLytter(e) {
            if (e.key === 'Escape') lukk('avbryt');
        }
        document.addEventListener('keydown', escLytter);

        setTimeout(() => emneInp.focus(), 50);
    });
}

/**
 * Bygg liste over feltreferanser for melding-editoren fra skjematype-data.
 * Returnerer [{ref, tekst}] hvor ref er '1-02' eller UUID (foretrekker UUID hvis satt).
 */
export function samleFeltreferanser(data) {
    const out = [];
    const seksjoner = data?.Seksjoner || [];
    for (const s of seksjoner) {
        const seksjonNr = s.Seksjon_nummer;
        for (const f of (s.Felter || [])) {
            if (f.Type === 'Informasjon') continue;
            const feltNr = String(f.Nummer).padStart(2, '0');
            const label = `${seksjonNr}-${feltNr}: ${f.Tekst?.Verdi || '(uten tittel)'}`;
            // Foretrekker UUID hvis satt
            const ref = f.Id || `${seksjonNr}-${feltNr}`;
            out.push({ ref, tekst: label });
        }
    }
    return out;
}
