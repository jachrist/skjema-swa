/**
 * Samtalen må med i PDF-en.
 *
 * Når saken lukkes, deaktiveres lenken til samtalen. Da er PDF-en
 * innsenderens ENESTE kopi av en samtale om hens egen sak. Mangler den der,
 * er den borte — og ingenting sier fra, fordi PDF-en genereres og leveres som
 * normalt.
 *
 * To ledd må henge sammen, og de ligger i hver sin fil:
 *
 *   `pdf.js` må HENTE samtalen. Den ligger i egen tabell, ikke i skjemaet, så
 *   den kommer ikke med av seg selv slik `Dialog` gjør.
 *
 *   `pdf-generator.js` må SKRIVE den ut. Uten filtrering: samtalen har ingen
 *   interne innlegg, og alt som står der har alle deltakerne allerede sett.
 *   Det er nettopp derfor den er trygg å skrive ut i sin helhet — i motsetning
 *   til `Dialog`, som kalleren må filtrere først.
 *
 * Testen er kildebasert. Å bygge en ekte PDF krever `pdf-lib`, og testene her
 * skal kjøre uten `node_modules` — men det er hentingen og utskrivingen som
 * kan falle bort, ikke tegningen.
 *
 * Kjøres med:  node api/test/samtale-pdf.test.js
 */
const fs = require('fs');
const path = require('path');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const les = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');
const endepunkt = les('functions/pdf.js');
const generator = les('lib/pdf-generator.js');

// ---------- hentingen ----------
{
    sjekk('pdf.js henter samtalen',
        /samtaleStorage\.hentInnlegg\(/.test(endepunkt), true);
    sjekk('og legger den på skjemaet',
        /skjema\.Samtale\s*=/.test(endepunkt), true);

    // Rekkefølgen: hentingen må skje før generatoren kalles. Etterpå er
    // dokumentet allerede tegnet.
    sjekk('hentes før generatoren kalles',
        endepunkt.indexOf('samtaleStorage.hentInnlegg') < endepunkt.indexOf('genererOppsummeringPdf(skjema'), true);

    // Best-effort: en PDF uten samtale er bedre enn ingen PDF, men det skal
    // stå i loggen at den mangler.
    const blokk = endepunkt.slice(endepunkt.indexOf('samtaleStorage.hentInnlegg') - 200,
        endepunkt.indexOf('samtaleStorage.hentInnlegg') + 300);
    sjekk('hentingen kan ikke velte PDF-en', /catch/.test(blokk), true);
    sjekk('og feilen logges', /context\.log/.test(blokk), true);
}

// ---------- utskrivingen ----------
{
    sjekk('generatoren leser skjema.Samtale',
        /Array\.isArray\(skjema\.Samtale\)/.test(generator), true);
    sjekk('og gir seksjonen en overskrift',
        /skrivTekst\('Samtale'/.test(generator), true);

    // Avsender, dato og tekst — uten dem er utskriften en vegg av tekst der
    // ingen kan se hvem som sa hva.
    const start = generator.indexOf('// === SAMTALE ===');
    const slutt = generator.indexOf('// === DIALOG ===', start);
    sjekk('fant samtale-blokken', start !== -1 && slutt > start, true);
    const blokk = generator.slice(start, slutt);

    sjekk('avsenderen skrives ut', /AvsenderNavn \|\| i\.Avsender/.test(blokk), true);
    sjekk('datoen skrives ut', /formatKortDato\(i\.Dato\)/.test(blokk), true);
    sjekk('teksten brytes over linjer', /wrapTekst\(i\.Tekst/.test(blokk), true);

    // Ingen filtrering her — og det skal det ikke være. Samtalen har ingen
    // interne innlegg. Dukker det opp et Type-filter, betyr det at noen har
    // gjeninnført et skjult modus, og da er dette stedet det lekker.
    //
    // Kommentarene strippes først. Uten det traff regexen forklaringen rett
    // over — testen ville bestått på sin egen dokumentasjon, og feilet så
    // snart noen skrev ordet «intern» i en kommentar.
    const kode = blokk.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    sjekk('ingen intern-filtrering i samtale-blokken', /intern/i.test(kode), false);

    // Dialog-blokken under SKAL fortsatt skille intern og ekstern. Den
    // filtreres av kalleren, men skriver dem i hver sin seksjon.
    sjekk('dialog-blokken skiller fortsatt',
        /Intern dialog/.test(generator.slice(slutt)), true);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
