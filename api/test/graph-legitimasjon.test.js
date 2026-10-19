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

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
