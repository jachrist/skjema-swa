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
 * Kjøres med:  node api/test/behandler-definisjon.test.js
 */
let modul = null;
try { modul = require('../src/functions/skjematyper'); } catch (_) { /* uten @azure/functions */ }

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

if (!modul?._erBehandlerPaaSkjema) {
    console.log('(hopper over — @azure/functions ikke installert)');
    console.log('\n0 OK, 0 feil, 1 hoppet over');
    process.exit(0);
}
const erBehandler = modul._erBehandlerPaaSkjema;

const forekomst = require('../src/lib/skjema-forekomst-storage');
const behandling = require('../src/lib/behandling');

const gammelHent = forekomst.hentSkjema;
const gammelAktive = behandling.beregnAktiveSteg;
const gammelErBeh = behandling.brukerErBehandlerAsync;

function stub({ skjema = null, aktive = [], erBeh = () => false }) {
    forekomst.hentSkjema = async () => skjema;
    behandling.beregnAktiveSteg = () => aktive;
    behandling.brukerErBehandlerAsync = async (steg, upn) => erBeh(steg, upn);
}

async function kjor() {
    const STEG = { Steg: 1, Roller: ['Administrativ godkjenner(Driftstab)'] };
    const SKJEMA = { Skjema_id: '6', Skjematype_id: '123', Behandling: [STEG] };

    // ---------- behandler på aktivt steg ----------
    {
        stub({ skjema: SKJEMA, aktive: [STEG], erBeh: () => true });
        sjekk('behandler slipper til', await erBehandler('123', '6', 'maja@fhs.no'), true);
    }

    // ---------- ikke behandler ----------
    {
        stub({ skjema: SKJEMA, aktive: [STEG], erBeh: () => false });
        sjekk('utenforstående avvises', await erBehandler('123', '6', 'kari@fhs.no'), false);
    }

    // ---------- steget er ikke aktivt lenger ----------
    {
        // Er skjemaet ferdigbehandlet, har hun ikke lenger noe der å gjøre via
        // denne veien. Er hun eier eller publikum, slipper hun inn på vanlig vis.
        stub({ skjema: SKJEMA, aktive: [], erBeh: () => true });
        sjekk('ingen aktive steg gir ingen tilgang', await erBehandler('123', '6', 'maja@fhs.no'), false);
    }

    // ---------- skjemaet finnes ikke ----------
    {
        stub({ skjema: null, aktive: [STEG], erBeh: () => true });
        sjekk('ukjent skjema gir ingen tilgang', await erBehandler('123', '999', 'maja@fhs.no'), false);
    }

    // ---------- oppslag som feiler ----------
    {
        // En feil under oppslaget skal lukke døra, ikke åpne den.
        forekomst.hentSkjema = async () => { throw new Error('nettverk'); };
        sjekk('feil gir ingen tilgang', await erBehandler('123', '6', 'maja@fhs.no'), false);
    }

    // ---------- flere steg, behandler på ett ----------
    {
        const a = { Steg: 1, Roller: ['Annen rolle'] };
        const b = { Steg: 2, Roller: ['Administrativ godkjenner(Driftstab)'] };
        stub({
            skjema: { ...SKJEMA, Behandling: [a, b] },
            aktive: [a, b],
            erBeh: async (steg) => steg.Steg === 2
        });
        sjekk('behandler på ett av flere steg holder', await erBehandler('123', '6', 'maja@fhs.no'), true);
    }

    forekomst.hentSkjema = gammelHent;
    behandling.beregnAktiveSteg = gammelAktive;
    behandling.brukerErBehandlerAsync = gammelErBeh;

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
}

kjor().catch(e => { console.error('Testen krasjet:', e); process.exit(1); });
