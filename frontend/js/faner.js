/**
 * Arbeidsfaner — stripe med åpne oppgaver øverst på siden.
 *
 * Utvikling, test og administrasjon ligger på tolv separate sider, og å jobbe
 * med én skjematype betyr å hoppe mellom editor, utfylling, behandling og
 * admin-panel. Stripa holder oversikten over hva du har gående.
 *
 * En fane er IKKE et vindu — den er et bokmerke med hukommelse. Hvert klikk er
 * en helt vanlig navigasjon til en helt vanlig URL. Det er hele grunnen til at
 * dyplenker fra e-post og Teams, tilbakeknappen, oppdatering og bokmerker
 * fortsetter å virke uendret.
 *
 * Bruk: <script type="module" src="/js/faner.js"></script>
 * Modulen kjører av seg selv, som systemtopp.js, og trenger ingen markup.
 * Navnet på fanen leses fra sidens <h1>, som settes når dataene er lastet —
 * derfor følger vi med på endringer i stedet for å lese én gang.
 *
 * Vises bare for admin og skjemaskapere. En respondent som fyller ut ett skjema
 * via en OTP-lenke har ingen arbeidsoppgaver å holde styr på, og skal ikke se
 * en stripe med andres.
 *
 * Lagres i localStorage — per maskin og nettleser. Å følge brukeren mellom
 * maskiner ville krevd server-side lagring, og behovet for å bytte maskin midt
 * i en økt er lite.
 */

const NOKKEL = 'arbeidsfaner';
const MAKS = 8;

/**
 * Sidene som er arbeidsflater, med ikon og type.
 *
 * `kunFra` betyr at siden bare blir en fane når man kom dit derfra.
 * Utfyllingssiden nås også av eksterne respondenter, og skal bare telle som
 * arbeid når den er åpnet fra editoren for å teste utfylling live.
 */
const FLATER = {
    '/velgskjematype.html':  { type: 'oversikt',      ikon: '☰' },
    '/editor.html':          { type: 'editor',        ikon: '✎' },
    '/evaluering.html':      { type: 'behandle',      ikon: '⚖' },
    '/visning.html':         { type: 'visning',       ikon: '👁' },
    '/admin.html':           { type: 'admin',         ikon: '⚙' },
    '/datauttrekk.html':     { type: 'uttrekk',       ikon: '⤓' },
    '/velgrapporttype.html': { type: 'rapporter',     ikon: '📊' },
    '/rapporteditor.html':   { type: 'rapporteditor', ikon: '📈' },
    '/rapport.html':         { type: 'rapport',       ikon: '📉' },
    '/register.html':        { type: 'register',      ikon: '🗄' },
    '/index.html':           { type: 'utfylling',     ikon: '🧪', kunFra: 'editor' }
};

// Parametrene som skiller én oppgave fra en annen. Alt annet — visningsvalg,
// filtre, sporing — skal ikke lage en ny fane.
//
// `status` er med fordi registeret har to innganger fra skjemaoversikten:
// Register er de aktive skjemaene, Arkiv er de avsluttede (status=5). Det er
// to ulike lister, og skal kunne stå som to faner.
const IDENT_PARAM = ['skjematype_id', 'skjema_id', 'rapporttype_id', 'kopi_fra', 'status'];

// ==================== ren logikk ====================

/** Normaliser stien, så både /editor.html og /editor treffer samme flate. */
export function stiFor(pathname) {
    const p = String(pathname || '/');
    if (p === '/' || p === '') return '/velgskjematype.html';
    return p.endsWith('.html') ? p : `${p}.html`;
}

/**
 * Identiteten til en fane.
 *
 * Hash er bevisst utelatt: admin-panelet bytter underfane med #nokler,
 * #hendelser og så videre, og hver av dem skulle ikke bli en egen arbeidsfane.
 * Hele URL-en lagres likevel, så du kommer tilbake til riktig underfane.
 */
export function faneNokkel(url) {
    const u = new URL(url, 'https://x');
    const p = new URLSearchParams();
    for (const navn of IDENT_PARAM) {
        const v = u.searchParams.get(navn);
        if (v) p.set(navn, v);
    }
    const q = p.toString();
    return stiFor(u.pathname) + (q ? `?${q}` : '');
}

/** Skal denne siden i det hele tatt bli en fane? */
export function erArbeidsflate(url) {
    const u = new URL(url, 'https://x');
    const flate = FLATER[stiFor(u.pathname)];
    if (!flate) return null;
    if (flate.kunFra && u.searchParams.get('fra') !== flate.kunFra) return null;
    return flate;
}

/**
 * Legg til eller aktiver en fane.
 *
 * Er oppgaven åpen fra før, oppdateres den i stedet for å bli duplisert — det
 * er samme arbeid, ikke et nytt. Over taket faller den eldste av dem som IKKE
 * har ulagret arbeid; en fane med ulagrede endringer skal aldri forsvinne av
 * seg selv, for da er det arbeid som ryker uten at noen ba om det.
 */
export function leggTil(faner, ny, maks = MAKS) {
    const ut = faner.filter(f => f.nokkel !== ny.nokkel);
    const fra_for = faner.find(f => f.nokkel === ny.nokkel);
    ut.push({ ...fra_for, ...ny, sett: ny.sett ?? Date.now() });

    while (ut.length > maks) {
        const kandidater = ut.filter(f => !f.ulagret && f.nokkel !== ny.nokkel);
        if (kandidater.length === 0) break; // alt er ulagret — behold heller for mange
        const eldst = kandidater.reduce((a, b) => (a.sett <= b.sett ? a : b));
        ut.splice(ut.indexOf(eldst), 1);
    }
    return ut;
}

/** Rydd bort faner som ikke lenger er gyldige — f.eks. etter en omlegging. */
export function lesLagret(rå) {
    try {
        const data = JSON.parse(rå || '{}');
        if (!Array.isArray(data.faner)) return [];
        return data.faner.filter(f => f && f.nokkel && f.url && f.navn);
    } catch (_) {
        return [];
    }
}

// ==================== nettleserdel ====================

const erNettleser = typeof document !== 'undefined' && typeof window !== 'undefined';

function lagre(faner) {
    try {
        localStorage.setItem(NOKKEL, JSON.stringify({ versjon: 1, faner }));
    } catch (_) { /* full localStorage skal ikke velte siden */ }
}

function hent() {
    try { return lesLagret(localStorage.getItem(NOKKEL)); } catch (_) { return []; }
}

/**
 * Har brukeren nytte av stripa?
 *
 * Svaret caches i sessionStorage. Uten det ville hver eneste navigasjon kostet
 * et ekstra /api/whoami-kall — og faner er nettopp laget for å navigere ofte.
 */
async function harTilgang() {
    const bufret = sessionStorage.getItem('arbeidsfaner-tilgang');
    if (bufret !== null) return bufret === 'ja';
    try {
        const svar = await fetch('/api/whoami');
        if (!svar.ok) return false;
        const meg = await svar.json();
        const ja = !!(meg.erAdmin || meg.kanOppretteSkjematype);
        sessionStorage.setItem('arbeidsfaner-tilgang', ja ? 'ja' : 'nei');
        return ja;
    } catch (_) {
        return false;
    }
}

function sidenavn() {
    const h1 = document.querySelector('h1');
    const fra_h1 = (h1?.textContent || '').trim();
    if (fra_h1) return fra_h1;
    return (document.title || '').split('—')[0].trim() || 'Uten navn';
}

const STIL = `
.arbeidsfaner {
    display: flex; align-items: stretch; gap: 2px;
    margin: 0 0 14px; padding-bottom: 0;
    overflow-x: auto; scrollbar-width: thin;
    border-bottom: 1px solid var(--border-color, rgba(0,0,0,0.1));
}
.arbeidsfaner .fane {
    display: inline-flex; align-items: center; gap: 8px; flex: 0 0 auto;
    max-width: 230px; padding: 8px 11px;
    border: 1px solid transparent; border-bottom: 0; border-radius: 8px 8px 0 0;
    background: transparent; color: var(--text-secondary, #6e6e73);
    font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap;
    text-decoration: none;
}
.arbeidsfaner .fane:hover { background: var(--accent-light, rgba(10,132,255,0.12)); color: var(--text-primary, #1c1c1e); }
.arbeidsfaner .fane.aktiv {
    background: var(--bg-container, #fff); border-color: var(--border-color, rgba(0,0,0,0.1));
    color: var(--text-primary, #1c1c1e); font-weight: 600;
    box-shadow: 0 -2px 0 var(--accent, #0a84ff) inset;
}
.arbeidsfaner .fane:focus-visible { outline: 2px solid var(--accent, #0a84ff); outline-offset: 2px; }
.arbeidsfaner .navn { overflow: hidden; text-overflow: ellipsis; }
.arbeidsfaner .prikk { width: 7px; height: 7px; border-radius: 50%; background: var(--warning, #ff9500); flex: 0 0 auto; }
.arbeidsfaner .lukk {
    border: 0; background: transparent; color: inherit; font: inherit; font-size: 14px;
    line-height: 1; cursor: pointer; padding: 2px 3px; border-radius: 4px; opacity: 0.45;
}
.arbeidsfaner .fane:hover .lukk { opacity: 1; }
.arbeidsfaner .lukk:hover { background: var(--border-color, rgba(0,0,0,0.12)); }
@media print { .arbeidsfaner { display: none; } }
`;

let gjeldende = null;

function tegn(faner) {
    let nav = document.querySelector('.arbeidsfaner');
    if (!nav) {
        if (!document.getElementById('arbeidsfaner-stil')) {
            const stil = document.createElement('style');
            stil.id = 'arbeidsfaner-stil';
            stil.textContent = STIL;
            document.head.appendChild(stil);
        }
        nav = document.createElement('nav');
        nav.className = 'arbeidsfaner';
        nav.setAttribute('aria-label', 'Åpne arbeidsoppgaver');
        const vert = document.querySelector('.container') || document.body;
        vert.insertBefore(nav, vert.firstChild);
    }

    nav.innerHTML = '';
    for (const f of [...faner].sort((a, b) => a.sett - b.sett)) {
        const aktiv = f.nokkel === gjeldende;
        const a = document.createElement('a');
        a.className = 'fane' + (aktiv ? ' aktiv' : '');
        a.href = f.url;
        if (aktiv) a.setAttribute('aria-current', 'page');
        a.innerHTML = `<span aria-hidden="true">${f.ikon || '•'}</span><span class="navn"></span>`;
        a.querySelector('.navn').textContent = f.navn;
        if (f.ulagret) {
            const prikk = document.createElement('span');
            prikk.className = 'prikk';
            prikk.title = 'Ulagrede endringer';
            a.appendChild(prikk);
        }
        const lukk = document.createElement('button');
        lukk.className = 'lukk';
        lukk.type = 'button';
        lukk.textContent = '✕';
        lukk.title = `Lukk ${f.navn}`;
        lukk.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            lagre(hent().filter(x => x.nokkel !== f.nokkel));
            tegn(hent());
        });
        a.appendChild(lukk);
        // Lagre rulleposisjonen før vi forlater siden, så fanen kommer tilbake
        // der du var — ikke øverst.
        a.addEventListener('click', () => lagreRull());
        nav.appendChild(a);
    }
}

function lagreRull() {
    if (!gjeldende) return;
    const faner = hent();
    const f = faner.find(x => x.nokkel === gjeldende);
    if (!f) return;
    f.scroll = Math.round(window.scrollY);
    lagre(faner);
}

function oppdaterNavn() {
    if (!gjeldende) return;
    const faner = hent();
    const f = faner.find(x => x.nokkel === gjeldende);
    if (!f) return;
    const navn = sidenavn();
    if (navn && navn !== f.navn) {
        f.navn = navn;
        lagre(faner);
        tegn(faner);
    }
}

/** Editoren melder fra når det finnes ulagrede endringer. */
function settUlagret(ulagret) {
    if (!gjeldende) return;
    const faner = hent();
    const f = faner.find(x => x.nokkel === gjeldende);
    if (!f || f.ulagret === !!ulagret) return;
    f.ulagret = !!ulagret;
    lagre(faner);
    tegn(faner);
}

async function start() {
    const flate = erArbeidsflate(window.location.href);
    if (!flate) return;
    if (!(await harTilgang())) return;

    gjeldende = faneNokkel(window.location.href);
    const faner = leggTil(hent(), {
        nokkel: gjeldende,
        url: window.location.href,
        type: flate.type,
        ikon: flate.ikon,
        navn: sidenavn()
    });
    lagre(faner);
    tegn(faner);

    // Navnet settes først når sidens data er lastet. Vi følger med på
    // overskriften i stedet for å lese den én gang for tidlig.
    const h1 = document.querySelector('h1');
    if (h1) new MutationObserver(oppdaterNavn).observe(h1, { childList: true, subtree: true, characterData: true });
    new MutationObserver(oppdaterNavn).observe(document.head, { childList: true, subtree: true });

    // Kom du tilbake til denne fanen, skal du lande der du forlot den.
    const meg = faner.find(f => f.nokkel === gjeldende);
    if (meg?.scroll > 0) {
        window.requestAnimationFrame(() => window.scrollTo(0, meg.scroll));
    }
    window.addEventListener('pagehide', lagreRull);

    window.faner = { settUlagret, oppdaterNavn };
}

if (erNettleser) start();
