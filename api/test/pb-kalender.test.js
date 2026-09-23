/**
 * Power BI-koblinger i nøkkelkalenderen.
 *
 * Tokenet bak en rapport varer i 365 dager. Når det går ut, feiler
 * oppdateringen med 403 og Power BI deaktiverer planen — for noen som
 * sannsynligvis ikke var med da koblingen ble satt opp. Ingenting varslet om
 * det før 23.09.2026.
 *
 * Fem ting testes, og det første er det viktigste:
 *
 *   **Én eskaleringsregel, ikke to.** Radene formes slik at
 *   `nokkelkalender-storage.skalVarsles` kan brukes uendret. Testen kjører
 *   den ekte funksjonen på en Power BI-rad og krever samme svar som for en
 *   vanlig kalenderrad. En egen «når skal vi mase»-regel for Power BI ville
 *   før eller siden svart noe annet — og da hadde den ene typen enten maset
 *   hver dag eller tiet i en måned.
 *
 *   **Utløpet kopieres ikke.** Det leses fra tokenraden hver gang. Kalenderens
 *   egne datoer føres for hånd fordi vi ikke kan spørre Key Vault; her trengs
 *   det ikke, og en kopi kunne kommet ut av takt.
 *
 *   **Et token uten utløp hoppes over.** Å regne dager fra ingenting gir
 *   enten «utløpt for lenge siden» eller «utløper aldri», og begge er
 *   påstander vi ikke har dekning for.
 *
 *   **Avkryssingen går til riktig lager.** Power BI-radene er syntetiske og
 *   har ingen kalenderrad. Gikk avkryssingen dit, ville varselet kommet på
 *   nytt hver eneste kjøring.
 *
 *   **Oppslaget filtrerer i spørringen.** Tabellen deles med OTP-tokenene,
 *   som er kortlevde og mange.
 *
 * Kjøres med:  node api/test/pb-kalender.test.js
 */
const fs = require('fs');
const path = require('path');
const { utenKommentarer } = require('../../scripts/test-kilde.js');
const pbKalender = require('../src/lib/pb-kalender.js');
const kalender = require('../src/lib/nokkelkalender-storage.js');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const NA = new Date('2026-09-23T12:00:00Z');
const omDager = (n) => new Date(NA.getTime() + n * 86400000).toISOString();
const token = (over) => ({
    upn: 'eier@x.no', guid: 'g1', skjematypeId: '45',
    utloper: omDager(20), sistVarslet: '', sistVarsletTrinn: null, ...over
});
const rad = (over) => pbKalender.somKalenderRader([token(over)], {
    na: NA, navnFor: (id) => (id === '45' ? 'Fraværssøknad SKSK' : '')
})[0];

// ---------- formen ----------
{
    const r = rad();
    sjekk('navnet peker på rapporten', r.Navn, 'Power BI-kobling — «Fraværssøknad SKSK»');
    sjekk('dager igjen regnes fra tokenet', r.DagerIgjen, 20);
    sjekk('utløpet er tokenets eget', r.UtloperFaktisk, omDager(20));
    sjekk('konsekvensen er konkret', /403/.test(r.Konsekvens), true);
    sjekk('fornyelsen peker på Datauttrekk', /Datauttrekk/.test(r.Rotasjon), true);
    sjekk('eieren står i «hvor»', /eier@x\.no/.test(r.Hvor), true);

    // Uten skjematypenavn skal ID-en stå der — admin finner den likevel.
    const uten = pbKalender.somKalenderRader([token({ skjematypeId: '99' })], { na: NA })[0];
    sjekk('ukjent navn gir ID i stedet', /skjematype 99/.test(uten.Navn), true);
}

// ---------- token uten utløp hoppes over ----------
{
    sjekk('uten utløp blir ingen rad',
        pbKalender.somKalenderRader([token({ utloper: '' })], { na: NA }).length, 0);
    sjekk('tom liste tåles', pbKalender.somKalenderRader(null, { na: NA }), []);
}

// ---------- ÉN eskaleringsregel ----------
{
    // Den ekte funksjonen fra nøkkelkalenderen, kjørt på en Power BI-rad.
    sjekk('utenfor varslingsvinduet: ingenting',
        kalender.skalVarsles(rad({ utloper: omDager(40) }), NA), null);
    sjekk('innenfor vinduet: første varsel',
        kalender.skalVarsles(rad({ utloper: omDager(20) }), NA), 30);
    sjekk('samme trinn igjen: tier',
        kalender.skalVarsles(rad({ utloper: omDager(20), sistVarsletTrinn: 30 }), NA), null);
    sjekk('neste trinn: varsler igjen',
        kalender.skalVarsles(rad({ utloper: omDager(6), sistVarsletTrinn: 30 }), NA), 7);

    // Og svaret skal være identisk for en vanlig kalenderrad med samme tall.
    const vanlig = {
        Id: 'noe-annet', Roteres: 'ja', VarsleDagerFor: 30,
        DagerIgjen: 6, SistVarslet: '', SistVarsletTrinn: 30
    };
    sjekk('samme svar som for en vanlig rad',
        kalender.skalVarsles(rad({ utloper: omDager(6), sistVarsletTrinn: 30 }), NA),
        kalender.skalVarsles(vanlig, NA));
}

// ---------- avkryssingen går til riktig lager ----------
{
    sjekk('Power BI-rad gjenkjennes', pbKalender.erPbRad(rad()), true);
    sjekk('vanlig rad gjenkjennes ikke', pbKalender.erPbRad({ Id: 'entra-sertifikat' }), false);
    sjekk('raden bærer hvor den skal merkes', rad()._pb, { upn: 'eier@x.no', guid: 'g1' });

    const les = (...d) => utenKommentarer(
        fs.readFileSync(path.join(__dirname, '..', 'src', ...d), 'utf8'));
    const endepunkt = les('functions', 'nokkelkalender.js');
    sjekk('varslingen skiller de to lagrene',
        /if \(pbKalender\.erPbRad\(f\.rad\)\) \{\s*await pbToken\.markerVarslet\(f\.rad\._pb\.upn, f\.rad\._pb\.guid, f\.trinn\);/.test(endepunkt), true);
    sjekk('og bruker kalenderen for resten',
        /await kalender\.markerVarslet\(f\.rad\.Id, f\.trinn, m\);/.test(endepunkt), true);
    // Feiler tokenoppslaget, skal de andre hemmelighetene varsles likevel.
    const i = endepunkt.indexOf('listPbEierTokens');
    sjekk('tokenoppslaget er pakket i try', endepunkt.lastIndexOf('try {', i) > i - 400, true);

    const lager = les('lib', 'pb-token-storage.js');
    // Tabellen deles med OTP-tokenene — filteret hører hjemme i spørringen.
    sjekk('oppslaget filtrerer i spørringen',
        /filter: "Tilgangstype eq 'pb-eier'"/.test(lager), true);
    // Merge, ikke Replace: raden bærer selve tokenet.
    sjekk('avkryssingen er en Merge', /\}, 'Merge'\)/.test(lager), true);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
