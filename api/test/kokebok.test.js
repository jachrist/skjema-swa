/**
 * Kommandoer folk klipper og limer — kokeboka, dokumentene og skriptene.
 *
 * Dokumentet skal kjøres i et arbeidsmøte, av noen som klipper og limer. Da
 * er en feil i formen like dyr som en feil i innholdet, og den oppdages på
 * verst tenkelige tidspunkt.
 *
 * Første utgave blandet to skall: bash-blokker med bakstrek som
 * fortsettelsestegn, og PowerShell-blokker med backtick. **`\` fortsetter
 * ikke en linje i PowerShell** — den leses som et tegn i argumentet, og
 * feilen peker et helt annet sted. `VAR=verdi`, `for … do … done` og `xargs`
 * finnes heller ikke der.
 *
 * Fire krav:
 *
 *   **Ett skall.** Alle kodeblokker er `powershell`.
 *
 *   **Ingen fortsettelsestegn i det hele tatt.** Verken bakstrek eller
 *   backtick. Lange kommandoer står på én linje, eller som en argumentliste i
 *   parentes — en parentes holder uttrykket åpent uten noe tegn på slutten.
 *   En backtick er dessuten usynlig: et mellomrom etter den slår den av, og
 *   klipp-og-lim legger ofte igjen ett.
 *
 *   **Ingen bash-isme.** Formene som ser like ut i de to skallene, men
 *   oppfører seg ulikt, er de farlige.
 *
 *   **Hemmelighetene lekker ikke.** Hver `appsettings`-kommando som setter
 *   noe, har `--output none`.
 *
 * Fra 18.10.2026 dekker fila også RESTEN av repoet, med en mildere regel.
 * Bakgrunnen er at den samme feilen fanst flere steder: tre umerkede
 * kodeblokker i beslutningsdokumentet, der fortsettelsestegnet var eneste
 * hint om hvilket skall som gjaldt — og de var ikke enige med hverandre.
 * `steg1-funcapp.ps1` SKREV UT kommandoer med backtick-fortsettelse, og
 * hjelpeteksten viste det samme.
 *
 * Den mildere regelen: en kodeblokk med en kommando i skal være MERKET med
 * språk, og fortsettelsestegnet skal passe til merkingen. En `\` i bash er
 * riktig; en backtick i PowerShell er riktig. Det er blandingen, og det
 * umerkede, som koster tid.
 *
 * Kjøres med:  node api/test/kokebok.test.js
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
const KOKEBOK = 'docs/KOKEBOK-PROD-V3.md';
const tekst = fs.readFileSync(path.join(rot, KOKEBOK), 'utf8');
const linjer = tekst.split('\n');

/** Kodeblokkene, med språket de er merket med. */
function blokker() {
    const ut = [];
    let aapen = null;
    linjer.forEach((l, i) => {
        const start = /^```(\w*)\s*$/.exec(l);
        if (start && !aapen) { aapen = { sprak: start[1], fra: i + 1, linjer: [] }; return; }
        if (/^```\s*$/.test(l) && aapen) { ut.push(aapen); aapen = null; return; }
        if (aapen) aapen.linjer.push({ nr: i + 1, tekst: l });
    });
    return ut;
}

const alle = blokker();
sjekk('dokumentet har kodeblokker', alle.length > 5, true);

// ---------- 1. ett skall ----------
{
    const sprak = [...new Set(alle.map(b => b.sprak))].sort();
    sjekk('alle kodeblokker er powershell', sprak, ['powershell']);
}

// ---------- 2. ingen fortsettelsestegn ----------
{
    const med = [];
    for (const b of alle) {
        for (const l of b.linjer) {
            if (/[\\`]\s*$/.test(l.tekst)) med.push(`${KOKEBOK}:${l.nr}`);
        }
    }
    sjekk('ingen linje i en kodeblokk slutter på \\ eller backtick', med, []);
}

// ---------- 3. ingen bash-isme ----------
//
// Hver av disse SER ut som den virker i PowerShell, og gjør det ikke.
{
    const BASHISMER = [
        [/^\s*[A-Z_][A-Z0-9_]*=/, 'VAR=verdi (PowerShell: $VAR = ...)'],
        [/\bfor\s+\w+\s+in\b.*;\s*do\b/, 'for … in …; do (PowerShell: foreach)'],
        [/\bdone\s*$/, 'done'],
        [/\|\s*xargs\b/, 'xargs'],
        [/\|\s*sort\s*$/, '| sort (PowerShell: Sort-Object)'],
        [/\bexport\s+[A-Z_]+=/, 'export VAR=']
    ];
    const funnet = [];
    for (const b of alle) {
        for (const l of b.linjer) {
            for (const [m, hva] of BASHISMER) {
                if (m.test(l.tekst)) funnet.push(`${KOKEBOK}:${l.nr}: ${hva}`);
            }
        }
    }
    sjekk('ingen bash-isme i kommandoene', funnet, []);
}

// ---------- 4. hemmelighetene lekker ikke ----------
{
    const utenStille = [];
    for (const b of alle) {
        for (const l of b.linjer) {
            // Bare kommandoer som SETTER noe. `list --query "[].name"` skal
            // ikke ha --output none; den er nettopp kontrollen.
            if (!/appsettings\s+set/.test(l.tekst)) continue;
            if (!/--output\s+none/.test(l.tekst)) utenStille.push(`${KOKEBOK}:${l.nr}`);
        }
    }
    sjekk('hver appsettings set har --output none', utenStille, []);

    // Og kontroll-lesningen skal ikke hente ut verdier.
    const leser = alle.flatMap(b => b.linjer).filter(l => /appsettings\s+list/.test(l.tekst));
    sjekk('appsettings list leses i dokumentet', leser.length > 0, true);
    sjekk('og bare navnene hentes ut',
        leser.filter(l => !/\[\]\.name/.test(l.tekst)).map(l => l.nr), []);
}

// ---------- 5. alt dokumentet peker på, finnes ----------
{
    const filer = [...new Set([...tekst.matchAll(/`(scripts\/[\w./-]+|config\/[\w./-]+)`/g)]
        .map(m => m[1]))];
    sjekk('dokumentet peker på filer i repoet', filer.length > 2, true);
    sjekk('og alle finnes',
        filer.filter(f => !fs.existsSync(path.join(rot, f))).sort(), []);

    // Skriptene det faktisk kjører, navngitt hver for seg: en generell
    // «finnes»-sjekk over alle treff ville vært grønn selv om nettopp disse
    // to forsvant fra dokumentet.
    for (const s of ['scripts/steg1-funcapp.ps1', 'scripts/vis-appsettings.js']) {
        sjekk(`${s} kjøres fra kokeboka`, tekst.includes(s), true);
        sjekk(`${s} finnes`, fs.existsSync(path.join(rot, s)), true);
    }
}

// ---------- 6. formene står likt to steder ----------
//
// `vis-appsettings.js` grupperer etter form, og `env-inventar.test.js` godtar
// et sett former. To lister over det samme er feilklassen dette repoet lager
// flest av — her leses BEGGE, og de skal svare likt.
{
    const { FORMER } = require('../../scripts/vis-appsettings.js');
    const inventar = fs.readFileSync(path.join(rot, 'api', 'test', 'env-inventar.test.js'), 'utf8');
    const m = /const FORMER = \[([^\]]*)\]/.exec(inventar);
    sjekk('fant FORMER i env-inventar.test.js', !!m, true);
    const fraTest = [...(m?.[1] || '').matchAll(/'(\w+)'/g)].map(x => x[1]).sort();
    sjekk('de to listene over former er like', Object.keys(FORMER).sort(), fraTest);
}

// ---------- 7. vis-appsettings skriver aldri ut en verdi ----------
{
    const { grupper } = require('../../scripts/vis-appsettings.js');
    const prod = JSON.parse(fs.readFileSync(path.join(rot, 'config', 'env.prod.json'), 'utf8'));
    const { grupper: g, uten } = grupper(prod);

    sjekk('ingen oppføring har ukjent form', uten, []);
    const antall = Object.values(g).reduce((n, l) => n + l.length, 0);
    const noklerIFila = Object.keys(prod).filter(n => !n.startsWith('_')).length;
    sjekk('hver oppføring havner i nøyaktig én gruppe', antall, noklerIFila);

    // Utskriften skal bære navn og secret-navn — aldri en verdi. En lekket
    // verdi herfra ville stått på en skjerm i et møterom.
    const verdier = Object.values(prod)
        .map(v => v && v.value)
        .filter(v => typeof v === 'string' && v.length > 3);
    const utskrift = Object.values(g).flat().join('\n');
    sjekk('det finnes verdier å lekke i fila', verdier.length > 0, true);
    sjekk('og ingen av dem står i utskriften',
        verdier.filter(v => utskrift.includes(v)), []);
}

// ---------- 8. resten av repoet: merket, og i ett skall per blokk ----------
{
    const dokumenter = [];
    const gaa = (katalog) => {
        for (const n of fs.readdirSync(path.join(rot, katalog), { withFileTypes: true })) {
            if (n.isDirectory()) continue;
            if (n.name.endsWith('.md')) dokumenter.push(path.join(katalog, n.name));
        }
    };
    gaa('docs');
    gaa('.');
    sjekk('det finnes dokumenter å sjekke', dokumenter.length > 5, true);

    /** Ser linja ut som en kommando noen skal kjøre? */
    // `\$\w+\s+=` krever MELLOMROM rundt likhetstegnet. Uten det traff
    // regelen `$select=userPrincipalName,...` i TEAM-CACHE-KONTRAKT.md — et
    // URL-fragment, ikke en kommando. En regel som melder falske treff blir
    // en regel folk slår av.
    const erKommando = (l) => /^\s*(az|gh|node|npm|curl|git|Connect-MgGraph|New-Mg|Get-Mg|Set-Az|\$\w+\s+=)/.test(l);

    const umerket = [];
    const feilTegn = [];
    for (const d of dokumenter) {
        const linjer = fs.readFileSync(path.join(rot, d), 'utf8').split('\n');
        let aapen = null;
        linjer.forEach((l, i) => {
            const start = /^```(\w*)\s*$/.exec(l);
            if (start && !aapen) { aapen = { sprak: start[1], linjer: [] }; return; }
            if (/^```\s*$/.test(l) && aapen) {
                if (aapen.linjer.some(x => erKommando(x.tekst)) && !aapen.sprak) {
                    umerket.push(`${d}:${aapen.linjer[0]?.nr}`);
                }
                aapen = null;
                return;
            }
            if (aapen) aapen.linjer.push({ nr: i + 1, tekst: l });
            if (!aapen) return;
            // Fortsettelsestegnet skal passe til merkingen.
            if (aapen.sprak === 'powershell' && /\\[ \t]*$/.test(l)) {
                feilTegn.push(`${d}:${i + 1}: bakstrek i powershell-blokk`);
            }
            if (aapen.sprak === 'bash' && /`[ \t]*$/.test(l)) {
                feilTegn.push(`${d}:${i + 1}: backtick i bash-blokk`);
            }
            // Og aldri et fortsettelsestegn med mellomrom etter — det er
            // usynlig, og slår tegnet av.
            if (/[\\`][ \t]+$/.test(l)) {
                feilTegn.push(`${d}:${i + 1}: fortsettelsestegn med mellomrom etter`);
            }
        });
    }
    sjekk('hver kodeblokk med en kommando er merket med språk', umerket, []);
    sjekk('fortsettelsestegnet passer til merkingen', feilTegn, []);
}

// ---------- 9. .ps1-skriptene: ingen fortsettelse i det folk kopierer ----------
{
    const ps1 = fs.readdirSync(path.join(rot, 'scripts'))
        .filter(n => n.endsWith('.ps1'));
    sjekk('det finnes .ps1-skript', ps1.length > 2, true);

    const funn = [];
    for (const navn of ps1) {
        const fil = `scripts/${navn}`;
        const linjer = fs.readFileSync(path.join(rot, fil), 'utf8').split('\n');
        let iHjelp = false;
        linjer.forEach((l, i) => {
            if (l.includes('<#')) iHjelp = true;
            if (l.includes('#>')) { iHjelp = false; return; }

            // En bakstrek fortsetter ingenting i PowerShell.
            if (/\\[ \t]*$/.test(l)) funn.push(`${fil}:${i + 1}: bakstrek`);
            // Mellomrom etter en backtick slår den av — usynlig.
            if (/`[ \t]+$/.test(l)) funn.push(`${fil}:${i + 1}: backtick med mellomrom etter`);
            // En DOBBEL backtick sist på linja er en escapet backtick — altså
            // en fortsettelse i tekst skriptet SKRIVER UT, som noen skal
            // kopiere. Samme felle, ett lag unna.
            if (/``[ \t]*$/.test(l)) funn.push(`${fil}:${i + 1}: utskrevet fortsettelsestegn`);
            // Og hjelpeteksten er ren klipp-og-lim.
            if (iHjelp && /`[ \t]*$/.test(l)) funn.push(`${fil}:${i + 1}: fortsettelse i hjelpeteksten`);
        });
    }
    sjekk('ingen fortsettelsesfelle i .ps1-skriptene', funn, []);
}

// ---------- 10. rollene står likt i skriptet og i kokeboka ----------
//
// 3.2 ber deg kontrollere at rollene er på plass, og lister hvilke. Skriptet
// tildeler dem. To kilder til samme regel — og den som leser dokumentet i et
// arbeidsmøte har ingen måte å se at skriptet er endret. Her leses BEGGE.
{
    const skript = fs.readFileSync(path.join(rot, 'scripts', 'steg1-funcapp.ps1'), 'utf8');

    // Skriptet tildeler på to former: en løkke over tre storage-roller, og én
    // literal for Key Vault. Begge må med — leser vi bare den ene, blir en
    // forsvunnet rolle usynlig.
    const fraSkript = new Set();
    for (const m of skript.matchAll(/'--role'\s*,\s*'([^']+)'/g)) fraSkript.add(m[1]);
    const lokke = /foreach\s*\(\s*\$rolle\s+in\s+@\(([^)]*)\)\s*\)/.exec(skript);
    sjekk('fant løkka over storage-rollene i steg1-funcapp.ps1', !!lokke, true);
    // ... og at løkkevariabelen faktisk er den som sendes til --role. Uten
    // denne ville navnene i @(...) blitt lest selv om løkka ikke tildelte noe.
    sjekk('løkkevariabelen sendes til --role', /'--role'\s*,\s*\$rolle/.test(skript), true);
    for (const m of (lokke?.[1] || '').matchAll(/'([^']+)'/g)) fraSkript.add(m[1]);

    // Dokumentet: tabellen rett etter ankeret i 3.2.
    const etter = tekst.split('<!-- roller-fra-steg1 -->')[1] || '';
    sjekk('ankeret <!-- roller-fra-steg1 --> finnes i kokeboka', etter !== '', true);
    const fraDok = [];
    for (const linje of etter.split('\n')) {
        if (!linje.startsWith('|')) { if (fraDok.length) break; else continue; }
        const m = /^\|\s*`([^`]+)`\s*\|/.exec(linje);
        if (m) fraDok.push(m[1]);
    }

    sjekk('kokeboka lister rollene', fraDok.length > 2, true);
    sjekk('skriptet og kokeboka lister de samme rollene',
        fraDok.slice().sort(), [...fraSkript].sort());

    // Og ingen av dem er «Contributor» — den er poenget i både skript og doc.
    sjekk('ingen av rollene er Contributor',
        [...fraSkript].filter(r => r === 'Contributor'), []);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
