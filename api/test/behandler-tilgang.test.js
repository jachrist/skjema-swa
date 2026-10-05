/**
 * Hvem får LESE en sak?
 *
 * Meldt fra testing 05.10.2026: behandleren på steg 2 fikk «Ingen tilgang» på
 * et skjema hen var satt opp som behandler på. Diagnosen viste hvorfor —
 * skjemaet var ferdig behandlet (status 5), ingen steg var aktive, og
 * tilgangssjekken krevde et AKTIVT steg.
 *
 * Følgen: en behandler mistet saken i det den ble ferdig. Hen kunne verken se
 * hva hen selv hadde bestemt, åpne lenka fra e-posten eller hente PDF-en. Det
 * gjaldt også MELLOM steg — er steg 2 blokkert av en avhengighet, sto
 * behandleren uten innsyn i saken hen snart skal avgjøre.
 *
 * Og regelen fantes i tre varianter, med tre ulike svar:
 *
 *   skjemaer.js GET   krevde aktivt steg
 *   pdf.js            aktivt steg ELLER BehandletAv
 *   dialog-tilgang    ethvert steg
 *
 * Fem ting testes:
 *
 *   **Et ferdig skjema er fortsatt lesbart for behandleren.** Det er feilen.
 *
 *   **Tre kilder teller.** Lista kan ha endret seg siden beslutningen ble
 *   tatt, så den som FAKTISK avgjorde må telle selv om hen er fjernet.
 *
 *   **«Alle må avgjøre» har markøren «alle-behandlere» i BehandletAv**, ikke
 *   en person. Deltakerne ligger i Beslutninger[].Aktor. PDF-en godtok bare
 *   det første, så de falt utenfor.
 *
 *   **En utenforstående slipper fortsatt ikke inn.** Rettelsen må ikke bli
 *   «alle får lese».
 *
 *   **Alle tre stedene spør samme sted.**
 *
 * Kjøres med:  node api/test/behandler-tilgang.test.js
 */
const fs = require('fs');
const path = require('path');
const { utenKommentarer } = require('../../scripts/test-kilde.js');
const behandling = require('../src/lib/behandling.js');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const BEH = 'behandler1@jccodevel.onmicrosoft.com';
const ANNEN = 'utenfor@jccodevel.onmicrosoft.com';

(async () => {
    // ---------- det ferdige skjemaet fra feilmeldingen ----------
    {
        // Skjema 8: begge steg avgjort, status 5, ingen aktive steg.
        const ferdig = {
            Skjema_status: 5,
            Behandling: [
                { Steg: 1, Beslutning: 1, Personer: ['jan@jccodevel.onmicrosoft.com'], Roller: [], Team: [] },
                { Steg: 2, Beslutning: 1, Personer: [BEH], Roller: [], Team: [] }
            ]
        };
        sjekk('behandler på ferdig sak får lese',
            await behandling.erBehandlerPaaNoeSteg(ferdig, BEH), true);
        // Kontrollen: ingen steg er aktive, så «kan handle nå» er fortsatt nei.
        sjekk('men ingen steg er aktive', behandling.beregnAktiveSteg(ferdig).length, 0);
        sjekk('utenforstående slipper ikke inn',
            await behandling.erBehandlerPaaNoeSteg(ferdig, ANNEN), false);
    }

    // ---------- blokkert steg: innsyn før man kan handle ----------
    {
        const blokkert = {
            Skjema_status: 2,
            Behandling: [
                { Steg: 1, Beslutning: 0, Personer: ['jan@x.no'] },
                { Steg: 2, Beslutning: 0, AvhengigAv: 1, Personer: [BEH] }
            ]
        };
        sjekk('steg 2 er ikke aktivt ennå',
            behandling.beregnAktiveSteg(blokkert).map(s => s.Steg), [1]);
        sjekk('men behandleren får lese saken',
            await behandling.erBehandlerPaaNoeSteg(blokkert, BEH), true);
    }

    // ---------- tre kilder ----------
    {
        // Den som avgjorde, selv om hen siden er tatt av lista.
        sjekk('BehandletAv teller', await behandling.erBehandlerPaaNoeSteg(
            { Behandling: [{ Steg: 1, Beslutning: 1, BehandletAv: BEH, Personer: [] }] }, BEH), true);

        // «Alle må avgjøre»: BehandletAv er markøren, ikke en person.
        const alle = {
            Behandling: [{
                Steg: 1, Beslutning: 1, BehandletAv: 'alle-behandlere', Personer: [],
                Beslutninger: [{ Aktor: BEH, Beslutning: 1 }, { Aktor: 'jan@x.no', Beslutning: 1 }]
            }]
        };
        sjekk('deltaker i «alle må avgjøre» teller',
            await behandling.erBehandlerPaaNoeSteg(alle, BEH), true);
        // Markørverdiene i BehandletAv er ikke UPN-er, men de ville matchet
        // som strenger — og da gitt tilgang til den som logget inn med navnet.
        for (const markor of ['alle-behandlere', 'ekstern-flyt', 'system']) {
            sjekk(`«${markor}» er ikke en person`,
                await behandling.erBehandlerPaaNoeSteg(
                    { Behandling: [{ Steg: 1, BehandletAv: markor }] }, markor), false);
        }

        // Utpekt nå, uten å ha avgjort noe.
        sjekk('utpekt på lista teller', await behandling.erBehandlerPaaNoeSteg(
            { Behandling: [{ Steg: 1, Beslutning: 0, Personer: [BEH] }] }, BEH), true);

        // Store/små bokstaver skal ikke avgjøre tilgang.
        sjekk('kasus spiller ingen rolle', await behandling.erBehandlerPaaNoeSteg(
            { Behandling: [{ Steg: 1, BehandletAv: BEH.toUpperCase() }] }, BEH), true);
    }

    // ---------- tomt og tull ----------
    {
        sjekk('uten upn: nei', await behandling.erBehandlerPaaNoeSteg({ Behandling: [{ Personer: [BEH] }] }, ''), false);
        sjekk('uten behandling: nei', await behandling.erBehandlerPaaNoeSteg({}, BEH), false);
    }

    // ---------- alle tre stedene spør samme sted ----------
    {
        const les = (...d) => utenKommentarer(
            fs.readFileSync(path.join(__dirname, '..', 'src', ...d), 'utf8'));

        const skjemaer = les('functions', 'skjemaer.js');
        sjekk('GET bruker regelen',
            /await erBehandlerPaaNoeSteg\(skjema, upn\)/.test(skjemaer), true);
        // Og den gamle sperren skal være borte.
        sjekk('tilgang krever ikke lenger aktivt steg',
            /mineStegNumre\.length === 0\) \{\s*erEier = await harEierTilgang/.test(skjemaer), false);
        // _mineStegNumre skal fortsatt bare være de AKTIVE — det er hva man
        // kan handle på, og frontend bruker det til å vise knapper.
        sjekk('_mineStegNumre er fortsatt bare aktive',
            /for \(const s of aktive\) \{\s*if \(await brukerErBehandlerAsync\(s, upn\)\) mineStegNumre\.push/.test(skjemaer), true);

        const pdf = les('functions', 'pdf.js');
        sjekk('PDF bruker regelen', /return await erBehandlerPaaNoeSteg\(skjema, upn\);/.test(pdf), true);
        sjekk('PDF har ikke sin egen BehandletAv-sjekk',
            /s\.BehandletAv \|\| ''\)\.toLowerCase\(\) === upnLower/.test(pdf), false);

        const dialog = les('lib', 'dialog-tilgang.js');
        sjekk('dialogen bruker regelen',
            /if \(await erBehandlerPaaNoeSteg\(skjema, upn\)\) return 'behandler';/.test(dialog), true);
    }

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
})();
