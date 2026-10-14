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

/**
 * Hent en navngitt funksjon ut av en kildefil og gjør den kallbar.
 *
 * Testene her kjører mot ekte kode, ikke mot kopier skrevet i testen. Fire
 * tester hadde hver sin måte å klippe ut `escapeHtml` på, og én hadde gitt
 * opp og skrevet sin egen `escAttr` — som da ikke hadde hullet den ekte
 * hadde, og derfor heller ikke kunne avsløre det.
 *
 * Leter etter `export function navn(`, `function navn(` og
 * `const navn = (…) =>`, og leser til og med den avsluttende `}` på kolonne 0
 * eller det avsluttende semikolonet.
 *
 * @param {string} kilde  filinnhold
 * @param {string} navn   funksjonsnavnet
 * @param {string[]} ogsa andre funksjoner den er avhengig av, i samme fil
 * @returns {Function}
 */
function hentEksport(kilde, navn, ogsa = []) {
    const biter = [...ogsa, navn].map(n => {
        for (const m of [`export function ${n}(`, `function ${n}(`]) {
            const i = kilde.indexOf(m);
            if (i === -1) continue;
            const slutt = kilde.indexOf('\n}', i);
            if (slutt === -1) break;
            return kilde.slice(i, slutt + 2).replace('export function', 'function');
        }
        throw new Error(`Fant ikke ${n} i kilden`);
    });
    return new Function(`${biter.join('\n')}\nreturn ${navn};`)();
}

/**
 * Navnene som faktisk er i scope i en modul.
 *
 * `import { escapeHtml as escHtml } from …` binder **escHtml**, ikke
 * escapeHtml. Det er hele poenget med denne funksjonen, og det var feilen
 * den ble skrevet for: en test lette etter `\bescapeHtml\b` i importlinja,
 * fant kildenavnet i aliaset, og konkluderte med at navnet var importert.
 * `escapeHtml(...)` i register.html slapp dermed gjennom til pilot og ga
 * «escapeHtml is not defined» første gang lista ble tegnet.
 *
 * Tar med importerte navn (med alias), og det som erklæres i fila selv med
 * `function`, `const`, `let` eller `var`. Ikke en scope-analyse — parametre
 * og blokk-scope ses bort fra — men nok til å svare på «finnes dette navnet
 * i det hele tatt i denne fila».
 */
function bundneNavn(kilde) {
    const ut = new Set();
    for (const m of String(kilde).matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
        for (const del of m[1].split(',')) {
            const t = del.trim();
            if (!t) continue;
            const deler = t.split(/\s+as\s+/);
            ut.add((deler[1] || deler[0]).trim());
        }
    }
    // `import navn from …` og `import * as navn from …`
    for (const m of String(kilde).matchAll(/import\s+(?:\*\s+as\s+)?([A-Za-zÆØÅæøå_$][\w$]*)\s+from/g)) {
        ut.add(m[1]);
    }
    for (const m of String(kilde).matchAll(/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:function|const|let|var)\s+([A-Za-zÆØÅæøå_$][\w$]*)/g)) {
        ut.add(m[1]);
    }
    // Parametre, både til `function f(a, b)` og til `(a, b) =>`.
    //
    // Grovt: alle parametre legges i ett felles sett, uten hensyn til hvilken
    // funksjon de hører til. Det gir FÆRRE treff enn en ekte scope-analyse
    // ville gitt, og det er riktig retning her — en sjekk som roper om navn
    // som finnes, blir slått av. `kommentarerSomHtml(steg, escape)` er
    // grunnen: `escape` er et parameternavn, ikke den utdaterte globalen.
    for (const m of String(kilde).matchAll(/(?:function\s*[A-Za-zÆØÅæøå_$][\w$]*\s*|function\s*)\(([^)]*)\)|\(([^)]*)\)\s*=>|(?:^|[^\w$])([A-Za-zÆØÅæøå_$][\w$]*)\s*=>/gm)) {
        const liste = m[1] ?? m[2] ?? m[3] ?? '';
        for (const p of liste.split(',')) {
            const navn = p.trim().replace(/^\.\.\./, '').split(/[=:\s]/)[0];
            if (/^[A-Za-zÆØÅæøå_$][\w$]*$/.test(navn)) ut.add(navn);
        }
    }
    return ut;
}

module.exports = {
    utenKommentarer, lesKode, hentEksport, bundneNavn,
    utenHtmlKommentarer, utenBlokkKommentarer, utenLinjeKommentarer
};
