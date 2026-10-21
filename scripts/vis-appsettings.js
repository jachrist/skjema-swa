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

if (require.main === module) {
    const args = process.argv.slice(2);
    const miljo = args.find(a => !a.startsWith('--'));
    const formIdx = args.indexOf('--form');
    if (!miljo) {
        console.log('Bruk: node scripts/vis-appsettings.js <miljø> [--form <form>] [--navn]');
        process.exit(1);
    }
    try {
        if (args.includes('--navn')) { skrivNavn(miljo); }
        else skriv(miljo, formIdx >= 0 ? args[formIdx + 1] : null);
    } catch (e) {
        console.log(`FEIL: ${e.message}`);
        process.exit(1);
    }
}

module.exports = { FORMER, formenTil, grupper, MA_SETTES };
