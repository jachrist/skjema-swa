/**
 * Dynamiske roller: at HVERT valg blir en rolle, og at tomme roller sies fra om.
 *
 * Meldt 26.10.2026: innsenderen valgte flere emner, og bare emneansvarlig for
 * det første ble behandler.
 *
 * Ekspansjonen var ikke feilen — den gir én rolle per valg, og det er pinnet
 * her. Feilen var at `sikreBehandler` summerte innehavere PÅ TVERS av alle
 * rollene og bare reagerte når totalen var null. Har tre emner hver sin rolle
 * og bare det første en registrert innehaver, er totalen positiv: steget har
 * en behandler, to av emnene har ingen, og ingenting sa fra.
 *
 * Rollelista vedlikeholdes manuelt, så den tilstanden oppstår av seg selv.
 *
 * At ingen test kjørte `sikreBehandler` er en del av historien: returtypen
 * kunne endres fra array til objekt uten at noe ble rødt.
 *
 * Lagringen er stubbet gjennom `Module._load`, samme mønster som
 * backup-delta.test.js — modulen tar ingen avhengigheter inn.
 *
 * Kjøres med:  node api/test/dynamisk-rolle-dekning.test.js
 */
const Module = require('module');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

// Hvilke roller har innehavere — settes per tilfelle.
let MED_INNEHAVERE = new Set();
let KASTER = new Set();

const origLoad = Module._load;
Module._load = function (req, ...rest) {
    if (req === './roller-storage') {
        return {
            hentInnehavere: async (rolle) => {
                if (KASTER.has(rolle)) throw new Error('oppslag nede');
                return MED_INNEHAVERE.has(rolle) ? [{ EP: `en@fhs.no` }] : [];
            }
        };
    }
    if (req === './omfang') return { hentOmfangsalias: async (v) => [String(v)] };
    return origLoad.apply(this, [req, ...rest]);
};
const dyn = require('../src/lib/dynamisk-rolle');
Module._load = origLoad;

const seksjoner = (svar, type = 'Flervalg-dropdown') => ([
    { Nummer: 2, Felter: [{ Nummer: '01', Type: type, Svar: svar }] }
]);
const steg = () => ({ Steg: 1, Roller: ['Emneansvarlig({2-01})'], Beslutning: 0 });

(async () => {
    // ---------- ekspansjonen: ett valg = én rolle ----------
    {
        MED_INNEHAVERE = new Set(['Emneansvarlig(CU1)', 'Emneansvarlig(CU2)', 'Emneansvarlig(CU3)']);
        const r = await dyn.ekspanderRolleStreng('Emneansvarlig({2-01})', seksjoner(['CU1', 'CU2', 'CU3']));
        sjekk('tre valgte emner gir tre roller', r.roller,
            ['Emneansvarlig(CU1)', 'Emneansvarlig(CU2)', 'Emneansvarlig(CU3)']);
        sjekk('og ingen av dem er uløst', r.ulost, false);

        // Et felt som IKKE er flervalg gir bare første verdi — det er regelen
        // i alleSvarIFelt, og den skal ikke endres i smug.
        const en = await dyn.ekspanderRolleStreng('Emneansvarlig({2-01})',
            seksjoner(['CU1', 'CU2'], 'Tekst'));
        sjekk('et ikke-flervalgsfelt gir én rolle', en.roller, ['Emneansvarlig(CU1)']);
    }

    // ---------- hele veien: steg.Roller etter ekspandering ----------
    {
        const skjema = { Seksjoner: seksjoner(['CU1', 'CU2', 'CU3']), Behandling: [steg()] };
        await dyn.ekspanderBehandling(skjema);
        sjekk('steget får alle rollene', skjema.Behandling[0].Roller,
            ['Emneansvarlig(CU1)', 'Emneansvarlig(CU2)', 'Emneansvarlig(CU3)']);
        sjekk('og malen er tatt vare på', skjema.Behandling[0].RollerMal, ['Emneansvarlig({2-01})']);
    }

    // ---------- DET SOM MANGLET: bare én av tre har innehavere ----------
    {
        MED_INNEHAVERE = new Set(['Emneansvarlig(CU1)']);
        const skjema = { Seksjoner: seksjoner(['CU1', 'CU2', 'CU3']), Behandling: [steg()] };
        await dyn.ekspanderBehandling(skjema);
        const { mangler, delvis } = await dyn.sikreBehandler(skjema);

        sjekk('steget regnes ikke som uten behandler', mangler, []);
        sjekk('men det meldes som delvis dekket', delvis.length, 1);
        sjekk('og de tomme rollene navngis', delvis[0] && delvis[0].tomme,
            ['Emneansvarlig(CU2)', 'Emneansvarlig(CU3)']);
        sjekk('med tellingen per rolle', delvis[0] && delvis[0].perRolle,
            [{ rolle: 'Emneansvarlig(CU1)', antall: 1 },
             { rolle: 'Emneansvarlig(CU2)', antall: 0 },
             { rolle: 'Emneansvarlig(CU3)', antall: 0 }]);
    }

    // ---------- alle dekket: ingen melding ----------
    {
        MED_INNEHAVERE = new Set(['Emneansvarlig(CU1)', 'Emneansvarlig(CU2)']);
        const skjema = { Seksjoner: seksjoner(['CU1', 'CU2']), Behandling: [steg()] };
        await dyn.ekspanderBehandling(skjema);
        const { mangler, delvis } = await dyn.sikreBehandler(skjema);
        sjekk('alle dekket gir ingen meldinger', [mangler.length, delvis.length], [0, 0]);
    }

    // ---------- ingen dekket: som før, med reserverolle ----------
    {
        MED_INNEHAVERE = new Set();
        const s = { ...steg(), Reserverolle: 'Studieleder' };
        const skjema = { Seksjoner: seksjoner(['CU1', 'CU2']), Behandling: [s] };
        await dyn.ekspanderBehandling(skjema);
        const { mangler, delvis } = await dyn.sikreBehandler(skjema);
        sjekk('helt udekket meldes som før', mangler.length, 1);
        sjekk('reserverollen legges på', skjema.Behandling[0].Roller.includes('Studieleder'), true);
        sjekk('og det meldes ikke OGSÅ som delvis', delvis, []);
    }

    // ---------- oppslagsfeil skal ikke se ut som en tom rolle ----------
    //
    // Et nede oppslag vet vi ingenting om. Meldte vi det som tomt, ville
    // skjemaeier lett etter et hull i rollelista som kanskje ikke finnes.
    {
        MED_INNEHAVERE = new Set(['Emneansvarlig(CU1)']);
        KASTER = new Set(['Emneansvarlig(CU2)']);
        const skjema = { Seksjoner: seksjoner(['CU1', 'CU2']), Behandling: [steg()] };
        await dyn.ekspanderBehandling(skjema);
        const { delvis } = await dyn.sikreBehandler(skjema);
        sjekk('bare feilet oppslag gir ingen melding om tomme', delvis, []);

        // Men feilet oppslag skal ikke STOPPE meldingen om de andre: CU3
        // svarte 0, og det vet vi, uansett hva CU2 måtte være.
        const blandet = { Seksjoner: seksjoner(['CU1', 'CU2', 'CU3']), Behandling: [steg()] };
        await dyn.ekspanderBehandling(blandet);
        const r = await dyn.sikreBehandler(blandet);
        sjekk('en sikkert tom rolle meldes selv om et annet oppslag feilet',
            r.delvis[0] && r.delvis[0].tomme, ['Emneansvarlig(CU3)']);
        sjekk('og den feilede står med ukjent antall, ikke null treff',
            r.delvis[0] && r.delvis[0].perRolle.find(p => p.rolle === 'Emneansvarlig(CU2)').antall, null);
        KASTER = new Set();
    }

    // ---------- kalleren må bruke den nye formen ----------
    {
        const fs = require('fs'), path = require('path');
        const { utenKommentarer } = require('../../scripts/test-kilde.js');
        const skj = utenKommentarer(
            fs.readFileSync(path.join(__dirname, '..', 'src', 'functions', 'skjemaer.js'), 'utf8'));
        sjekk('innsendingen leser { mangler, delvis }',
            /const \{ mangler, delvis \} = await dynamiskRolle\.sikreBehandler\(/.test(skj), true);
        sjekk('og logger de delvis dekkede',
            /behandling\.rolle-uten-innehavere/.test(skj), true);
        sjekk('med de tomme rollene i meldingen',
            /d\.tomme\.join\(', '\)/.test(skj), true);
    }

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
})();
