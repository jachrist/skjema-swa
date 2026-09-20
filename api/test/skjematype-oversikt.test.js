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
        { Skjematype_id: '1', JSON: { Skjema_navn: 'Reiseregning', Eiere: { Personer: ['a@b.no'] }, Behandling: [{ Steg: 1 }], Samtale: 'Alle' } },
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

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
