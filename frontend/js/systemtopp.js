/**
 * Systemmerking — logo/advarsel øverst til venstre på alle sider.
 *
 * Merkingen forteller at dette er FHS Skjemasystem og at data må være
 * ugraderte. Den skal stå på hver eneste side, også utfyllingssiden som
 * eksterne respondenter når via OTP-lenke.
 *
 * Bruk: <script type="module" src="/js/systemtopp.js"></script>
 * Modulen kjører av seg selv og trenger ingen markup på siden — den finner
 * første <h1> og legger merket til venstre for overskriften. Overskriften
 * flyttes, ikke erstattes, så sider som senere setter textContent på sin
 * egen tittel-id fungerer uendret.
 *
 * Logo og tekster settes i admin-panelet (SystemInnstillinger). Er ingen logo
 * valgt, vises en ren tekstvariant — en side skal aldri stå umerket.
 */

const STANDARD = { url: '', tittel: 'FHS Skjemasystem', advarsel: 'Kun ugraderte data' };

async function hentMerke() {
    try {
        const r = await fetch('/api/systemlogo');
        if (!r.ok) return STANDARD;
        const d = await r.json();
        return {
            url: d.url || '',
            tittel: d.tittel || STANDARD.tittel,
            advarsel: d.advarsel || STANDARD.advarsel
        };
    } catch (_) {
        return STANDARD;
    }
}

function fyllMerke(boks, m) {
    boks.textContent = '';
    boks.title = `${m.tittel} — ${m.advarsel}`;

    if (m.url) {
        const img = document.createElement('img');
        img.src = m.url;
        // Alt-teksten bærer advarselen videre for skjermlesere og hvis bildet
        // ikke lastes — logoen alene er ikke tilgjengelig for alle.
        img.alt = `${m.tittel} — ${m.advarsel}`;
        img.style.cssText = 'height: 52px; max-width: 130px; object-fit: contain;';
        // Slettet eller omdøpt logofil skal gi tekstvarianten, ikke et brukket bilde.
        img.addEventListener('error', () => {
            img.remove();
            boks.appendChild(byggTekst(m));
        });
        boks.appendChild(img);
        return;
    }

    boks.appendChild(byggTekst(m));
}

function byggTekst(m) {
    const tekst = document.createElement('div');
    tekst.className = 'systemmerke-tekst';
    tekst.style.cssText = 'display: flex; flex-direction: column; line-height: 1.25; ' +
        'padding: 4px 10px; border-left: 3px solid #d13438; white-space: nowrap;';

    const linje1 = document.createElement('span');
    linje1.textContent = m.tittel;
    linje1.style.cssText = 'font-size: 12px; font-weight: 600;';

    const linje2 = document.createElement('span');
    linje2.textContent = m.advarsel;
    linje2.style.cssText = 'font-size: 11px; font-weight: 600; color: #d13438;';

    tekst.append(linje1, linje2);
    return tekst;
}

/**
 * Raden merket havner i må tåle en smal skjerm.
 *
 * Merket har `flex: 0 0 auto` og krymper ikke — det skal det ikke, en
 * graderingsmerking som er presset sammen til ukjennelighet er verre enn
 * ingen. Følgen er at ALT annet i raden må gi etter, og på mobil gjorde ikke
 * tittelen det: `.tittelrad` har `min-width: 0`, så h1-boksen krympet, men et
 * langt ord uten bindestrek kan ikke brytes — og teksten fløt utenfor boksen,
 * rett oppå merket. «Gaveprotokoll FHS» lå tvers over «Kun for UGRADERT»
 * (meldt 23.09.2026).
 *
 * To grep, og begge trengs: raden får brekke slik at merket kan gå ned på
 * egen linje, og tittelen får brytes inne i et ord når den ikke har noe annet
 * sted å gå.
 *
 * Settes her og ikke i hver enkelt sides CSS: tolv sider har merket, og de
 * kaller beholderen `.topplinje`, `.topprad` eller `.topp`. Regelen hører
 * hjemme hos den som plasserer merket, ikke i tolv kopier som kan skli fra
 * hverandre.
 */
function sikreRad(rad) {
    if (!rad) return;
    rad.style.flexWrap = 'wrap';
    for (const h of rad.querySelectorAll('h1')) {
        h.style.overflowWrap = 'anywhere';
        h.style.minWidth = '0';
    }
}

function settInn(merke) {
    // Sider som vil styre plasseringen selv lager en beholder med denne id-en
    // (utfyllingssiden har merket til høyre for tittelen, ikke til venstre).
    const plass = document.getElementById('systemmerke-plass');
    if (plass) {
        plass.appendChild(merke);
        sikreRad(plass.parentElement);
        return;
    }

    const h1 = document.querySelector('h1');
    if (h1 && h1.parentNode) {
        // Merket og overskriften flyttes inn i en egen flex-rad som tar
        // overskriftens plass. Da trenger vi ikke røre layouten på hver enkelt
        // side — topplinje, topp og vanlige div-er oppfører seg likt.
        const rad = document.createElement('div');
        rad.className = 'systemtopp-rad';
        rad.style.cssText = 'display: flex; align-items: center; gap: 14px; flex: 1; min-width: 0;';
        h1.parentNode.insertBefore(rad, h1);
        rad.append(merke, h1);
        h1.style.flex = '1';
        sikreRad(rad);
        return;
    }
    // Ingen overskrift på siden — legg merket øverst uansett.
    const vert = document.querySelector('.container') || document.body;
    merke.style.marginBottom = '12px';
    vert.insertBefore(merke, vert.firstChild);
}

/**
 * Miljømerke — vises bare når dette IKKE er produksjon.
 *
 * Pilot og prod ser identiske ut, og forveksling går begge veier: man tester
 * på det man tror er pilot, eller demonstrerer på det man tror er prod. Et
 * merke som bare står i produksjon ville vært lett å overse; dette står
 * derimot bare der man IKKE skal gjøre skade, som er den nyttige retningen.
 *
 * Verdien kommer fra frontend/js/config.js, som genereres av build-config.js
 * per miljø.
 */
async function miljomerke() {
    let miljo = '';
    try {
        const { CONFIG } = await import('./config.js');
        miljo = String(CONFIG?.MILJO || '');
    } catch (_) {
        return null;   // uten config.js sier vi ingenting
    }
    if (!miljo || /^prod/i.test(miljo)) return null;

    const el = document.createElement('span');
    el.className = 'miljomerke';
    el.textContent = miljo.toUpperCase();
    el.title = `Dette er ${miljo}-miljøet, ikke produksjon`;
    el.style.cssText = 'flex: 0 0 auto; padding: 3px 10px; border-radius: 999px; ' +
        'background: #ff9500; color: #1c1c1e; font-size: 11px; font-weight: 700; ' +
        'letter-spacing: 0.06em; white-space: nowrap;';
    return el;
}

// Tekstvarianten settes inn med en gang, og byttes ut med logoen når
// innstillingene er lastet. Da står siden aldri umerket mens kallet går —
// heller ikke om /api/systemlogo henger eller feiler.
const boks = document.createElement('div');
boks.className = 'systemmerke';
boks.style.cssText = 'display: flex; align-items: center; gap: 10px; flex: 0 0 auto;';
fyllMerke(boks, STANDARD);
settInn(boks);
hentMerke().then(m => fyllMerke(boks, m));
miljomerke().then(el => { if (el) boks.appendChild(el); });
