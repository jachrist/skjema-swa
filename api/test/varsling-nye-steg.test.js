/**
 * Behandlervarselet skal gå til steg som BLE aktive — ikke til dem som var det.
 *
 * Meldt 26.10.2026: et steg med «alle må avgjøre» og to behandlere sendte
 * «Skjema til behandling» på nytt til BEGGE hver gang én av dem avga sin
 * beslutning — også til den som nettopp hadde avgjort. Innboksen fylte seg
 * med samme melding i flere omganger.
 *
 * Årsaken var et navn som lovet noe funksjonen ikke ga:
 *
 *     const nyeAktive = beregnAktiveSteg(skjemaKlartekst);
 *
 * `beregnAktiveSteg` svarer på «hvilke steg er aktive NÅ», ikke «hvilke ble
 * det». Med «alle må avgjøre» er steget fortsatt aktivt til alle har levert,
 * så hver beslutning utløste et nytt varsel til hele steget.
 *
 * Testen er todelt, og begge delene trengs:
 *
 *   **Regelen**, kjørt mot den ekte `beregnAktiveSteg`: aktiv før og aktiv
 *   etter skal gi en tom differanse når ingen steg skiftet tilstand.
 *
 *   **At beslutningsveien faktisk tar differansen**, og at den leser «før»
 *   FØR noe er endret. Leses den etterpå, er svaret et annet, og feilen er
 *   tilbake uten at regelen over merker det.
 *
 * Kjøres med:  node api/test/varsling-nye-steg.test.js
 */
const fs = require('fs');
const path = require('path');
const { utenKommentarer } = require('../../scripts/test-kilde.js');
const { beregnAktiveSteg, alleStegFerdig } = require('../src/lib/behandling');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

/** Steg som ble aktive — slik beslutningsveien regner det ut. */
function bleAktive(skjemaFor, skjemaEtter) {
    const fr = new Set(beregnAktiveSteg(skjemaFor).map(s => String(s.Steg)));
    return beregnAktiveSteg(skjemaEtter).filter(s => !fr.has(String(s.Steg))).map(s => s.Steg);
}

// ---------- regelen, mot den ekte beregnAktiveSteg ----------
{
    // Ett steg, «alle må avgjøre», to roller med hver sin innehaver.
    const lagSkjema = () => ({
        Seksjoner: [],
        Behandling: [{
            Steg: 1, Stegnavn: 'Anbefaling', Beslutning: 0, Beslutning_alle: true,
            Roller: ['Emneansvarlig(FKI0301)', 'Emneansvarlig(ING2301)'],
            Personer: [], Team: [], Beslutninger: []
        }]
    });

    const for1 = lagSkjema();
    sjekk('steget er aktivt før noen har avgjort',
        beregnAktiveSteg(for1).map(s => s.Steg), [1]);

    // Behandler 1 avgir. Steget får IKKE Beslutning — det venter på nr. 2.
    const etter1 = lagSkjema();
    etter1.Behandling[0].Beslutninger = [{ Aktor: 'behandler1@x.no', Beslutning: 1 }];
    sjekk('og er fortsatt aktivt etterpå',
        beregnAktiveSteg(etter1).map(s => s.Steg), [1]);

    // DETTE ER FEILEN SOM VAR: «aktive steg» ga [1], og varselet gikk på nytt.
    sjekk('men INGEN steg ble aktive — ingen skal varsles', bleAktive(for1, etter1), []);

    // Behandler 2 avgir. Nå er steget ferdig.
    const etter2 = lagSkjema();
    etter2.Behandling[0].Beslutninger = [
        { Aktor: 'behandler1@x.no', Beslutning: 1 }, { Aktor: 'behandler2@x.no', Beslutning: 1 }
    ];
    etter2.Behandling[0].Beslutning = 1;
    sjekk('ferdig steg er ikke aktivt', beregnAktiveSteg(etter2).map(s => s.Steg), []);
    sjekk('og alle steg er ferdige', alleStegFerdig(etter2), true);
}

// ---------- og neste steg SKAL varsles når det blir aktivt ----------
//
// Rettelsen må ikke bli så stram at den stopper det varselet som er hele
// poenget: at steg 2 får beskjed når steg 1 er ferdig.
{
    const lag = (beslutning1) => ({
        Seksjoner: [],
        Behandling: [
            { Steg: 1, Stegnavn: 'Anbefaling', Beslutning: beslutning1, Personer: ['a@x.no'], Roller: [], Team: [] },
            { Steg: 2, Stegnavn: 'Godkjenning', Beslutning: 0, AvhengigAv: 1, Personer: ['b@x.no'], Roller: [], Team: [] }
        ]
    });
    const før = lag(0);
    const etter = lag(1);
    sjekk('steg 2 var blokkert før', beregnAktiveSteg(før).map(s => s.Steg), [1]);
    sjekk('og er aktivt etter', beregnAktiveSteg(etter).map(s => s.Steg), [2]);
    sjekk('steg 2 ble aktivt — og skal varsles', bleAktive(før, etter), [2]);
}

// ---------- beslutningsveien må ta differansen, og lese «før» FØRST ----------
{
    const rå = fs.readFileSync(path.join(__dirname, '..', 'src', 'functions', 'skjemaer.js'), 'utf8');
    const kilde = utenKommentarer(rå);

    sjekk('tilstanden før beslutningen leses',
        /const aktiveFor = new Set\(\s*beregnAktiveSteg\(skjema\)\.map\(s => String\(s\.Steg\)\)\);/.test(kilde), true);
    sjekk('og varselet går bare til det som BLE aktivt',
        /beregnAktiveSteg\(skjemaKlartekst\)\s*\.filter\(s => !aktiveFor\.has\(String\(s\.Steg\)\)\)/.test(kilde), true);

    // Rekkefølgen er det subtile: leses «før» etter at beslutningen er
    // påført, er svaret det samme som «etter», differansen alltid tom, og
    // da varsles ingen steg i det hele tatt — motsatt feil, like stille.
    const iFor = kilde.indexOf('const aktiveFor = new Set(');
    const iMutasjon = Math.min(
        ...['stegObj.Beslutninger.push(', 'stegObj.Beslutning = beslutning']
            .map(t => { const i = kilde.indexOf(t); return i < 0 ? Number.MAX_SAFE_INTEGER : i; })
    );
    sjekk('fant både avlesningen og mutasjonen',
        iFor > -1 && iMutasjon < Number.MAX_SAFE_INTEGER, true);
    sjekk('og «før» leses FØR beslutningen påføres', iFor < iMutasjon, true);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
