/**
 * Utfallet av et behandlingssteg — regelen, og at tvillingene svarer likt.
 *
 * Meldt 26.10.2026: to behandlere på samme steg ga ULIKE anbefalinger, og bare
 * den siste sto i utskriftene — behandlingssiden, innsenderens visning og
 * PDF-en. Den andre vurderingen fantes i dataene hele tiden.
 *
 * Årsaken: `steg.Beslutning` settes til den SISTE avgivelsen i alle-modus
 * («Sluttbeslutning = siste avgivelse — i praksis samme siden alle må
 * godkjenne»). Den antagelsen holder helt til to behandlere er uenige. Tre
 * visninger leste det feltet alene.
 *
 * Regelen bor nå i behandling-utfall.js, og testen gjør to ting:
 *
 *   **Kjører begge tvillingene** mot de samme stegene. Frontend kan ikke
 *   importere fra api/, så filen må dupliseres — men en kopi som får drive
 *   fra originalen er verre enn to ulike funksjoner, fordi den ser ut som
 *   den ene.
 *
 *   **Pinner at de tre visningene faktisk bruker modulen.** En modul ingen
 *   leser er ikke en regel ett sted; det er en regel fire steder.
 *
 * Kjøres med:  node api/test/behandling-utfall.test.js
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { utenKommentarer } = require('../../scripts/test-kilde.js');
const api = require('../src/lib/behandling-utfall');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const VALG = [
    { Nummer: 1, Tekst: 'Anbefalt' },
    { Nummer: 2, Tekst: 'Ikke anbefalt' },
    { Nummer: 3, Tekst: 'Send i retur', Handling: 'ompuss' },
    { Nummer: 4, Tekst: 'Ikke relevant' }
];

const TILFELLER = {
    'én behandler, positivt': {
        Beslutningsvalg: VALG, Beslutning: 1, BehandletAv: 'kari@fhs.no'
    },
    'én behandler, negativt': {
        Beslutningsvalg: VALG, Beslutning: 2, BehandletAv: 'kari@fhs.no'
    },
    'alle enige': {
        Beslutningsvalg: VALG, Beslutning: 1, BehandletAv: 'alle-behandlere',
        Beslutninger: [{ Aktor: 'kari@fhs.no', Beslutning: 1 }, { Aktor: 'ola@fhs.no', Beslutning: 1 }]
    },
    'ULIKE VURDERINGER': {
        Beslutningsvalg: VALG, Beslutning: 2, BehandletAv: 'alle-behandlere',
        Beslutninger: [{ Aktor: 'kari@fhs.no', Beslutning: 1 }, { Aktor: 'ola@fhs.no', Beslutning: 2 }]
    },
    'tre, to enige': {
        Beslutningsvalg: VALG, Beslutning: 1, BehandletAv: 'alle-behandlere',
        Beslutninger: [
            { Aktor: 'a@x.no', Beslutning: 1 }, { Aktor: 'b@x.no', Beslutning: 1 },
            { Aktor: 'c@x.no', Beslutning: 3 }
        ]
    },
    'ompuss alene': { Beslutningsvalg: VALG, Beslutning: 3, BehandletAv: 'kari@fhs.no' },
    'hoppet over': { Beslutningsvalg: VALG, Beslutning: 5 },
    'ubesvart': { Beslutningsvalg: VALG, Beslutning: 0 },
    'ukjent nummer': { Beslutningsvalg: VALG, Beslutning: 9, BehandletAv: 'kari@fhs.no' },
    'uten valgliste': { Beslutning: 1, BehandletAv: 'kari@fhs.no' },
    'tomt steg': {},
    'avgivelse med 0': {
        Beslutningsvalg: VALG, Beslutning: 1, BehandletAv: 'alle-behandlere',
        Beslutninger: [{ Aktor: 'a@x.no', Beslutning: 0 }, { Aktor: 'b@x.no', Beslutning: 1 }]
    }
};

(async () => {
    const front = await import(pathToFileURL(
        path.join(__dirname, '..', '..', 'frontend', 'js', 'behandling-utfall.js')).href);

    // ---------- tvillingene svarer likt ----------
    {
        const ulike = [];
        for (const [navn, steg] of Object.entries(TILFELLER)) {
            for (const fn of ['enkeltutfall', 'samletUtfall', 'utfallLinje']) {
                const a = JSON.stringify(api[fn](steg));
                const b = JSON.stringify(front[fn](steg));
                if (a !== b) ulike.push(`${navn}/${fn}: ${a} ≠ ${b}`);
            }
        }
        sjekk('tvillingene svarer likt på alle stegene', ulike, []);
        sjekk('og fargetabellene er like', api.FARGER, front.FARGER);
    }

    // ---------- og reglene SKILLER ----------
    //
    // Svarte begge likt på alt fordi begge svarte det samme overalt, ville
    // testen over vært grønn og modulen gjort ingenting.
    {
        const u = api.samletUtfall(TILFELLER['ULIKE VURDERINGER']);
        sjekk('uenighet gir «Ulike vurderinger»', u.tekst, 'Ulike vurderinger');
        sjekk('med type ulike', u.type, 'ulike');
        sjekk('og oransje', u.farge, api.FARGER.ulike);
        sjekk('og begge vurderingene er med',
            api.enkeltutfall(TILFELLER['ULIKE VURDERINGER']).map(e => e.tekst),
            ['Anbefalt', 'Ikke anbefalt']);

        sjekk('enighet gir utfallet selv', api.samletUtfall(TILFELLER['alle enige']).tekst, 'Anbefalt');
        sjekk('og grønt', api.samletUtfall(TILFELLER['alle enige']).farge, api.FARGER.positiv);
        sjekk('negativt gir rødt',
            api.samletUtfall(TILFELLER['én behandler, negativt']).farge, api.FARGER.negativ);
        sjekk('ompuss gir gult',
            api.samletUtfall(TILFELLER['ompuss alene']).farge, api.FARGER.ompuss);

        // Nummer, ikke tekst: to valg kan hete det samme, og teksten kan
        // endres i editoren etter at beslutningen ble tatt.
        const likTekst = {
            Beslutningsvalg: [{ Nummer: 1, Tekst: 'Godkjent' }, { Nummer: 2, Tekst: 'Godkjent' }],
            Beslutninger: [{ Aktor: 'a@x.no', Beslutning: 1 }, { Aktor: 'b@x.no', Beslutning: 2 }]
        };
        sjekk('lik tekst, ulikt nummer er fortsatt uenighet',
            api.samletUtfall(likTekst).ulike, true);

        // En avgivelse med 0 er ingen avgivelse.
        sjekk('beslutning 0 teller ikke som en vurdering',
            api.enkeltutfall(TILFELLER['avgivelse med 0']).map(e => e.aktor), ['b@x.no']);
    }

    // ---------- typeFor: erklært vinner, tekst er reserve ----------
    {
        sjekk('erklært ompuss', api.typeFor({ Tekst: 'Hva som helst', Handling: 'ompuss' }), 'ompuss');
        sjekk('erklært avvisning', api.typeFor({ Tekst: 'Anbefalt', Handling: 'avvisning' }), 'negativ');
        sjekk('«Ikke anbefalt» er negativ', api.typeFor({ Tekst: 'Ikke anbefalt' }), 'negativ');
        sjekk('«Avslått» er negativ', api.typeFor({ Tekst: 'Avslått' }), 'negativ');
        // Ikke alt som begynner på «ikke» er et avslag. Første utgave brukte
        // /^ikke\b/ og gjorde dette til en avvisning.
        sjekk('«Ikke relevant» er ikke et avslag', api.typeFor({ Tekst: 'Ikke relevant' }), 'positiv');
        sjekk('ukjent valg', api.typeFor(null), 'ukjent');
    }

    // ---------- de tre visningene bruker modulen ----------
    //
    // Regelen sto i tre eksemplarer med ulikt innhold: evaluering.html kjente
    // ikke «revid», visning.html gjorde det, og PDF-en hadde ingen farge i
    // det hele tatt. En modul ingen leser er ikke én regel.
    {
        const les = (...p) => utenKommentarer(fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8'));
        const ev = les('frontend', 'evaluering.html');
        const vi = les('frontend', 'visning.html');
        const pdf = les('api', 'src', 'lib', 'pdf-generator.js');

        for (const [navn, kilde] of [['evaluering.html', ev], ['visning.html', vi]]) {
            sjekk(`${navn}: importerer modulen`,
                /from '\.\/js\/behandling-utfall\.js'/.test(kilde), true);
            sjekk(`${navn}: bruker samletUtfall`, /samletUtfall\(steg\)/.test(kilde), true);
            sjekk(`${navn}: viser hver behandlers svar`, /enkeltutfall\(steg\)/.test(kilde), true);
            // Den gamle heuristikken skal være BORTE, ikke bare forbigått.
            sjekk(`${navn}: ingen egen fargeheuristikk igjen`,
                /includes\('avslå'\)/.test(kilde), false);
        }
        sjekk('pdf-generator bruker modulen', /require\('\.\/behandling-utfall'\)/.test(pdf), true);
        sjekk('pdf-generator viser hvert svar', /utfall\.enkeltutfall\(b\)/.test(pdf), true);

        // Editoren må kunne ERKLÆRE et negativt utfall. Uten bryteren er
        // tekstregelen eneste vei, og et valg som heter noe annet enn
        // «avslå»/«avvis»/«ikke anbefalt» blir vist i grønt.
        const ed = les('frontend', 'editor.html');
        sjekk('editoren tilbyr Avvisning', /<option value="avvisning"/.test(ed), true);
        sjekk('og holder ompuss adskilt', /<option value="ompuss"/.test(ed), true);
        // Flyten skal IKKE endres av den: bare fargen.
        const beh = les('api', 'src', 'lib', 'behandling.js');
        sjekk('avvisning styrer ikke flyten', /'avvisning'/.test(beh), false);
    }

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
})();
