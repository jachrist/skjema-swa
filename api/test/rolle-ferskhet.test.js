/**
 * Hvor fersk er en rolle? (punkt 89)
 *
 * En rolle som får innehaverne sine fra FS gjennom importen ser helt lik ut
 * enten importen gikk i går eller i fjor: antallet stemmer, navnene står der,
 * og ingenting i oversikten skiller en fersk liste fra en forlatt. Ønsket var
 * å kunne stole på lista — altså å se datoen.
 *
 * Feltet `SistOppdatert` har ligget på hver rad hele tiden. Det var ingen som
 * leste det: `hentAlleGrupper` tok med `Antall` og `Kilder`, og
 * innehavertabellen viste `Kilde` men ikke datoen.
 *
 * **Den samlede nyeste datoen er ikke svaret.** Redigeres én rad for hånd i
 * dag, blir «sist oppdatert» i dag, mens importen kan være måneder gammel.
 * Det er nettopp den situasjonen som skal kunne ses, og derfor føres datoen
 * per kilde. Den sjekken står først under.
 *
 * Kjøres med:  node api/test/rolle-ferskhet.test.js
 */
const fs = require('fs');
const path = require('path');
const rollerStorage = require('../src/lib/roller-storage');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

/** Stubbet tabell — testene skal kunne kjøre uten node_modules. */
function stubb(rader) {
    const storage = require('../src/lib/storage');
    storage.sikreTabell = async () => ({
        listEntities: () => (async function* () { for (const r of rader) yield r; })()
    });
}

// Rekkefølgen er en del av testen. Table Storage gir radene sortert på
// RowKey, så den manuelle raden kommer FØRST her — og det er den
// rekkefølgen som skiller en dato per kilde fra «den nyeste jeg har sett så
// langt». Med den gamle raden sist ga begge samme svar på disse dataene, og
// en mutasjon som fjernet skillet ble grønn (20.10.2026).
const RADER = [
    // Importert liste, en måned gammel, og én rad rettet for hånd i dag.
    { partitionKey: 'Emneansvarlig', rowKey: 'CBU1503|anne@fhs.no', Kilde: 'manuell', SistOppdatert: '2026-10-20T09:00:00.000Z' },
    { partitionKey: 'Emneansvarlig', rowKey: 'CBU1503|bjorn@fhs.no', Kilde: 'import', SistOppdatert: '2026-09-20T08:00:00.000Z' },
    { partitionKey: 'Emneansvarlig', rowKey: 'CBU1503|carl@fhs.no', Kilde: 'import', SistOppdatert: '2026-09-20T08:00:00.000Z' },
    // Et annet omfang på samme rolle: skal ikke blandes inn.
    { partitionKey: 'Emneansvarlig', rowKey: 'CBU2501|d@fhs.no', Kilde: 'import', SistOppdatert: '2026-10-19T08:00:00.000Z' },
    // Rolle med rader fra før feltet ble skrevet.
    { partitionKey: 'Klassesjef', rowKey: 'MILM23-1|e@fhs.no', Kilde: 'manuell' },
    { partitionKey: 'Klassesjef', rowKey: 'MILM23-1|f@fhs.no', Kilde: 'manuell', SistOppdatert: '' },
    // Table Storage leverer en Date for kolonner typet Edm.DateTime. En Date
    // sammenlignet med en streng gir `false` i BEGGE retninger, så en slik
    // rad ville aldri vunnet som «nyeste» — og rollen sett eldre ut enn den
    // er, uten noen feilmelding.
    { partitionKey: 'Vernepliktsrådet', rowKey: '|g@fhs.no', Kilde: 'import', SistOppdatert: new Date('2026-10-18T07:00:00.000Z') },
    { partitionKey: 'Vernepliktsrådet', rowKey: '|h@fhs.no', Kilde: 'import', SistOppdatert: '2026-10-01T07:00:00.000Z' }
];

async function kjor() {
    stubb(RADER);
    const grupper = await rollerStorage.hentAlleGrupper();
    const finn = (rolle, omfang) => grupper.find(g => g.Rolle === rolle && g.Omfang === omfang);

    // ---------- 1. en manuell rettelse skal ikke skjule en gammel import ----------
    {
        const g = finn('Emneansvarlig', 'CBU1503');
        sjekk('gruppa finnes', !!g, true);
        sjekk('antallet er uendret', g.Antall, 3);
        sjekk('nyeste dato totalt er den manuelle', g.SistOppdatert, '2026-10-20T09:00:00.000Z');
        // Dette er hele poenget: importdatoen er fortsatt en måned gammel,
        // og den skal være lesbar ved siden av.
        sjekk('importdatoen står for seg', g.SistPerKilde.import, '2026-09-20T08:00:00.000Z');
        sjekk('og den manuelle for seg', g.SistPerKilde.manuell, '2026-10-20T09:00:00.000Z');
    }

    // ---------- 2. omfang blandes ikke ----------
    {
        const g = finn('Emneansvarlig', 'CBU2501');
        sjekk('naboomfanget har sin egen dato', g.SistPerKilde.import, '2026-10-19T08:00:00.000Z');
        sjekk('og ingen manuell dato', g.SistPerKilde.manuell, undefined);
    }

    // ---------- 3. «vi vet ikke» er ikke «aldri» ----------
    {
        const g = finn('Klassesjef', 'MILM23-1');
        sjekk('ingen dato gir null, ikke en oppdiktet dato', g.SistOppdatert, null);
        sjekk('og radene uten dato telles', g.UtenDato, 2);
        // En tom streng er like ukjent som et manglende felt, og skal ikke
        // sortere som den minste datoen. Regelen prøves direkte i 4b.
        sjekk('ingen kilde fikk en dato', Object.keys(g.SistPerKilde), []);
    }

    // ---------- 3b. en Date leses, ikke forkastes ----------
    {
        const g = finn('Vernepliktsrådet', '');
        sjekk('Date-raden vant som nyeste', g.SistPerKilde.import, '2026-10-18T07:00:00.000Z');
        sjekk('og ingen rad ble regnet som udatert', g.UtenDato, 0);
    }

    // ---------- 4. kildene er uendret ----------
    {
        sjekk('Kilder er fortsatt med', finn('Emneansvarlig', 'CBU1503').Kilder.sort(),
            ['import', 'manuell']);
    }
}

// ---------- 4b. isoDato er én navngitt regel, ikke to overlappende vakter ----------
//
// Her sto først to vakter som dekket hverandre: en «&& e.SistOppdatert» i
// uttrykket og en `if (!dato)` etterpå. Fjernet man én av dem, oppførte koden
// seg likt — og mutasjonen ble grønn. En vakt ingen test kan skille fra
// ingenting, er ingenting.
{
    sjekk('ISO-streng går igjennom',
        rollerStorage.isoDato('2026-01-01T00:00:00Z'), '2026-01-01T00:00:00Z');
    sjekk('tom streng er ukjent', rollerStorage.isoDato(''), null);
    sjekk('mellomrom er også ukjent', rollerStorage.isoDato('   '), null);
    sjekk('manglende verdi er ukjent', rollerStorage.isoDato(undefined), null);
    sjekk('en Date oversettes', rollerStorage.isoDato(new Date('2026-03-04T05:06:07Z')), '2026-03-04T05:06:07.000Z');
    sjekk('en ugyldig Date er ukjent', rollerStorage.isoDato(new Date('tull')), null);
    sjekk('et tall er ukjent', rollerStorage.isoDato(1760000000000), null);
}

// ---------- 5. teksten i grensesnittet ----------
//
// Kjøres ekte: funksjonen klippes ut av admin.html. En avskrift her ville
// testet avskriften.
{
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'admin.html'), 'utf8');
    const fra = html.indexOf('function rolleSistTekst(');
    sjekk('fant rolleSistTekst i admin.html', fra > 0, true);
    const til = html.indexOf('\n        }', fra);
    const kilde = html.slice(fra, til + 10);

    // `formatDato` hører til siden; her holder det at datoen er gjenkjennelig.
    const lag = new Function('formatDato', `${kilde}; return rolleSistTekst;`);
    const rolleSistTekst = lag((iso) => String(iso).slice(0, 10));

    const g = {
        Antall: 3, SistOppdatert: '2026-10-20T09:00:00.000Z',
        SistPerKilde: { import: '2026-09-20T08:00:00.000Z', manuell: '2026-10-20T09:00:00.000Z' },
        UtenDato: 0
    };
    sjekk('kort form viser importdatoen', rolleSistTekst(g), 'importert 2026-09-20');
    sjekk('og ikke den manuelle', /2026-10-20/.test(rolleSistTekst(g)), false);
    sjekk('full form viser begge', rolleSistTekst(g, true),
        'importert 2026-09-20 · manuelt endret 2026-10-20');

    const bareManuell = { Antall: 1, SistOppdatert: '2026-10-01T00:00:00.000Z', SistPerKilde: { manuell: '2026-10-01T00:00:00.000Z' }, UtenDato: 0 };
    sjekk('uten import sies «endret»', rolleSistTekst(bareManuell), 'endret 2026-10-01');

    const utenDato = { Antall: 2, SistOppdatert: null, SistPerKilde: {}, UtenDato: 2 };
    sjekk('ukjent dato sies som ukjent', rolleSistTekst(utenDato), 'dato ukjent');
    sjekk('og ikke som aldri', /aldri/.test(rolleSistTekst(utenDato)), false);

    const tom = { Antall: 0, SistOppdatert: null, SistPerKilde: {}, UtenDato: 0 };
    sjekk('en rolle uten innehavere får ingen tekst', rolleSistTekst(tom), '');

    const delvis = { Antall: 3, SistOppdatert: '2026-09-20T08:00:00.000Z', SistPerKilde: { import: '2026-09-20T08:00:00.000Z' }, UtenDato: 1 };
    sjekk('full form sier hvor mange som mangler dato',
        rolleSistTekst(delvis, true), 'importert 2026-09-20 · 1 uten dato');
}

// ---------- 6. og den vises faktisk, begge steder ----------
{
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'admin.html'), 'utf8');

    const gruppeFra = html.indexOf('function rollerRenderGrupper()');
    const gruppeTil = html.indexOf('window.rollerVelgGruppe', gruppeFra);
    sjekk('gruppelista kaller den',
        /rolleSistTekst\(g\)/.test(html.slice(gruppeFra, gruppeTil)), true);

    const detaljFra = html.indexOf('function rollerRenderInnehavere(');
    const detaljTil = html.indexOf('function teamBoks(', detaljFra);
    const detalj = html.slice(detaljFra, detaljTil);
    sjekk('detaljruta bruker full form', /rolleSistTekst\(g, true\)/.test(detalj), true);
    sjekk('innehavertabellen har en kolonne for datoen',
        /<div>Sist oppdatert<\/div>/.test(detalj), true);
    sjekk('og radene fyller den', /i\.SistOppdatert \? escHtml\(formatDato\(i\.SistOppdatert\)\)/.test(detalj), true);

    // Fem kolonner i overskriften krever fem i radene. Står de ulikt,
    // forskyves hele tabellen — og det ser ut som en datafeil.
    const kolonner = [...detalj.matchAll(/grid-template-columns: ([^;"]+)/g)].map(m => m[1].trim());
    sjekk('overskrift og rad har samme kolonneoppsett',
        kolonner.length >= 2 && new Set(kolonner.slice(0, 2)).size, 1);
}

kjor().then(() => {
    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
}).catch(e => { console.log('UVENTET', e); process.exit(1); });
