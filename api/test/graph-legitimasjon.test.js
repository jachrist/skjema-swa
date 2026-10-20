/**
 * Hva backup-appen kan autentisere seg MED — ett svar, to steder.
 *
 * `docs/BACKUP-SHAREPOINT.md` anbefalte sertifikat i steg 2 og hadde bare
 * `GRAPH_CLIENT_SECRET` i steg 4. Dokumentet motsa seg selv på samme side, og
 * koden støttet bare den ene halvdelen. 19.10.2026 fulgte noen anbefalingen,
 * fikk app-registreringen opprettet med sertifikat hos en administrator, og
 * sto igjen uten noe å sette inn i en env-variabel.
 *
 * Det er den tilbakevendende feilklassen i dette repoet: samme regel i to
 * eksemplarer som svarer ulikt. Her leses BEGGE — hvilke legitimasjonstyper
 * `graph-opplast.js` faktisk sender i token-kallet, og hva dokumentet lover —
 * og de skal stemme.
 *
 * Kjøres med:  node api/test/graph-legitimasjon.test.js
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
const kilde = les('api', 'src', 'lib', 'graph-opplast.js');
const dok = les('docs', 'BACKUP-SHAREPOINT.md');

// ---------- 1. hva koden faktisk sender ----------
//
// Lest ut av kroppen i token-kallet, ikke av kommentarer. En kommentar kan
// påstå hva som helst; `client_secret:` i URLSearchParams er det som skjer.
// Kroppen bygges i `tokenKropp()`, med én gren per legitimasjonstype. Leses
// bare den FØRSTE `new URLSearchParams({`, måles bare den første grenen — og
// da melder testen «sertifikat støttes ikke» mens koden støtter det. Det
// skjedde 19.10.2026, i akkurat denne testen.
const kroppStart = kilde.indexOf('function tokenKropp(');
sjekk('fant tokenKropp() i graph-opplast.js', kroppStart > 0, true);
const kropp = kilde.slice(kroppStart, kilde.indexOf('\n}', kroppStart));

// Og kroppen skal faktisk brukes av token-kallet — ellers kan den si hva som
// helst uten at noe sendes.
sjekk('hentToken bruker tokenKropp()', /const kropp = tokenKropp\(k\);/.test(kilde), true);

const koden = {
    'client secret': /\bclient_secret\s*:/.test(kropp),
    'sertifikat': /\bclient_assertion\s*:/.test(kropp)
};
sjekk('koden sender minst én legitimasjon',
    Object.values(koden).some(Boolean), true);

// ---------- 2. hva dokumentet lover ----------
{
    const etter = dok.split('<!-- legitimasjon-fra-graph-opplast -->')[1] || '';
    sjekk('ankeret finnes i BACKUP-SHAREPOINT.md', etter !== '', true);

    const dokumentert = {};
    for (const linje of etter.split('\n')) {
        if (!linje.startsWith('|')) { if (Object.keys(dokumentert).length) break; else continue; }
        const m = /^\|\s*`([^`]+)`\s*\|\s*(ja|nei)\s*\|/.exec(linje);
        if (m) dokumentert[m[1]] = m[2] === 'ja';
    }

    sjekk('dokumentet lister legitimasjonstypene',
        Object.keys(dokumentert).sort(), Object.keys(koden).sort());
    sjekk('og er enig med koden om hver av dem', dokumentert, koden);
}

// ---------- 3. env-variablene står likt i kode og dokument ----------
//
// konfig() er kilden. Navngir dokumentet en GRAPH-variabel koden ikke leser,
// setter noen en verdi som aldri brukes — og det er like stille som det
// motsatte.
{
    const konfigStart = kilde.indexOf('function konfig()');
    const konfigKropp = kilde.slice(konfigStart, kilde.indexOf('\n}', konfigStart));
    const iKoden = [...new Set([...konfigKropp.matchAll(/les\('(GRAPH_[A-Z_]+)'\)/g)].map(m => m[1]))].sort();
    sjekk('konfig() leser GRAPH-variabler', iKoden.length > 0, true);

    const iDok = [...new Set([...dok.matchAll(/`(GRAPH_[A-Z_]+)`/g)].map(m => m[1]))].sort();
    sjekk('dokumentet navngir de samme GRAPH-variablene', iDok, iKoden);
}

// ---------- 4. den påstanden som kostet mest ----------
//
// «Sertifikat er å foretrekke» sto i steg 2 mens steg 4 ikke hadde noen
// variabel for det. Så lenge koden ikke støtter sertifikat, skal dokumentet
// ikke anbefale det — og når støtten kommer, feller sjekk 2 over dette
// dokumentet til tabellen er oppdatert.
{
    if (!koden['sertifikat']) {
        const steg2 = dok.slice(dok.indexOf('### 2. App-registrering'), dok.indexOf('### 3.'));
        sjekk('steg 2 anbefaler ikke sertifikat så lenge koden ikke kan det',
            /[Ss]ertifikat er å foretrekke/.test(steg2), false);
        sjekk('og sier hvorfor auth-appen likevel kan bruke det',
            /clientSecretCertificateKeyVaultReference/.test(steg2), true);
        // Formatkravet er målt, og det er det som avgjør om et sertifikat i
        // Key Vault i det hele tatt lar seg lese. Står det ikke her, blir
        // det oppdaget i produksjon.
        sjekk('og at et sertifikat må være PEM, ikke PKCS#12',
            /PKCS#12/.test(steg2) && /PEM/.test(steg2), true);
    } else {
        sjekk('sertifikat støttes — dokumentet må beskrive oppsettet',
            /GRAPH_CLIENT_CERT/.test(dok), true);
    }
}

// ---------- 5. formatkravet står likt tre steder ----------
//
// Koden avviser PKCS#12 og navngir løsningen i feilmeldingen. Kokeboka har
// det som et punkt i bestillingen. Backup-dokumentet har framgangsmåten.
// Endres kravet ett sted, skal de to andre følge — ellers bestiller noen ett
// format og feilsøker et annet.
{
    const kokebok = les('docs', 'KOKEBOK-PROD-V3.md');

    // Innholdstypen koden peker på, lest ut av SELVE AVVISNINGEN. Over hele
    // fila traff søket `application/x-www-form-urlencoded` fra HTTP-headeren.
    const avvisStart = kilde.indexOf('er ikke PEM.');
    sjekk('fant PFX-avvisningen i koden', avvisStart > 0, true);
    const avvisning = kilde.slice(avvisStart, avvisStart + 600);
    sjekk('avvisningen peker på PEM-innholdstypen',
        /application\/x-pem-file/.test(avvisning), true);
    sjekk('og navngir formatet som ikke virker',
        /PKCS#12/.test(avvisning), true);

    for (const [navn, tekst] of [['BACKUP-SHAREPOINT.md', dok], ['KOKEBOK-PROD-V3.md', kokebok]]) {
        sjekk(`${navn} krever samme innholdstype som koden`,
            tekst.includes('application/x-pem-file'), true);
        // Og den gale varianten skal være nevnt — et krav uten fellen ved
        // siden av forteller ikke hva man skal se etter.
        sjekk(`${navn} navngir også formatet som IKKE virker`,
            /application\/x-pkcs12/.test(tekst), true);
    }

    // Variabelnavnet bærer formatkravet. Endres det, mister navnet poenget
    // sitt, og da skal noen ta stilling til det bevisst.
    sjekk('variabelnavnet sier PEM', /GRAPH_CLIENT_CERT_PEM/.test(kilde), true);
}

// ---------- 6. dev-oppskriften kan ikke gi et falskt grønt svar ----------
//
// `tokenKropp` lar hemmeligheten vinne når begge er satt. Da er det ÉN måte
// dev-prøven kan se vellykket ut uten å ha prøvd noe: at
// GRAPH_CLIENT_SECRET blir stående. Oppskriften må si det — og snus
// rekkefølgen i koden en dag, skal denne si fra, ikke tilpasse seg.
{
    const hemmelighetVinner = /if \(k\.clientSecret\)\s*return/.test(kropp);
    sjekk('koden lar hemmeligheten vinne når begge er satt', hemmelighetVinner, true);

    const fra = dok.indexOf('Prøv i dev først');
    const til = dok.indexOf('Hvor sertifikatveien');
    sjekk('dev-oppskriften finnes i dokumentet', fra > 0 && til > fra, true);
    const dev = dok.slice(fra, til);

    if (hemmelighetVinner) {
        sjekk('og den krever at GRAPH_CLIENT_SECRET står tom',
            /GRAPH_CLIENT_SECRET[\s\S]{0,60}tom/.test(dev), true);
        sjekk('og sier hvorfor det betyr noe',
            /tester du ingenting|falskt grønt/.test(dev), true);
    }

    // Oppskriften skal be om PEM-innholdstypen eksplisitt — standardpolicyen
    // gir PKCS#12, og det er nettopp fellen hele avsnittet handler om.
    sjekk('oppskriften overstyrer innholdstypen',
        /secretProperties\.contentType\s*=\s*['"]application\/x-pem-file['"]/.test(dev), true);
}

// ---------- 7. appnavnet står likt i skriptet og i dokumentet ----------
//
// 20.10.2026 ble backup-sertifikatet lastet opp på `sp-skjema-3-dev` —
// deploy-tjenestehovedobjektet — i stedet for backup-appen. Avtrykket
// stemte med Key Vault, så sammenligningen så riktig ut, men Entra slår opp
// på appen `client_id` navngir og fant ingenting.
//
// Dokumentet navngir nå begge, så forvekslingen kan ses. Navnet må komme
// fra skriptet som faktisk oppretter appen, ikke fra en avskrift.
{
    const skript = fs.readFileSync(
        path.join(rot, 'scripts', 'opprett-backup-app.ps1'), 'utf8');
    const m = /\[string\]\$Navn\s*=\s*'([^']+)'/.exec(skript);
    sjekk('fant standardnavnet i opprett-backup-app.ps1', !!m, true);

    const appnavn = m && m[1];
    sjekk('dokumentet navngir backup-appen', dok.includes(appnavn), true);

    // Og den andre siden av forvekslingen: deploy-SP-en skal nevnes, ellers
    // forteller dokumentet ikke hva man kan komme til å forveksle den med.
    sjekk('dokumentet navngir også deploy-tjenestehovedobjektet',
        /sp-skjema-\*|create-for-rbac/.test(dok), true);

    // Det som faktisk avgjør: appen GRAPH_CLIENT_ID peker på.
    sjekk('dokumentet peker på GRAPH_CLIENT_ID som fasiten',
        /GRAPH_CLIENT_ID[\s\S]{0,120}peker på/.test(dok), true);
}

// ---------- 8. parametrene dokumentet ber om, finnes i skriptet ----------
//
// Dev-oppskriften hadde ingen kommandolinje i det hele tatt: den begynte med
// sertifikatet og antok at app-registreringen fantes. 20.10.2026 fulgte noen
// den, hadde ingen backup-app i dev, og lastet sertifikatet opp på
// deploy-tjenestehovedobjektet i stedet.
//
// Nå står kallet der — og et dokumentert flagg som ikke finnes i skriptet er
// samme feil ett lag unna: oppskriften stopper på «A parameter cannot be
// found that matches parameter name».
{
    const skript = fs.readFileSync(
        path.join(rot, 'scripts', 'opprett-backup-app.ps1'), 'utf8');
    const parametre = [...skript.matchAll(/\[(?:switch|string|int)\]\$(\w+)/g)].map(m => m[1]);
    sjekk('fant parameterlista i skriptet', parametre.length > 3, true);

    const kall = [...dok.matchAll(/opprett-backup-app\.ps1([^\n]*)/g)].map(m => m[1]);
    sjekk('dokumentet viser hvordan skriptet kalles', kall.length > 0, true);

    const brukt = [...new Set(kall.flatMap(k => [...k.matchAll(/-([A-ZÆØÅ]\w+)/g)].map(m => m[1])))];
    sjekk('og alle flaggene det bruker finnes i skriptet',
        brukt.filter(b => !parametre.includes(b)), []);

    // Og veien koden faktisk har, skal være den dev-oppskriften tar. Lages en
    // hemmelighet som ikke skal brukes, er den en ekstra vei inn og en ekstra
    // utløpsdato — og den vinner over sertifikatet hvis noen setter den.
    if (koden['sertifikat']) {
        sjekk('skriptet kan hoppe over klienthemmeligheten',
            parametre.includes('Sertifikat'), true);
        sjekk('og dev-oppskriften bruker det', brukt.includes('Sertifikat'), true);
    }
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
