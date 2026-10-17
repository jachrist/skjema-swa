/**
 * Finn verdier som skrives til HTML uten escaping.
 *
 * Bakgrunnen: `docs/SIKKERHET-OG-ARKITEKTUR.md` punkt 11 sa at escaping
 * finnes, at det ikke er noen CSP, og at `innerHTML` brukes mange steder —
 * men at ingen hadde gått gjennom det systematisk. Dette er gjennomgangen,
 * som et skript i stedet for en rapport, fordi en rapport er sann den dagen
 * den skrives.
 *
 * Hva som regnes som en sink: `innerHTML`, `outerHTML`, `insertAdjacentHTML`
 * og `document.write`. For hver av dem leses uttrykket som følger, og hver
 * `${...}` i det vurderes.
 *
 * En interpolasjon er TRYGG når den er
 *
 *   - pakket i en escape-funksjon (`escapeHtml`, `escHtml`, `escAttr`,
 *     `escapeAttr`, `encodeURIComponent`), eller i en renderer som escaper
 *     selv (`renderTekst`, `renderTekstInline`, `parseMarkdown`),
 *   - et tall, eller
 *   - en betinget som bare kan gi strengliteraler — `x ? 'checked' : ''`.
 *     Da er det betingelsen som er variabel, ikke det som havner i HTML-en.
 *
 * Alt annet må stå i `GODTATT` med en begrunnelse. Uten den lista kan et
 * hull ikke skilles fra en vurdering noen har gjort, og 40 varsler ingen
 * handler på er det samme som ingen varsler.
 *
 * Bruk:
 *   node scripts/html-injeksjon.js            # sammendrag
 *   node scripts/html-injeksjon.js --alle     # også de godtatte
 */
const fs = require('fs');
const path = require('path');
const { utenKommentarer } = require('./test-kilde.js');

const ROT = path.join(__dirname, '..');
const SINKER = /\.(innerHTML|outerHTML)\s*\+?=|\.insertAdjacentHTML\s*\(|document\.write\s*\(/g;

/** Funksjoner som gjør verdien trygg å sette inn i HTML. */
const TRYGGE = [
    'escapeHtml', 'escHtml', 'escAttr', 'escapeAttr', 'encodeURIComponent',
    'renderTekst', 'renderTekstInline', 'parseMarkdown'
];

/**
 * Interpolasjoner som IKKE er escapet, men som er vurdert og godtatt.
 *
 * Hver gruppe er én vurdering, gjort ved å lese koden 13.10.2026, og
 * begrunnelsen skal kunne leses av en som evaluerer sikkerheten — ikke bare
 * av den som skrev den.
 *
 * Uten denne lista kan et hull ikke skilles fra en beslutning, og et skript
 * som melder 88 treff hver gang er et skript ingen kjører to ganger.
 */
const GODTATT_GRUPPER = [
    {
        fil: 'frontend/admin.html',
        grunn: 'Tellere og varigheter fra vårt eget API, rendret i admin-panelet. '
            + 'Ingen av dem bærer tekst fra lagring; alle er tall API-et selv har regnet ut. '
            + 'Blir en av dem en tekstverdi en dag, er det en API-endring, og da skal den escapes.',
        uttrykk: ['nummer', 'i', 'iAar - 1',
            'r.lest', 'r.lagtTil', 'r.hoppetOver', 'r.slettet',
            's.lest', 's.leggTil', 's.oppdater', 's.fjern', 's.uendret', 's.manuelle', 's.antall',
            's.Skjematyper', 's.Utfylte', 's.Mellomlagret',
            'res.slettet', 'res.antall', 'res.antallPurret',
            'data.antall', 'data.besvart', 'data.ubesvart', 'data.varighetSekunder',
            'b.antallRader', 'b.antallSlettet', 'b.varighetSekunder',
            't.antall', 't.slettet', 'c.antall', 'c.slettet',
            'Math.round((Date.now() - start) / 1000)',
            'Math.round(stille / 60)']
    },
    {
        fil: 'frontend/admin.html',
        grunn: 'Jobber-fanen setter radene gjennom jobbRadHtml(), som står i HTML_PRODUSENTER '
            + 'og er lest: hver tekstverdi fra API-et går gjennom escHtml, tallene gjennom '
            + 'escHtml(String(...)), jobb-id-en i onclick-attributtet gjennom escapeJsIAttributt, '
            + 'og datoene gjennom formatDato. Produsentregelen treffer bare et direkte kall, '
            + 'ikke et kall inne i en .map() — derfor står formen her i stedet.',
        uttrykk: ["jobberState.jobber.map(j => jobbRadHtml(j)).join('')"]
    },
    {
        fil: 'frontend/admin.html',
        grunn: 'formatStorrelse() fra js/storrelse.js. Den slipper ALDRI inndata gjennom: '
            + 'returverdien er enten null eller en streng bygget av sifre, ett komma, ett '
            + 'mellomrom og en enhet fra en fast liste i funksjonen. En markup-bærende verdi '
            + 'inn gir null ut, ikke markup ut — så escaping ville ikke endret noe her.',
        uttrykk: ['formatStorrelse(data.storrelseBytes)',
            'formatStorrelse(st.storrelseBytes)',
            'formatStorrelse(blob.size)',
            'formatStorrelse(b.storrelseBytes)']
    },
    {
        fil: 'frontend/admin.html',
        grunn: 'Klassenavn og statusord valgt av koden selv, fra faste literaler. '
            + 'Verdien fra API-et avgjør hvilken literal som velges, og havner aldri i HTML-en.',
        uttrykk: ["st.status === 'feil'",
            "(s.status === 'feil' ? 'danger' : (s.status === 'kjører' ? 'warning' : 'text-secondary'))",
            "(st.oneDriveStatus === 'ok' ? 'suksess' : 'info')"]
    },
    {
        fil: 'frontend/admin.html',
        grunn: 'Bygget lenger opp i samme funksjon, med escHtml på tekstverdiene. '
            + 'Skanneren slår opp lokale variabler, men tar den FØRSTE erklæringen av et navn i fila — '
            + 'og disse navnene brukes i flere funksjoner.',
        uttrykk: ['html', 'kopi']
    },
    {
        fil: 'frontend/admin.html',
        grunn: 'Hjelpetekst fra GEVINST_TYPER, en fast liste i fila. Ikke data fra lagring.',
        uttrykk: ['t.hjelp']
    },
    {
        fil: 'frontend/admin.html',
        grunn: 'Formatversjonen i et backup-manifest, skrevet av vår egen backup-jobb som et tall. '
            + 'Et manifest med markup i versjonsfeltet ville betydd at backupfila er manipulert — '
            + 'og da er det ikke dette feltet som er problemet.',
        uttrykk: ['data.manifest.versjon']
    },
    {
        fil: 'frontend/admin.html',
        grunn: 'Dato formatert fra et Date-objekt, eller tankestrek. Kan ikke bære markup.',
        uttrykk: ["(b.ferdig ? formatDato(b.ferdig) : '—')"]
    },
    {
        fil: 'frontend/admin.html',
        grunn: 'Returnerer et objekt fra oppslagState, ikke HTML — treffet er betingelsen, '
            + 'ikke det som rendres.',
        uttrykk: ['oppslagKjoring(l.Navn)']
    },
    {
        fil: 'frontend/editor.html',
        grunn: 'Faste lister i fila: KANAL_PLASSHOLDERE, SP_PLASSHOLDERE, feltkonfigurasjonene '
            + 'i editorpanelene og EPOST_IKON (en innebygd SVG). Ingen av dem kommer fra lagring.',
        uttrykk: ['p.navn', 'hjelp', 'f.hjelp', 'EPOST_IKON']
    },
    {
        fil: 'frontend/editor.html',
        grunn: 'Tellere og indekser i editoren: posisjonen i en liste, sidetall i en '
            + 'forhåndsvisning, og antall sendte varsler. Alle regnet ut av koden eller API-et.',
        uttrykk: ['idx', 'sideNr', 'totalt', 'f.antallSendt']
    },
    {
        fil: 'frontend/evaluering.html',
        grunn: 'Fargekode og stil valgt av koden selv, fra faste hex-literaler i samme fil '
            + '(se funksjonen som gir { tekst, farge }).',
        uttrykk: ['status.farge', 'bekreftStil']
    },
    {
        fil: 'frontend/register.html',
        grunn: 'Samme faste fargeliteraler som i evaluering.html, og et antall fra API-et.',
        uttrykk: ['status.farge', 'r.skrevet']
    },
    {
        fil: 'frontend/rapport.html',
        grunn: 'Antall rader i resultatet, regnet ut av API-et.',
        uttrykk: ['resultat.meta.antallEtterFilter', 'resultat.meta.antallSkjemaer']
    },
    {
        fil: 'frontend/js/faner.js',
        grunn: 'Ikonet kommer fra SIDER, en fast tabell øverst i samme fil. Fanenavnet ved '
            + 'siden av settes med textContent, nettopp fordi det kan variere.',
        uttrykk: ['f.ikon']
    },
    {
        fil: 'frontend/js/otp-widget.js',
        grunn: 'Kanalnøkkelen er «epost» eller «sms», fra en fast liste i samme fil.',
        uttrykk: ['k']
    }
];

const GODTATT = {};
for (const g of GODTATT_GRUPPER) {
    for (const u of g.uttrykk) GODTATT[`${g.fil}:${u}`] = g.grunn;
}

/**
 * Funksjoner som bygger HTML og escaper selv.
 *
 * Skanneren følger ikke kall — ett nivå ville dratt inn halve fila, og
 * dypere ville gjort at alt så trygt ut. Står en funksjon her, er den LEST,
 * og det den returnerer er escapet. Lista er kort med vilje: blir den lang,
 * er det et tegn på at HTML-byggingen burde ligget ett sted.
 */
const HTML_PRODUSENTER = [
    // admin.html — alle lest 13.10.2026. Hver av dem escaper tekstverdiene
    // sine med escHtml og setter bare tall og egne literaler ellers.
    'rollerImportOmrade', 'rollerImportFeilliste', 'rollerImportListe',
    'nokkelVerdiTabell', 'sysHemmeligeTabell', 'byggOversiktTabell',
    'oversiktRad', 'tegnArkivSletting', 'tegnArkivHistorikk',
    // Jobber-fanen, lest 17.10.2026: hver tekstverdi fra API-et går gjennom
    // escHtml, tallene gjennom escHtml(String(...)), og jobb-id-en i
    // onclick-attributtet gjennom escapeJsIAttributt. Datoene kommer fra
    // formatDato, som står lenger ned i samme liste.
    'jobbRadHtml',
    // Dato formatert fra et Date-objekt — kan ikke bære markup.
    'formatDato', 'kortDato', 'formatTid',
    // js/behandling-kommentar.js: tar escape-funksjonen som argument og
    // bruker den på både aktør og kommentar.
    'kommentarerSomHtml',
    // js/skjemastatus.js: returnerer et klassenavn fra et fast sett
    // (STATUSKLASSER), aldri noe som kommer fra lagring.
    'statusKlasse'
];

/**
 * Tekst med innholdet i strenger og maler nøytralisert.
 *
 * LENGDEN MÅ BEVARES. Første versjon erstattet `'x'` med `''`, og da pekte
 * hver indeks etter den første strengen feil sted — `a ? 'x' : 'y'` ble delt
 * til grenene `'x'` og `: 'y'`, og alt som inneholdt en streng ble feilaktig
 * flagget. Derfor fylles literalene med punktum i stedet for å fjernes.
 */
function utenLiteraler(s) {
    const fyll = (m) => m[0] + '.'.repeat(Math.max(0, m.length - 2)) + m[m.length - 1];
    return s.replace(/'(?:[^'\\]|\\.)*'/g, fyll)
        .replace(/"(?:[^"\\]|\\.)*"/g, fyll)
        .replace(/`(?:[^`\\]|\\.)*`/g, fyll);
}

/** `${...}`-uttrykkene i en malstreng, med nøsting håndtert. */
function interpolasjoner(mal) {
    const ut = [];
    for (let i = 0; i < mal.length - 1; i++) {
        if (mal[i] !== '$' || mal[i + 1] !== '{') continue;
        if (i > 0 && mal[i - 1] === '\\') continue;
        let dybde = 1, j = i + 2;
        let streng = null;
        while (j < mal.length && dybde > 0) {
            const c = mal[j];
            if (streng) {
                if (c === '\\') j++;
                else if (c === streng) streng = null;
            } else if (c === "'" || c === '"' || c === '`') streng = c;
            else if (c === '{') dybde++;
            else if (c === '}') dybde--;
            j++;
        }
        ut.push(mal.slice(i + 2, j - 1));
        i = j - 1;
    }
    return ut;
}

/** Topp-nivå-grenene i et uttrykk: det som faktisk kan havne i HTML-en. */
function grener(uttrykk) {
    const u = uttrykk.trim();
    const nøytral = utenLiteraler(u);
    // Del på topp-nivå `?`/`:` og `||`/`??`. Betingelsen i en ternær er ikke
    // en gren — den avgjør hvilken gren som velges, og havner aldri i HTML.
    let dybde = 0, spm = -1, kolon = -1;
    for (let i = 0; i < nøytral.length; i++) {
        const c = nøytral[i];
        if ('([{'.includes(c)) dybde++;
        else if (')]}'.includes(c)) dybde--;
        else if (dybde === 0 && c === '?' && nøytral[i + 1] !== '.' && nøytral[i + 1] !== '?' && spm === -1) spm = i;
        else if (dybde === 0 && c === ':' && spm !== -1 && kolon === -1) kolon = i;
    }
    if (spm !== -1 && kolon !== -1) {
        return [...grener(u.slice(spm + 1, kolon)), ...grener(u.slice(kolon + 1))];
    }
    for (const op of ['||', '??', '+']) {
        let d = 0;
        for (let i = 0; i < nøytral.length - 1; i++) {
            const c = nøytral[i];
            if ('([{'.includes(c)) d++;
            else if (')]}'.includes(c)) d--;
            else if (d === 0 && nøytral.slice(i, i + op.length) === op
                && !(op === '+' && (nøytral[i + 1] === '+' || nøytral[i - 1] === '+'))) {
                return [...grener(u.slice(0, i)), ...grener(u.slice(i + op.length))];
            }
        }
    }
    return [u];
}

/**
 * Lokale variabler i en fil: `const navn = <uttrykk>`.
 *
 * Halvparten av treffene var variabler som `flytHtml` og `tRows` — HTML
 * bygget noen linjer lenger opp, med escaping. Uten oppslaget måtte de vært
 * erklært én for én, og en unntaksliste på hundre oppføringer er en liste
 * ingen leser.
 */
function lokaleVariabler(tekst) {
    const ut = new Map();
    const re = /(?:^|\n)\s*(?:const|let|var)\s+([A-Za-zÆØÅæøå_$][\w$]*)\s*=\s*/g;
    let m;
    while ((m = re.exec(tekst)) !== null) {
        const fra = m.index + m[0].length;
        // Les fram til slutten av uttrykket: balanser parenteser og maler.
        let i = fra, dybde = 0, streng = null, malDybde = 0;
        while (i < tekst.length) {
            const c = tekst[i];
            if (c === '\\') { i += 2; continue; }
            if (streng) {
                if (c === streng && !(streng === '`' && malDybde > 0)) streng = null;
                else if (streng === '`' && c === '$' && tekst[i + 1] === '{') { malDybde++; i++; }
                else if (streng === '`' && c === '}' && malDybde > 0) malDybde--;
            } else if (c === "'" || c === '"' || c === '`') streng = c;
            else if ('([{'.includes(c)) dybde++;
            else if (')]}'.includes(c)) { if (dybde === 0) break; dybde--; }
            // Bare `;` avslutter, ikke linjeskift: en ternær over flere
            // linjer er vanlig her, og brøt vi på linjeskift fanget vi bare
            // betingelsen. `const filerHtml = x.length === 0` ble da lest som
            // et tall-uttrykk, og HTML-en under slapp unna sjekken.
            // `;` avslutter, og `,` på topp-nivå gjør det også: `let a = 0,
            // feilet = 0;` ga ellers uttrykket «0, feilet = 0».
            else if ((c === ';' || c === ',') && dybde === 0) break;
            i++;
        }
        // Første erklæring vinner. Samme navn i to funksjoner er vanlig, og
        // da er den strengeste tolkningen å se på den vi fant først.
        if (!ut.has(m[1])) ut.set(m[1], tekst.slice(fra, i).trim());
    }
    return ut;
}

/** Er denne ene grenen trygg? */
function grenErTrygg(gren, ktx) {
    const g = gren.trim();
    if (!g) return true;
    // Ren strengliteral.
    if (/^'(?:[^'\\]|\\.)*'$/.test(g) || /^"(?:[^"\\]|\\.)*"$/.test(g)) return true;
    // Tall.
    if (/^-?\d+(\.\d+)?$/.test(g)) return true;
    // Malstreng: trygg hvis hver interpolasjon i den er trygg.
    if (/^`[\s\S]*`$/.test(g)) return interpolasjoner(g).every(u => erTrygg(u, ktx));
    // Pakket i en escape-funksjon, og hele uttrykket er det kallet.
    for (const fn of TRYGGE) {
        if (new RegExp(`^${fn}\\s*\\(`).test(g) && g.endsWith(')')) return true;
    }
    // En funksjon som er erklært å returnere ferdig escapet HTML.
    const kall = /^([A-Za-zÆØÅæøå_$][\w$]*)\s*\(/.exec(g);
    if (kall && HTML_PRODUSENTER.includes(kall[1]) && g.endsWith(')')) return true;

    // Kjeder som bygger HTML: `rader.map(r => `…`).join('')`. Grenen er trygg
    // hvis hver interpolasjon i malstrengene inni er trygg. Det er det øyet
    // gjør når det leser en slik linje, og det er den formen som dominerer
    // her — uten den ville halvparten av treffene vært støy.
    if (g.includes('`')) {
        const maler = finnMalstrenger(g);
        if (maler.length) return maler.every(m => interpolasjoner(m).every(u => erTrygg(u, ktx)));
    }
    // En lokal variabel: slå opp hva den ble satt til.
    if (ktx && /^[A-Za-zÆØÅæøå_$][\w$]*$/.test(g) && ktx.lokale.has(g)) {
        if (ktx.sett.has(g)) return false;   // sirkel — regn den som utrygg
        ktx.sett.add(g);
        const svar = erTrygg(ktx.lokale.get(g), ktx);
        ktx.sett.delete(g);
        return svar;
    }
    // Her stopper vi. Noter BLADET, ikke uttrykket det lå inni: `flytHtml`
    // sier ingenting om hva som må escapes, mens `steg.Flyt_url` gjør det.
    if (ktx) ktx.feil.add(g.replace(/\s+/g, ' ').trim());
    return false;
}

/** Malstrengene i et uttrykk, med nøsting håndtert. */
function finnMalstrenger(s) {
    const ut = [];
    for (let i = 0; i < s.length; i++) {
        if (s[i] !== '`') continue;
        if (i > 0 && s[i - 1] === '\\') continue;
        let j = i + 1, dybde = 0;
        while (j < s.length) {
            const c = s[j];
            if (c === '\\') { j += 2; continue; }
            if (c === '$' && s[j + 1] === '{') { dybde++; j += 2; continue; }
            if (c === '}' && dybde > 0) { dybde--; j++; continue; }
            if (c === '`' && dybde === 0) break;
            j++;
        }
        ut.push(s.slice(i, j + 1));
        i = j;
    }
    return ut;
}

function erTrygg(uttrykk, ktx) {
    return grener(uttrykk).every(g => grenErTrygg(g, ktx));
}

/** Malstrengen (eller strengen) som følger en sink. */
function uttrykketEtter(tekst, fra) {
    let i = fra;
    while (i < tekst.length && /\s/.test(tekst[i])) i++;
    if (tekst[i] !== '`') return null;
    let j = i + 1, dybde = 0;
    while (j < tekst.length) {
        const c = tekst[j];
        if (c === '\\') { j += 2; continue; }
        if (c === '$' && tekst[j + 1] === '{') { dybde++; j += 2; continue; }
        if (c === '}' && dybde > 0) { dybde--; j++; continue; }
        if (c === '`' && dybde === 0) return tekst.slice(i, j + 1);
        j++;
    }
    return null;
}

function skann() {
    const filer = [
        ...fs.readdirSync(path.join(ROT, 'frontend')).filter(n => n.endsWith('.html')).map(n => `frontend/${n}`),
        ...fs.readdirSync(path.join(ROT, 'frontend', 'js')).filter(n => n.endsWith('.js')).map(n => `frontend/js/${n}`)
    ].sort();

    const funn = [];
    let sinker = 0;
    for (const rel of filer) {
        const rå = fs.readFileSync(path.join(ROT, rel), 'utf8');
        const tekst = utenKommentarer(rå);
        const ktx = { lokale: lokaleVariabler(tekst), sett: new Set(), feil: new Set() };
        SINKER.lastIndex = 0;
        let m;
        while ((m = SINKER.exec(tekst)) !== null) {
            sinker++;
            // Hopp fram til etter `=` eller `(`.
            let p = m.index + m[0].length;
            const mal = uttrykketEtter(tekst, p);
            if (!mal) continue;
            const linje = tekst.slice(0, m.index).split('\n').length;
            for (const u of interpolasjoner(mal)) {
                ktx.feil.clear();
                if (erTrygg(u, ktx)) continue;
                for (const blad of ktx.feil) funn.push({ fil: rel, linje, uttrykk: blad });
            }
        }
    }
    return { funn, sinker, filer };
}

const { funn, sinker, filer } = skann();
const uerklært = funn.filter(f => !(`${f.fil}:${f.uttrykk}` in GODTATT));
const erklært = funn.filter(f => `${f.fil}:${f.uttrykk}` in GODTATT);

if (require.main === module) {
    const alle = process.argv.includes('--alle');
    console.log(`${filer.length} filer, ${sinker} HTML-sinker`);
    console.log(`  uescapede interpolasjoner : ${funn.length}`);
    console.log(`  av dem: vurdert og godtatt: ${erklært.length}`);
    console.log(`  av dem: UERKLÆRT          : ${uerklært.length}`);
    if (alle && erklært.length) {
        console.log('\nGODTATT:');
        for (const f of erklært) console.log(`  ${f.fil}:${f.linje}  ${f.uttrykk}\n      ${GODTATT[`${f.fil}:${f.uttrykk}`]}`);
    }
    if (uerklært.length) {
        console.log('\nUERKLÆRT — escape dem, eller før dem opp i GODTATT med en begrunnelse:');
        for (const f of uerklært) console.log(`  ${f.fil}:${f.linje}  ${f.uttrykk}`);
        process.exitCode = 1;
    }
}

module.exports = { skann, erTrygg, grener, interpolasjoner, lokaleVariabler, GODTATT, HTML_PRODUSENTER, TRYGGE };
