/**
 * Kokeboka for prod v3 — kommandoene skal kunne limes inn og virke.
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

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
