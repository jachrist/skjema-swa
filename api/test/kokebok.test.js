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
    // 21.10.2026 sa 4.2 «tom utskrift = ferdig», og den testen krevde det.
    // Begge tok feil: `=>`-siden har ALLTID treff, fordi verten har sine
    // egne settinger (`AzureWebJobsStorage`, `FUNCTIONS_WORKER_RUNTIME`, og
    // timeouten fra 4.1). Et kriterium som aldri inntreffer er et kriterium
    // folk slutter å bruke — og «mener at alt er satt» er det det skulle
    // erstatte.
    sjekk('ferdig-kriteriet er at det ikke st\u00e5r noen <=',
        /ingen `<=`[\s\S]{0,40}ferdig/.test(tekst), true);
    sjekk('og dokumentet sier at utskriften ikke blir tom',
        /blir ikke tom/.test(tekst), true);

    // De forventede `=>`-navnene må STÅ der, ellers må operatøren vurdere
    // sju ukjente linjer midt i et oppsett. Navnene leses her, så en
    // forkortelse av tabellen blir rød.
    for (const navn of ['AzureWebJobsStorage', 'FUNCTIONS_WORKER_RUNTIME',
        'FUNCTIONS_EXTENSION_VERSION', 'WEBSITE_RUN_FROM_PACKAGE',
        'AzureFunctionsJobHost__functionTimeout']) {
        sjekk(`4.2 navngir ${navn} som et forventet =>`,
            tekst.includes(navn), true);
    }

    // Timeouten fra 4.1 er den ene operatøren satte selv, og den skal
    // merkes som det — ikke stå i samme bunke som plattformens egne.
    sjekk('og peker timeouten tilbake til 4.1',
        /AzureFunctionsJobHost__functionTimeout`[\s\S]{0,60}4\.1/.test(tekst), true);

    // Og et `=>` utenfor lista skal ikke kunne forbli uforklart.
    sjekk('et uventet => skal forklares',
        /ikke st\u00e5r i tabellen[\s\S]{0,60}forklares/.test(tekst), true);
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

// ---------- 17. redirect-URI-en, og at den er lagt TIL ----------
//
// 21.10.2026: forsiden til prod v3 vistes, og første pålogging endte i
// `AADSTS50011`. Spørsmålet som fulgte var «må vi ha en egen app?» — og
// svaret er nei, men kapittel 6 sa det ikke. Det sa «sin egen
// app-registrering, eller gjenbruk av v2 sin med en ny redirect-URI», altså
// begge, uten å avgjøre noe.
//
// 5.2 sa heller ikke at feilen kom. Den kommer ETTER at forsiden vistes, og
// ser derfor ut som at noe gikk i stykker etterpå.
{
    // Selve URI-formen er bundet i `swa-config.test.js`, der
    // påloggingsstien alt er en regel: leverandørsegmentet leses ut av
    // SWA-configen, som er det plattformen faktisk handler på — ikke ut av
    // én HTML-side.

    const fra = tekst.indexOf('## 6. Innlogging');
    const til = tekst.indexOf('## 7. Flytene');
    sjekk('fant kapittel 6', fra > 0 && til > fra, true);
    const kap6 = tekst.slice(fra, til);

    // Spørsmålet må besvares, ikke stilles.
    sjekk('kapittel 6 avgjør om det trengs en ny app',
        /ingen ny app-registrering/i.test(kap6), true);
    sjekk('og sier hvorfor: mange URI-er per app',
        /mange\s*\n?\s*redirect-URI-er|flere redirect-URI/i.test(kap6), true);

    // Den dyre feilen her er en kommando som SETTER lista og dermed sletter
    // v2 sine URI-er. Hvert `--web-redirect-uris` skal stå i en blokk som
    // leser de gamle først.
    const settBlokker = alle.filter(b =>
        b.fra > tekst.slice(0, fra).split('\n').length
        && b.linjer.some(l => /--web-redirect-uris/.test(l.tekst)));
    sjekk('kommandoen som setter URI-ene finnes', settBlokker.length > 0, true);
    for (const b of settBlokker) {
        const blokk = b.linjer.map(l => l.tekst).join('\n');
        sjekk(`blokka på linje ${b.fra} leser de gamle først`,
            /web\.redirectUris/.test(blokk), true);
        sjekk(`og de gamle sendes med inn (linje ${b.fra})`,
            /\$gamle/.test(blokk), true);
    }
    sjekk('og det står at flagget setter hele samlingen',
        /setter HELE samlingen/.test(kap6), true);
    sjekk('med credential reset som familien den hører til',
        /credential reset/.test(kap6), true);

    // Bestillingen: 21.10.2026 hadde operatøren ikke rollen, og måtte
    // bestille URI-en fra admin. Da er plattformvalget ute av egne hender,
    // og det er den ene detaljen som kan gjøres feil uten å synes:
    // registreres URI-en under «Single-page application», behandler Entra
    // klienten som offentlig, og innløsningen avvises ETT steg senere, med
    // en melding som ikke nevner plattformen.
    sjekk('kapittel 6 har en bestillingstekst',
        /Har du ikke rollen: bestillingen/.test(kap6), true);
    sjekk('og den krever plattformen Web',
        /plattformen \*\*Web\*\*/.test(kap6), true);
    sjekk('og avviser SPA uttrykkelig',
        /ikke «Single-page application»/.test(kap6), true);
    sjekk('og sier at de gamle skal stå igjen',
        /Legg den TIL/.test(kap6), true);

    // Og kontrollen som skiller de to utfallene. Uten den er «utført» og
    // «utført på feil plattform» samme svar.
    sjekk('kontrollen leser begge listene',
        /web\.redirectUris/.test(kap6) && /spa\.redirectUris/.test(kap6), true);

    // Preview-miljøet har sitt eget vertsnavn, og innloggingen feiler DER og
    // bare der. Det står i deploy-prod.yml; kapittel 6 må si det også, for
    // ingen leser en workflow-kommentar midt i et oppsett.
    sjekk('kapittel 6 nevner preview-vertsnavnet',
        /preview-miljø[\s\S]{0,120}vertsnavn/.test(kap6), true);

    // Og 5.2 må forberede feilen, med koden man kan søke på.
    const f52 = tekst.indexOf('### 5.2');
    const kap52 = tekst.slice(f52, tekst.indexOf('### 5.3', f52));
    sjekk('5.2 varsler at innloggingen feiler', /AADSTS50011/.test(kap52), true);
    sjekk('og peker til kapittel 6', /kapittel 6/.test(kap52), true);
    sjekk('og sier at det ikke er en mislykket deploy',
        /ikke en mislykket deploy/.test(kap52), true);
}

// ---------- 18. SWA-ens egen identitet må ha et TRINN ----------
//
// 22.10.2026: redirect-URI-en var på plass, men innloggingen feilet etter
// MFA. Kravet sto i kokeboka to steder — 0.2 («SWA-ens plattformidentitet»)
// og 0.5 — men INGEN steg slo på identiteten eller tildelte rollene. Et krav
// uten et trinn er et krav som hoppes over, og dette er den dyreste
// varianten: autoriseringen trenger ikke sertifikatet, så brukeren kommer
// gjennom passord og MFA og avvises først i kodevekslingen, som er en
// server-til-server-samtale ingen ser.
//
// Regelen: bruker en SWA-config `clientSecretCertificateKeyVaultReference`,
// MÅ kokeboka ha kommandoene som slår på identiteten og gir BEGGE rollene.
{
    const konfigene = fs.readdirSync(rot)
        .filter(n => /^staticwebapp\.config\..*\.json$/.test(n));
    const brukerKvRef = konfigene.some(n => fs
        .readFileSync(path.join(rot, n), 'utf8')
        .includes('clientSecretCertificateKeyVaultReference'));
    sjekk('en SWA-config henter sertifikatet fra Key Vault', brukerKvRef, true);

    if (brukerKvRef) {
        // Identiteten må slås PÅ et sted, ikke bare omtales.
        sjekk('kokeboka sl\u00e5r p\u00e5 identiteten',
            /az staticwebapp identity assign/.test(tekst), true);
        sjekk('og leser den f\u00f8rst, s\u00e5 trinnet kan gjentas',
            /az staticwebapp identity show/.test(tekst), true);

        // Begge rollene, i en kommando som faktisk tildeler.
        const fra = tekst.indexOf('SWA-ens egen identitet');
        sjekk('trinnet finnes som eget avsnitt', fra > 0, true);
        const trinn = tekst.slice(fra, fra + 2600);
        for (const rolle of ['Key Vault Secrets User', 'Key Vault Certificate User']) {
            sjekk(`trinnet tildeler ${rolle}`, trinn.includes(rolle), true);
        }
        sjekk('og det er en rolletildeling, ikke en tabellrad',
            /'role', 'assignment', 'create'/.test(trinn), true);

        // Og kontrollen etterpå. Én rolle av to feiler like stille som ingen.
        sjekk('trinnet kontrollerer at begge st\u00e5r der',
            /role assignment list[\s\S]{0,200}roleDefinitionName/.test(trinn), true);
        sjekk('og sier hva som forventes',
            /To linjer forventes/.test(trinn), true);

        // Diagnoserekkefølgen. Den tredje raden er den viktige: «dev har
        // ingen identitet» er et nærliggende motbevis, og det er ugyldig —
        // dev og pilot bruker clientSecretSettingName. Står ikke den
        // forskjellen her, gjentas resonnementet.
        const kap6b = tekst.slice(fra, fra + 6000);
        sjekk('diagnoserekkefølgen står der',
            /v2 logger inn/.test(kap6b), true);
        sjekk('og at fravær av rader i Entra er et funn',
            /Ingen mislykkede p\u00e5logginger/.test(kap6b), true);
        sjekk('og at dev ikke er et motbevis',
            /clientSecretSettingName/.test(kap6b), true);
        sjekk('og hvorfor: app setting mot Key Vault-referanse',
            /uten noen identitet/.test(kap6b), true);

        // Symptomet må stå der, ellers leter man i Key Vault-loggene etter
        // noe som ser ut som en Entra-feil.
        sjekk('symptomet er beskrevet', /etter MFA|etter MFA-koden/.test(trinn), true);
    }
}

// ---------- 19. $p skriver ikke navnene opp en gang til ----------
//
// 22.10.2026: Cloud Shell-økten mistet variablene midt i kjøringen, og
// `@p -Trinn lenk` stoppet med «Cannot bind argument to parameter 'Rg'
// because it is an empty string». Meldingen sender deg på jakt etter en
// variabel `$Rg` — den finnes ikke, `Rg` er en nøkkel i `$p`.
//
// To ting fulgte: hashtabellen skal bygges av variablene fra kapittel 1, så
// navnene ikke står to steder, og den skal si fra NÅR en er tom i stedet for
// å splatte en tom streng videre.
{
    const fra = tekst.indexOf('$p = @{');
    sjekk('fant $p-blokka', fra > 0, true);
    const blokk = tekst.slice(fra, tekst.indexOf('}', fra));

    // Hver verdi skal være en variabelreferanse, ikke en streng i hermetegn.
    const rader = [...blokk.matchAll(/^\s*(\w+)\s*=\s*(\S+)/gm)]
        .filter(m => m[1] !== 'p');
    sjekk('$p har rader', rader.length >= 6, true);
    const litteraler = rader.filter(m => /^'/.test(m[2])).map(m => m[1]);
    sjekk('ingen navn er skrevet opp på nytt i $p', litteraler, []);

    // Og variablene må være de samme som kapittel 1 setter.
    const kap1 = tekst.slice(tekst.indexOf('## 1. Navn og variabler'),
        tekst.indexOf('## 2. '));
    const satt = new Set([...kap1.matchAll(/^\$(\w+)\s*=/gm)].map(m => m[1]));
    sjekk('kapittel 1 setter variabler', satt.size >= 6, true);
    const ukjente = rader
        .map(m => /^\$(\w+)/.exec(m[2]))
        .filter(Boolean)
        .map(m => m[1])
        .filter(navn => !satt.has(navn));
    sjekk('alle variablene i $p settes i kapittel 1', ukjente, []);

    // Vakten. Uten den er en tom variabel en feilmelding om noe annet.
    sjekk('$p-blokka sjekker for tomme verdier',
        /\$tomme/.test(tekst), true);
    sjekk('og navngir hvilke som er tomme',
        /\$tomme -join/.test(tekst), true);
    sjekk('og peker tilbake til kapittel 1',
        /Kjor blokka i kapittel 1 forst/.test(tekst), true);

    // Og forklaringen på meldingen man faktisk får.
    sjekk('den ekte feilmeldingen står der',
        /Cannot bind argument to parameter/.test(tekst), true);
    sjekk('og at Rg er en nøkkel, ikke en variabel',
        /`Rg` er en NØKKEL/.test(tekst), true);
    sjekk('og at Cloud Shell mister variablene',
        /Cloud Shell mister variablene/.test(tekst), true);
}

// ---------- 20. secreten kapittel 8 setter, er den workflowen leser ----------
//
// 22.10.2026 sa kapittel 8 `gh secret set AZURE_FUNCAPP_CREDENTIALS_PROD`.
// `deploy-funcapp-pilot.yml` leser `secrets.AZURE_FUNCAPP_CREDENTIALS` i
// GitHub-MILJØET. En repo-secret med `_PROD` på slutten leses aldri, og
// deployen ville feilet i `azure/login` med en JSON-feil om en tom verdi —
// langt fra kommandoen som satte feil navn.
//
// Navnet leses derfor ut av workflowen, ikke skrevet opp her.
{
    const wf = fs.readFileSync(
        path.join(rot, '.github', 'workflows', 'deploy-funcapp-pilot.yml'), 'utf8');

    const m = /creds:\s*\$\{\{\s*secrets\.(\w+)\s*\}\}/.exec(wf);
    sjekk('fant secret-navnet i workflowen', !!m, true);

    // Leses den i et miljø, må kokeboka sette den DER.
    const iMiljo = /^\s*environment:\s*\$\{\{\s*inputs\.miljo/m.test(wf);
    sjekk('workflowen kjører i et GitHub-miljø', iMiljo, true);

    const satt = /gh secret set (\S+)([^\n]*)/.exec(tekst.slice(tekst.indexOf('## 8. Deploy av API-et')));
    sjekk('kokeboka setter en secret i kapittel 8', !!satt, true);
    if (m && satt) {
        sjekk('og navnet er det workflowen leser', satt[1], m[1]);
        if (iMiljo) {
            sjekk('og den settes i miljøet, ikke på repoet',
                /--env\s+prod/.test(satt[2]), true);
        }
    }

    // Flagget til create-for-rbac står to steder, og de skal være enige.
    const beslutning = fs.readFileSync(
        path.join(rot, 'docs', 'BESLUTNING-EGEN-FUNCTION-APP.md'), 'utf8');
    //
    // Regelen gjelder KOMMANDOLINJER, ikke prosa: første utgave forbød
    // strengen overalt, og tok dermed raden som forklarer hvorfor flagget
    // ikke skal brukes. En regel som ikke kan begrunnes i dokumentet den
    // gjelder for, er en regel folk fjerner begrunnelsen til.
    const kommandolinjer = (d) => d.split('\n')
        .filter(l => /create-for-rbac|azure\/login/.test(l));
    for (const [navn, d] of [['kokeboka', tekst], ['BESLUTNING', beslutning]]) {
        const linjer = kommandolinjer(d);
        sjekk(`${navn} har create-for-rbac-linjer`, linjer.length > 0, true);
        sjekk(`${navn} bruker ikke det avviklede --sdk-auth`,
            linjer.filter(l => /--sdk-auth/.test(l)), []);
        sjekk(`${navn} bruker --json-auth`,
            d.includes('--json-auth'), true);
    }

    // Vakten på $creds: uten den blir en rettighetsfeil til en gh-feil.
    const kap8 = tekst.slice(tekst.indexOf('## 8. Deploy av API-et'),
        tekst.indexOf('## 9. Verifikasjon'));
    sjekk('kapittel 8 vokter $creds', /if \(-not \$creds\)/.test(kap8), true);
    sjekk('og navngir symptomet uten den',
        /flag needs an argument/.test(kap8), true);

    // Og rettighetsfeilen, som er den sannsynligste utgangen.
    sjekk('Insufficient privileges er dekket',
        /Insufficient privileges/.test(kap8), true);
    sjekk('og rollen er navngitt',
        /Application Administrator/.test(kap8), true);
    sjekk('og det finnes en vei uten rollen',
        /Del jobben/.test(kap8), true);
    sjekk('der administratoren IKKE trenger ressursgruppa',
        /UTEN rolle/.test(kap8), true);
}

// ---------- 21. identitetstabellen navngir ALLE, og peker riktig ----------
//
// 22.10.2026, midt i kapittel 8: «Hvilken app-registrering er dette? Jeg har
// allerede en for AAD og en for Site-selected. Er det for tilgang til
// lageret?» Tre av fem identiteter var i bruk uten å stå i samme tabell, og
// den fjerde — managed identityen som FAKTISK har lagringsrollene — er ikke
// en app-registrering i det hele tatt. Spørsmålet var rimelig og hadde ikke
// noe sted å slås opp.
{
    const fra = tekst.indexOf('### 0.5');
    const til = tekst.indexOf('### 0.6');
    sjekk('fant 0.5', fra > 0 && til > fra, true);
    const kap = tekst.slice(fra, til);

    // De to managed identitetene må navngis SOM managed identities, ellers
    // leses hele tabellen som en liste over app-registreringer.
    sjekk('tabellen skiller managed identity fra app-registrering',
        /managed identity/.test(kap) && /app-registrering/.test(kap), true);

    // Lagringssvaret. Det var spørsmålet.
    sjekk('tabellen sier at lagringen ikke går via en app-registrering',
        /Lagringen går IKKE gjennom noen app-registrering/.test(kap), true);
    sjekk('og navngir hva den går på',
        /mi-skjema-3-prod[\s\S]{0,80}storage-roller/.test(kap), true);

    // Deploy-objektet: drift mot utrulling.
    sjekk('deploy-objektet er med', /sp-skjema-3-prod-deploy/.test(kap), true);
    sjekk('og det står at det aldri brukes i drift',
        /brukes aldri i drift/.test(kap), true);

    // Navnefellen. Den sto bare i BACKUP-SHAREPOINT.md, og det er for sent:
    // 20.10.2026 ble backup-sertifikatet lastet opp på deploy-objektet i
    // dev, avtrykket stemte med Key Vault, og Entra svarte AADSTS700027.
    // Prefikset leses ut av det dokumentet, ikke skrevet opp her.
    {
        const backup = fs.readFileSync(
            path.join(rot, 'docs', 'BACKUP-SHAREPOINT.md'), 'utf8');
        const m = /Backup-appen heter `([a-z0-9-]+)`/.exec(backup);
        sjekk('fant backup-appens navn i BACKUP-SHAREPOINT.md', !!m, true);
        if (m) {
            // Tabellen må navngi BEGGE formene, ellers skiller den dem ikke.
            sjekk('0.5 navngir backup-appens navneform',
                kap.includes(m[1].replace(/-dev$|-prod$/, '')), true);
        }
        sjekk('0.5 advarer om sp-skjema-prefikset',
            /`sp-skjema-\*` er ALLTID deploy-objektet/.test(kap), true);
        sjekk('og viser til hendelsen', /AADSTS700027/.test(kap), true);
    }

    // Og at de to managed identitetene ikke er den samme — den
    // sammenblandingen kostet innloggingen.
    sjekk('de to identitetene skilles uttrykkelig',
        /ikke den samme/.test(kap), true);

    // Pekerne må være EKTE app settings. En tabell som navngir en setting
    // som ikke finnes, er verre enn ingen tabell: den leses som fasit.
    const prod = JSON.parse(fs.readFileSync(
        path.join(rot, 'config', 'env.prod.json'), 'utf8'));
    const finnes = new Set();
    (function samle(o) {
        if (o && typeof o === 'object') {
            for (const [k, v] of Object.entries(o)) {
                if (v && typeof v === 'object'
                    && ('keyvault' in v || 'value' in v || 'valgfri' in v
                        || 'settes_direkte' in v || 'kun_dokumentasjon' in v)) finnes.add(k);
                else samle(v);
            }
        }
    })(prod);

    // Navnene leses UT AV TABELLRADENE, ikke fra en liste her. Første utgave
    // hadde lista skrevet opp, og en mutasjon som byttet `GRAPH_CLIENT_ID`
    // mot et oppdiktet navn forble grønn — fordi det ekte navnet også sto
    // ellers i avsnittet. Da målte sjekken avsnittet, ikke tabellen.
    const rader = kap.split('\n').filter(l => /^\|\s*\*\*/.test(l));
    sjekk('tabellen har rader', rader.length >= 5, true);

    // Navn som IKKE er app settings, med grunnen til hver:
    //   AZURE_CLIENT_ID      — leses av @azure/identity, ikke av vår kode,
    //                          og står derfor med vilje utenfor inventaret.
    //   AZURE_FUNCAPP_CREDENTIALS — en GitHub-secret, ikke en app setting.
    const UTENFOR = new Set(['AZURE_CLIENT_ID', 'AZURE_FUNCAPP_CREDENTIALS']);

    const iTabellen = [...new Set(rader
        .flatMap(l => [...l.matchAll(/`([A-Z][A-Z0-9_]{3,})`/g)].map(m => m[1])))];
    sjekk('tabellen navngir app settings', iTabellen.length >= 4, true);

    const ukjente = iTabellen
        .filter(n => !UTENFOR.has(n))
        .filter(n => !finnes.has(n));
    sjekk('hver setting i tabellen finnes i inventaret', ukjente, []);

    // Og de tre pekerne som bærer hele poenget, skal faktisk stå der.
    for (const n of ['AAD_CLIENT_ID', 'GRAPH_CLIENT_ID', 'AZURE_CLIENT_ID']) {
        sjekk(`tabellen peker på ${n}`, iTabellen.includes(n), true);
    }

    // Kapittel 8 må peke tilbake, ellers dukker objektet opp uten sammenheng.
    const kap8 = tekst.slice(tekst.indexOf('## 8. Deploy av API-et'),
        tekst.indexOf('## 9. Verifikasjon'));
    sjekk('kapittel 8 peker tilbake til tabellen',
        /tabellen i 0\.5/.test(kap8), true);
    sjekk('og avviser lagringstolkningen der også',
        /ingenting med lagringen/.test(kap8), true);
}

// ---------- 22. variabler settes FØR første bruk, og bare ett sted ----------
//
// `$PRINCIPAL` ble satt i 3.1 — et VILKÅRSAVSNITT («Hvis Key Vault ligger i
// en annen ressursgruppe»). Hoppet man over det, var variabelen tom i 3.2,
// 3.3, 10 og 11, og `--assignee-object-id ''` gir en feil om noe annet enn
// en manglende variabel.
//
// Det er tredje gang i samme kokebok: `$p` splattet tomt, `$creds` ga en
// gh-feil, og denne. Regelen her er generell: hver `$VAR` som brukes i en
// kommando, skal settes tidligere i dokumentet enn den brukes — og bare ett
// sted, ellers kan de to svare ulikt.
{
    // To avsnitt står utenfor, og begge har en grunn som må STÅ i
    // dokumentet — ellers er unntaket bare en tilpasning til testen:
    //
    //   «Om kommandoene» handler om FORMEN på et kall, ikke om et trinn.
    //   Kapittel 0 leses før møtet, før noe finnes. Kommandoene der bruker
    //   likevel variablene fra kapittel 1, og det er greit FORDI kapittelet
    //   sier at den blokka kan kjøres først. Forsvinner den setningen,
    //   gjelder ikke unntaket lenger.
    sjekk('kapittel 0 sier at variabelblokka kan kj\u00f8res f\u00f8rst',
        /bruker variablene fra kapittel 1[\s\S]{0,200}kan kj\u00f8res f\u00f8r/.test(tekst), true);

    const start = tekst.indexOf('## 1. Navn og variabler');
    sjekk('fant kapittel 1', start > 0, true);
    const forsteLinje = tekst.slice(0, start).split('\n').length;
    const blokk = blokker().filter(b => b.fra >= forsteLinje);

    // Hvor hver variabel SETTES, og hvor den BRUKES.
    const settes = new Map();
    const brukes = new Map();
    for (const b of blokk) {
        for (const l of b.linjer) {
            const s1 = /^\s*\$([A-Z][A-Z0-9_]*)\s*=/.exec(l.tekst);
            if (s1 && !settes.has(s1[1])) settes.set(s1[1], l.nr);
            for (const m of l.tekst.matchAll(/\$([A-Z][A-Z0-9_]*)/g)) {
                if (s1 && m[1] === s1[1]) continue;
                if (!brukes.has(m[1])) brukes.set(m[1], l.nr);
            }
        }
    }

    // Variabler kokeboka ikke setter selv, med grunnen:
    //   $_      — PowerShells egen i en pipeline
    //   $APPID  — fylles inn for hånd fra en administrator
    //   $V2_ID, $SWAMI, $UTLOPER, $NOTAFTER … settes i sine egne avsnitt
    const UTENFOR = new Set(['_']);

    const forSent = [...brukes.entries()]
        .filter(([navn]) => !UTENFOR.has(navn))
        .filter(([navn]) => settes.has(navn))
        .filter(([navn, nr]) => nr < settes.get(navn))
        .map(([navn, nr]) => `${navn} (brukt ${nr}, satt ${settes.get(navn)})`);
    sjekk('ingen variabel brukes før den settes', forSent, []);

    // Filer kokeboka SKRIVER inne i repoet, må være gitignorert.
    //
    // 4.2 lager krav.txt og satt.txt, og kommandoen kjøres typisk fra en
    // klone i Cloud Shell. 22.10.2026: «krav.txt opprettes, men legges bare
    // i det klonede repositoriet — skal den tas vare på noe sted?» Svaret er
    // nei, og da skal den heller ikke kunne havne i en commit.
    {
        const ignore = fs.readFileSync(path.join(rot, '.gitignore'), 'utf8')
            .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
        const skrevne = [...tekst.matchAll(/Set-Content\s+([A-Za-z0-9_.-]+)\s*$/gm)]
            .map(m => m[1])
            .filter(n => /\.\w+$/.test(n));
        sjekk('kokeboka skriver filer i repoet', skrevne.length > 0, true);
        const uignorerte = [...new Set(skrevne)].filter(n => !ignore.includes(n));
        sjekk('og alle er gitignorert', uignorerte, []);
    }

    // Og $PRINCIPAL spesielt: den skal settes UTENFOR vilkårsavsnittet 3.1.
    const i31 = tekst.indexOf('### 3.1');
    const iSatt = tekst.indexOf('$PRINCIPAL = az identity show');
    sjekk('$PRINCIPAL settes i kokeboka', iSatt > 0, true);
    sjekk('og før vilkårsavsnittet 3.1', iSatt < i31, true);
    sjekk('og bare étt sted',
        tekst.split('$PRINCIPAL = az identity show').length - 1, 1);
    sjekk('med en vakt som sier fra når den er tom',
        /if \(-not \$PRINCIPAL\)/.test(tekst), true);
}

// ---------- 23. skråstreken hører på VÅR side ----------
//
// Kapittel 7 sa at flytene måtte ha `https://service.flow.microsoft.com/`
// «som audience — med skråstrek bakerst». Det leses som en innstilling i
// Power Automate, og den finnes ikke: `aud` kommer av hvilken ressurs VI ber
// om et token for. 22.10.2026 spurte den som skriver flytene hva som var
// ment, og det var et rimelig spørsmål — teksten ba om noe som ikke kan
// gjøres.
//
// Ressursen leses derfor ut av koden, og kapittelet må peke på koden.
{
    const auth = fs.readFileSync(
        path.join(rot, 'api', 'src', 'lib', 'flyt-auth.js'), 'utf8');
    const m = /FLYT_RESSURS\s*=\s*'([^']+)'/.exec(auth);
    sjekk('fant flyt-ressursen i koden', !!m, true);

    const fra = tekst.indexOf('## 7. Flytene');
    const til = tekst.indexOf('## 8. Deploy av API-et');
    sjekk('fant kapittel 7', fra > 0 && til > fra, true);
    const kap = tekst.slice(fra, til);

    if (m) {
        sjekk('ressursen slutter på skråstrek', m[1].endsWith('/'), true);
        sjekk('og kapittelet oppgir samme streng', kap.includes(m[1]), true);
    }

    // Og at den tilhører oss, ikke flyten. Uten dette leter man i Power
    // Automate etter en innstilling som ikke finnes.
    sjekk('kapittelet sier at skråstreken er vår',
        /Skråstreken er VÅR, ikke flytens/.test(kap), true);
    sjekk('og navngir modulen som ber om den',
        /flyt-auth\.js/.test(kap), true);
    sjekk('og hvorfor plattform-token\\.js finnes',
        /plattform-token\.js[\s\S]{0,200}klippet den bort/.test(kap), true);

    // Det som FAKTISK skal gjøres i flyten, med etikettene fra brukerflaten.
    for (const etikett of ['Spesifikke brukere i leieren', 'Tillatte brukere']) {
        sjekk(`kapittelet bruker etiketten «${etikett}»`,
            kap.includes(etikett), true);
    }

    // `oid` er per miljø. Settes den ved eksport, er dette fella.
    sjekk('kapittelet sier at oid er per miljø',
        /per miljø/.test(kap), true);
    sjekk('og hva som skjer med dev-identitetens oid i prod',
        /avviser prod-flytene prod-API-et/.test(kap), true);

    // Og at ordet «allow-liste» ikke står igjen noe sted: brukerflaten
    // heter noe annet, og et oppslagsord som ikke finnes i verktøyet er et
    // oppslagsord ingen finner.
    sjekk('ordet allow-liste er ute av kapittelet',
        /allow-liste/.test(kap), false);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
