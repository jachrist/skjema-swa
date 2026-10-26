/**
 * Beslutningssvaret må si HVA SOM SKJEDDE — også når ingenting skjedde.
 *
 * 26.10.2026: en behandler trykket «Anbefalt» flere ganger og så steget stå
 * uendret. Kallet svarte `status: 'ok'` hver gang, og siden rendret seg likt
 * på nytt. «Ok» på noe som ikke flyttet seg er like misvisende som en
 * feilmelding som peker feil vei.
 *
 * I alle-modus er det tre ulike ting som kan skje, og de ser like ut utenfra:
 *
 *   registrert — en ny beslutning ble lagt til
 *   oppdatert  — aktøren hadde avgitt før, og endret valg eller kommentar
 *   uendret    — aktøren avga nøyaktig det samme en gang til
 *
 * Svaret bærer også `aktor`. Testes det med to kontoer i samme nettleser, er
 * det den som avslører at begge klikkene havnet på den samme — og det er
 * nettopp den feilen man ellers leter etter i koden.
 *
 * `utfall` settes ALLTID når alle-modus kjører. Et felt som kan mangle kan
 * ikke feilsøkes: «det gikk galt» blir umulig å skille fra «koden er ikke
 * deployet».
 *
 * Kjøres med:  node api/test/beslutning-utfall.test.js
 */
const fs = require('fs');
const path = require('path');
const { utenKommentarer } = require('../../scripts/test-kilde.js');
const { beregnAlleKrav } = require('../src/lib/behandling');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const kilde = utenKommentarer(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'functions', 'skjemaer.js'), 'utf8'));
const ui = utenKommentarer(
    fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'evaluering.html'), 'utf8'));

// ---------- de tre utfallene skilles ----------
{
    sjekk('ny beslutning merkes registrert', /utfall = 'registrert';/.test(kilde), true);
    sjekk('likt valg OG lik kommentar er uendret',
        /utfall = \(likBeslutning && likKommentar\) \? 'uendret' : 'oppdatert';/.test(kilde), true);

    // Begge delene av sammenligningen må være med. Bare beslutningen ville
    // meldt «uendret» på en ny kommentar — som ER en endring, og som lagres.
    sjekk('beslutningen sammenlignes',
        /const likBeslutning = Number\(eksisterende\.Beslutning\) === Number\(beslutning\);/.test(kilde), true);
    sjekk('og kommentaren sammenlignes',
        /const likKommentar = String\(eksisterende\.Kommentar \|\| ''\) === String\(body\?\.kommentar \|\| ''\);/.test(kilde), true);
}

// ---------- svaret bærer det videre ----------
{
    // Leses ut av det EKTE svarobjektet, ikke antatt som stenografi: `aktor`
    // står med en verdi (`upn || 'ekstern-flyt'`), de tre andre som
    // stenografi. En regex som bare godtok den ene formen meldte feil på et
    // felt som var der.
    const svaret = kilde.slice(kilde.indexOf("status: 'ok',", kilde.indexOf('const erOmpuss')));
    for (const felt of ['aktor', 'utfall', 'venterPaa', 'levert']) {
        sjekk(`svaret bærer ${felt}`,
            new RegExp(`(^|\\n)\\s*${felt}(,|:)`).test(svaret.slice(0, 400)), true);
    }
    sjekk('venterPaa kommer fra kravberegningen',
        /venterPaa = \[\.\.\.gjenstar\];/.test(kilde), true);

    // Feltene erklæres FØR grenen, så de alltid finnes i svaret. Erklæres de
    // inni, er de undefined i alle andre moduser — og JSON.stringify dropper
    // dem, så «uten alle-modus» blir umulig å skille fra «feltet mangler».
    // Målt mot GRENEN, ikke mot bruken. Flyttes erklæringen inn i
    // alle-modus-grenen, står den fortsatt før bruken — og en test som bare
    // sammenlignet de to ville vært grønn mens feltene forsvant fra svaret i
    // alle andre moduser.
    const iErkl = kilde.indexOf('let utfall = null;');
    const iGren = kilde.indexOf('if (kreverAlle && harKandidater)');
    sjekk('fant både erklæringen og alle-modus-grenen',
        iErkl > -1 && iGren > -1, true);
    sjekk('feltene erklæres UTENFOR alle-modus, så svaret alltid bærer dem',
        iErkl < iGren, true);
}

// ---------- UI-et sier fra når ingenting skjedde ----------
{
    sjekk('UI-et leser svaret', /const res = await api\.post\(/.test(ui), true);
    sjekk('og sier fra ved uendret', /res\.utfall === 'uendret'/.test(ui), true);
    sjekk('med hvem beslutningen ble registrert på', /res\.aktor/.test(ui), true);
    sjekk('og hvem steget venter på', /res\.venterPaa/.test(ui), true);
}

// ---------- kravberegningen, som venterPaa kommer fra ----------
//
// Den ekte funksjonen, ikke en etterligning: `gjenstar` er det brukeren får
// se, og en oppdiktet form her ville gjort testen over til pynt.
(async () => {
    const steg = {
        Roller: ['Emneansvarlig(FKI0301)', 'Emneansvarlig(ING2301)'],
        Personer: [], Team: [],
        Beslutninger: [{ Aktor: 'behandler1@x.no', Beslutning: 1 }]
    };
    const cache = null;
    // Stubbet medlemskap gjennom en cache ville krevd lagring; her holder det
    // å vise formen: uten treff er ingen krav dekket, og alle gjenstår.
    const r = await beregnAlleKrav(steg, cache);
    sjekk('kravene er én per rolle', r.krav.map(k => k.navn),
        ['Emneansvarlig(FKI0301)', 'Emneansvarlig(ING2301)']);
    sjekk('gjenstår er de udekkede', r.gjenstar.length, r.krav.filter(k => !k.dekket).length);
    sjekk('alleLevert krever at alle er dekket', r.alleLevert, false);

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
})();
