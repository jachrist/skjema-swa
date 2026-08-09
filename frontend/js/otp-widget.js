/**
 * OTP-widget — gjenbrukbar modal for engangskode-verifisering.
 *
 * Bruk:
 *   const resultat = await apneOtpModal({
 *       tittel: 'Verifiser mobilnummer',
 *       tekst: 'Vi sender en 6-sifret kode til...',
 *       kanaler: ['sms', 'epost']    // eller ['sms']
 *   });
 *   // resultat = { verifikasjonstoken, kanal, mottaker } eller null hvis avbrutt
 *
 * Krever at OTP-endepunktene er anonym-tilgjengelige (staticwebapp.config.json).
 */

export function apneOtpModal(options = {}) {
    return new Promise(resolve => {
        const tittel = options.tittel || 'Verifiser med engangskode';
        const tekst = options.tekst || 'Vi sender en kode du må skrive inn for å bekrefte at du eier denne kontakten.';
        const kanaler = (options.kanaler && options.kanaler.length) ? options.kanaler : ['sms', 'epost'];

        const bakgrunn = document.createElement('div');
        bakgrunn.className = 'otp-modal-bakgrunn';
        bakgrunn.innerHTML = `
            <div class="otp-modal-boks">
                <div class="otp-modal-topp">
                    <h3></h3>
                    <button class="otp-modal-lukk" title="Avbryt">✕</button>
                </div>
                <p class="otp-modal-tekst"></p>

                <div class="otp-skjerm otp-mottaker-skjerm">
                    <label class="otp-label">Kanal</label>
                    <div class="otp-kanaler"></div>
                    <label class="otp-label" id="otp-mottaker-label">Mottaker</label>
                    <input type="text" class="otp-mottaker" placeholder="">
                    <div class="otp-feilmelding" id="otp-mottaker-feil"></div>
                    <div class="otp-knapper">
                        <button class="otp-knapp" data-svar="avbryt">Avbryt</button>
                        <button class="otp-knapp primær" id="otp-send">Send kode</button>
                    </div>
                </div>

                <div class="otp-skjerm otp-kode-skjerm" style="display: none;">
                    <p class="otp-info">Vi sendte en 6-sifret kode til <span id="otp-mottaker-visning"></span>.</p>
                    <label class="otp-label">Kode</label>
                    <input type="text" class="otp-kode" maxlength="6" pattern="[0-9]{6}" inputmode="numeric" autocomplete="one-time-code">
                    <div class="otp-feilmelding" id="otp-kode-feil"></div>
                    <div class="otp-knapper">
                        <button class="otp-knapp" data-svar="tilbake">Tilbake</button>
                        <button class="otp-knapp primær" id="otp-verifiser">Verifiser</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(bakgrunn);

        const boks = bakgrunn.querySelector('.otp-modal-boks');
        boks.querySelector('h3').textContent = tittel;
        boks.querySelector('.otp-modal-tekst').textContent = tekst;

        const kanalerDiv = boks.querySelector('.otp-kanaler');
        for (const k of kanaler) {
            const label = document.createElement('label');
            label.className = 'otp-kanal';
            label.innerHTML = `<input type="radio" name="otp-kanal" value="${k}"> ${k === 'sms' ? 'SMS' : 'E-post'}`;
            kanalerDiv.appendChild(label);
        }
        // Velg første som default
        const førsteRadio = kanalerDiv.querySelector('input[type="radio"]');
        if (førsteRadio) førsteRadio.checked = true;

        const mottakerInp = boks.querySelector('.otp-mottaker');
        const mottakerLabel = boks.querySelector('#otp-mottaker-label');
        const mottakerFeil = boks.querySelector('#otp-mottaker-feil');
        const kodeInp = boks.querySelector('.otp-kode');
        const kodeFeil = boks.querySelector('#otp-kode-feil');
        const mottakerSkjerm = boks.querySelector('.otp-mottaker-skjerm');
        const kodeSkjerm = boks.querySelector('.otp-kode-skjerm');

        function oppdaterPlaceholder() {
            const kanal = boks.querySelector('input[name="otp-kanal"]:checked')?.value;
            if (kanal === 'sms') {
                mottakerLabel.textContent = 'Mobilnummer';
                mottakerInp.type = 'tel';
                mottakerInp.placeholder = '+47 41234567';
                mottakerInp.autocomplete = 'tel';
            } else {
                mottakerLabel.textContent = 'E-postadresse';
                mottakerInp.type = 'email';
                mottakerInp.placeholder = 'ola@example.no';
                mottakerInp.autocomplete = 'email';
            }
        }
        kanalerDiv.querySelectorAll('input[type="radio"]').forEach(r =>
            r.addEventListener('change', oppdaterPlaceholder)
        );
        oppdaterPlaceholder();

        let valgtKanal = null;
        let valgtMottaker = null;

        const sendKnapp = boks.querySelector('#otp-send');
        const verifiserKnapp = boks.querySelector('#otp-verifiser');

        function visFeil(el, tekst) { el.textContent = tekst; el.style.display = tekst ? '' : 'none'; }

        async function sendKode() {
            visFeil(mottakerFeil, '');
            const kanal = boks.querySelector('input[name="otp-kanal"]:checked')?.value;
            const mottaker = mottakerInp.value.trim();
            if (!mottaker) { visFeil(mottakerFeil, 'Fyll inn mottaker'); return; }
            sendKnapp.disabled = true;
            sendKnapp.textContent = 'Sender…';
            try {
                const res = await fetch('/api/otp/be-om-kode', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ kanal, mottaker })
                });
                await res.json();
                // Anti-enumerasjon: server sier alltid ok — men vi går til kode-skjerm uansett
                valgtKanal = kanal;
                valgtMottaker = mottaker;
                boks.querySelector('#otp-mottaker-visning').textContent = maskert(kanal, mottaker);
                mottakerSkjerm.style.display = 'none';
                kodeSkjerm.style.display = '';
                setTimeout(() => kodeInp.focus(), 50);
            } catch (e) {
                visFeil(mottakerFeil, 'Nettverksfeil: ' + e.message);
            } finally {
                sendKnapp.disabled = false;
                sendKnapp.textContent = 'Send kode';
            }
        }

        async function verifiser() {
            visFeil(kodeFeil, '');
            const kode = kodeInp.value.trim();
            if (!/^\d{6}$/.test(kode)) { visFeil(kodeFeil, 'Koden må være 6 sifre'); return; }
            verifiserKnapp.disabled = true;
            verifiserKnapp.textContent = 'Verifiserer…';
            try {
                const res = await fetch('/api/otp/verifiser-kode', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ kanal: valgtKanal, mottaker: valgtMottaker, kode })
                });
                const data = await res.json();
                if (data.status === 'ok') {
                    lukk({ verifikasjonstoken: data.verifikasjonstoken, kanal: valgtKanal, mottaker: valgtMottaker });
                    return;
                }
                const feilmap = {
                    'feil-kode': `Feil kode. ${data.forsok_igjen != null ? `Forsøk igjen: ${data.forsok_igjen}` : ''}`,
                    'utlopt': 'Koden er utløpt — be om ny.',
                    'blokkert': 'For mange feilforsøk — be om ny kode.'
                };
                visFeil(kodeFeil, feilmap[data.status] || 'Feil ved verifisering');
            } catch (e) {
                visFeil(kodeFeil, 'Nettverksfeil: ' + e.message);
            } finally {
                verifiserKnapp.disabled = false;
                verifiserKnapp.textContent = 'Verifiser';
            }
        }

        function tilbake() {
            kodeSkjerm.style.display = 'none';
            mottakerSkjerm.style.display = '';
            kodeInp.value = '';
            visFeil(kodeFeil, '');
        }

        function lukk(resultat) {
            document.body.removeChild(bakgrunn);
            resolve(resultat || null);
        }

        sendKnapp.addEventListener('click', sendKode);
        verifiserKnapp.addEventListener('click', verifiser);
        boks.querySelectorAll('button[data-svar]').forEach(b => {
            b.addEventListener('click', () => {
                if (b.dataset.svar === 'tilbake') tilbake();
                else lukk(null);
            });
        });
        boks.querySelector('.otp-modal-lukk').addEventListener('click', () => lukk(null));
        bakgrunn.addEventListener('click', (e) => { if (e.target === bakgrunn) lukk(null); });

        // Enter i input
        mottakerInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendKode(); });
        kodeInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') verifiser(); });

        setTimeout(() => mottakerInp.focus(), 50);
    });
}

function maskert(kanal, mottaker) {
    if (kanal === 'sms') {
        return mottaker.length > 4 ? '****' + mottaker.slice(-4) : mottaker;
    }
    const parts = String(mottaker).split('@');
    if (parts.length !== 2) return mottaker;
    return parts[0].slice(0, 2) + '***@' + parts[1];
}

/**
 * Injiser standard-stiler for widget-en. Kall én gang, evt. legg i en delt CSS-fil.
 * For enkelhet: pilot-versjon inline-legger stilen første gang widget åpnes.
 */
let _stilerLagtTil = false;
function sikreStiler() {
    if (_stilerLagtTil) return;
    _stilerLagtTil = true;
    const s = document.createElement('style');
    s.textContent = `
        .otp-modal-bakgrunn { position: fixed; inset: 0; background: rgba(0,0,0,0.45); display: flex; align-items: center; justify-content: center; z-index: 10000; padding: 20px; }
        .otp-modal-boks { background: var(--bg-container, white); color: var(--text-primary, #1c1c1e); border: 1px solid var(--border-color, rgba(0,0,0,0.1)); border-radius: 14px; padding: 20px 24px; width: 100%; max-width: 420px; box-shadow: 0 12px 40px rgba(0,0,0,0.25); }
        .otp-modal-topp { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
        .otp-modal-topp h3 { margin: 0; font-size: 17px; font-weight: 600; }
        .otp-modal-lukk { background: transparent; border: none; font-size: 20px; cursor: pointer; color: var(--text-secondary, #666); padding: 0 6px; }
        .otp-modal-tekst { margin: 0 0 14px 0; font-size: 13px; color: var(--text-secondary, #666); line-height: 1.5; }
        .otp-label { display: block; font-size: 12px; font-weight: 600; margin: 10px 0 4px; }
        .otp-modal-boks input[type="text"], .otp-modal-boks input[type="tel"], .otp-modal-boks input[type="email"] { width: 100%; padding: 8px 10px; font-size: 14px; border: 1px solid var(--input-border, #d1d1d6); border-radius: 6px; background: var(--bg-input, white); color: inherit; box-sizing: border-box; }
        .otp-kanaler { display: flex; gap: 8px; margin-bottom: 4px; }
        .otp-kanal { display: inline-flex; align-items: center; gap: 4px; padding: 4px 12px; font-size: 13px; border: 1px solid var(--border-color, rgba(0,0,0,0.1)); border-radius: 999px; cursor: pointer; }
        .otp-kanal input { margin: 0; }
        .otp-feilmelding { font-size: 12px; color: var(--danger, #d9534f); margin-top: 4px; min-height: 16px; }
        .otp-knapper { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
        .otp-knapp { padding: 8px 16px; border-radius: 6px; border: 1px solid var(--input-border, #d1d1d6); background: var(--bg-input, white); color: inherit; font-size: 14px; cursor: pointer; }
        .otp-knapp.primær { background: var(--accent, #0a84ff); color: white; border-color: var(--accent, #0a84ff); }
        .otp-knapp:disabled { opacity: 0.5; cursor: not-allowed; }
        .otp-info { font-size: 13px; color: var(--text-secondary, #666); margin: 8px 0 0; }
        .otp-kode { font-size: 20px !important; letter-spacing: 4px; text-align: center; font-family: 'SF Mono', Menlo, monospace; }
    `;
    document.head.appendChild(s);
}

// Sikre stiler lastes ved modul-import
sikreStiler();
