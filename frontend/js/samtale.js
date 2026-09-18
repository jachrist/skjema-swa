/**
 * Samtale — gruppechat mellom innsender og behandlere på én sak.
 *
 * Bruk:
 *   const s = byggSamtale(container, { api, skjematypeId, skjemaId, infotekst });
 *   s.start();     // henter og begynner å polle
 *   s.stopp();     // MÅ kalles når siden/panelet forlates
 *
 * Alt en deltaker skriver, ser alle deltakerne. Det finnes ingen intern-modus
 * her — se docs/FASE-SAMTALE.md. Widgeten har derfor ingen synlighetsvelger,
 * og det er med vilje: finnes den ikke, kan ingen tro at de er i den.
 *
 * SANNTID FINNES IKKE. SWA Managed Functions har hverken WebSockets eller
 * SignalR, så dette er polling. `etter`-parameteren gjør at vi bare henter det
 * som har kommet siden sist, ikke hele tråden hvert intervall.
 */
import { escapeHtml } from './felt-render.js';

const INTERVALL_MS = 12000;

/** Hvor lenge vi venter ekstra etter en feil, og hvor lenge vi gir opp å øke. */
const FEIL_MAKS_MS = 120000;

function tid(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const idag = new Date().toDateString() === d.toDateString();
    return d.toLocaleString('no-NO', idag
        ? { hour: '2-digit', minute: '2-digit' }
        : { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function avsenderNavn(i) {
    return i.AvsenderNavn || i.Avsender || '–';
}

export function byggSamtale(container, { api, skjematypeId, skjemaId, infotekst = '', megId = '' } = {}) {
    const base = `/api/skjemaer/${encodeURIComponent(skjematypeId)}/${encodeURIComponent(skjemaId)}/samtale`;

    let innlegg = [];
    let sisteId = '';
    let tilstand = { synlig: false, apen: false, kanSkrive: false, kanDempe: false, dempet: false, antallInnlegg: 0 };
    let timer = null;
    let ventMs = INTERVALL_MS;
    let sender = false;
    let stoppet = false;

    container.classList.add('samtale');
    container.innerHTML = '';

    // ---------- tegning ----------

    function tegn() {
        if (!tilstand.synlig) { container.hidden = true; container.innerHTML = ''; return; }
        container.hidden = false;

        const utkast = container.querySelector('.samtale-felt')?.value || '';
        const varVedBunn = erVedBunn();

        container.innerHTML = `
            <div class="samtale-topp">
                <h3 class="samtale-tittel">Samtale</h3>
                ${tilstand.kanDempe ? `
                    <label class="samtale-demp">
                        <input type="checkbox" class="samtale-demp-boks" ${tilstand.dempet ? 'checked' : ''}>
                        Demp varsling for denne saken
                    </label>` : ''}
            </div>
            ${!tilstand.apen ? `
                <p class="samtale-lukket">Saken er ferdigbehandlet, og samtalen er lukket for nye innlegg.
                Den følger saken i PDF-en.</p>` : ''}
            <div class="samtale-liste" role="log" aria-live="polite">
                ${innlegg.length === 0
                    ? '<p class="samtale-tom">Ingen innlegg ennå.</p>'
                    : innlegg.map(tegnInnlegg).join('')}
            </div>
            ${tilstand.kanSkrive ? `
                ${infotekst ? `<p class="samtale-info">${escapeHtml(infotekst)}</p>` : ''}
                <div class="samtale-skriv">
                    <textarea class="samtale-felt" rows="3"
                        placeholder="Skriv et innlegg…" aria-label="Nytt innlegg"></textarea>
                    <div class="samtale-knapperad">
                        <span class="samtale-status" role="status"></span>
                        <button type="button" class="samtale-send">Send</button>
                    </div>
                </div>` : ''}
        `;

        const felt = container.querySelector('.samtale-felt');
        if (felt) {
            felt.value = utkast;
            // Ctrl/Cmd+Enter sender. Enter alene gjør linjeskift — et innlegg
            // kan ikke redigeres etterpå, så det skal koste et bevisst trykk.
            felt.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
            });
            container.querySelector('.samtale-send').addEventListener('click', send);
        }
        const demp = container.querySelector('.samtale-demp-boks');
        if (demp) demp.addEventListener('change', () => settDemping(demp.checked));

        // Bare rull ned hvis brukeren allerede var nederst. Ellers river vi
        // dem bort fra det de leser, hvert tolvte sekund.
        if (varVedBunn) tilBunn();
    }

    function tegnInnlegg(i) {
        const meg = megId && String(i.Avsender).toLowerCase() === String(megId).toLowerCase();
        return `
            <div class="samtale-innlegg${meg ? ' meg' : ''}">
                <div class="samtale-hode">
                    <span class="samtale-avsender">${escapeHtml(avsenderNavn(i))}</span>
                    <span class="samtale-tid">${escapeHtml(tid(i.Dato))}</span>
                </div>
                <div class="samtale-tekst">${escapeHtml(i.Tekst || '')}</div>
            </div>`;
    }

    function liste() { return container.querySelector('.samtale-liste'); }

    function erVedBunn() {
        const l = liste();
        if (!l) return true;
        return l.scrollHeight - l.scrollTop - l.clientHeight < 40;
    }

    function tilBunn() {
        const l = liste();
        if (l) l.scrollTop = l.scrollHeight;
    }

    function status(tekst, feil = false) {
        const s = container.querySelector('.samtale-status');
        if (!s) return;
        s.textContent = tekst;
        s.classList.toggle('feil', !!feil);
    }

    // ---------- data ----------

    async function hent() {
        const url = sisteId ? `${base}?etter=${encodeURIComponent(sisteId)}` : base;
        const svar = await api.get(url);

        tilstand = {
            synlig: !!svar.synlig, apen: !!svar.apen, kanSkrive: !!svar.kanSkrive,
            kanDempe: !!svar.kanDempe, dempet: !!svar.dempet,
            antallInnlegg: Number(svar.antallInnlegg || 0)
        };

        const nye = Array.isArray(svar.innlegg) ? svar.innlegg : [];
        // Med `etter` er svaret bare det nye; uten er det hele tråden.
        innlegg = sisteId ? innlegg.concat(nye) : nye;
        if (innlegg.length > 0) sisteId = innlegg[innlegg.length - 1].Id;
        return nye.length;
    }

    async function send() {
        const felt = container.querySelector('.samtale-felt');
        const tekst = (felt?.value || '').trim();
        if (!tekst || sender) return;

        sender = true;
        const knapp = container.querySelector('.samtale-send');
        if (knapp) knapp.disabled = true;
        status('Sender…');
        try {
            await api.post(base, { tekst });
            if (felt) felt.value = '';
            status('');
            // Hent med en gang, så innlegget dukker opp uten å vente på neste
            // polling-runde.
            await hent();
            tegn();
            tilBunn();
        } catch (e) {
            // Teksten blir stående i feltet. Å tømme det ved feil er å slette
            // noe brukeren har skrevet.
            status(e?.message || 'Kunne ikke sende innlegget', true);
        } finally {
            sender = false;
            const k = container.querySelector('.samtale-send');
            if (k) k.disabled = false;
        }
    }

    async function settDemping(dempet) {
        try {
            const svar = await api.post(`${base}/demping`, { dempet });
            tilstand.dempet = !!svar.dempet;
        } catch (_) {
            // Sett haken tilbake — ellers tror brukeren at varslingen er
            // dempet mens den ikke er det, og det er den feilen som gjør at
            // en sak blir stående.
            const boks = container.querySelector('.samtale-demp-boks');
            if (boks) boks.checked = !dempet;
            status('Kunne ikke lagre innstillingen', true);
        }
    }

    // ---------- polling ----------

    function planlegg() {
        if (stoppet) return;
        clearTimeout(timer);
        timer = setTimeout(runde, ventMs);
    }

    async function runde() {
        if (stoppet) return;
        // Ingen grunn til å spørre mens fanen ligger i bakgrunnen. Nettleseren
        // struper timere der uansett, og en lukket laptop skal ikke lage
        // trafikk.
        if (typeof document !== 'undefined' && document.hidden) { planlegg(); return; }
        try {
            await hent();
            tegn();
            ventMs = INTERVALL_MS;
        } catch (_) {
            // Doble intervallet ved feil. Er API-et nede, skal ikke hver åpne
            // fane banke på hvert tolvte sekund til det kommer tilbake.
            ventMs = Math.min(ventMs * 2, FEIL_MAKS_MS);
        }
        planlegg();
    }

    async function start() {
        stoppet = false;
        try {
            await hent();
            tegn();
            tilBunn();
        } catch (_) {
            // Første henting feilet. Widgeten viser ingenting heller enn en
            // tom samtale som ser ut som «ingen har skrevet noe».
            container.hidden = true;
        }
        planlegg();
    }

    function stopp() {
        stoppet = true;
        clearTimeout(timer);
        timer = null;
    }

    /**
     * Hent og tegn én gang, utenom pollingen.
     *
     * Verten kan kalle den når noe har skjedd på siden som sannsynligvis
     * berører samtalen — typisk etter at en beslutning er registrert.
     */
    async function oppdater() {
        await hent();
        tegn();
    }

    return { start, stopp, tegn, oppdater, get tilstand() { return { ...tilstand }; } };
}
