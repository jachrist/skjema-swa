/**
 * Avhengighet mellom behandlingssteg i editoren.
 *
 * To feil, begge stille, begge meldt inn 23.09.2026:
 *
 *   **Feltet forsvant.** Kandidatlista ble bygget av `slice(0, idx)` — altså
 *   av arrayposisjon. Så lenge rekkefølgen i arrayet og Steg-numrene følger
 *   hverandre er de to det samme, og det gjør de så lenge skjematypen bare
 *   redigeres i editoren. En definisjon som er importert, kopiert eller
 *   håndredigert trenger ikke være sortert — og da så steget ut til å være
 *   det første, feltet ble ikke tegnet, og avhengigheten kunne ikke settes i
 *   det hele tatt. Utslaget merkes først i drift: begge stegene varsles
 *   samtidig, og steg 2 kan avgjøres før steg 1.
 *
 *   **Renummereringen pekte på feil steg.** Ved flytting ble numrene skrevet
 *   om og referansene oppdatert i SAMME løkke. En referanse kunne dermed bli
 *   skrevet om to ganger: først til sitt nye nummer, og så en gang til fordi
 *   et senere steg hadde nettopp det nummeret fra før. Resultatet var ikke en
 *   manglende avhengighet — det var en avhengighet til FEIL steg. Det er den
 *   farlige varianten: alt ser konfigurert ut.
 *
 * Renummereringen kjøres ekte her, ikke lest som tekst. En regel for
 * omnummerering er nettopp den typen som ser riktig ut i kildekoden.
 *
 * Kjøres med:  node frontend/test/steg-avhengighet.test.js
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

const rå = fs.readFileSync(path.join(__dirname, '..', 'editor.html'), 'utf8');
const kode = utenKommentarer(rå);
sjekk('editor.html ble lest', kode.length > 50000, true);

// ---------- renummereringen, kjørt ekte ----------
const renummerer = (function () {
    const m = /function renummererBehandling\(\) \{[\s\S]*?\n        \}/.exec(rå);
    if (!m) return null;
    // `data.Behandling` byttes ut med en parameter så funksjonen kan kalles
    // uten resten av editoren.
    const src = m[0]
        .replace('function renummererBehandling()', 'function f(Behandling)')
        .replace(/data\.Behandling \|\| \[\]/g, 'Behandling || []');
    // eslint-disable-next-line no-eval
    return eval(`(${src})`);
})();
sjekk('renummereringen lot seg hente ut', typeof renummerer, 'function');

function flytt(steg, fra, til) {
    const [s] = steg.splice(fra, 1);
    steg.splice(til, 0, s);
    renummerer(steg);
    return steg;
}
/** Navnet på steget en avhengighet faktisk peker på. */
function peker(steg, navn) {
    const s = steg.find(x => x.N === navn);
    const mål = steg.find(x => Number(x.Steg) === Number(s.AvhengigAv));
    return mål ? mål.N : null;
}

if (renummerer) {
    // Den opprinnelige feilen: C avhenger av B, B flyttes fremst.
    let b = [{ Steg: 1, N: 'A' }, { Steg: 2, N: 'B' }, { Steg: 3, N: 'C', AvhengigAv: 2 }];
    flytt(b, 1, 0);
    sjekk('numrene følger rekkefølgen', b.map(s => `${s.N}=${s.Steg}`), ['B=1', 'A=2', 'C=3']);
    sjekk('C avhenger fortsatt av B', peker(b, 'C'), 'B');

    // Motsatt vei: steget det pekes PÅ flyttes bakover.
    b = [{ Steg: 1, N: 'A' }, { Steg: 2, N: 'B', AvhengigAv: 1 }, { Steg: 3, N: 'C' }];
    flytt(b, 0, 2);
    sjekk('B avhenger fortsatt av A', peker(b, 'B'), 'A');

    // Flere avhengigheter samtidig — her slo dobbeltskrivingen hardest til.
    b = [{ Steg: 1, N: 'A' }, { Steg: 2, N: 'B', AvhengigAv: 1 }, { Steg: 3, N: 'C', AvhengigAv: 2 }];
    flytt(b, 2, 0);
    sjekk('B peker på A etter flytting', peker(b, 'B'), 'A');
    sjekk('C peker på B etter flytting', peker(b, 'C'), 'B');

    // En referanse til et steg som ikke finnes skal fjernes, ikke bevares.
    // Beholdt ville den blokkert steget for alltid — se sjekkAvhengighet.
    b = [{ Steg: 1, N: 'A' }, { Steg: 2, N: 'B', AvhengigAv: 99 }];
    renummerer(b);
    sjekk('ukjent referanse fjernes', b[1].AvhengigAv, undefined);

    // Ingen avhengighet skal ikke bli til en.
    b = [{ Steg: 2, N: 'A' }, { Steg: 1, N: 'B' }];
    renummerer(b);
    sjekk('uten avhengighet forblir uten', b.some(s => 'AvhengigAv' in s), false);
}

// ---------- kandidatene kommer fra Steg-nummer, ikke posisjon ----------
{
    sjekk('kandidatene filtreres på nummer',
        /\.filter\(s => Number\(s\.Steg\) < nr\)/.test(kode), true);
    sjekk('og sorteres på nummer',
        /\.sort\(\(a, b\) => Number\(a\.Steg\) - Number\(b\.Steg\)\)/.test(kode), true);
    // Den gamle regelen skal være borte. Står den igjen, er feilen tilbake.
    sjekk('arrayposisjon brukes ikke lenger',
        /const forrigeSteg = \(data\.Behandling \|\| \[\]\)\.slice\(0, idx\)/.test(kode), false);
}

// ---------- feltet tegnes alltid ----------
{
    sjekk('velgeren finnes', /onchange="setStegAvhengig\(\$\{idx\}, this\.value\)"/.test(kode), true);
    sjekk('den vises når det finnes tidligere steg',
        /\$\{tidligere\.length > 0 \? `/.test(kode), true);
    // Uten forklaringen forsvant raden helt på steg 1, og det så ut som om
    // muligheten ikke fantes — nøyaktig slik feilen ble meldt inn.
    sjekk('ellers står det hvorfor',
        /Ingen steg med lavere nummer å vente på/.test(kode), true);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
