/**
 * Oversikten over skjematyper (TODO 65).
 *
 * «Antall utfylte» er det eneste tallet i denne oversikten som kan bety to
 * ting, og forskjellen er nettopp det man lurer på: et mellomlagret skjema er
 * påbegynt, ikke levert. Telles de med, ser en skjematype mer brukt ut enn
 * den er — og tallet ser like riktig ut uansett.
 *
 * Tre ting til som er lette å ta feil av:
 *
 *   **Eierskap via rolle eller team.** `Eiere` er en tilgangsstruktur, ikke
 *   en personliste. En oversikt som bare leste `Personer` ville vist tomt for
 *   nettopp de skjematypene der eierskapet er minst åpenbart.
 *
 *   **Skjematyper uten skjemaer skal med.** En type i produksjon som ingen
 *   har brukt er ofte hele grunnen til å se på lista.
 *
 *   **Sortering på bruk, ikke navn.** Alfabetisk rekkefølge skjuler det man
 *   kom for å finne.
 *
 * Kjøres med:  node api/test/skjematype-oversikt.test.js
 */
let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const { eiereTekst, tellinger, byggOversikt } = require('../src/lib/skjematype-oversikt');

// ---------- eiere ----------
{
    sjekk('person', eiereTekst({ Personer: ['kari@fhs.no'] }), 'kari@fhs.no');
    sjekk('flere personer', eiereTekst({ Personer: ['a@b.no', 'c@d.no'] }), 'a@b.no, c@d.no');

    // Eierskap via rolle er vanlig, og en oversikt som bare leste Personer
    // ville meldt «ingen eier» for dem.
    sjekk('rolle', eiereTekst({ Roller: ['Studieleder(CBU2501)'] }), 'Studieleder(CBU2501)');
    sjekk('team merkes', eiereTekst({ Team: ['Fagavdelingen'] }), 'Team: Fagavdelingen');
    sjekk('alle tre',
        eiereTekst({ Personer: ['a@b.no'], Roller: ['Sjef'], Team: ['Stab'] }),
        'a@b.no, Sjef, Team: Stab');

    sjekk('ingen eier', eiereTekst({}), '');
    sjekk('uten struktur', eiereTekst(null), '');
    sjekk('tomme verdier siles bort', eiereTekst({ Personer: ['', '  ', 'a@b.no'] }), 'a@b.no');
}

// ---------- tellinger ----------
{
    // Kjernen: mellomlagrede er ikke utfylte.
    sjekk('utfylte er totalt minus mellomlagret',
        tellinger({ Antall: 10, Mellomlagret: 3 }).Utfylte, 7);
    sjekk('bare mellomlagrede gir null utfylte',
        tellinger({ Antall: 4, Mellomlagret: 4 }).Utfylte, 0);
    sjekk('ingen skjemaer', tellinger(undefined), { Utfylte: 0, Mellomlagret: 0, UnderBehandling: 0, Avsluttet: 0, Totalt: 0 });

    // Skulle tallene være i utakt, skal Utfylte ikke bli negativ — en negativ
    // telling i en oversikt er verre enn en null.
    sjekk('flere mellomlagrede enn totalt klippes',
        tellinger({ Antall: 2, Mellomlagret: 5 }).Utfylte, 0);
}

// ---------- hele raden ----------
{
    const kart = new Map([
        ['1', { Antall: 5, Mellomlagret: 2, UnderBehandling: 1, Avsluttet: 2, SisteDato: '2026-09-20T10:00:00Z' }],
        ['3', { Antall: 12, Mellomlagret: 0, UnderBehandling: 4, Avsluttet: 8, SisteDato: '2026-09-19T08:00:00Z' }]
    ]);
    const typer = [
        // Den EKTE formen fra `hentAlleSkjematyper`: { id, navn, JSON }.
        // Testen brukte `{ Skjematype_id, JSON }` på alle tre — en form
        // lagringen aldri produserer. Id-en kom derfor bare fra JSON-en, og en
        // definisjon uten den ville gitt tom id og en editorlenke uten
        // skjematype.
        { id: '1', navn: 'Reiseregning', JSON: { Skjema_navn: 'Reiseregning', Eiere: { Personer: ['a@b.no'] }, Behandling: [{ Steg: 1 }], Samtale: 'Alle' } },
        { Skjematype_id: '2', JSON: { Skjema_navn: 'Aldri brukt', Fase: 'Utvikling' } },
        { Skjematype_id: '3', JSON: { Skjema_navn: 'Avvik', Eiere: { Roller: ['Sjef'] } } }
    ];
    const rader = byggOversikt(typer, kart);

    // Mest brukt først.
    sjekk('sortert på bruk', rader.map(r => r.Skjema_navn), ['Avvik', 'Reiseregning', 'Aldri brukt']);

    const reise = rader.find(r => r.Skjematype_id === '1');
    sjekk('utfylte', reise.Utfylte, 3);
    sjekk('mellomlagret', reise.Mellomlagret, 2);
    sjekk('siste dato', reise.SisteDato, '2026-09-20T10:00:00Z');
    sjekk('behandlingssteg telles', reise.Behandlingssteg, 1);
    sjekk('samtale-innstillingen er med', reise.Samtale, 'Alle');
    sjekk('fase har standardverdi', reise.Fase, 'Produksjon');

    // Den ubrukte skal med, med nuller — ikke utelates.
    const ubrukt = rader.find(r => r.Skjematype_id === '2');
    sjekk('ubrukt type er med', !!ubrukt, true);
    sjekk('ubrukt har null', ubrukt.Totalt, 0);
    sjekk('ubrukt har tom dato', ubrukt.SisteDato, '');
    sjekk('fase fra definisjonen', ubrukt.Fase, 'Utvikling');
    sjekk('ingen eier gir tom streng', ubrukt.Eiere, '');

    sjekk('eier via rolle', rader.find(r => r.Skjematype_id === '3').Eiere, 'Sjef');
}

// ---------- tomme tilfeller ----------
{
    sjekk('ingen skjematyper', byggOversikt([], new Map()), []);
    sjekk('uten argumenter', byggOversikt(null, null), []);
    // Et kart uten treff skal ikke gi undefined-felter i raden.
    const r = byggOversikt([{ Skjematype_id: '9', JSON: { Skjema_navn: 'X' } }], new Map())[0];
    sjekk('ukjent type får nuller', [r.Utfylte, r.Totalt, r.SisteDato], [0, 0, '']);
}

// ---------- id-en kommer fra rowKey ----------
{
    const { byggOversikt: bygg } = require('../src/lib/skjematype-oversikt');
    // Fasiten er `id` — det er rowKey-en i tabellen.
    sjekk('ekte form gir id', bygg([{ id: '129', navn: 'X', JSON: { Skjema_navn: 'X' } }], new Map())[0].Skjematype_id, '129');
    // Fallbackene beholdes for definisjoner som bærer den i JSON-en.
    sjekk('fallback til JSON', bygg([{ JSON: { Skjematype_id: '7', Skjema_navn: 'X' } }], new Map())[0].Skjematype_id, '7');
    sjekk('id vinner over JSON',
        bygg([{ id: '129', JSON: { Skjematype_id: '999' } }], new Map())[0].Skjematype_id, '129');
}

// ---------- eksporten ----------
{
    const { tilEksportRader, EKSPORT_KOLONNER, byggOversikt: bygg } = require('../src/lib/skjematype-oversikt');
    const fs2 = require('fs');
    const path2 = require('path');

    const rader = bygg([
        { id: '129', navn: 'Behandling', JSON: { Skjema_navn: 'Behandling', Fase: 'Produksjon', Eiere: { Personer: ['a@b.no'] }, Behandling: [{}, {}] } },
        { id: '123', navn: 'Uten eier', JSON: { Skjema_navn: 'Uten eier', Fase: 'Utvikling' } }
    ], new Map([['129', { Antall: 11, Mellomlagret: 1, Avsluttet: 7, UnderBehandling: 2, SisteDato: '2026-10-06' }]]));
    const eksport = tilEksportRader(rader);

    sjekk('én rad per skjematype', eksport.length, 2);
    // Rekkefølgen er den samme som på skjermen — mest brukt først. En fil i en
    // annen rekkefølge enn tabellen er en forskjell ingen har bedt om.
    sjekk('samme rekkefølge som tabellen',
        eksport.map(r => r['Skjematype']), rader.map(r => r.Skjema_navn));

    sjekk('overskriftene er lesbare', Object.keys(eksport[0]), EKSPORT_KOLONNER.map(k => k[0]));
    sjekk('tallene følger med',
        [eksport[0]['Innsendt'], eksport[0]['Mellomlagret'], eksport[0]['Avsluttet'], eksport[0]['Totalt']],
        [10, 1, 7, 11]);
    sjekk('id-en er med', eksport[0]['Id'], '129');

    // Tom celle leses som «ikke eksportert». Her betyr den «ingen eier», og
    // det er et forvaltningshull man skal kunne filtrere på i regnearket.
    sjekk('uten eier står det noe', eksport[1]['Eiere'], '(ingen eier satt)');

    // Hver kolonne i tabellen må finnes i eksporten. Det er denne retningen
    // som ryker stille: en kolonne legges til i visningen, og fila fortsetter
    // å se riktig ut mens den mangler den.
    const admin = fs2.readFileSync(path2.join(__dirname, '..', '..', 'frontend', 'admin.html'), 'utf8');
    // Ankret i funksjonen som tegner NETTOPP denne tabellen. admin.html har
    // flere `<thead>`, og «den første» ville pekt på en annen den dagen noen
    // la til et panel over.
    const fn = admin.indexOf('function byggOversiktTabell(');
    sjekk('fant tabellfunksjonen', fn > -1, true);
    const tabell = /<thead><tr>([\s\S]*?)<\/tr><\/thead>/.exec(admin.slice(fn));
    sjekk('fant tabelloverskriftene', !!tabell, true);
    if (tabell) {
        const kolonner = [...tabell[1].matchAll(/<th[^>]*>([^<]+)<\/th>/g)].map(m => m[1].trim());
        sjekk('tabellen har kolonner', kolonner.length > 0, true);
        const overskrifter = EKSPORT_KOLONNER.map(k => k[0].toLowerCase());
        const mangler = kolonner.filter(k => !overskrifter.includes(k.toLowerCase()));
        sjekk('alle tabellkolonner finnes i eksporten', mangler, []);
    }

    // Endepunktet skal bruke den SAMME sammenstillingen, ikke bygge sin egen.
    const ep = fs2.readFileSync(path2.join(__dirname, '..', 'src', 'functions', 'skjematype-oversikt.js'), 'utf8');
    sjekk('eksporten bygges av de samme radene',
        /genererExcel\(tilEksportRader\(rader\)/.test(ep), true);
    sjekk('og utløses av format=excel',
        /request\.query\.get\('format'\)/.test(ep), true);

    // Knappen finnes, og henter nettopp det.
    sjekk('knappen finnes i admin', /eksporterSkjematyper\(\)/.test(admin), true);
    sjekk('og kaller endepunktet', /skjematype-oversikt\?format=excel/.test(admin), true);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
