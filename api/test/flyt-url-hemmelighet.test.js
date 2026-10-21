/**
 * Er en flyt-URL en hemmelighet? Det avhenger, og det er det som er poenget.
 *
 * Spørsmålet kom 21.10.2026, midt i oppsettet av prod v3: trengs flyt-URLene
 * i Key Vault når de ikke har `sig=` lenger?
 *
 * Svaret er nei. Uten signaturen er adressen ingen legitimasjon — den som har
 * den, kan ikke kalle flyten: kallet krever et Entra-token for
 * `https://service.flow.microsoft.com/`, og identitetens `oid` må stå i
 * flytens allow-liste.
 *
 * **Men svaret hviler på en egenskap ved FLYTEN**, ikke på noe i dette
 * repoet. Importeres en gammel flyt, eller settes en HTTP-trigger opp uten
 * Entra, kommer `sig=` tilbake — og da ligger en hemmelighet i klartekst i
 * app settings, mens `FLYT_AUTH=entra` sier at alt er i orden. Ingenting
 * feiler, og ingen ser det.
 *
 * `sasIUrlTrossEntra` er vakten for nettopp det. Den leses av helsesjekken,
 * og den prøves her — mot den ekte funksjonen, ikke en avskrift.
 *
 * Kjøres med:  node api/test/flyt-url-hemmelighet.test.js
 */
const fs = require('fs');
const path = require('path');
const { sasIUrlTrossEntra, MODUS } = require('../src/lib/flyt-auth');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const MED_SIG = 'https://prod-12.westeurope.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?api-version=2016-06-01&sig=hemmelig';
const UTEN_SIG = 'https://prod-12.westeurope.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?api-version=2016-06-01';

// ---------- 1. regelen ----------
{
    sjekk('entra + sig gir en advarsel', typeof sasIUrlTrossEntra(MED_SIG, 'entra'), 'string');
    sjekk('entra uten sig er stille', sasIUrlTrossEntra(UTEN_SIG, 'entra'), null);

    // I sas-modus ER signaturen meningen. Da skal vakten ikke si noe — en
    // advarsel som alltid står, er en advarsel ingen leser.
    sjekk('sas + sig er stille', sasIUrlTrossEntra(MED_SIG, 'sas'), null);
    sjekk('sas uten sig er stille', sasIUrlTrossEntra(UTEN_SIG, 'sas'), null);

    sjekk('tom verdi gir ingen advarsel', sasIUrlTrossEntra('', 'entra'), null);
    sjekk('manglende verdi gir ingen advarsel', sasIUrlTrossEntra(undefined, 'entra'), null);

    // `sig` må være en PARAMETER, ikke en delstreng. En flyt som heter
    // «design-signatur» skal ikke utløse den.
    sjekk('sig i stien utløser ingenting',
        sasIUrlTrossEntra('https://x/workflows/design-signatur/invoke', 'entra'), null);
    sjekk('men sig som andre parameter fanges',
        typeof sasIUrlTrossEntra('https://x/y?a=1&sig=k', 'entra'), 'string');

    // Meldingen må si HVA man skal gjøre. «Advarsel» alene er ingenting.
    const m = sasIUrlTrossEntra(MED_SIG, 'entra');
    sjekk('meldingen sier at adressen er legitimasjon', /legitimasjon/.test(m), true);
    sjekk('og at den står i klartekst', /klartekst/.test(m), true);
    sjekk('og nevner begge mulige årsaker',
        /modusen/.test(m) && /gammel kopi/.test(m), true);

    // Signaturen skal ALDRI være med i meldingen — den havner i et API-svar.
    sjekk('signaturen gjentas ikke i meldingen', /hemmelig/.test(m), false);
}

// ---------- 2. modusnavnet er lest ut av modulen ----------
//
// Første forsøk sammenlignet med `MODUS.ENTRA`. `MODUS` er en LISTE, så det
// var `undefined` — og vakten slo aldri til, i noen modus. Den feilen er
// usynlig: funksjonen returnerer null, altså «alt i orden».
{
    sjekk('MODUS er en liste', Array.isArray(MODUS), true);
    sjekk('og inneholder entra', MODUS.includes('entra'), true);

    // Prøvd mot HVER modus modulen kjenner: ingen av dem skal gi en vakt som
    // er stille når den skal rope, eller omvendt.
    const svar = MODUS.map(m => [m, sasIUrlTrossEntra(MED_SIG, m) !== null]);
    sjekk('bare entra-modus advarer', svar, [['sas', false], ['entra', true]]);
}

// ---------- 3. helsesjekken bruker den ----------
//
// En vakt ingen leser, er ingenting. `system.js` krever @azure/functions på
// toppnivå og kan ikke lastes her, så koblingen prøves i kilden.
{
    const kilde = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'functions', 'system.js'), 'utf8');

    sjekk('system.js importerer vakten',
        /sasIUrlTrossEntra \} = require\('\.\.\/lib\/flyt-auth'\)|, sasIUrlTrossEntra \}/.test(kilde), true);

    // Den må brukes i maskFlytUrl — det er den funksjonen som rapporterer
    // *_FLOW_URL-ene.
    const fra = kilde.indexOf('function maskFlytUrl');
    const til = kilde.indexOf('\napp.http', fra);
    const mask = kilde.slice(fra, til);
    sjekk('maskFlytUrl kaller den', /sasIUrlTrossEntra\(verdi\)/.test(mask), true);
    sjekk('og tar advarselen med i svaret', /advarsel \? \{ advarsel \}/.test(mask), true);

    // Og signaturen skal fortsatt ikke med i svaret. Feltene er vertsnavn og
    // sti — query-strengen er aldri med.
    sjekk('svaret bærer bare vertsnavn og sti',
        /vertsnavn: u\.hostname, sti: u\.pathname/.test(mask), true);
    sjekk('ingen søk eller query i svaret', /u\.search|u\.query/.test(mask), false);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
