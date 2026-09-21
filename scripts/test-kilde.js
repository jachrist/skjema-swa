/**
 * Les kildefiler for tester, uten kommentarer.
 *
 * Mange av testene leser koden som tekst og sjekker at en regel finnes eller
 * ikke finnes. Da må kommentarene bort: uten det kan en test bestå på sin egen
 * forklaring, og en sjekk på at noe IKKE finnes kan feile fordi ordet står i
 * en kommentar rett over.
 *
 * Hver test hadde sin egen strippe-funksjon, og alle hadde samme feil:
 *
 *     .replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
 *
 * I `admin.html` står det `accept="image/*,.pdf,.txt,…"`. Skråstrek-stjernen i
 * `image/*` er ikke en kommentar, men regexen ser den som starten på én — og
 * spiser 17 490 tegn fram til neste `*/`. Testen leser da en fil med et
 * hull i, og en sjekk på at noe ikke finnes, består fordi teksten ble borte.
 *
 * Det er den farligste formen for testfeil: den er grønn.
 *
 * Reglene her er strengere, og bygget på hvordan ekte kommentarer faktisk ser
 * ut:
 *
 *   En blokk-kommentar starter på linjestart eller etter skilletegn, og
 *   `/*` følges av mellomrom, linjeskift eller enda en stjerne. `image/*` har
 *   en bokstav foran og komma etter, og overlever.
 *
 *   En linje-kommentar starter ikke rett etter `:` — det tar `https://`. Den
 *   starter heller ikke inne i en streng som åpenbart er en sti.
 *
 * Reglene er ikke en parser og later ikke som. De er valgt slik at feilen,
 * når den oppstår, gir for LITE stripping og ikke for mye: en kommentar som
 * blir stående kan gi en falsk grønn på én sjekk, mens kode som blir spist
 * gir falsk grønn på alle sjekkene rundt.
 */
const fs = require('fs');

/** HTML-kommentarer. Entydige — de har ingen tvillingbruk i verdier. */
function utenHtmlKommentarer(kilde) {
    return String(kilde).replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * Blokk-kommentarer.
 *
 * `/*` må stå først på linja, eller etter mellomrom eller et skilletegn, OG
 * følges av mellomrom, linjeskift eller `*`. Tegnet foran beholdes.
 */
function utenBlokkKommentarer(kilde) {
    return String(kilde).replace(/(^|[\s{};,(])\/\*[\s*][\s\S]*?\*\//g, '$1');
}

/**
 * Linje-kommentarer.
 *
 * `//` teller ikke når det står rett etter `:` (protokoll i en URL), etter en
 * skråstrek (en sti som `a//b`), eller rett etter et anførselstegn — da er det
 * starten på en protokoll-relativ URL i en streng. Tegnet foran beholdes.
 *
 * Prisen er at en kommentar som klistrer seg inntil en streng uten mellomrom
 * (`'x'// se her`) blir stående. Det er den retningen feilen skal gå: en
 * kommentar for mye kan gi falsk grønn på én sjekk, mens kode som blir spist
 * gir falsk grønn på alle sjekkene rundt.
 */
function utenLinjeKommentarer(kilde) {
    return String(kilde).replace(/(^|[^:/\\'"`])\/\/[^\n]*/g, '$1');
}

/** Alle tre, i den rekkefølgen som gjør minst skade. */
function utenKommentarer(kilde) {
    return utenLinjeKommentarer(utenBlokkKommentarer(utenHtmlKommentarer(kilde)));
}

/** Les en fil og strip kommentarene. */
function lesKode(...stier) {
    const path = require('path');
    return utenKommentarer(fs.readFileSync(path.join(...stier), 'utf8'));
}

module.exports = {
    utenKommentarer, lesKode,
    utenHtmlKommentarer, utenBlokkKommentarer, utenLinjeKommentarer
};
