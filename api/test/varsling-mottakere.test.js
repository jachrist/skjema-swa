/**
 * Mottakerne for et behandlingssteg: Personer, Roller OG Team.
 *
 * Alle tre er kilder til hvem som kan behandle et steg — `behandling.js`
 * teller dem likt, både for tilgang og for «alle må avgjøre». Varslingen
 * kjente bare Personer og Roller fram til 16.09.2026.
 *
 * Utslaget var ikke en feilmelding, men taushet: et steg som pekte på et team
 * ga null mottakere, `sendBehandlerVarsling` hoppet over, og behandlerne fikk
 * hverken e-post eller Planner-oppgave. En konkret person i samme felt virket
 * helt fint — og det var nettopp det som gjorde den vanskelig å se.
 *
 * Testen holder på at de tre kildene behandles likt, og på de tre
 * egenskapene som gjorde feilen usynlig da den var der:
 *
 *   Et team alene SKAL gi mottakere — ellers er vi tilbake til taushet.
 *   Samme person i to kilder skal telle én gang — ellers får noen dobbelt.
 *   Et oppslag som feiler skal ikke ta de andre med seg — ellers gjør ett
 *   slettet team at et helt steg står uten varsel.
 *
 * Kjøres med:  node api/test/varsling-mottakere.test.js
 */
let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const varsling = require('../src/lib/varsling');
const rollerStorage = require('../src/lib/roller-storage');
const teamStorage = require('../src/lib/team-storage');

const samle = varsling._samleBehandlerMottakere;

/** Bytter ut de to oppslagene mens én sjekk kjører. */
async function med({ roller = {}, team = {} }, fn) {
    const r = rollerStorage.hentInnehavere;
    const t = teamStorage.hentMedlemmerDetaljert;
    rollerStorage.hentInnehavere = async (navn) => {
        const v = roller[navn];
        if (v instanceof Error) throw v;
        return v || [];
    };
    teamStorage.hentMedlemmerDetaljert = async (navn) => {
        const v = team[navn];
        if (v instanceof Error) throw v;
        return v || [];
    };
    try { return await fn(); } finally {
        rollerStorage.hentInnehavere = r;
        teamStorage.hentMedlemmerDetaljert = t;
    }
}

async function kjor() {
    const epostene = (liste) => liste.map(m => m.epost);

    // ---------- team alene ----------
    {
        const team = { 'Team A': [
            { EP: 'behandler1@jccodevel.onmicrosoft.com', Navn: 'Behandler Én' },
            { EP: 'behandler2@jccodevel.onmicrosoft.com', EN: 'Etternavn', FN: 'Fornavn' }
        ] };
        const res = await med({ team }, () => samle({ Team: ['Team A'] }));
        sjekk('team alene gir mottakere', epostene(res),
            ['behandler1@jccodevel.onmicrosoft.com', 'behandler2@jccodevel.onmicrosoft.com']);
        sjekk('navn tas med når flyten har lagret det', res[0].navn, 'Behandler Én');
        sjekk('og settes sammen når bare EN/FN finnes', res[1].navn, 'Etternavn, Fornavn');
    }

    // ---------- de tre kildene sammen ----------
    {
        const res = await med({
            roller: { Saksbehandler: [{ EP: 'kari@fhs.no', EN: 'Nordmann', FN: 'Kari' }] },
            team: { 'Team B': [{ EP: 'per@fhs.no', Navn: 'Per Hansen' }] }
        }, () => samle({ Personer: ['ola@fhs.no'], Roller: ['Saksbehandler'], Team: ['Team B'] }));
        sjekk('alle tre kildene er med', epostene(res), ['ola@fhs.no', 'kari@fhs.no', 'per@fhs.no']);
    }

    // ---------- ingen dubletter ----------
    {
        // Samme person som konkret behandler, i rollen og i teamet. Én e-post,
        // én Planner-oppgave.
        const res = await med({
            roller: { Saksbehandler: [{ EP: 'Ola@FHS.no' }] },
            team: { 'Team B': [{ EP: 'ola@fhs.no' }] }
        }, () => samle({ Personer: ['ola@fhs.no'], Roller: ['Saksbehandler'], Team: ['Team B'] }));
        sjekk('samme person telles én gang', epostene(res), ['ola@fhs.no']);
    }

    // ---------- ett oppslag som feiler tar ikke resten ----------
    {
        const res = await med({
            team: { 'Slettet team': new Error('404'), 'Team B': [{ EP: 'per@fhs.no' }] }
        }, () => samle({ Personer: ['ola@fhs.no'], Team: ['Slettet team', 'Team B'] }));
        sjekk('resten varsles selv om ett team feiler', epostene(res), ['ola@fhs.no', 'per@fhs.no']);
    }

    // ---------- tomme og manglende felter ----------
    {
        sjekk('tomt steg', epostene(await med({}, () => samle({}))), []);
        sjekk('uten steg', epostene(await med({}, () => samle(null))), []);
        sjekk('tomme lister', epostene(await med({}, () => samle({ Personer: [], Roller: [], Team: [] }))), []);
        // Et medlem uten e-post kan ikke varsles, og skal ikke gi en tom rad i
        // payloaden til flyten.
        const res = await med({ team: { T: [{ EP: '' }, { EP: '   ' }, { EP: 'ok@fhs.no' }] } },
            () => samle({ Team: ['T'] }));
        sjekk('medlemmer uten e-post hoppes over', epostene(res), ['ok@fhs.no']);
    }

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
}

kjor().catch(e => { console.error(e); process.exit(1); });
