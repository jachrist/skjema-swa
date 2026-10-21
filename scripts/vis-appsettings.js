/**
 * Vis hvilke app settings et miljø skal ha, gruppert etter form.
 *
 * Skrevet for `docs/KOKEBOK-PROD-V3.md`. Lista som settes opp i et nytt miljø
 * skal komme fra inventaret (`config/env.<miljø>.json`), ikke fra en kopi i
 * et dokument — en kopi driver, og en oversikt som ser komplett ut og ikke er
 * det er verre enn ingen.
 *
 * **SKRIVER ALDRI UT VERDIER.** Navnene er greie å ha på en skjerm i et
 * arbeidsmøte; verdiene er det ikke. For `keyvault`-formen vises
 * SECRET-NAVNET, som heller ikke er en hemmelighet — det er en peker inn i
 * vaulten, og den som skal sette opp miljøet trenger nettopp den.
 *
 * Bruk:
 *   node scripts/vis-appsettings.js prod
 *   node scripts/vis-appsettings.js dev --form keyvault
 *   node scripts/vis-appsettings.js prod --navn      (ett navn per linje)
 *   node scripts/vis-appsettings.js prod --kommandoer --vault fhs-kv-01
 *
 * `--kommandoer` skriver ut PowerShell-blokkene som SETTER settingene, slik
 * at 22 Key Vault-referanser ikke skrives for hånd. Den SETTER ingenting
 * selv: utskriften leses, og limes inn av et menneske. Et skript som endrer
 * prod uten at noen har lest kommandoen, er en annen slags verktøy.
 *
 * Den dekker to av formene, og det er ikke en begrensning men et skille:
 *   keyvault  — referansen er bygget av vaultnavn + secret-navn. Ingen
 *               hemmelighet er involvert; referansen er en PEKER.
 *   value     — verdien står i config/env.<miljø>.json og er ikke hemmelig.
 * `settes_direkte` kan den ikke dekke: de verdiene finnes ikke i repoet, og
 * det er hele poenget med formen. De listes med merknaden sin i stedet.
 *
 * `--navn` skriver bare navnene på de settingene som MÅ ha en verdi, uten
 * overskrifter og forklaringer. Den finnes for å kunne svare på «er kapittel
 * 4 ferdig?» — sammenlign med navnene som faktisk står på verten:
 *
 *   node scripts/vis-appsettings.js prod --navn | Set-Content krav.txt
 *   az functionapp config appsettings list --name $FA --resource-group $RG `
 *       --query "[].name" -o tsv | Set-Content satt.txt
 *   Compare-Object (Get-Content krav.txt) (Get-Content satt.txt)
 *
 * `valgfri` og `kun_dokumentasjon` er UTE av lista: den første har en
 * standard i koden, den andre settes av plattformen. Tar man dem med, ser et
 * ferdig miljø ut som om 18 settings mangler.
 */
const fs = require('fs');
const path = require('path');

/**
 * Formene en oppføring kan ha, i rekkefølgen de skal settes opp.
 *
 * Den samme lista står i `_kommentar` i hver miljøfil og i FORMER i
 * `api/test/env-inventar.test.js`. At den finnes tre steder er ikke bra, og
 * `api/test/kokebok.test.js` krever derfor at DENNE og testens liste er like.
 */
const FORMER = {
    keyvault: 'Key Vault-referanse — @Microsoft.KeyVault(SecretUri=…)',
    value: 'Fast verdi, ikke hemmelig — kopier fra miljøfila',
    settes_direkte: 'Settes direkte på API-verten — verdien hører ikke i repoet',
    valgfri: 'Trenger ingen verdi — koden har en standard',
    kun_dokumentasjon: 'Settes av plattformen, eller står for oversiktens skyld'
};

function formenTil(oppforing) {
    return Object.keys(FORMER).find(f => f in (oppforing || {})) || null;
}

function les(miljo) {
    const fil = path.join(__dirname, '..', 'config', `env.${miljo}.json`);
    if (!fs.existsSync(fil)) {
        throw new Error(`Fant ikke ${fil}. Kjente miljøer: `
            + fs.readdirSync(path.join(__dirname, '..', 'config'))
                .filter(n => /^env\..*\.json$/.test(n))
                .map(n => n.slice(4, -5)).join(', '));
    }
    return JSON.parse(fs.readFileSync(fil, 'utf8'));
}

function grupper(data) {
    const ut = {};
    for (const f of Object.keys(FORMER)) ut[f] = [];
    const uten = [];
    for (const [navn, oppforing] of Object.entries(data)) {
        if (navn.startsWith('_')) continue;
        const f = formenTil(oppforing);
        if (!f) { uten.push(navn); continue; }
        ut[f].push(f === 'keyvault' ? `${navn}  ←  ${oppforing.keyvault}` : navn);
    }
    return { grupper: ut, uten };
}

function skriv(miljo, bareForm = null) {
    const { grupper: g, uten } = grupper(les(miljo));
    console.log(`App settings for miljøet «${miljo}»\n`);
    for (const [form, forklaring] of Object.entries(FORMER)) {
        if (bareForm && form !== bareForm) continue;
        const liste = g[form];
        console.log(`== ${form} (${liste.length}) — ${forklaring}`);
        if (liste.length === 0) console.log('   (ingen)');
        for (const n of liste.slice().sort()) console.log(`   ${n}`);
        console.log('');
    }
    // En oppføring uten kjent form er en tastefeil, ikke en kategori. Den
    // skal ikke forsvinne i stillhet fra en liste noen skal sette opp etter.
    if (uten.length > 0) {
        console.log(`== UKJENT FORM (${uten.length}) — tastefeil i miljøfila?`);
        for (const n of uten.sort()) console.log(`   ${n}`);
        console.log('');
    }
    console.log('Verdiene står IKKE her, med vilje. Hemmelige verdier hentes fra');
    console.log('Key Vault; ikke-hemmelige står i config/env.' + miljo + '.json.');
}

/** Navnene som MÅ ha en verdi, ett per linje. Se `--navn` i toppkommentaren. */
const MA_SETTES = ['keyvault', 'value', 'settes_direkte'];

function skrivNavn(miljo) {
    const data = les(miljo);
    const { grupper: g } = grupper(data);
    const navn = MA_SETTES.flatMap(f => (g[f] || []))
        // keyvault-raden er «NAVN  ←  secret-navn»; her vil vi bare navnet.
        .map(rad => String(rad).split('  ←  ')[0].trim())
        // En oppføring som OGSÅ er `kun_dokumentasjon`, leses ikke av API-et.
        // `AAD_CLIENT_ID` i prod er den ene: den hører på SWA-ressursen, der
        // auth-blokka leser den (4.3). Tas den med, melder sammenligningen
        // den som manglende på Function App-en hver gang — og en liste med
        // én kjent falsk positiv er en liste folk slutter å lese.
        .filter(n => !(data[n] && data[n].kun_dokumentasjon))
        .sort();
    for (const n of navn) console.log(n);
}

/**
 * Kommandoene som setter settingene, som PowerShell-argumentlister.
 *
 * Argumentliste og ikke én lang linje: det er formen kokeboka bruker, fordi
 * et fortsettelsestegn er usynlig og et mellomrom etter det slår det av.
 *
 * ÉN kommando per form, ikke én per setting. `--settings` tar mange par, og
 * hver `az functionapp config appsettings set` starter appen på nytt — 22
 * kall er 22 omstarter og mange minutter.
 */
/**
 * Verdier som står i inventaret, men som gjelder ÉN instans.
 *
 * `SWA_URL` i env.prod.json er v2 sin adresse. Settes den automatisk på en
 * v3-app, peker lenkene i e-poster og varsler til v2 — og under
 * parallellkjøring er begge i drift, så ingenting feiler. Det oppdages av en
 * bruker som klikker seg til feil versjon.
 *
 * Lista er kort og navngitt med vilje: en heuristikk på «ser ut som en URL»
 * ville tatt flyt-URLene også, og de er riktige som de står.
 */
const INSTANSSPESIFIKKE = new Set(['SWA_URL']);

function skrivKommandoer(miljo, vault) {
    const data = les(miljo);
    const { grupper: g } = grupper(data);
    const sitert = (s) => `'${String(s).replace(/'/g, "''")}'`;

    console.log('# Les disse FØR du limer dem inn. Skriptet setter ingenting selv.');
    console.log('# $FA og $RG må være satt (kapittel 1).');
    console.log('');

    const kvRader = g.keyvault.map(rad => {
        const [navn, secret] = String(rad).split('  ←  ').map(s => s.trim());
        return `    ${sitert(`${navn}=@Microsoft.KeyVault(SecretUri=https://${vault}.vault.azure.net/secrets/${secret}/)`)},`;
    });
    if (kvRader.length) {
        console.log(`# ${kvRader.length} Key Vault-referanser. Uten versjon til slutt gir alltid nyeste.`);
        console.log('$kv = @(');
        console.log(kvRader.join('\n').replace(/,$/, ''));
        console.log(')');
        console.log("$arg = @('functionapp','config','appsettings','set','--name',$FA,'--resource-group',$RG,'--settings') + $kv + @('--output','none')");
        console.log('az @arg');
        console.log('');
    }

    const verdiRader = g.value
        .filter(navn => !(data[navn] && data[navn].kun_dokumentasjon))
        .filter(navn => !INSTANSSPESIFIKKE.has(navn))
        .map(navn => `    ${sitert(`${navn}=${data[navn].value}`)},`);
    if (verdiRader.length) {
        console.log(`# ${verdiRader.length} faste verdier, ikke hemmelige.`);
        console.log('$verdier = @(');
        console.log(verdiRader.join('\n').replace(/,$/, ''));
        console.log(')');
        console.log("$arg = @('functionapp','config','appsettings','set','--name',$FA,'--resource-group',$RG,'--settings') + $verdier + @('--output','none')");
        console.log('az @arg');
        console.log('');
    }

    const direkte = g.settes_direkte.filter(navn => !(data[navn] && data[navn].kun_dokumentasjon));
    if (direkte.length) {
        console.log(`# ${direkte.length} MÅ SETTES FOR HÅND - verdiene finnes ikke i repoet:`);
        for (const navn of direkte) {
            const m = (data[navn] && data[navn].merknad) || '';
            console.log(`#   ${navn}${m ? '  - ' + m : ''}`);
        }
        console.log('');
    }

    // Instansspesifikke verdier står i inventaret, men gjelder det MILJØET
    // inventaret beskriver. De hører i håndlista, ikke i kommandoen.
    const instans = g.value.filter(navn => INSTANSSPESIFIKKE.has(navn));
    if (instans.length) {
        console.log('# MÅ SETTES FOR HÅND, selv om verdien står i inventaret:');
        for (const navn of instans) {
            console.log(`#   ${navn}  - inventaret har ${data[navn].value}`);
            console.log('#     Det er den EKSISTERENDE instansens adresse. Setter du opp en ny');
            console.log('#     SWA, skal den nyes vertsnavn inn her - ellers peker lenker i');
            console.log('#     e-poster og varsler til den gamle, uten at noe feiler.');
        }
        console.log('');
    }
    console.log('# Kontroller til slutt med --navn og Compare-Object, se kapittel 4.2.');
}

if (require.main === module) {
    const args = process.argv.slice(2);
    const miljo = args.find(a => !a.startsWith('--'));
    const formIdx = args.indexOf('--form');
    if (!miljo) {
        console.log('Bruk: node scripts/vis-appsettings.js <miljø> [--form <form>] [--navn] [--kommandoer --vault <navn>]');
        process.exit(1);
    }
    try {
        if (args.includes('--navn')) { skrivNavn(miljo); }
        else if (args.includes('--kommandoer')) {
            const vaultIdx = args.indexOf('--vault');
            const vault = vaultIdx >= 0 ? args[vaultIdx + 1] : null;
            // Uten vaultnavn blir referansene ugyldige, og feilen viser seg
            // først når appen prøver å løse dem. Krev den.
            if (!vault) {
                console.log('--kommandoer krever --vault <navn>, f.eks. --vault fhs-kv-01');
                process.exit(1);
            }
            skrivKommandoer(miljo, vault);
        }
        else skriv(miljo, formIdx >= 0 ? args[formIdx + 1] : null);
    } catch (e) {
        console.log(`FEIL: ${e.message}`);
        process.exit(1);
    }
}

module.exports = { FORMER, formenTil, grupper, MA_SETTES };
