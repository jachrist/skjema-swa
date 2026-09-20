/**
 * Arkiveringsfanen på adminsiden.
 *
 * Det som testes her er ikke tegningen, men sperrene. Sletting av skjemaer
 * fra Table Storage kan ikke angres — det finnes hverken soft delete eller
 * point-in-time restore — så den eneste kopien av dataene etter en sletting
 * er fila brukeren lastet ned. Grensesnittet har tre steg nettopp for å
 * gjøre den rekkefølgen umulig å hoppe over:
 *
 *   1. Forhåndsvis — hvor mange og hvor gamle
 *   2. Eksporter   — bygger arkivet OG laster det ned
 *   3. Slett       — krever arkiv-id og sjekksum fra steg 2
 *
 * Hver test under svarer til én måte den rekkefølgen kan ryke på: at
 * slettingen er tilgjengelig uten nedlasting, at den overlever et bytte av
 * skjematype, eller at den sender noe annet enn sjekksummen fra det arkivet
 * som faktisk ble lastet ned.
 *
 * Seksjonen klippes ut av admin.html og kjøres mot stubbet DOM — samme
 * mønster som de andre frontend-testene.
 *
 * Kjøres med:  node frontend/test/arkiv-ui.test.js
 */
const fs = require('fs');
const path = require('path');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

// ---------- klipp seksjonen ut av admin.html ----------
const kilde = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
const start = kilde.indexOf('// ==================== ARKIVERING ====================');
if (start === -1) throw new Error('Fant ikke ARKIVERING-seksjonen i admin.html');
const slutt = kilde.indexOf('function rendrBackup(', start);
if (slutt === -1) throw new Error('Fant ikke slutten på ARKIVERING-seksjonen');
const seksjon = kilde.slice(start, slutt);

// ---------- stubbet DOM og omverden ----------
function lagElement() {
    return { innerHTML: '', textContent: '', value: '', checked: false, disabled: false };
}
const FELTER = ['innhold', 'ark-type', 'ark-dato', 'ark-vedlegg',
    'ark-forhaands', 'ark-eksport-knapp', 'ark-eksport-status',
    'ark-slett', 'ark-slett-status'];

let el, logg, nedlastinger, promptSvar, promptTekst, apiKall, apiSvar;

function nullstill() {
    el = {};
    for (const id of FELTER) el[id] = lagElement();
    logg = [];
    nedlastinger = [];
    promptSvar = 'SLETT';
    promptTekst = '';
    apiKall = [];
    apiSvar = {};
}
nullstill();

const dokument = {
    getElementById: (id) => el[id] || (el[id] = lagElement()),
    createElement: () => ({ click() { logg.push('klikk'); }, remove() {} }),
    body: { appendChild() {} }
};
const vindu = {};
const api = {
    get: async (sti) => { apiKall.push(['GET', sti]); return apiSvar[sti]; },
    post: async (sti, body) => {
        apiKall.push(['POST', sti, body]);
        const svar = apiSvar[sti];
        if (svar instanceof Error) throw svar;
        return svar;
    }
};
const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const escAttr = (s) => String(s ?? '').replace(/"/g, '&quot;').replace(/'/g, "\\'");
const kortDato = (iso) => iso ? String(iso).slice(0, 10) : '–';

const miljo = new Function(
    'window', 'document', 'api', 'escHtml', 'escAttr', 'kortDato',
    'Blob', 'URL', 'prompt', 'setTimeout',
    `${seksjon}
     return { rendrArkiv, tegnArkiv, tegnArkivSletting, hentState: () => arkivState };`
)(
    vindu, dokument, api, escHtml, escAttr, kortDato,
    function Blob(deler) { this.tekst = deler.join(''); },
    {
        createObjectURL: (b) => { nedlastinger.push(b.tekst); logg.push('nedlasting'); return 'blob:x'; },
        revokeObjectURL: () => {}
    },
    (tekst) => { promptTekst = String(tekst); logg.push('bekreftelse'); return promptSvar; },
    () => {}
);

/**
 * `tegnArkivSletting` kan kaste hvis sperren og tilstanden kommer i utakt —
 * og en test som bare krasjer sier lite om hva som er galt. Her telles det
 * som en feil, slik at resten av sjekkene også får kjørt.
 */
function slettePanel() {
    try {
        return miljo.tegnArkivSletting();
    } catch (e) {
        feil++;
        console.log(`FEIL  tegnArkivSletting kastet: ${e.message}`);
        return '';
    }
}

/**
 * Fersk start: både DOM-stubbene og modulens egen `arkivState`.
 *
 * Uten det siste ville en test arvet nedlastingen fra testen før — og en
 * sperre som avhenger av at ingenting er lastet ned, ville da blitt testet
 * med noe lastet ned.
 */
function friskStart() {
    nullstill();
    Object.assign(miljo.hentState(),
        { typer: [], valgt: '', forhaands: null, nedlastet: null, tidligere: [] });
}

// Funksjonene seksjonen henger på `window` er de grensesnittet kaller.
const { arkVelg, arkForhandsvis, arkEksporter, arkSlett } = vindu;
sjekk('alle fire handlingene er eksponert',
    [arkVelg, arkForhandsvis, arkEksporter, arkSlett].every(f => typeof f === 'function'), true);

// Filnavnet lages av API-et, ikke av siden — se lib/arkiv.js:filnavnFor.
const FILNAVN = 'arkiv_PLANNER_120_2026-09-20_162106.json';

const MANIFEST = {
    ArkivId: 'ark-2026-09-20-001',
    Skjematype_id: '120',
    FoerDato: '2025-01-01T00:00:00.000Z',
    Sjekksum: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    Antall: 42,
    AntallVedlegg: 7,
    MedVedlegg: true
};

/** Kjører steg 1 og 2 slik grensesnittet gjør det. */
async function gjennomførEksport(manifest = MANIFEST) {
    friskStart();
    apiSvar = {
        '/api/arkiv/120/forhandsvis': { antall: 42, antallVedlegg: 7, eldste: '2020-03-01', nyeste: '2024-12-30' },
        '/api/arkiv/120': { Manifest: manifest, Filnavn: FILNAVN, Skjemaer: [{ Skjema_id: '1' }] },
        '/api/arkiv/120/slett': { slettet: 40, feilet: 0, hoppetOver: 2 },
        '/api/arkiv': { arkiv: [] }
    };
    arkVelg('120');
    el['ark-dato'].value = '2025-01-01';
    el['ark-vedlegg'].checked = manifest.MedVedlegg;
    await arkForhandsvis();
    await arkEksporter();
    return miljo.hentState();
}

async function kjor() {

    // ---------- steg 3 er stengt før steg 2 ----------
    {
        friskStart();
        const laast = slettePanel();
        sjekk('ingen slett-knapp før nedlasting', /arkSlett\(\)/.test(laast), false);
        sjekk('forklarer hvorfor den er stengt', laast.includes('lastet ned'), true);
    }

    // ---------- steg 1 låser ikke opp steg 2 uten treff ----------
    {
        friskStart();
        apiSvar = { '/api/arkiv/120/forhandsvis': { antall: 0, antallVedlegg: 0 } };
        arkVelg('120');
        el['ark-dato'].value = '2025-01-01';
        el['ark-eksport-knapp'].disabled = false;
        await arkForhandsvis();
        sjekk('null treff gir ingen eksportknapp', el['ark-eksport-knapp'].disabled, true);
    }
    {
        friskStart();
        apiSvar = { '/api/arkiv/120/forhandsvis': { antall: 3, antallVedlegg: 1, eldste: '2020-01-01', nyeste: '2024-01-01' } };
        arkVelg('120');
        el['ark-dato'].value = '2025-01-01';
        await arkForhandsvis();
        sjekk('treff låser opp eksporten', el['ark-eksport-knapp'].disabled, false);
        sjekk('antallet vises', el['ark-forhaands'].innerHTML.includes('3'), true);
    }
    {
        friskStart();
        arkVelg('120');
        el['ark-dato'].value = '';
        await arkForhandsvis();
        sjekk('uten dato spørres ikke API-et', apiKall.length, 0);
    }

    // ---------- steg 2 laster ned FØR steg 3 tilbys ----------
    {
        const state = await gjennomførEksport();
        sjekk('arkivet ble lastet ned', nedlastinger.length, 1);
        sjekk('fila inneholder skjemaene', (nedlastinger[0] || '').includes('"Skjema_id"'), true);
        sjekk('fila inneholder manifestet', (nedlastinger[0] || '').includes(MANIFEST.Sjekksum), true);
        sjekk('nedlastingen ble faktisk utløst', logg.includes('nedlasting') && logg.includes('klikk'), true);
        sjekk('sjekksummen er tatt vare på', state.nedlastet.sjekksum, MANIFEST.Sjekksum);
        sjekk('arkiv-id er tatt vare på', state.nedlastet.arkivId, MANIFEST.ArkivId);

        // Filnavnet kommer fra API-et. Bygde siden det selv, ville den måttet
        // gjette på felter i manifestet — og et felt som ikke finnes gir
        // «arkiv__2026-09-21.json» uten at noe sier fra.
        sjekk('fila heter det API-et sa', el['ark-eksport-status'].innerHTML.includes(FILNAVN), true);

        const aapen = slettePanel();
        sjekk('slett-knappen er der nå', /arkSlett\(\)/.test(aapen), true);
        sjekk('arkiv-id vises', aapen.includes(MANIFEST.ArkivId), true);
    }

    // ---------- steg 3 sender sjekksummen fra fila ----------
    {
        await gjennomførEksport();
        apiKall.length = 0;
        promptSvar = 'SLETT';
        await arkSlett();
        const kall = apiKall.find(k => k[1] === '/api/arkiv/120/slett');
        sjekk('slettingen ble sendt', !!kall, true);
        sjekk('med arkiv-id', kall[2].arkivId, MANIFEST.ArkivId);
        sjekk('med sjekksum', kall[2].sjekksum, MANIFEST.Sjekksum);
    }
    {
        await gjennomførEksport();
        apiKall.length = 0;
        promptSvar = 'slett';                     // feil ord — små bokstaver
        await arkSlett();
        sjekk('feil bekreftelse sletter ingenting',
            apiKall.some(k => k[1].endsWith('/slett')), false);
    }
    {
        await gjennomførEksport();
        apiKall.length = 0;
        promptSvar = null;                        // avbrutt dialog
        await arkSlett();
        sjekk('avbrutt bekreftelse sletter ingenting',
            apiKall.some(k => k[1].endsWith('/slett')), false);
    }
    {
        friskStart();
        await arkSlett();
        sjekk('uten nedlasting spørres det ikke engang', logg.includes('bekreftelse'), false);
        sjekk('uten nedlasting sletter arkSlett ingenting', apiKall.length, 0);
    }

    // ---------- bytte av skjematype nullstiller alt ----------
    {
        await gjennomførEksport();
        arkVelg('999');
        const state = miljo.hentState();
        sjekk('nedlastingen følger ikke med til ny type', state.nedlastet, null);
        sjekk('forhåndsvisningen følger ikke med', state.forhaands, null);
        sjekk('slettepanelet er stengt igjen', /arkSlett\(\)/.test(slettePanel()), false);

        apiKall.length = 0;
        await arkSlett();
        sjekk('og slettingen kan ikke kjøres', apiKall.length, 0);
    }

    // ---------- sletting nullstiller nedlastingen ----------
    {
        await gjennomførEksport();
        await arkSlett();
        sjekk('arkivet kan ikke slettes to ganger', miljo.hentState().nedlastet, null);
        sjekk('antallet slettede vises', el['ark-slett-status'].innerHTML.includes('40'), true);
        // Skjemaer som ble endret etter arkiveringen står igjen. Sies det ikke,
        // tror brukeren at alt er borte — og sletter arkivfila.
        sjekk('de som står igjen nevnes',
            el['ark-slett-status'].innerHTML.includes('2') &&
            el['ark-slett-status'].innerHTML.includes('endret etter arkiveringen'), true);
    }

    // ---------- vedlegg som ikke er med, blir ikke slettet ----------
    {
        await gjennomførEksport({ ...MANIFEST, MedVedlegg: false });
        sjekk('advarer om vedlegg utenfor arkivet',
            slettePanel().includes('Vedlegg ble ikke tatt med'), true);
        promptSvar = 'SLETT';
        await arkSlett();
        sjekk('bekreftelsen lover ikke at vedlegg forsvinner',
            promptTekst.includes('med vedlegg'), false);
        sjekk('bekreftelsen nevner antallet', promptTekst.includes('42'), true);
    }
    {
        await gjennomførEksport();
        await arkSlett();
        sjekk('bekreftelsen nevner vedlegg når de er med',
            promptTekst.includes('med vedlegg'), true);
    }
    {
        // Skjemaer uten vedlegg er ikke det samme som vedlegg utelatt.
        // MedVedlegg kommer fra avkrysningsboksen, ikke fra AntallVedlegg.
        await gjennomførEksport({ ...MANIFEST, MedVedlegg: true, AntallVedlegg: 0 });
        sjekk('ingen advarsel når jobben tok vedlegg, men ingen fantes',
            slettePanel().includes('ble ikke tatt med'), false);
    }

    // ---------- feil fra API-et stopper flyten ----------
    {
        friskStart();
        apiSvar = {
            '/api/arkiv/120/forhandsvis': { antall: 5, antallVedlegg: 0, eldste: '2020-01-01', nyeste: '2024-01-01' },
            '/api/arkiv/120': new Error('Arkivet er for stort')
        };
        arkVelg('120');
        el['ark-dato'].value = '2025-01-01';
        await arkForhandsvis();
        await arkEksporter();
        sjekk('ingen nedlasting ved feil', nedlastinger.length, 0);
        sjekk('feilmeldingen vises', el['ark-eksport-status'].innerHTML.includes('Arkivet er for stort'), true);
        sjekk('slettepanelet forblir stengt', miljo.hentState().nedlastet, null);
    }

    // ---------- fritekst fra brukeren ----------
    {
        friskStart();
        apiSvar = {
            '/api/skjematyper': [{ Skjematype_id: '1', Skjema_navn: '<img src=x onerror="alert(1)">' }],
            '/api/arkiv': { arkiv: [{ ArkivId: 'a', Skjematype_id: '1', Skjema_navn: '<b>x</b>',
                Antall: 1, Arkivert: '2026-01-01', ArkivertAv: '<script>', Slettet: '' }] }
        };
        await miljo.rendrArkiv();
        const ut = el['innhold'].innerHTML;
        sjekk('skjemanavn escapes i nedtrekket', ut.includes('<img src=x'), false);
        sjekk('navnet er beholdt, bare escapet', ut.includes('&lt;img'), true);
        sjekk('historikken escapes også', ut.includes('<script>'), false);
    }

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
}

kjor();
