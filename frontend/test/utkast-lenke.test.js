/**
 * Lenka tilbake til et mellomlagret utkast.
 *
 * Brukerønske: vanlige brukere skal gå rett fra en skjemareferanse til
 * utfylling og aldri innom skjemavelgeren. Men det er NETTOPP der
 * mellomlagrede utkast listes opp — så den som lagret et utkast og lukket
 * fanen, hadde ingen vei tilbake.
 *
 * Lenka har ligget i adressefeltet hele tiden: `lagreForSenere` skriver den
 * med `replaceState` etter første lagring. Den var bare usynlig for den som
 * ikke vet at den er der, og det er flertallet.
 *
 * Tre ting testes:
 *
 *   **Formen på lenka**, kjørt ekte. Den bygges av `utkastLenke`, som tar
 *   opprinnelsen som PARAMETER nettopp for å kunne prøves her.
 *
 *   **At boksen faktisk tegnes**, mot en stubbet DOM — med lenka, teksten og
 *   kopieringsknappen i.
 *
 *   **At den bare vises når lagringen gikk bra**, og at den BLIR STÅENDE. En
 *   melding som forsvinner etter noen sekunder er ubrukelig for noe brukeren
 *   skal ta vare på.
 *
 * Kjøres med:  node frontend/test/utkast-lenke.test.js
 */
const fs = require('fs');
const path = require('path');
const { utenKommentarer } = require('../../scripts/test-kilde.js');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const raa = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

/** Klipp ut én funksjon fra siden, fra signaturen til dens egen avslutning. */
function klipp(navn, start) {
    const fra = raa.indexOf(start);
    if (fra < 0) return null;
    // Funksjonene ligger på åtte mellomrom innrykk; avslutningen er den
    // første `\n        }` etter starten.
    const til = raa.indexOf('\n        }', fra);
    return til < 0 ? null : raa.slice(fra, til + 10);
}

// ---------- 1. formen på lenka ----------
{
    const kilde = klipp('utkastLenke', 'function utkastLenke(');
    sjekk('fant utkastLenke i index.html', !!kilde, true);

    const utkastLenke = new Function(`${kilde}\nreturn utkastLenke;`)();

    sjekk('lenka er absolutt og peker på utfyllingssiden',
        utkastLenke('https://fskjema.no', 'ST-12', 'SK-99'),
        'https://fskjema.no/index.html?skjematype_id=ST-12&skjema_id=SK-99');

    // Begge parameterne må med. Mangler skjematype_id, vet ikke siden hvilken
    // skjematype den skal tegne, og utkastet er like utilgjengelig som før.
    const l = utkastLenke('https://x', 'A', 'B');
    sjekk('skjematype_id er med', l.includes('skjematype_id=A'), true);
    sjekk('skjema_id er med', l.includes('skjema_id=B'), true);

    // URL-koding. Id-ene er våre egne og tamme, men en regel som bare er
    // trygg fordi inndata tilfeldigvis er det, er ikke en trygg regel.
    sjekk('id-er kodes', utkastLenke('https://x', 'a b&c', 'd=e'),
        'https://x/index.html?skjematype_id=a%20b%26c&skjema_id=d%3De');
}

// ---------- 2. boksen tegnes ----------
{
    const kilde = klipp('visUtkastLenke', 'function visUtkastLenke(');
    sjekk('fant visUtkastLenke i index.html', !!kilde, true);
    const lenkeKilde = klipp('utkastLenke', 'function utkastLenke(');

    const boks = {
        id: 'utkast-lenke-boks',
        className: '',
        style: { display: 'none', textAlign: '' },
        innerHTML: '',
        scrollIntoView() { this._rullet = true; }
    };
    const vis = new Function('document', 'window', 'skjematypeId', 'escapeHtml',
        `${lenkeKilde}\n${kilde}\nreturn visUtkastLenke;`)(
        { getElementById: (id) => (id === 'utkast-lenke-boks' ? boks : null) },
        { location: { origin: 'https://fskjema.no' } },
        'ST-7',
        (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
    );

    vis('SK-42');

    sjekk('boksen vises', boks.style.display, 'block');
    sjekk('og er merket som en infomelding', boks.className, 'status-melding info');
    sjekk('lenka står i boksen',
        boks.innerHTML.includes('https://fskjema.no/index.html?skjematype_id=ST-7&amp;skjema_id=SK-42'), true);
    sjekk('feltet er readonly', /readonly/.test(boks.innerHTML), true);
    sjekk('det finnes en kopieringsknapp', /kopierUtkastLenke\(\)/.test(boks.innerHTML), true);

    // Forklaringen er halve poenget: lenka uten teksten er en adresse ingen
    // vet hva de skal med.
    sjekk('teksten sier at utkastet er lagret', /lagret/i.test(boks.innerHTML), true);
    sjekk('og ber brukeren ta vare på lenka', /[Tt]a vare på/.test(boks.innerHTML), true);
    sjekk('og sier at innlogging kreves', /innlogget/.test(boks.innerHTML), true);

    // Uten id finnes det ingen lenke å vise, og da skal boksen ikke dukke opp
    // tom.
    const boks2 = { ...boks, style: { display: 'none' }, innerHTML: '', scrollIntoView() {} };
    const vis2 = new Function('document', 'window', 'skjematypeId', 'escapeHtml',
        `${lenkeKilde}\n${kilde}\nreturn visUtkastLenke;`)(
        { getElementById: () => boks2 }, { location: { origin: 'https://x' } }, 'ST', (s) => s);
    vis2(null);
    sjekk('uten id vises ingenting', boks2.style.display, 'none');
}

// ---------- 3. når den kalles, og når den ikke gjør det ----------
{
    const kode = utenKommentarer(raa);
    const fra = kode.indexOf('async function lagreForSenere()');
    const til = kode.indexOf('async function submitSkjema()');
    sjekk('fant lagreForSenere', fra > 0 && til > fra, true);
    const lagring = kode.slice(fra, til);

    // Inne i try-grenen, altså etter at serveren svarte OK.
    const etterSvar = lagring.indexOf('const resp = await api.post');
    const feilgren = lagring.indexOf('} catch (e) {', etterSvar);
    const kall = lagring.indexOf('visUtkastLenke(');
    sjekk('boksen vises etter at lagringen gikk bra',
        kall > etterSvar && kall < feilgren, true);
    sjekk('og ikke i feilgrenen',
        lagring.slice(feilgren).includes('visUtkastLenke('), false);

    // Id-en fra svaret går foran: ved FØRSTE lagring er den eneste kilden.
    sjekk('id-en tas fra svaret, med fallback',
        /visUtkastLenke\(resp\.Skjema_id \|\| skjemaId \|\| skjemaIdParam\)/.test(lagring), true);

    // Boksen skal BLI STÅENDE. Et setTimeout som skjuler den igjen ville
    // gjort hele funksjonen meningsløs.
    const visFra = kode.indexOf('function visUtkastLenke(');
    const visTil = kode.indexOf('window.kopierUtkastLenke', visFra);
    const visKode = kode.slice(visFra, visTil);
    sjekk('ingenting skjuler boksen igjen',
        /display = 'none'|setTimeout/.test(visKode), false);

    // Boksen starter skjult. Uten det står en tom infoboks under skjemaet
    // for alle som ikke har lagret.
    sjekk('boksen starter skjult',
        /utkastBoks\.style\.display = 'none'/.test(kode), true);
}

// ---------- 4. kopieringen innrømmer at den feilet ----------
//
// Utklippstavlen krever sikker kontekst og kan være avslått. En knapp som
// sier «✓ Kopiert» uten å ha kopiert noe, er verre enn ingen knapp: brukeren
// lukker fanen i tillit til at lenka er tatt vare på.
{
    const kode = utenKommentarer(raa);
    const fra = kode.indexOf('window.kopierUtkastLenke');
    const til = kode.indexOf('async function lagreForSenere()', fra);
    const kopi = kode.slice(fra, til);

    sjekk('fant kopieringsfunksjonen', fra > 0 && til > fra, true);
    sjekk('den prøver utklippstavlen', /navigator\.clipboard\.writeText/.test(kopi), true);
    sjekk('og har en reservevei', /execCommand/.test(kopi), true);
    sjekk('og sier fra når ingen av dem virket',
        /Merk teksten og kopier/.test(kopi), true);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
