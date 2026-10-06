/**
 * Oversiktskolonna i registerlista.
 *
 * Lista viste `#123 — innsender@mil.no` for hver rad. For saker er det
 * riktig. For en skjematype som holder masterdata — ett skjema per datapunkt,
 * 270 av dem — er det ubrukelig: man leter etter `epost_privat`, ikke etter
 * sak 123.
 *
 * Fire ting testes:
 *
 *   **Standard er uendret.** Ingen avkryssede felt gir oppførselen fra før.
 *   Det var kravet fra oppdragsgiver, og det er den enkleste måten dette
 *   kunne blitt feil på.
 *
 *   **Rekkefølgen er feltrekkefølgen.** Det finnes ingen egen sortering å
 *   stille på, og da må den som leser koden kunne stole på at rekkefølgen er
 *   den man ser i editoren.
 *
 *   **Nøkkelen matcher `FilterSvar`.** Serveren sender verdiene under
 *   `${seksjon}-${feltnummer}` med padding. Bommer nøkkelen, tegner lista
 *   tomt — uten noen feilmelding, for en manglende nøkkel i et oppslag er
 *   bare `undefined`.
 *
 *   **De to kopiene svarer likt.** Serveren bestemmer hvilke felt som BLIR
 *   SENDT, registeret hvilke som BLIR TEGNET. Er de uenige, henter serveren
 *   felt ingen viser, eller lista viser felt den ikke har fått.
 *
 * Kjøres med:  node api/test/listekolonne.test.js
 */
const fs = require('fs');
const path = require('path');
const { utenKommentarer } = require('../../scripts/test-kilde.js');
const { listekolonner } = require('../src/lib/listekolonne');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const TYPE = {
    Seksjoner: [
        {
            Seksjon_nummer: 1,
            Felter: [
                { Nummer: '01', Type: 'Tekst', Tekst: 'Datapunkt (navn)', Listekolonne: true },
                { Nummer: '02', Type: 'Tekst', Tekst: 'Beskrivelse' },
                { Nummer: '03', Type: 'Flervalg', Tekst: 'Informasjonskategori', Listekolonne: true }
            ]
        },
        {
            Seksjon_nummer: 2,
            Felter: [
                { Nummer: '1', Type: 'Flervalg', Tekst: 'Verdivurdering', Listekolonne: true },
                { Nummer: '2', Type: 'Informasjon', Tekst: { Verdi: 'Les dette' }, Listekolonne: true }
            ]
        }
    ]
};

// ---------- standard: ingenting valgt ----------
{
    sjekk('ingen avkryssede felt', listekolonner({ Seksjoner: [{ Seksjon_nummer: 1, Felter: [{ Nummer: '01', Type: 'Tekst' }] }] }), []);
    sjekk('tom skjematype', listekolonner({}), []);
    sjekk('uten skjematype', listekolonner(null), []);
    // `Listekolonne: false` og et felt uten egenskapen skal behandles likt.
    sjekk('eksplisitt false',
        listekolonner({ Seksjoner: [{ Seksjon_nummer: 1, Felter: [{ Nummer: '01', Type: 'Tekst', Listekolonne: false }] }] }), []);
    // Bare `true` teller — en streng fra en håndredigert definisjon skal ikke
    // slå den på ved et uhell.
    sjekk('sannhetslignende verdi teller ikke',
        listekolonner({ Seksjoner: [{ Seksjon_nummer: 1, Felter: [{ Nummer: '01', Type: 'Tekst', Listekolonne: 'ja' }] }] }), []);
}

// ---------- valgte felt, i feltrekkefølge ----------
{
    const k = listekolonner(TYPE);
    sjekk('tre felt (informasjonsfeltet er ute)', k.map(x => x.nokkel), ['1-01', '1-03', '2-01']);
    sjekk('etikettene følger med', k.map(x => x.Tekst),
        ['Datapunkt (navn)', 'Informasjonskategori', 'Verdivurdering']);
    // Et informasjonsfelt har ingen svar. Krysses det av, skal det ignoreres,
    // ikke gi en tom kolonne uten forklaring.
    sjekk('informasjonsfelt tas ikke med', k.some(x => x.nokkel === '2-02'), false);
}

// ---------- nøkkelen matcher FilterSvar ----------
{
    // Serveren bygger `${sekNr}-${String(f.Nummer).padStart(2, '0')}`. Står
    // feltnummeret upadded i definisjonen, må nøkkelen likevel bli padded.
    sjekk('upadded feltnummer paddes', listekolonner(TYPE).find(x => x.Tekst === 'Verdivurdering').nokkel, '2-01');
    sjekk('seksjonsnummer som tall blir streng', typeof listekolonner(TYPE)[0].sekNr, 'string');

    // Seksjoner fra eldre definisjoner har `Nummer` i stedet for
    // `Seksjon_nummer` — samme fallback som svarNokkel bruker.
    sjekk('seksjon med bare Nummer',
        listekolonner({ Seksjoner: [{ Nummer: 4, Felter: [{ Nummer: '02', Type: 'Tekst', Listekolonne: true }] }] })[0].nokkel,
        '4-02');

    // Og serveren må faktisk ta dem med i FilterSvar — ellers har lista
    // ingenting å tegne.
    const api = utenKommentarer(
        fs.readFileSync(path.join(__dirname, '..', 'src', 'functions', 'skjemaer.js'), 'utf8'));
    sjekk('serveren bruker modulen', /for \(const k of listekolonner\(st\?\.JSON\)\)/.test(api), true);
    sjekk('og legger dem i filterFelt', /filterFelt\.push\(\{ sekNr: k\.sekNr, feltNrPadded: k\.feltNrPadded \}\)/.test(api), true);
    // Uten denne sjekken hentes et felt som er BÅDE filtrerbart og
    // listekolonne to ganger.
    sjekk('ingen dobbeltoppføring', /filterFelt\.some\(f => `\$\{f\.sekNr\}-\$\{f\.feltNrPadded\}` === k\.nokkel\)/.test(api), true);
}

// ---------- registeret tegner det serveren sender ----------
{
    const reg = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'register.html'), 'utf8');
    sjekk('registeret importerer modulen',
        /import \{ listekolonner \} from '\.\/js\/listekolonne\.js'/.test(reg), true);
    sjekk('og bruker nøkkelen fra den', /s\.FilterSvar\?\.\[k\.nokkel\]/.test(reg), true);
    // Standardteksten skal fortsatt finnes, for tilfellet uten kolonner.
    sjekk('faller tilbake til id og innsender',
        /if \(kolonner\.length === 0\) return `#\$\{s\.Skjema_id\} — \$\{s\.Innsender_Epost \|\| '–'\}`/.test(reg), true);
    // Saksnummeret skal ikke forsvinne når kolonnene er satt.
    sjekk('id-en flytter til metalinja', /kolonner\.length > 0 \? '#' \+ escHtml\(s\.Skjema_id\)/.test(reg), true);

    const ed = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'editor.html'), 'utf8');
    sjekk('editoren har avkrysningen', /'Listekolonne', this\.checked/.test(ed), true);
}

// ---------- de to kopiene svarer likt ----------
(async () => {
    const { pathToFileURL } = require('url');
    const front = await import(pathToFileURL(
        path.join(__dirname, '..', '..', 'frontend', 'js', 'listekolonne.js')).href);

    const tilfeller = [
        TYPE,
        {},
        null,
        { Seksjoner: [] },
        { Seksjoner: [{ Seksjon_nummer: 1, Felter: [] }] },
        { Seksjoner: [{ Nummer: 4, Felter: [{ Nummer: 2, Type: 'Tall', Listekolonne: true }] }] },
        { Seksjoner: [{ Seksjon_nummer: 1, Felter: [{ Nummer: '01', Type: 'Informasjon', Tekst: { Verdi: 'x' }, Listekolonne: true }] }] }
    ];
    for (let i = 0; i < tilfeller.length; i++) {
        sjekk(`kopiene er enige: tilfelle ${i}`,
            front.listekolonner(tilfeller[i]), listekolonner(tilfeller[i]));
    }

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
})();
