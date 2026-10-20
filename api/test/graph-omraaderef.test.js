/**
 * Områdereferansen til Graph — ett svar, to språk.
 *
 * `BACKUP_SHAREPOINT_SITE` og `-Site` i `scripts/opprett-backup-app.ps1`
 * skal bære det samme. API-et har godtatt tre former hele tiden
 * (`siteReferanse()`); skriptet leste adressen med `[Uri]`, og det tålte bare
 * én.
 *
 * 20.10.2026 ble skriptet kjørt med Graph-formen, og `[Uri]` leste
 * «jachconsulting.sharepoint.com:/teams/SkjemaBackupDev» som et SKJEMA:
 * `$u.Host` ble tom, og oppslaget ble «:/teams/SkjemaBackupDev». Graph svarte
 * som om rettighetene manglet, og feilsøkingen gikk mot tilganger i en time.
 *
 * Den tilbakevendende feilklassen her: samme regel i to eksemplarer som
 * svarer ulikt. Frontend kan ikke `require` backend, og PowerShell kan ikke
 * `require` noe i det hele tatt — så skriptet bærer formene som en TABELL i
 * kommentaren over funksjonen, og den tabellen holdes mot `siteReferanse()`
 * her. Endres regelen på JS-siden, blir denne rød, og tabellen (som
 * PowerShell-grenene er skrevet mot) må oppdateres bevisst.
 *
 * Kjøres med:  node api/test/graph-omraaderef.test.js
 */
const fs = require('fs');
const path = require('path');
const { siteReferanse } = require('../src/lib/graph-opplast.js');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const skript = fs.readFileSync(
    path.join(__dirname, '..', '..', 'scripts', 'opprett-backup-app.ps1'), 'utf8');

// ---------- 1. tabellen i skriptet er API-ets svar ----------
{
    const rader = [...skript.matchAll(/^#\s{3}(\S+)\s*=>\s*(\S+)\s*$/gm)]
        .map(m => [m[1], m[2]]);

    // Uten rader tester resten ingenting — og ville meldt alt OK.
    sjekk('skriptet har en formtabell', rader.length >= 4, true);

    // Alle tre inngangsformene skal være dekket. En tabell med bare full URL
    // ville vært grønn og ikke dekket det som feilet.
    const former = {
        'full URL': rader.some(([v]) => /^https?:\/\//.test(v)),
        'Graph-formen': rader.some(([v]) => !/^https?:\/\//.test(v) && v.includes(':')),
        'vertsnavn/sti': rader.some(([v]) => !v.includes(':') && v.includes('/')),
        'bare vertsnavn': rader.some(([v]) => !v.includes(':') && !v.includes('/'))
    };
    sjekk('tabellen dekker alle formene', former,
        { 'full URL': true, 'Graph-formen': true, 'vertsnavn/sti': true, 'bare vertsnavn': true });

    for (const [verdi, forventet] of rader) {
        sjekk(`siteReferanse(${verdi})`, siteReferanse(verdi), forventet);
    }
}

// ---------- 2. det ekte tilfellet ----------
//
// Verdien fra hendelsen, ikke en oppdiktet. Skrevet med `[Uri]` ble denne
// «:/teams/SkjemaBackupDev».
{
    const graphForm = 'jachconsulting.sharepoint.com:/teams/SkjemaBackupDev';
    const url = 'https://jachconsulting.sharepoint.com/teams/SkjemaBackupDev';
    sjekk('Graph-formen går uendret igjennom', siteReferanse(graphForm), graphForm);
    sjekk('og full URL gir samme referanse', siteReferanse(url), graphForm);
    sjekk('referansen har et vertsnavn', siteReferanse(graphForm).startsWith(':'), false);
}

// ---------- 3. skriptet bruker ikke [Uri] på -Site ----------
//
// Det er selve feilen. `[Uri]` er fortsatt riktig INNE i https-grenen, så
// sjekken gjelder bare bruken rett på $Site.
{
    sjekk('ingen [Uri]$Site', /\[Uri\]\s*\$Site/.test(skript), false);
    sjekk('ingen referanse bygget av $u.Host direkte',
        /\$omraadeRef\s*=\s*"\$\(\$u\.Host\)/.test(skript), false);
    sjekk('referansen kommer fra Omraaderef',
        /\$omraadeRef\s*=\s*Omraaderef\s+\$Site/.test(skript), true);
}

// ---------- 4. PowerShell-grenene finnes ----------
//
// Tabellen er en påstand til `siteReferanse()` svarer likt — men bare hvis
// skriptet faktisk har grenene tabellen beskriver. Uten dem kan tabellen
// stemme og skriptet likevel bomme.
{
    const fra = skript.indexOf('function Omraaderef(');
    sjekk('Omraaderef finnes', fra > 0, true);
    const kropp = skript.slice(fra, skript.indexOf('\n}', fra));

    sjekk('https-grenen finnes', /-match\s+'\^https\?:\/\/'/.test(kropp), true);
    sjekk('kolon-grenen finnes', /\$s\.Contains\(':'\)/.test(kropp), true);
    sjekk('og vertsnavn-grenen deler på første skråstrek',
        /IndexOf\('\/'\)/.test(kropp), true);
    sjekk('skråstrek bakerst strippes', /-replace\s+'\/\+\$'/.test(kropp), true);

    // `"$vert:$sti"` ville PowerShell lest som navnerommet `$vert:` — samme
    // syntaks som `$env:PATH`. Formatoperatoren har ikke det problemet.
    sjekk('vert og sti settes sammen med formatoperatoren',
        /'\{0\}:\{1\}'\s+-f\s+\$vert,\s+\$sti/.test(kropp), true);
}

// ---------- 5. referansen vises før kallet ----------
//
// Hele hendelsen var usynlig fordi den utledede referansen bare ble skrevet
// ut når adressen inneholdt mellomrom. Tallet som avgjør, skal alltid fram.
{
    const fra = skript.indexOf('$omraadeRef = Omraaderef $Site');
    const til = skript.indexOf('Invoke-MgGraphRequest', fra);
    sjekk('utledningen kommer før oppslaget', fra > 0 && til > fra, true);
    sjekk('og referansen skrives ut på vei dit',
        /Info "Graph slår opp: \$omraadeRef"/.test(skript.slice(fra, til)), true);

    // En tom referanse skal stoppe, ikke sendes til Graph som «/sites/».
    sjekk('tom referanse stopper kjøringen',
        /if \(-not \$omraadeRef\)[\s\S]{0,400}exit 1/.test(skript), true);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
