/**
 * Behandlernavn i oppsummeringen.
 *
 * Oppsummeringen leste `steg.Personer` direkte. Et steg med rollebasert
 * behandler sto derfor tomt — selv om e-posten gikk til rett person. Feilen
 * var taus på verst tenkelige måte: alt VIRKET, det så bare ut som om ingen
 * var satt på steget.
 *
 * Fem ting testes:
 *
 *   **Roller og team kommer med.** Det var hele feilen. En test som bare
 *   dekker Personer ville bestått før rettelsen også.
 *
 *   **Samme kilde som varslingen.** `behandlereForVisning` bygger på
 *   `samleBehandlerMottakere` — den som avgjør hvem som får e-post. Står det
 *   et navn i oppsummeringen som ikke fikk varselet, er en av de to gal, og
 *   da skal de gå i stykker sammen. Testen sjekker koblingen i kilden, ikke
 *   bare resultatet.
 *
 *   **Avgjort steg svarer på et annet spørsmål.** Der er det HVEM SOM GJORDE
 *   det som gjelder, ikke hvem som kunne. Gjør vi rolleoppslag der, får vi
 *   både feil svar og unødig arbeid på hver sidevisning.
 *
 *   **«alle-behandlere» er ikke en person.** Markøren for et steg avgjort av
 *   flere ville ellers stått i grensesnittet som om den var et navn, og et
 *   navneoppslag på den ville vært bortkastet.
 *
 *   **Hoppede steg gir ingenting.** En tom «Behandlere:»-linje er verre enn
 *   ingen linje.
 *
 * Kjøres med:  node api/test/behandler-visning.test.js
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { utenKommentarer } = require('../../scripts/test-kilde.js');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

// Lagringen stubbes: testene skal kjøre uten node_modules og uten konto.
const NAVN = { 'ola@x.no': 'Ola Nordmann' };
const INNEHAVERE = { 'Sjef(A)': [{ EP: 'kari@x.no', EN: 'Hansen', FN: 'Kari' }] };
const TEAMMEDLEMMER = { 'FFT': [{ EP: 'team@x.no', Navn: 'Team Person' }] };
let navneoppslag = 0;

const orig = Module.prototype.require;
Module.prototype.require = function (id) {
    if (id === './brukernavn-storage') {
        return { hentNavn: async (e) => { navneoppslag++; return NAVN[e] || ''; } };
    }
    if (id === './roller-storage') return { hentInnehavere: async (r) => INNEHAVERE[r] || [] };
    if (id === './team-storage') return { hentMedlemmerDetaljert: async (t) => TEAMMEDLEMMER[t] || [] };
    return orig.apply(this, arguments);
};
const varsling = require('../src/lib/varsling.js');

(async () => {
    // ---------- roller og team kommer med ----------
    {
        const r = await varsling.behandlereForVisning([
            { Steg: 1, Beslutning: 0, Personer: ['ola@x.no'], Roller: ['Sjef(A)'], Team: ['FFT'] }
        ]);
        sjekk('alle tre kildene med', r['1'].kandidater.map(b => b.epost),
            ['ola@x.no', 'kari@x.no', 'team@x.no']);
        // Det var nettopp rollen som manglet før.
        sjekk('rolleinnehaveren har navn fra rollelista',
            r['1'].kandidater.find(b => b.epost === 'kari@x.no').navn, 'Hansen, Kari');
        // En konkret person er bare en adresse — navnet må hentes.
        sjekk('personen har navn fra Brukernavn',
            r['1'].kandidater.find(b => b.epost === 'ola@x.no').navn, 'Ola Nordmann');
        sjekk('et uavgjort steg har ingen aktør', r['1'].behandletAv, []);
    }

    // ---------- avgjort steg: hvem gjorde det ----------
    {
        const r = await varsling.behandlereForVisning([
            { Steg: 1, Beslutning: 1, BehandletAv: 'ola@x.no', Roller: ['Sjef(A)'] }
        ]);
        sjekk('aktøren vises', r['1'].behandletAv, [{ epost: 'ola@x.no', navn: 'Ola Nordmann' }]);
        // Rolleoppslag her ville gitt feil svar OG unødig arbeid.
        sjekk('ingen kandidater slås opp', r['1'].kandidater, []);
    }

    // ---------- «alle-behandlere» er en markør, ikke en person ----------
    {
        navneoppslag = 0;
        const r = await varsling.behandlereForVisning([
            {
                Steg: 1, Beslutning: 2, BehandletAv: 'alle-behandlere',
                Beslutninger: [{ Aktor: 'ola@x.no' }, { Aktor: 'ukjent@x.no' }, { Aktor: 'ola@x.no' }]
            }
        ]);
        sjekk('de faktiske aktørene listes', r['1'].behandletAv.map(b => b.epost),
            ['ola@x.no', 'ukjent@x.no']);
        sjekk('ordet «alle-behandlere» vises ikke',
            r['1'].behandletAv.some(b => b.epost.includes('alle-behandlere')), false);
        sjekk('ukjent navn blir tomt, ikke oppdiktet',
            r['1'].behandletAv.find(b => b.epost === 'ukjent@x.no').navn, '');
    }

    // ---------- sentinelverdier slås ikke opp ----------
    {
        navneoppslag = 0;
        const r = await varsling.behandlereForVisning([
            { Steg: 1, Beslutning: 1, BehandletAv: 'ekstern-flyt' }
        ]);
        sjekk('ekstern-flyt vises som den er', r['1'].behandletAv, [{ epost: 'ekstern-flyt', navn: '' }]);
        sjekk('og slås ikke opp i Brukernavn', navneoppslag, 0);
    }

    // ---------- hoppet steg gir ingenting ----------
    {
        const r = await varsling.behandlereForVisning([
            { Steg: 1, Beslutning: 5, Roller: ['Sjef(A)'] }
        ]);
        sjekk('hoppet steg har ingen kandidater', r['1'].kandidater, []);
        sjekk('og ingen aktør', r['1'].behandletAv, []);
    }

    // ---------- samme adresse slås opp én gang ----------
    {
        navneoppslag = 0;
        await varsling.behandlereForVisning([
            { Steg: 1, Beslutning: 1, BehandletAv: 'ola@x.no' },
            { Steg: 2, Beslutning: 1, BehandletAv: 'ola@x.no' },
            { Steg: 3, Beslutning: 1, BehandletAv: 'ola@x.no' }
        ]);
        sjekk('tre steg, ett navneoppslag', navneoppslag, 1);
    }

    // ---------- koblingene i kilden ----------
    {
        const les = (...d) => utenKommentarer(
            fs.readFileSync(path.join(__dirname, '..', 'src', ...d), 'utf8'));

        const v = les('lib', 'varsling.js');
        // Dette er den viktigste linja i hele testen: oppsummeringen og
        // varslingen skal svare likt fordi de spør samme funksjon.
        const fn = /async function behandlereForVisning\(behandling\) \{[\s\S]*?\n\}/.exec(v);
        sjekk('funksjonen finnes', !!fn, true);
        sjekk('den bruker varslingens mottakerliste',
            /await samleBehandlerMottakere\(steg\)/.test(fn ? fn[0] : ''), true);

        const skjemaer = les('functions', 'skjemaer.js');
        sjekk('GET beriker skjemaet',
            /skjema\._behandlere = await varsling\.behandlereForVisning\(skjema\.Behandling\)/.test(skjemaer), true);
        // En feilet berikelse skal ikke gjøre skjemaet uleselig.
        const berik = skjemaer.indexOf('_behandlere = await');
        sjekk('berikelsen er pakket i try', skjemaer.lastIndexOf('try {', berik) > berik - 400, true);
    }

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
})();
