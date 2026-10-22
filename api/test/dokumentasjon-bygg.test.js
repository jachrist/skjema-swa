/**
 * Dokumentasjonssiden — at den dekker alt, og at den ikke blir åpen.
 *
 * Runde 2 i `docs/DOKUMENTASJONSPLAN.md`: `docs/*.md` bygges med MkDocs til
 * `frontend/dokumentasjon/` og serveres fra SWA-en, bak Entra-innloggingen
 * som alt står der.
 *
 * Tre ting kan gå galt stille, og alle tre er verre enn en byggfeil:
 *
 *   **En rute som ikke krever innlogging.** Arkitektur, datasikring og
 *   tilgangsstyring beskriver nøyaktig det en angriper vil vite. Mangler
 *   regelen i ÉN av de fire konfigurasjonsfilene, er dokumentasjonen åpen i
 *   det ene miljøet.
 *
 *   **Et dokument som ikke står i navigasjonen.** Det bygges ikke, og det er
 *   vanskeligere å oppdage enn et dokument som mangler: siden ser komplett ut.
 *
 *   **En deploy-jobb som ikke bygger dokumentasjonen.** Da serverer det
 *   miljøet ingenting under /dokumentasjon/, eller — verre — det som lå der
 *   fra forrige gang.
 *
 * Testen kjører ikke MkDocs. Den leser koblingene: navigasjonen mot
 * filsystemet, ruteregelen mot alle fire konfigurasjoner, og hver
 * frontend-deploy mot byggeskriptet.
 *
 * Kjøres med:  node api/test/dokumentasjon-bygg.test.js
 */
const fs = require('fs');
const path = require('path');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const rot = path.join(__dirname, '..', '..');
const les = (...p) => fs.readFileSync(path.join(rot, ...p), 'utf8');
const mkdocs = les('mkdocs.yml');
const skript = les('scripts', 'bygg-dokumentasjon.sh');

// ---------- 1. navigasjonen dekker hver fil i docs/ ----------
{
    const filer = fs.readdirSync(path.join(rot, 'docs'))
        .filter(f => f.endsWith('.md')).sort();
    sjekk('det finnes dokumenter å bygge', filer.length > 10, true);

    const navStart = mkdocs.indexOf('\nnav:');
    sjekk('mkdocs.yml har en nav-seksjon', navStart > 0, true);
    const nav = mkdocs.slice(navStart);
    const iNav = [...new Set([...nav.matchAll(/([A-Za-z0-9ÆØÅæøå_.-]+\.md)\s*$/gm)].map(m => m[1]))].sort();

    sjekk('ingen dokumenter mangler i navigasjonen',
        filer.filter(f => !iNav.includes(f)), []);
    // Og motsatt: en nav-oppføring som peker på en slettet fil gjør at
    // `mkdocs build --strict` i CI feiler, uten at noen har rørt mkdocs.yml.
    sjekk('ingen nav-oppføring peker på en fil som ikke finnes',
        iNav.filter(f => !filer.includes(f)), []);

    // Forsiden må finnes: uten `index.md` får /dokumentasjon/ en 404, og
    // MkDocs setter da den første fila i nav som forside i stedet.
    sjekk('forsiden finnes', filer.includes('index.md'), true);
    sjekk('og er oppført som Start', /- Start: index\.md/.test(nav), true);

    // Forsiden er ordnet etter MÅLGRUPPE — steg 5 i planen. En forside som
    // bare lister filer er den alfabetiske mappa med ekstra steg.
    const forside = les('docs', 'index.md');
    for (const m of ['vurdere sikkerheten', 'forvalte', 'endre et skjema', 'videreutvikle']) {
        sjekk(`forsiden har en inngang for «${m}»`, forside.includes(m), true);
    }
}

// ---------- 2. utgangen er den SWA serverer, og den er gitignorert ----------
{
    const m = /^site_dir:\s*(\S+)\s*$/m.exec(mkdocs);
    sjekk('site_dir er satt', !!m, true);
    const siteDir = m ? m[1] : '';
    sjekk('den bygges inn i frontend/, som SWA laster opp',
        siteDir, 'frontend/dokumentasjon');

    sjekk('utgangen er gitignorert', les('.gitignore').includes(`${siteDir}/`), true);

    // `site_url` MÅ være utelatt. Settes den, bygger MkDocs absolutte lenker
    // mot roten, og siden ligger under /dokumentasjon/ på en vert som er ulik
    // per miljø. Da peker hver lenke feil sted — og det ser riktig ut lokalt.
    sjekk('site_url er ikke satt', /^site_url:/m.test(mkdocs), false);
    // Uten denne gir MkDocs mapper i stedet for .html-filer, og SWA trenger
    // en egen omskrivingsregel for å finne index-fila i hver mappe.
    sjekk('use_directory_urls er av', /^use_directory_urls:\s*false\s*$/m.test(mkdocs), true);
}

// ---------- 3. ruteregelen, i ALLE fire konfigurasjonene ----------
//
// Den ene som mangler, er den som gjør dokumentasjonen åpen.
{
    // Filene finnes med samme mønster som `swa-config.test.js` bruker, og av
    // samme grunn: rot-fila `staticwebapp.config.json` skrives av
    // `build-config.js` og er GITIGNORERT. En hardkodet liste med den i
    // kræsjer i CI, der klonen er frisk — og består lokalt hos den som nettopp
    // har bygget. Den valideres hvis den finnes, og kreves ikke.
    const MILJOER = ['dev', 'pilot', 'prod'];
    const KONFIGER = fs.readdirSync(rot)
        .filter(n => /^staticwebapp\.config(\.[a-z]+)?\.json$/.test(n)).sort();

    // Miljøkildene MÅ finnes. Forsvinner én, er dokumentasjonen uten
    // ruteregel i det miljøet — og det er nettopp det som ikke skal kunne
    // skje stille.
    sjekk('alle miljøkildene finnes',
        MILJOER.filter(m => !KONFIGER.includes(`staticwebapp.config.${m}.json`)), []);

    for (const f of KONFIGER) {
        const d = JSON.parse(les(f));
        const treff = (d.routes || []).filter(r => r.route === '/dokumentasjon/*');
        sjekk(`${f}: har én regel for /dokumentasjon/*`, treff.length, 1);
        if (treff.length !== 1) continue;
        sjekk(`${f}: krever innlogging`, treff[0].allowedRoles, ['authenticated']);
        // CLAUDE.md: `methods` på en ruteregel får SWA til å avvise HELE
        // konfigurasjonen — og da mister vi alle ruteregler, ikke bare denne.
        sjekk(`${f}: ingen methods på regelen`, 'methods' in treff[0], false);
        // Jokertegn bare på SLUTTEN av en rute. En rute som
        // «/dokumentasjon/*/pdf» ville tatt ned hele fila på samme måte.
        sjekk(`${f}: jokertegnet står sist`,
            /^[^*]*\*?$/.test(treff[0].route), true);
        // En manglende side under /dokumentasjon/ skal gi 404, ikke
        // app-skallet. Uten dette svarer en død lenke med velgskjematype.html.
        sjekk(`${f}: navigationFallback hopper over dokumentasjonen`,
            (d.navigationFallback?.exclude || []).includes('/dokumentasjon/*'), true);
    }
}

// ---------- 4. hver frontend-deploy bygger dokumentasjonen ----------
//
// SWA laster opp `app_location`. En jobb som laster opp ./frontend uten å ha
// bygget dokumentasjonen, serverer ingenting under /dokumentasjon/ i det
// miljøet — eller det som tilfeldigvis lå igjen.
{
    const mappe = path.join(rot, '.github', 'workflows');
    const filer = fs.readdirSync(mappe).filter(f => f.endsWith('.yml'));
    const frontendJobber = filer.filter(f =>
        /app_location:\s*"\.\/frontend"/.test(fs.readFileSync(path.join(mappe, f), 'utf8')));

    // Antallet er bare en forsikring om at skanningen fant noe — regelen er
    // de to sjekkene under. Det var 3 til 22.10.2026, da deploy-pilot.yml
    // ble slått sammen med deploy-prod.yml; nå er det dev og prod/pilot.
    sjekk('fant deploy-jobbene som laster opp frontend', frontendJobber.length >= 2, true);
    const uten = frontendJobber.filter(f =>
        !fs.readFileSync(path.join(mappe, f), 'utf8').includes('bygg-dokumentasjon.sh'));
    sjekk('alle bygger dokumentasjonen først', uten, []);

    // Rekkefølgen avgjør: bygges den etter opplastingen, lastes den aldri opp.
    for (const f of frontendJobber) {
        const t = fs.readFileSync(path.join(mappe, f), 'utf8');
        sjekk(`${f}: bygget kommer før opplastingen`,
            t.indexOf('bygg-dokumentasjon.sh') < t.indexOf('static-web-apps-deploy'), true);
    }

    // CI bygger STRENGT — der skal en død lenke stoppe en PR. Deploy bygger
    // mildt: en lenkefeil i et dokument skal ikke kunne hindre at en
    // rettelse kommer ut.
    const ci = les('.github', 'workflows', 'ci.yml');
    sjekk('CI bygger med --strict', /bygg-dokumentasjon\.sh --strict/.test(ci), true);
    for (const f of frontendJobber) {
        sjekk(`${f}: deploy bygger uten --strict`,
            /bygg-dokumentasjon\.sh --strict/.test(fs.readFileSync(path.join(mappe, f), 'utf8')), false);
    }
}

// ---------- 5. byggeskriptet ----------
{
    // Versjonene skal være pinnet med ==. Material varsler selv at MkDocs 2.0
    // fjerner plugin-systemet uten migreringsvei; en flytende versjon tar ned
    // deployen den dagen, uten at noe her er endret.
    const pins = [...skript.matchAll(/^[A-Z_]+VERSJON="([^"]+)"/gm)].map(m => m[1]);
    sjekk('skriptet pinner versjoner', pins.length >= 2, true);
    sjekk('og alle er eksakte', pins.filter(p => !p.includes('==')), []);

    // PDF-lista skal peke på dokumenter som finnes.
    const m = /^PDF_DOKUMENTER=\(([^)]*)\)/m.exec(skript);
    sjekk('PDF-lista finnes', !!m, true);
    const pdfer = (m ? m[1] : '').trim().split(/\s+/).filter(Boolean);
    sjekk('PDF-lista er ikke tom', pdfer.length > 0, true);
    sjekk('og hvert dokument finnes',
        pdfer.filter(n => !fs.existsSync(path.join(rot, 'docs', `${n}.md`))), []);

    // Overleveringsdokumentet er hele poenget med PDF-utgangen.
    sjekk('overleveringsdokumentet er med', pdfer.includes('SIKKERHET-OG-ARKITEKTUR'), true);

    // En manglende pandoc eller nettleser skal SIES, ikke bare hoppes over.
    // En PDF som stille ikke ble laget, er en PDF noen tror finnes.
    sjekk('manglende pandoc gir en advarsel', /::warning::pandoc mangler/.test(skript), true);
    sjekk('manglende nettleser gir en advarsel',
        /::warning::fant ingen Chromium/.test(skript), true);

    // PDF-en skal bære dato og commit. «Hvilken versjon så evaluatoren?» har
    // ingen annen kilde enn fila selv.
    sjekk('PDF-en stemples med commit', /commit \$SHA/.test(skript), true);
    sjekk('og med dato', /bygget \$DATO/.test(skript), true);
}

// ---------- 5b. ingen test leser den bygde HTML-en som vår kode ----------
//
// Utgangen MÅ ligge under frontend/, for SWA laster opp `app_location`. Men
// seks tester går gjennom frontend-treet og leter etter regler i vår egen
// kode, og et bygget dokument som BESKRIVER en gammel formel ser derfra ut
// som kode som bruker den. `storrelse.test.js` meldte nøyaktig det
// 20.10.2026.
//
// Verre enn feilmeldingen: utfallet kom an på om noen hadde bygget
// dokumentasjonen lokalt. I CI bygges den etter testene, så den var grønn
// der. En test som svarer ulikt på to maskiner er ikke en test.
{
    const { hoppOverMappe, GENERERTE_MAPPER } = require('../../scripts/test-kilde.js');
    sjekk('regelen finnes ett sted', typeof hoppOverMappe, 'function');
    sjekk('og dekker dokumentasjonsmappa', hoppOverMappe('dokumentasjon'), true);
    sjekk('men ikke vanlige mapper', hoppOverMappe('js'), false);

    // Navnet i regelen må være det mkdocs faktisk skriver til.
    const m = /^site_dir:\s*frontend\/(\S+)\s*$/m.exec(mkdocs);
    sjekk('site_dir ligger under frontend/', !!m, true);
    sjekk('og mappenavnet er det regelen hopper over',
        m ? GENERERTE_MAPPER.has(m[1]) : false, true);

    // Og hver test som går REKURSIVT gjennom frontend, må spørre regelen.
    const mapper = [path.join(rot, 'api', 'test'), path.join(rot, 'frontend', 'test')];
    const uten = [];
    for (const mappe of mapper) {
        for (const f of fs.readdirSync(mappe).filter(n => n.endsWith('.test.js'))) {
            const kilde = fs.readFileSync(path.join(mappe, f), 'utf8');
            const rekursiv = /isDirectory\(\)/.test(kilde) && /'frontend'/.test(kilde);
            if (rekursiv && !kilde.includes('hoppOverMappe')) uten.push(f);
        }
    }
    sjekk('alle rekursive vandringer i frontend bruker regelen', uten, []);
}

// ---------- 6. unntaket fra «ingen byggsteg» er skrevet ned ----------
//
// CLAUDE.md har én regel om byggsteg. Et nytt unntak som bare finnes i en
// workflow-fil, er et unntak ingen vet om.
{
    const claude = les('CLAUDE.md');
    sjekk('CLAUDE.md nevner dokumentasjonsbygget',
        /bygg-dokumentasjon|dokumentasjon/i.test(claude.slice(0, 2000)), true);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
