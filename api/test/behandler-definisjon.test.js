/**
 * Tester at en behandler får lese skjematypens definisjon for skjemaet hun
 * skal behandle.
 *
 * Behandlingssiden gjør to kall: ett for skjemaet og ett for definisjonen.
 * Skjemaet slipper behandleren inn på; definisjonen krevde eier eller
 * publikum. En behandler er ikke nødvendigvis noen av delene — en
 * anskaffelsesansvarlig godkjenner skjemaer hun aldri fyller ut selv — og fikk
 * derfor «Ingen tilgang» på siden hun nettopp var varslet om.
 *
 * Feilen var vanskelig å lese: `Promise.all` faller på første avviste kall, og
 * meldingen sa «Kunne ikke hente skjemaet» selv om det var definisjonen som
 * ble nektet.
 *
 * Adgangen må være bundet til ett skjema. Uten den begrensningen ville enhver
 * behandler kunne lese enhver definisjon, og da er vi tilbake til en
 * tilgangsmodell ingen kan resonnere om.
 *
 * ## 03.11.2026: samme regel som for skjemaet
 *
 * Definisjonen krevde et AKTIVT steg; skjemaet har siden 05.10.2026 godtatt
 * ethvert steg (`erBehandlerPaaNoeSteg`). Når steget var avgjort, slapp
 * skjemaet gjennom og definisjonen ikke — samme feilmelding, på nytt. Testene
 * under kjører den ekte regelen, og krever at de to rutene bruker den.
 *
 * Testen hoppet til samme dato over seg selv når @azure/functions manglet —
 * og den mangler alltid i `npm test`. Den har derfor aldri kjørt. Nå stubbes
 * pakken, slik system-miljo.test.js gjør.
 *
 * Kjøres med:  node api/test/behandler-definisjon.test.js
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ekteLoad = Module._load;
Module._load = function (forespurt, ...rest) {
    if (forespurt === '@azure/functions') return { app: { http() {}, timer() {} } };
    return ekteLoad.call(this, forespurt, ...rest);
};
let modul;
try {
    modul = require('../src/functions/skjematyper');
} finally {
    Module._load = ekteLoad;
}

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const erBehandler = modul._erBehandlerPaaSkjema;
sjekk('skjematyper.js eksporterer regelen', typeof erBehandler, 'function');

const forekomst = require('../src/lib/skjema-forekomst-storage');
const roller = require('../src/lib/roller-storage');
const gammelHent = forekomst.hentSkjema;
const gammelErMedlem = roller.erMedlem;

/** Stubbet lagring: én sak, og rollemedlemskap som et enkelt kart. */
function stub({ skjema = null, medlemmer = {}, kast = false }) {
    forekomst.hentSkjema = async () => { if (kast) throw new Error('lagring nede'); return skjema; };
    roller.erMedlem = async (rolle, upn) => (medlemmer[rolle] || []).includes(String(upn).toLowerCase());
}

const MEDLEMMER = {
    'Emneansvarlig(FKI0301)': ['behandler1@jccodevel.onmicrosoft.com'],
    'Emneansvarlig(ING2301)': ['behandler2@jccodevel.onmicrosoft.com'],
    'Bransjeveileder(TESTKLASSE)': ['innsender2@jccodevel.onmicrosoft.com']
};

// Saken fra testingen 03.11.2026, slik den sto lagret (skjematype 45, sak 10).
const SAK = {
    Skjema_id: '10', Skjematype_id: '45', Skjema_status: 2,
    Behandling: [
        { Steg: 1, Roller: ['Emneansvarlig(FKI0301)', 'Emneansvarlig(ING2301)'], Personer: [], Team: [], Beslutning: 0 },
        { Steg: 2, Roller: ['Bransjeveileder(TESTKLASSE)'], Personer: [], Team: [], AvhengigAv: 1, Beslutning: 0 }
    ]
};

async function kjor() {
    // ---------- behandler på aktivt steg ----------
    stub({ skjema: SAK, medlemmer: MEDLEMMER });
    sjekk('emneansvarlig 1 slipper til', await erBehandler('45', '10', 'behandler1@jccodevel.onmicrosoft.com'), true);
    sjekk('emneansvarlig 2 slipper til', await erBehandler('45', '10', 'behandler2@jccodevel.onmicrosoft.com'), true);
    sjekk('utenforstående avvises', await erBehandler('45', '10', 'kari@jccodevel.onmicrosoft.com'), false);

    // ---------- steg 1 avgjort: behandleren skal fortsatt kunne lese ----------
    //
    // Det var dette som feilet. Steg 1 er ikke lenger aktivt, og den aktive-
    // steg-regelen avviste definisjonen mens skjemaet slapp gjennom.
    {
        const avgjort = JSON.parse(JSON.stringify(SAK));
        avgjort.Behandling[0].Beslutning = 1;
        avgjort.Behandling[0].BehandletAv = 'behandler1@jccodevel.onmicrosoft.com';
        stub({ skjema: avgjort, medlemmer: MEDLEMMER });
        sjekk('den som avgjorde, leser fortsatt', await erBehandler('45', '10', 'behandler1@jccodevel.onmicrosoft.com'), true);
        sjekk('den andre emneansvarlige også', await erBehandler('45', '10', 'behandler2@jccodevel.onmicrosoft.com'), true);
    }

    // ---------- blokkert steg: neste behandler kan lese før det er hennes tur ----------
    stub({ skjema: SAK, medlemmer: MEDLEMMER });
    sjekk('behandler på blokkert steg 2 leser', await erBehandler('45', '10', 'innsender2@jccodevel.onmicrosoft.com'), true);

    // ---------- det som IKKE skal gi tilgang ----------
    stub({ skjema: null, medlemmer: MEDLEMMER });
    sjekk('ukjent skjema gir ingen tilgang', await erBehandler('45', '999', 'behandler1@jccodevel.onmicrosoft.com'), false);
    stub({ kast: true });
    sjekk('feil gir ingen tilgang', await erBehandler('45', '10', 'behandler1@jccodevel.onmicrosoft.com'), false);
    {
        // Markørene i BehandletAv er ikke personer.
        const markør = JSON.parse(JSON.stringify(SAK));
        markør.Behandling[0].BehandletAv = 'system';
        stub({ skjema: markør, medlemmer: {} });
        sjekk('markøren «system» gir ingen tilgang', await erBehandler('45', '10', 'system'), false);
    }

    // ---------- de to rutene bruker samme regel ----------
    const les = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'functions', f), 'utf8');
    const typer = les('skjematyper.js');
    const fra = typer.indexOf('async function erBehandlerPaaSkjema(');
    const kropp = typer.slice(fra, typer.indexOf('\n}\n', fra));
    sjekk('definisjonen bruker erBehandlerPaaNoeSteg', /erBehandlerPaaNoeSteg\(/.test(kropp), true);
    sjekk('og ikke de aktive stegene', /beregnAktiveSteg\(/.test(kropp), false);
    sjekk('skjemaet bruker den samme', /erBehandlerPaaNoeSteg\(skjema, upn\)/.test(les('skjemaer.js')), true);

    // ---------- en avvisning sier hva og logger hvorfor ----------
    sjekk('skjematype-avvisningen logges', /loggAvvistTilgang\(\{\s*kall: 'skjematype'/.test(typer), true);
    sjekk('sak-avvisningen logges', /loggAvvistTilgang\(\{\s*kall: 'sak'/.test(les('skjemaer.js')), true);
    sjekk('meldingen sier hva som ble nektet', /Ingen tilgang til skjematype \$\{id\}/.test(typer), true);
}

kjor().then(() => {
    forekomst.hentSkjema = gammelHent;
    roller.erMedlem = gammelErMedlem;
    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
}).catch(e => {
    console.log('FEIL  testen kastet:', e.message);
    console.log(e.stack);
    process.exit(1);
});
