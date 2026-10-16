/**
 * Tester for miljøavhengige env-variabler i helsesjekken.
 *
 * `AAD_CLIENT_SECRET` hører hjemme i pilot, men ikke i prod: der autentiserer
 * SWA med sertifikat fra Key Vault. Uten dette skillet rapporterer
 * helsesjekken en mangel i prod som ikke er en mangel, og den som forvalter
 * løsningen leter etter noe som ikke skal finnes.
 *
 * Den motsatte feilen er verre og testes derfor også: skillet må ikke skjule
 * en ekte mangel i pilot, der hemmeligheten faktisk trengs.
 *
 * Og det var nettopp den feilen som lå her til 17.09.2026. Testen slo fast at
 * «production regnes som prod», mens kommentaren rett over sa at Production var
 * PILOT sitt navn. Pilot kjører med MILJO=production den dag i dag
 * (config/env.pilot.json), så pilot arvet prodens unntak: en manglende
 * AAD_CLIENT_SECRET — som tar ned innloggingen helt — ble meldt som forventet.
 *
 * Kjøres med:  node api/test/system-miljo.test.js
 */
// system.js gjoer `require('@azure/functions')` for aa registrere rutene.
// Testene skal kunne kjoere uten node_modules (se CLAUDE.md), saa pakken
// stubbes: `app.http()` registrerer bare handlere, og vi tester rene
// funksjoner ved siden av dem.
//
// Fram til 17.09.2026 sto det en try/catch her som hoppet over hele fila naar
// pakken manglet. Den manglet alltid — verken `npm test` lokalt eller deployen
// installerer avhengigheter foer testene — saa denne fila har aldri kjoert. En
// test som alltid hopper over er verre enn ingen test: den teller som groenn.
const Module = require('module');
const origLoad = Module._load;
Module._load = function (forespurt, ...rest) {
    if (forespurt === '@azure/functions') return { app: { http() { } } };
    return origLoad.call(this, forespurt, ...rest);
};

let modul = null;
try {
    modul = require('../src/functions/system');
} catch (e) {
    console.log('FEIL  kunne ikke laste system.js:', e.message);
    process.exit(1);
} finally {
    Module._load = origLoad;
}

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

if (!modul?._medForventning || !modul?._miljonavn) {
    console.log('FEIL  system.js eksporterer ikke _medForventning/_miljonavn');
    process.exit(1);
}
const { _medForventning: medForventning, _miljonavn: miljonavn } = modul;

const før = process.env.MILJO;
const TOM = { satt: false };
const SATT = { satt: true, lengde: 40 };

// ---------- prod: hemmeligheten skal ikke finnes ----------
{
    process.env.MILJO = 'prod';
    const r = medForventning('AAD_CLIENT_SECRET', TOM);
    sjekk('prod: tom verdi er forventet', r.gjelderHer, false);
    sjekk('prod: får en forklaring', typeof r.merknad === 'string' && r.merknad.length > 0, true);
    sjekk('prod: satt-flagget røres ikke', r.satt, false);

}

// ---------- pilot: en manglende hemmelighet er en ekte mangel ----------
{
    process.env.MILJO = 'pilot';
    const r = medForventning('AAD_CLIENT_SECRET', TOM);
    sjekk('pilot: ingen unnskyldning for tom verdi', r.gjelderHer, undefined);
    sjekk('pilot: ingen merknad', r.merknad, undefined);
    sjekk('pilot: rapporten er uendret', r, TOM);
}

// ---------- «production» er pilot, ikke prod ----------
{
    // Det gamle navnet på pilot. env.pilot.json setter det fortsatt, og
    // build-config.js gjør samme oversettelse ved bygg.
    process.env.MILJO = 'production';
    sjekk('production normaliseres til pilot', miljonavn(), 'pilot');
    sjekk('production: ingen unnskyldning for tom verdi',
        medForventning('AAD_CLIENT_SECRET', TOM).gjelderHer, undefined);

    process.env.MILJO = 'Production';
    sjekk('store bokstaver teller ikke', miljonavn(), 'pilot');
    sjekk('Production: ingen unnskyldning heller',
        medForventning('AAD_CLIENT_SECRET', TOM).gjelderHer, undefined);

    process.env.MILJO = '  PRODUCTION  ';
    sjekk('mellomrom trimmes', miljonavn(), 'pilot');

    process.env.MILJO = 'prod';
    sjekk('prod er prod', miljonavn(), 'prod');
}

// ---------- ukjent navn friskmelder ingenting ----------
{
    // Et navn vi ikke kjenner treffer ingen liste. Da står variabelen igjen
    // som en mangel — den trygge retningen.
    process.env.MILJO = 'staging';
    sjekk('ukjent navn sendes uendret videre', miljonavn(), 'staging');
    sjekk('ukjent navn gir ingen unnskyldning',
        medForventning('AAD_CLIENT_SECRET', TOM).gjelderHer, undefined);
}

// ---------- andre variabler røres ikke ----------
{
    process.env.MILJO = 'prod';
    sjekk('STORAGE_CONNECTION_STRING uendret i prod',
        medForventning('STORAGE_CONNECTION_STRING', TOM), TOM);
    sjekk('AAD_CLIENT_ID uendret i prod',
        medForventning('AAD_CLIENT_ID', SATT), SATT);
}

// ---------- ukjent miljø skal ikke friskmelde noe ----------
{
    // Er MILJO ikke satt, vet vi ikke nok til å påstå at en tom verdi er
    // greit. Da er det tryggere å la den framstå som en mangel.
    process.env.MILJO = '';
    sjekk('tomt MILJO gir ingen unnskyldning',
        medForventning('AAD_CLIENT_SECRET', TOM).gjelderHer, undefined);
    delete process.env.MILJO;
    sjekk('MILJO mangler helt gir ingen unnskyldning',
        medForventning('AAD_CLIENT_SECRET', TOM).gjelderHer, undefined);
}

// ---------- en satt verdi i prod skjules ikke ----------
{
    process.env.MILJO = 'prod';
    const r = medForventning('AAD_CLIENT_SECRET', SATT);
    sjekk('prod: satt verdi rapporteres fortsatt', r.satt, true);
    sjekk('prod: og markeres som utenfor miljøet', r.gjelderHer, false);
}

// ---------- dev er et ekte miljø, development er ikke et navn lenger ----------
//
// Lagt til 15.10.2026 sammen med dev-miljøet. Uten disse var `dev` og
// `development` usynlige for testen: den dekket pilot, prod, production og
// ett ukjent navn, og ville vært grønn uansett hva de to gjorde.
{
    process.env.MILJO = 'dev';
    sjekk('dev er sitt eget miljø', miljonavn(), 'dev');
    // Dev bruker klienthemmelighet som pilot, ikke sertifikat som prod.
    sjekk('dev: tom AAD_CLIENT_SECRET er en ekte mangel',
        medForventning('AAD_CLIENT_SECRET', TOM).gjelderHer, undefined);

    // `development` var alias for pilot til 15.10.2026. Det er fjernet, og da
    // skal navnet være UKJENT — ikke stille rutet til et miljø. Et ukjent
    // navn melder en manglende hemmelighet i stedet for å unnskylde den, og
    // det er den trygge retningen.
    process.env.MILJO = 'development';
    sjekk('development er ikke pilot lenger', miljonavn(), 'development');
    sjekk('development: ingen unnskyldning for tom verdi',
        medForventning('AAD_CLIENT_SECRET', TOM).gjelderHer, undefined);
}

// ---------- uløst Key Vault-referanse: ett symptom, to årsaker ----------
//
// SWA Managed Functions løser ikke referanser; en Function App gjør det.
// Samme uløste referanse betyr derfor ulike ting i dev og i pilot, og rådet
// må følge miljøet. Helsesjekken ga 16.10.2026 et aktivt feil råd i dev —
// «lim inn verdien som klartekst» — mens referansene der virket og det som
// manglet var én secret i vaulten.
{
    const uloest = modul._uloestReferanse;
    const maskLengde = modul._maskLengde;
    sjekk('system.js eksporterer det testen trenger',
        typeof uloest === 'function' && typeof maskLengde === 'function', true);

    process.env.MILJO = 'dev';
    const iDev = uloest();
    sjekk('dev: sier at plattformen LØSER dem', /LØSER dem/.test(iDev), true);
    sjekk('dev: ber IKKE om klartekst', /klartekst/.test(iDev), false);
    sjekk('dev: navngir de tre mulige årsakene',
        /secreten finnes ikke/.test(iDev) && /Key Vault Secrets User/.test(iDev)
            && /keyVaultReferenceIdentity/.test(iDev), true);

    for (const m of ['pilot', 'prod']) {
        process.env.MILJO = m;
        const her = uloest();
        sjekk(`${m}: ber om klartekst`, /klartekst i SWA Configuration/.test(her), true);
        sjekk(`${m}: sier ikke at plattformen løser dem`, /LØSER dem/.test(her), false);
    }

    // Et ukjent miljø skal få BEGGE årsakene, ikke den ene gjettet. Samme
    // regel som KJENTE_MILJOER: vi vet ikke nok til å peke én vei.
    process.env.MILJO = 'staging';
    const ukjent = uloest();
    sjekk('ukjent miljø: nevner begge årsakene',
        /SWA Managed Functions/.test(ukjent) && /Function App/.test(ukjent), true);

    // Og den ekte inngangen: maskLengde skal kjenne igjen referansestrengen.
    process.env.MILJO = 'dev';
    const ref = maskLengde('@Microsoft.KeyVault(SecretUri=https://kv.vault.azure.net/secrets/x/)');
    sjekk('referansestreng gir feilmelding', typeof ref.feil === 'string' && ref.feil.length > 0, true);
    sjekk('referansestreng rapporteres som satt', ref.satt, true);
    // En vanlig verdi skal IKKE få feilmeldingen.
    const vanlig = maskLengde('en-helt-vanlig-hemmelighet');
    sjekk('vanlig verdi har ingen feil', vanlig.feil, undefined);
    sjekk('vanlig verdi rapporterer lengde', vanlig.lengde, 26);
    // Tom verdi er «ikke satt», ikke en uløst referanse.
    sjekk('tom verdi er ikke satt', maskLengde(''), { satt: false });
}

// ---------- én regel, to filer ----------
//
// system.js og scripts/build-config.js har hver sin liste over miljønavn.
// De drev fra hverandre før: build-config rutet `development` til pilot mens
// KJENTE_MILJOER regnet det som et eget miljø. Denne testen leser BEGGE og
// krever likt svar — formen CLAUDE.md foreskriver for en regel som må finnes
// to steder.
{
    const fs = require('fs');
    const path = require('path');
    const rot = path.join(__dirname, '..', '..');
    const sysKilde = fs.readFileSync(path.join(rot, 'api', 'src', 'functions', 'system.js'), 'utf8');
    const byggKilde = fs.readFileSync(path.join(rot, 'scripts', 'build-config.js'), 'utf8');

    const navnFra = (kilde, m) => {
        const t = new RegExp(m).exec(kilde);
        if (!t) return null;
        return [...t[1].matchAll(/'([a-z]+)'/g)].map(x => x[1]).sort();
    };

    const kjente = navnFra(sysKilde, "KJENTE_MILJOER = new Set\\(\\[([^\\]]*)\\]");
    const godtatt = navnFra(byggKilde, "!\\[([^\\]]*)\\]\\.includes\\(miljo\\)");
    sjekk('fant KJENTE_MILJOER', Array.isArray(kjente), true);
    sjekk('fant lista i build-config', Array.isArray(godtatt), true);

    // build-config godtar i tillegg `production` som gammelt alias. Alt ANNET
    // skal være det samme settet.
    const utenAlias = (godtatt || []).filter(n => n !== 'production');
    sjekk('samme miljønavn i system.js og build-config.js', utenAlias, kjente);

    // Og aliaset skal bare finnes ett sted: det som rutes om, skal rutes om
    // likt. `development` er fjernet begge steder.
    sjekk('development er borte fra build-config', /'development'/.test(byggKilde), false);
    sjekk('development er borte fra system.js', /'development'/.test(sysKilde), false);
}

if (før === undefined) delete process.env.MILJO; else process.env.MILJO = før;

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
