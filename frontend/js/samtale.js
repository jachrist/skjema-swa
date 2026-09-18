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
 * som har kommet siden sist.
 *
 * TEGNINGEN ER INKREMENTELL, og det er ikke en optimalisering.
 *
 * Første utgave satte `container.innerHTML` på nytt hver runde. Tekstfeltet ble
 * da ødelagt og bygget på nytt hvert 12. sekund, og brukeren mistet fokus midt
 * i en setning. Teksten ble tatt vare på, så det så ut som et tilfeldig
 * rykk — ikke som at feltet var byttet ut.
 *
 * Derfor: rammen bygges ÉN gang, skrivefeltet røres aldri etterpå, og nye
 * innlegg legges til i lista. Ingenting under `container` erstattes.
 *
 * Alt innhold settes med `textContent`, ikke `innerHTML`. Et innlegg er
 * fritekst fra en behandler eller en ekstern innsender, og escaping man må
 * huske på er escaping man glemmer.
 */
const INTERVALL_MS = 12000;

/** Hvor lenge vi maksimalt venter etter gjentatte feil. */
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

function el(tag, klasse, tekst) {
    const n = document.createElement(tag);
    if (klasse) n.className = klasse;
    if (tekst !== undefined) n.textContent = tekst;
    return n;
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

    /** Nodene vi trenger igjen. Bygges én gang. */
    const n = {};

    container.classList.add('samtale');
    container.hidden = true;

    // ---------- rammen, én gang ----------

    function byggRamme() {
        if (n.rot) return;

        const topp = el('div', 'samtale-topp');
        topp.appendChild(el('h3', 'samtale-tittel', 'Samtale'));

        n.dempEtikett = el('label', 'samtale-demp');
        n.dempBoks = document.createElement('input');
        n.dempBoks.type = 'checkbox';
        n.dempBoks.className = 'samtale-demp-boks';
        n.dempEtikett.appendChild(n.dempBoks);
        n.dempEtikett.appendChild(document.createTextNode(' Demp varsling for denne saken'));
        n.dempEtikett.hidden = true;
        topp.appendChild(n.dempEtikett);
        container.appendChild(topp);

        n.lukket = el('p', 'samtale-lukket',
            'Saken er ferdigbehandlet, og samtalen er lukket for nye innlegg. Den følger saken i PDF-en.');
        n.lukket.hidden = true;
        container.appendChild(n.lukket);

        n.liste = el('div', 'samtale-liste');
        n.liste.setAttribute('role', 'log');
        n.liste.setAttribute('aria-live', 'polite');
        n.tom = el('p', 'samtale-tom', 'Ingen innlegg ennå.');
        n.liste.appendChild(n.tom);
        container.appendChild(n.liste);

        n.skriv = el('div', 'samtale-skriv');
        if (infotekst) n.skriv.appendChild(el('p', 'samtale-info', infotekst));

        n.felt = document.createElement('textarea');
        n.felt.className = 'samtale-felt';
        n.felt.rows = 3;
        n.felt.placeholder = 'Skriv et innlegg…';
        n.felt.setAttribute('aria-label', 'Nytt innlegg');
        // Ctrl/Cmd+Enter sender. Enter alene gir linjeskift: et innlegg kan
        // ikke redigeres etterpå, så det skal koste et bevisst trykk.
        n.felt.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
        });
        n.skriv.appendChild(n.felt);

        const rad = el('div', 'samtale-knapperad');
        n.status = el('span', 'samtale-status', '');
        n.status.setAttribute('role', 'status');
        rad.appendChild(n.status);
        n.send = el('button', 'samtale-send', 'Send');
        n.send.type = 'button';
        n.send.addEventListener('click', send);
        rad.appendChild(n.send);
        n.skriv.appendChild(rad);

        n.skriv.hidden = true;
        container.appendChild(n.skriv);

        n.dempBoks.addEventListener('change', () => settDemping(n.dempBoks.checked));
        n.rot = true;
    }

    /**
     * Oppdater det som kan endre seg. Rører ALDRI skrivefeltet eller lista —
     * bare synlighet og haker.
     */
    function oppdaterRamme() {
        container.hidden = !tilstand.synlig;
        if (!tilstand.synlig) return;
        n.dempEtikett.hidden = !tilstand.kanDempe;
        // Bare når den faktisk avviker: å sette checked mens brukeren klikker
        // gir et hopp.
        if (n.dempBoks.checked !== tilstand.dempet) n.dempBoks.checked = tilstand.dempet;
        n.lukket.hidden = tilstand.apen;
        n.skriv.hidden = !tilstand.kanSkrive;
        n.tom.hidden = innlegg.length > 0;
    }

    function nodeFor(i) {
        const meg = megId && String(i.Avsender).toLowerCase() === String(megId).toLowerCase();
        const boks = el('div', 'samtale-innlegg' + (meg ? ' meg' : ''));
        const hode = el('div', 'samtale-hode');
        hode.appendChild(el('span', 'samtale-avsender', i.AvsenderNavn || i.Avsender || '–'));
        hode.appendChild(el('span', 'samtale-tid', tid(i.Dato)));
        boks.appendChild(hode);
        boks.appendChild(el('div', 'samtale-tekst', i.Tekst || ''));
        return boks;
    }

    function leggTilNye(nye) {
        const varVedBunn = erVedBunn();
        for (const i of nye) n.liste.appendChild(nodeFor(i));
        // Bare rull ned hvis brukeren allerede var nederst. Ellers rives hen
        // bort fra det hen leser, hvert tolvte sekund.
        if (varVedBunn) tilBunn();
    }

    function erVedBunn() {
        if (!n.liste) return true;
        return n.liste.scrollHeight - n.liste.scrollTop - n.liste.clientHeight < 40;
    }

    function tilBunn() {
        if (n.liste) n.liste.scrollTop = n.liste.scrollHeight;
    }

    function status(tekst, feil = false) {
        if (!n.status) return;
        n.status.textContent = tekst;
        n.status.classList.toggle('feil', !!feil);
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
        if (!sisteId) {
            innlegg = nye;
            if (n.liste) { while (n.liste.lastChild) n.liste.removeChild(n.liste.lastChild); n.liste.appendChild(n.tom); }
        } else {
            innlegg = innlegg.concat(nye);
        }
        if (innlegg.length > 0) sisteId = innlegg[innlegg.length - 1].Id;
        return nye;
    }

    function tegn(nye = []) {
        byggRamme();
        leggTilNye(nye);
        oppdaterRamme();
    }

    async function send() {
        const tekst = (n.felt?.value || '').trim();
        if (!tekst || sender) return;

        sender = true;
        n.send.disabled = true;
        status('Sender…');
        try {
            await api.post(base, { tekst });
            // Tømmes først når lagringen er bekreftet.
            n.felt.value = '';
            status('');
            tegn(await hent());
            tilBunn();
            // Brukeren skrev nettopp; hen skal kunne fortsette uten å klikke.
            n.felt.focus();
        } catch (e) {
            // Teksten blir stående. Å tømme feltet ved feil er å slette noe
            // brukeren har skrevet.
            status(e?.message || 'Kunne ikke sende innlegget', true);
        } finally {
            sender = false;
            if (n.send) n.send.disabled = false;
        }
    }

    async function settDemping(dempet) {
        try {
            const svar = await api.post(`${base}/demping`, { dempet });
            tilstand.dempet = !!svar.dempet;
        } catch (_) {
            // Sett haken tilbake — ellers tror brukeren at varslingen er
            // dempet mens den ikke er det, og det er den feilen som gjør at en
            // sak blir stående.
            n.dempBoks.checked = !dempet;
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
            tegn(await hent());
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
            tegn(await hent());
            tilBunn();
        } catch (_) {
            // Første henting feilet. Widgeten viser ingenting heller enn en
            // tom samtale, som ser ut som «ingen har skrevet noe».
            container.hidden = true;
        }
        planlegg();
    }

    function stopp() {
        stoppet = true;
        clearTimeout(timer);
        timer = null;
    }

    /** Hent og tegn én gang, utenom pollingen. */
    async function oppdater() { tegn(await hent()); }

    return { start, stopp, oppdater, get tilstand() { return { ...tilstand }; } };
}
