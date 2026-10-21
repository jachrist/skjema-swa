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
const BASHISMER = [
    [/^\s*[A-Z_][A-Z0-9_]*=/, 'VAR=verdi (PowerShell: $VAR = ...)'],
    [/\bfor\s+\w+\s+in\b.*;\s*do\b/, 'for … in …; do (PowerShell: foreach)'],
    [/\bdone\s*$/, 'done'],
    [/\|\s*xargs\b/, 'xargs'],
    [/\|\s*sort\s*$/, '| sort (PowerShell: Sort-Object)'],
    [/\bexport\s+[A-Z_]+=/, 'export VAR='],
    [/\bumask\b/, 'umask (ingen motsvarighet i PowerShell)'],
    [/\|\s*jq\b/, 'jq (PowerShell: ConvertFrom-Json)'],
    [/\bbase64\s+-d\b/, 'base64 -d (PowerShell: [Convert]::FromBase64String)'],
    [/\bshred\b/, 'shred (finnes ikke i PowerShell)'],
    [/\bmktemp\b/, 'mktemp (PowerShell: GetTempPath + New-Item)']
];

{
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
    //
    // Regelen gjelder BLOKKA, ikke linja. Dokumentets egen konvensjon er
    // argumentlister over flere linjer — «'appsettings', 'list',» og
    // «'--query', '[].name',» står da på hver sin linje, og en linjevis
    // regel ville forbudt nettopp den formen dokumentet anbefaler. Den
    // feilet 21.10.2026, da 4.2 ble skrevet om til en argumentliste.
    const lesBlokker = alle.filter(b => {
        const samlet = b.linjer.map(l => l.tekst).join('\n');
        return /appsettings['",\s]+list/.test(samlet);
    });
    sjekk('appsettings list leses i dokumentet', lesBlokker.length > 0, true);
    sjekk('og bare navnene hentes ut',
        lesBlokker.filter(b => !/\[\]\.name/.test(b.linjer.map(l => l.tekst).join('\n')))
            .map(b => b.fra), []);
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

// ---------- 6. formene står likt FIRE steder ----------
//
// `vis-appsettings.js` grupperer etter form, `env-inventar.test.js` godtar et
// sett former, hver miljøfil beskriver dem i `_kommentar`, og kokeboka har
// dem som en tabell i kapittel 4. Fire lister over det samme er feilklassen
// dette repoet lager flest av — her leses ALLE, og de skal svare likt.
//
// 20.10.2026 var de uenige om MER enn navnet: env-filene definerte
// `settes_i_swa` som «verdien hører ikke hjemme i repoet», mens skriptet og
// kokeboka skrev den ut som «hører hjemme på SWA-ressursen, ikke på Function
// App-en». Den siste er feil i dev og prod v3, der API-et ER Function
// App-en — og seks av de sju variablene leses av API-et selv. Navnet er nå
// `settes_direkte`, og denne testen holder de fire listene sammen.
{
    const { FORMER } = require('../../scripts/vis-appsettings.js');
    const former = Object.keys(FORMER).sort();

    const inventar = fs.readFileSync(path.join(rot, 'api', 'test', 'env-inventar.test.js'), 'utf8');
    const m = /const FORMER = \[([^\]]*)\]/.exec(inventar);
    sjekk('fant FORMER i env-inventar.test.js', !!m, true);
    const fraTest = [...(m?.[1] || '').matchAll(/'(\w+)'/g)].map(x => x[1]).sort();
    sjekk('env-inventar.test.js har de samme formene', fraTest, former);

    // Miljøfilenes egen beskrivelse. `{"keyvault": "navn"}`, `{"valgfri"}` …
    for (const miljo of ['dev', 'pilot', 'prod']) {
        const d = JSON.parse(fs.readFileSync(path.join(rot, 'config', `env.${miljo}.json`), 'utf8'));
        const iKommentar = [...new Set([...String(d._kommentar || '')
            .matchAll(/\{"([a-z_]+)"/g)].map(x => x[1]))].sort();
        sjekk(`env.${miljo}.json beskriver de samme formene`, iKommentar, former);
    }

    // Kokebokas tabell i kapittel 4. Den er det operatøren følger.
    const fraKokebok = [...new Set([...tekst
        .matchAll(/^\| `([a-z_]+)` \| [^|]*\|$/gm)].map(x => x[1]))]
        .filter(n => former.includes(n) || /^[a-z_]+$/.test(n));
    sjekk('kokeboka lister de samme formene',
        former.filter(f => !fraKokebok.includes(f)), []);

    // Og navnet som løy, skal ikke finnes noe sted igjen.
    const steder = ['scripts/vis-appsettings.js', 'docs/KOKEBOK-PROD-V3.md',
        'config/env.dev.json', 'config/env.pilot.json', 'config/env.prod.json',
        'config/keyvault-secrets.md'];
    sjekk('ingen bruker det gamle formnavnet',
        steder.filter(f => fs.readFileSync(path.join(rot, f), 'utf8').includes('settes_i_swa')), []);
}

// ---------- 6.1 kokeboka navngir hver settes_direkte API-et leser ----------
//
// Det var ikke etiketten alene som var feil: den sendte seks variabler til
// SWA-ressursen, der API-et i v3 aldri leser dem. Utfallet ville vært en prod
// uten administratorer, uten identitetsbasert lagring og uten Graph-backup.
//
// Testen leser hvem som faktisk leser dem: en `settes_direkte` som finnes i
// `api/src` SKAL være navngitt i kapittel 4.3. Legges det til en ny, blir
// denne rød — og det er lista som driver, ikke teksten.
{
    const prod = JSON.parse(fs.readFileSync(path.join(rot, 'config', 'env.prod.json'), 'utf8'));
    const direkte = Object.keys(prod).filter(n => !n.startsWith('_') && prod[n] && prod[n].settes_direkte);
    sjekk('det finnes settes_direkte-oppføringer å sjekke', direkte.length > 0, true);

    // Hele api/src som én tekst. Variablene leses dels som `process.env.X`,
    // dels gjennom `les('X')` — så navnet, ikke formen, er det vi leter etter.
    const kilde = (function samle(mappe) {
        return fs.readdirSync(mappe, { withFileTypes: true }).flatMap(e => {
            const p = path.join(mappe, e.name);
            return e.isDirectory() ? samle(p) : (e.name.endsWith('.js') ? [fs.readFileSync(p, 'utf8')] : []);
        });
    })(path.join(rot, 'api', 'src')).join('\n');

    const fra = tekst.indexOf('### 4.3');
    const til = tekst.indexOf('\n## 5.', fra);
    sjekk('kapittel 4.3 finnes', fra > 0 && til > fra, true);
    const kap = tekst.slice(fra, til);

    const lest = direkte.filter(n => new RegExp(`(process\\.env\\.${n}\\b|les\\('${n}')`).test(kilde));
    sjekk('noen av dem leses av API-et', lest.length > 0, true);
    sjekk('og 4.3 navngir hver av dem', lest.filter(n => !kap.includes(n)), []);

    // Unntaket skal stå som et unntak, ikke mangle. AAD_CLIENT_ID leses av
    // SWA-ens auth-blokk, og en kopi på Function App-en kan drive fra
    // originalen — samme grunn env.dev.json oppgir.
    sjekk('og peker AAD_CLIENT_ID til SWA-ressursen',
        /AAD_CLIENT_ID[\s\S]{0,200}SWA/.test(kap), true);
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

// ---------- 11. delt ressursgruppe: scopet og slettingen ----------
//
// v2 og v3 kan dele ressursgruppe (0.3). Da er to linjer i dokumentet
// forskjellen mellom et avgrenset deploy-scope og en GitHub-hemmelighet som
// rekker over produksjonsdata — og mellom en riving av v3 og en riving av
// begge. Begge er lette å «forenkle» tilbake.
{
    const scopes = [...tekst.matchAll(/^\$scope\s*=\s*"([^"]+)"/gm)].map(m => m[1]);
    sjekk('dokumentet setter et $scope', scopes.length > 0, true);

    // Et scope som stopper på ressursgruppa treffer v2 også.
    sjekk('ingen $scope stopper på ressursgruppa',
        scopes.filter(s => /resourceGroups\/\$RG\s*$/.test(s)), []);
    sjekk('hvert $scope peker på en navngitt ressurs',
        scopes.filter(s => !s.includes('/providers/')), []);

    // Og rivingen skal ikke kunne ta gruppa.
    const gruppesletting = alle.flatMap(b => b.linjer)
        .filter(l => /\baz\s+group\s+delete\b/.test(l.tekst))
        .map(l => `${KOKEBOK}:${l.nr}`);
    sjekk('kokeboka river aldri hele ressursgruppa', gruppesletting, []);

    // Rivingen finnes, og den sletter ved navn — ellers er sjekken over
    // grønn fordi kapittelet er borte.
    sjekk('rivingen sletter ressurser ved navn',
        /az staticwebapp delete --name \$SWA/.test(tekst)
        && /az storage account delete --name \$DATA/.test(tekst), true);
}

// ---------- 12. BACKUP-SHAREPOINT.md er også PowerShell ----------
//
// 19.10.2026 ble dev-oppskriften for sertifikatet skrevet i Bash, med `jq`.
// Brukeren står i PowerShell-Cloud Shell: «The term 'jq' is not recognized».
// Konverteringsoppskriften i samme dokument brukte `umask`, `base64 -d` og
// `shred` — alle tre uten motsvarighet der.
//
// Kokeboka har hatt regelen siden 18.10. Dette dokumentet gir like
// operative kommandoer og skal holdes til den samme.
{
    const FIL = 'docs/BACKUP-SHAREPOINT.md';
    const linjer = fs.readFileSync(path.join(rot, FIL), 'utf8').split('\n');

    // `http`-blokkene er forespørselseksempler, ikke kommandoer. Regelen
    // gjelder blokker noen skal KJØRE.
    const erKommando = (l) => /^\s*(az|gh|node|npm|curl|git|openssl|\$\w+\s+=)/.test(l);

    const blokker = [];
    let aapen = null;
    linjer.forEach((l, i) => {
        const start = /^```(\w*)\s*$/.exec(l);
        if (start && !aapen) { aapen = { sprak: start[1], linjer: [] }; return; }
        if (/^```\s*$/.test(l) && aapen) { blokker.push(aapen); aapen = null; return; }
        if (aapen) aapen.linjer.push({ nr: i + 1, tekst: l });
    });

    const medKommando = blokker.filter(b => b.linjer.some(x => erKommando(x.tekst)));
    sjekk('det finnes kommandoblokker å sjekke', medKommando.length > 2, true);

    sjekk('hver kommandoblokk er powershell',
        medKommando.filter(b => b.sprak !== 'powershell').map(b => `${FIL}: «${b.sprak || 'umerket'}»`), []);

    const bashismer = [];
    for (const b of medKommando) {
        for (const l of b.linjer) {
            for (const [m, hva] of BASHISMER) {
                if (m.test(l.tekst)) bashismer.push(`${FIL}:${l.nr}: ${hva}`);
            }
        }
    }
    sjekk('ingen bash-isme i kommandoene', bashismer, []);
}

// ---------- 11. den utskrevne kommandoen kan limes inn igjen ----------
//
// `steg1-funcapp.ps1` skriver ut hver az-kommando før den kjører den, og det
// er den utskriften folk kopierer når noe feiler. `-join ' '` alene gir
//
//     az role assignment create --role Storage Table Data Contributor ...
//
// og limes den tilbake, leser az bare «Storage» som rollenavn og klager over
// «unrecognized arguments». Kallet var riktig hele tiden — utskriften var det
// ikke. 21.10.2026 ble nettopp en slik linje limt inn i en feilsøking.
{
    const skript = fs.readFileSync(path.join(rot, 'scripts', 'steg1-funcapp.ps1'), 'utf8');

    sjekk('det finnes en funksjon som siterer argumentene',
        /function Som-Kommando/.test(skript), true);
    sjekk('og den siterer det som har mellomrom',
        /\$a -match '\[\\s"\]'/.test(skript), true);

    // Utskriften og feilmeldingen skal BEGGE bruke den — en av dem alene
    // etterlater halve problemet.
    const fra = skript.indexOf('function Kjør-Az');
    const til = skript.indexOf('\nif ($Trinn', fra);
    const kjor = skript.slice(fra, til);
    sjekk('utskriften bruker den', /Write-Host "-> az \$\(Som-Kommando \$Argumenter\)"/.test(kjor), true);
    sjekk('tørrkjøringen bruker den', /Write-Host "   az \$\(Som-Kommando \$Argumenter\)"/.test(kjor), true);
    sjekk('og feilmeldingen bruker den',
        /throw "az feilet: \$\(Som-Kommando \$Argumenter\)"/.test(kjor), true);

    // Ingen rå -join igjen i de tre. En glemt forekomst er nøyaktig den
    // linja noen kommer til å kopiere.
    sjekk('ingen rå join igjen i Kjør-Az',
        /\$Argumenter -join ' '/.test(kjor), false);
}

// ---------- 12. ressursgruppa sjekkes FØRST ----------
//
// Azure svarer `AuthorizationFailed` på en ressursgruppe som ikke finnes, med
// «or the scope is invalid» til slutt. Du kan være Owner på gruppa du TROR du
// jobber i, og få en rettighetsfeil på en gruppe som aldri ble opprettet.
//
// 21.10.2026 bar `$p` navnet fra kokebokas gamle navnetabell
// (`rg-skjema-3-prod`) mens beslutningen var å gjenbruke `fhs-prod-rg-01`.
// Lagringskontonavn er globalt unike, så `az` meldte «will continue to update
// the existing account» og feilet deretter på gruppa. En halvtime gikk til
// rolletildelinger som var helt i orden.
{
    const skript = fs.readFileSync(path.join(rot, 'scripts', 'steg1-funcapp.ps1'), 'utf8');

    sjekk('skriptet spør om ressursgruppa finnes',
        /az group exists --name \$Rg/.test(skript), true);

    // FØR trinn 1. Står den etter, har de fire første kommandoene alt feilet
    // med den villedende meldingen.
    const iSjekk = skript.indexOf('az group exists --name $Rg');
    const iTrinn1 = skript.indexOf('== 1. Lagringskonto');
    sjekk('sjekken står før trinn 1', iSjekk > -1 && iSjekk < iTrinn1, true);

    // Og den må STOPPE en ekte kjøring — en advarsel alene er ingenting når
    // alt under feiler uansett.
    const iKast = skript.indexOf('throw "Ressursgruppa $Rg finnes ikke"');
    sjekk('en ekte kjøring stopper', iKast > -1, true);
    sjekk('og bare den ekte', /if \(\$Kjor\) \{ throw "Ressursgruppa/.test(skript), true);

    // Meldingen må navngi den villedende feilen, ellers gjentas feilsøkingen
    // neste gang noen treffer den fra en annen retning.
    sjekk('meldingen nevner den villedende Azure-feilen',
        /AuthorizationFailed[\s\S]{0,120}scope is invalid/.test(skript), true);
}

// ---------- 13. sluttmeldingen hører til trinnet som ble kjørt ----------
//
// «Prøven» gjelder etter LENKINGEN: den ber deg kalle /api/ping på SWA-URL-en
// og se at `headerMottatt` blir true. Blokka sto utenfor alle trinn-vaktene,
// så den ble skrevet ut også etter `-Trinn funcapp` — der ingen SWA finnes og
// ingenting er lenket. Da ber skriptet deg prøve en URL som ikke er
// opprettet, og det leses som at man har hoppet over et steg. Meldt
// 21.10.2026.
{
    const skript = fs.readFileSync(path.join(rot, 'scripts', 'steg1-funcapp.ps1'), 'utf8');

    const iProve = skript.indexOf('== Prøven ==');
    sjekk('prøven finnes', iProve > -1, true);

    // Den må ligge bak en vakt for 'lenk'. Formen er `if ($Trinn -eq 'lenk')`
    // rett før blokka.
    const foran = skript.slice(Math.max(0, iProve - 400), iProve);
    sjekk('prøven står bak en vakt for lenk',
        /if \(\$Trinn -eq 'lenk'\) \{/.test(foran), true);

    // Og funcapp skal ha sin EGEN avslutning. Uten den sier skriptet
    // ingenting om hva som er gjort og hva som kommer.
    sjekk('funcapp har sin egen sluttmelding',
        /if \(\$Trinn -eq 'funcapp'\) \{[\s\S]{0,200}Ferdig med trinn 3/.test(skript), true);

    // Den må si at 404 fra /api/ping er forventet før deploy. Uten det ser
    // et uferdig oppsett ut som en feil.
    sjekk('og sier at 404 før deploy er forventet',
        /404[\s\S]{0,120}forventet/.test(skript), true);

    // `--assignee` vil ha en PRINSIPAL-ID. Gir man navnet på identiteten,
    // svarer az «Cannot find user or service principal in graph database» —
    // som ser ut som at identiteten mangler, rett etter at skriptet har
    // opprettet den. Jeg skrev nettopp den feilen inn i sluttmeldingen
    // 21.10.2026, og den ble truffet med én gang.
    sjekk('kontrollkommandoen bruker prinsipal-ID-en',
        /role assignment list --assignee \$principal/.test(skript), true);
    sjekk('og ikke navnet på identiteten',
        /role assignment list --assignee \$Identitet/.test(skript), false);
    sjekk('og meldingen forklarer forskjellen',
        /PRINSIPAL-ID[\s\S]{0,200}Cannot find user or service principal/.test(skript), true);
}

// ---------- 14. kapittel 4 har et ferdig-kriterium ----------
//
// «Kommandoene over er eksempler på formen, ikke lista» — inventaret er
// fasiten, og prod har 32 settings som må ha en verdi. Men 4.2 sa bare
// «kontroller uten å lekke», og da er det ingen måte å vite at man er
// ferdig. 21.10.2026 var spørsmålet «er det ikke flere kommandoer igjen i
// kapittel 4?», og svaret var nei — det var 30 igjen.
{
    const { MA_SETTES } = require('../../scripts/vis-appsettings.js');
    sjekk('skriptet vet hva som må settes', MA_SETTES.length, 3);
    sjekk('og det er formene som trenger en verdi', MA_SETTES.sort(),
        ['keyvault', 'settes_direkte', 'value']);

    sjekk('kokeboka bruker --navn til sammenligningen',
        /vis-appsettings\.js prod --navn/.test(tekst), true);
    sjekk('og sammenligner mot det som står på verten',
        /Compare-Object/.test(tekst), true);

    // Tabellen som forklarer utfallet. Uten den er `<=` og `=>` to tegn de
    // fleste må slå opp, midt i et oppsett.
    sjekk('utfallet av Compare-Object er forklart',
        /`<=`[\s\S]{0,200}`=>`/.test(tekst), true);
    sjekk('og en tom utskrift betyr ferdig',
        /tom utskrift[\s\S]{0,40}ferdig/.test(tekst), true);
}

// ---------- 15. kommandogeneratoren setter ingenting selv ----------
//
// 22 Key Vault-referanser skrevet for hånd er 22 sjanser til en skrivefeil
// som først viser seg når appen prøver å løse dem. `--kommandoer` genererer
// dem — men den SKRIVER dem ut, den kjører dem ikke. Et skript som endrer
// prod uten at noen har lest kommandoen, er et annet slags verktøy.
{
    const kilde = fs.readFileSync(path.join(rot, 'scripts', 'vis-appsettings.js'), 'utf8');

    sjekk('generatoren finnes', /function skrivKommandoer/.test(kilde), true);

    // Den må ikke kjøre az. Hele kontrakten er at et menneske limer inn.
    sjekk('den kjører ingenting selv',
        /execSync|spawnSync|child_process/.test(kilde), false);

    // Vaultnavnet er påkrevd. Uten det blir referansene ugyldige, og feilen
    // viser seg først når appen prøver å løse dem.
    sjekk('vaultnavnet er påkrevd',
        /--kommandoer krever --vault/.test(kilde), true);

    // --output none på de genererte kommandoene: uten den skriver az ut ALLE
    // app settings, inkludert de hemmelige.
    const genStart = kilde.indexOf('function skrivKommandoer');
    const gen = kilde.slice(genStart, kilde.indexOf('\nif (require.main', genStart));
    const settKall = [...gen.matchAll(/appsettings','set'[\s\S]{0,200}?az @arg/g)];
    sjekk('det genereres set-kommandoer', settKall.length > 0, true);
    sjekk('og alle har --output none',
        settKall.filter(m => !/'--output','none'/.test(m[0])).length, 0);

    // Instansspesifikke verdier skal IKKE settes automatisk.
    sjekk('SWA_URL holdes utenfor', /INSTANSSPESIFIKKE[\s\S]{0,80}'SWA_URL'/.test(kilde), true);
    sjekk('og kokeboka sier hvorfor',
        /SWA_URL` settes ikke automatisk/.test(tekst), true);

    // Og dokumentet må vise kallet, ellers finnes generatoren uten at noen
    // vet om den.
    sjekk('kokeboka viser kallet',
        /vis-appsettings\.js prod --kommandoer --vault/.test(tekst), true);
}

// ---------- 16. datoen --expires får, er oversatt ----------
//
// 21.10.2026: `az keyvault certificate show --query attributes.expires -o tsv`
// gir `2031-10-19T10:52:53+00:00`, og `az keyvault secret set --expires`
// avviste den: «invalid datetime_type value». `datetime_type` i
// keyvault-modulen prøver fire strptime-former, og alle fire krever `Z` —
// en forskyvning finnes ikke blant dem.
//
// Regelen testen holder: variabelen `--expires` får, kan ikke VÆRE den som
// leser az-utskriften. Skriver noen kommandoen tilbake til den korte
// formen, blir denne rød — ikke kjøringen i prod.
{
    const fra = tekst.indexOf('Slik legges den konverterte PEM-en inn');
    const til = tekst.indexOf('Slik utstedes det, hvis det skal lages nytt');
    sjekk('fant avsnittet om den konverterte PEM-en', fra > 0 && til > fra, true);
    const pem = tekst.slice(fra, til);

    // Formkravene gjelder KOMMANDOEN, ikke prosaen rundt. Første forsøk
    // leste hele avsnittet, og `+ 'Z'` i tabellteksten gjorde sjekken blind:
    // mutasjonen som flyttet Z inn i formatstrengen ble ikke rød.
    const foerLinjer = tekst.slice(0, fra).split('\n').length;
    const kode = alle.find(b => b.fra > foerLinjer
        && b.linjer.some(l => /'--expires'/.test(l.tekst)));
    sjekk('fant kommandoen som setter secreten', !!kode, true);
    const kommando = kode ? kode.linjer.map(l => l.tekst).join('\n') : '';

    const raa = /\$(\w+)\s*=\s*az keyvault certificate show[^\n]*attributes\.expires/.exec(kommando);
    sjekk('utløpsdatoen leses av sertifikatet', !!raa, true);

    const brukt = /'--expires',\s*\$(\w+)/.exec(kommando);
    sjekk('og sendes til --expires', !!brukt, true);

    if (raa && brukt) {
        sjekk('--expires får ikke az-utskriften direkte', brukt[1] !== raa[1], true);

        // Og den må komme FRA den rå verdien — ellers er det en annen dato.
        const konvertering = new RegExp(
            '\\$' + brukt[1] + '\\s*=[^\\n]*\\$' + raa[1]);
        sjekk('den oversatte verdien utledes av den rå',
            konvertering.test(kommando), true);
    }

    // Formen må være Z-formen av de fire az godtar, og uten brøkdelssekunder
    // (`%Y-%m-%dT%H:%M:%SZ` har ingen plass til dem).
    sjekk('formen er sekundpresis UTC',
        /yyyy-MM-ddTHH:mm:ss'\)/.test(kommando), true);
    sjekk('og Z står utenfor formatstrengen', /\+ 'Z'/.test(kommando), true);
    sjekk('og det står hvorfor Z ikke står inni',
        /ikke et formattegn/.test(pem), true);

    // Feilmeldingen selv, slik man kan søke på den.
    sjekk('feilmeldingen står i dokumentet',
        /invalid datetime_type value/.test(pem), true);
    sjekk('og formen az skriver, som utløste den',
        /\+00:00/.test(pem), true);

    // Tekstbyttet er den nærliggende løsningen, og den er stille gal utenfor
    // UTC. Avvisningen må stå, ellers kommer den tilbake.
    sjekk('tekstbyttet er navngitt og avvist',
        /-replace[\s\S]{0,40}00:00[\s\S]{0,400}\+02:00/.test(pem), true);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
