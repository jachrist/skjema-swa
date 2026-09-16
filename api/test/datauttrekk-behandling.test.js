/**
 * Behandlingsdata i datauttrekket (TODO 5).
 *
 * Uttrekket hadde svarene, men ingenting om hva som skjedde med skjemaet
 * etterpå. Utfallet måtte slås opp i appen, ett skjema av gangen — og det er
 * nettopp sammenstillingen oppdragsgiver er ute etter.
 *
 * Tre ting er lette å ta feil av her, og alle tre gir tall som *ser* riktige ut:
 *
 *   Utfallet er den siste beslutningen som faktisk ble TATT, ikke siste steg i
 *   definisjonen. Steg kan hoppes over på vilkår, og et skjema kan stå midt i
 *   behandlingen.
 *
 *   I «alle må avgjøre» står `BehandletAv` som `alle-behandlere`. Det er riktig
 *   internt og ubrukelig i et regneark.
 *
 *   Behandlingstid telles bare for ferdige skjemaer. Ellers vokser tallet hver
 *   gang uttrekket kjøres, og det ser ut som data.
 *
 * Kjøres med:  node api/test/datauttrekk-behandling.test.js
 */
let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const { statusTekst, sisteBeslutning, behandlingstidDager, trekkUtSvar } = require('../src/lib/datauttrekk');

const VALG = [{ Nummer: 1, Tekst: 'Godkjent' }, { Nummer: 2, Tekst: 'Avslått' }];

// ---------- status ----------
{
    sjekk('mellomlagret', statusTekst(1), 'Mellomlagret');
    sjekk('under behandling', statusTekst(2), 'Under behandling');
    sjekk('til revidering', statusTekst(3), 'Til revidering');
    sjekk('avsluttet', statusTekst(5), 'Avsluttet');
    sjekk('ukjent status skjules ikke', statusTekst(9), 'Status 9');
    sjekk('mangler', statusTekst(undefined), '');
}

// ---------- siste beslutning ----------
{
    sjekk('ingen behandling', sisteBeslutning({}), null);
    sjekk('ingen beslutning tatt',
        sisteBeslutning({ Behandling: [{ Steg: 1, Beslutning: 0, Beslutningsvalg: VALG }] }), null);

    const to = sisteBeslutning({ Behandling: [
        { Steg: 1, Stegnavn: 'Førstelinje', Beslutning: 1, Beslutningsvalg: VALG, BehandletAv: 'kari@fhs.no', BehandletDato: '2026-09-10T10:00:00Z' },
        { Steg: 2, Stegnavn: 'Godkjenning', Beslutning: 2, Beslutningsvalg: VALG, BehandletAv: 'ola@fhs.no', BehandletDato: '2026-09-12T10:00:00Z' }
    ] });
    sjekk('teksten, ikke nummeret', to.tekst, 'Avslått');
    sjekk('stegnavnet følger med', to.steg, 'Godkjenning');
    sjekk('behandleren', to.av, 'ola@fhs.no');

    // Et halvferdig skjema: steg 2 er ikke avgjort. Da er utfallet steg 1 —
    // ikke tomt, og ikke steg 2.
    const halv = sisteBeslutning({ Behandling: [
        { Steg: 1, Stegnavn: 'Førstelinje', Beslutning: 1, Beslutningsvalg: VALG, BehandletAv: 'kari@fhs.no' },
        { Steg: 2, Stegnavn: 'Godkjenning', Beslutning: 0, Beslutningsvalg: VALG }
    ] });
    sjekk('siste TATTE beslutning', halv.tekst, 'Godkjent');
    sjekk('og steget den ble tatt på', halv.steg, 'Førstelinje');

    // Rekkefølgen i lista skal ikke avgjøre — stegnummeret gjør.
    const ustelt = sisteBeslutning({ Behandling: [
        { Steg: 2, Beslutning: 2, Beslutningsvalg: VALG },
        { Steg: 1, Beslutning: 1, Beslutningsvalg: VALG }
    ] });
    sjekk('sorterer på stegnummer', ustelt.tekst, 'Avslått');

    // Ukjent valg skal ikke bli tomt — nummeret er bedre enn ingenting.
    sjekk('valg som ikke finnes',
        sisteBeslutning({ Behandling: [{ Steg: 1, Beslutning: 7, Beslutningsvalg: VALG }] }).tekst, '7');
}

// ---------- «alle må avgjøre» ----------
{
    const alle = sisteBeslutning({ Behandling: [{
        Steg: 1, Stegnavn: 'Kollegium', Beslutning: 1, Beslutningsvalg: VALG,
        BehandletAv: 'alle-behandlere',
        BehandletDato: '2026-09-12T10:00:00Z',
        Beslutninger: [
            { Aktor: 'kari@fhs.no', Beslutning: 1, Kommentar: 'Enig' },
            { Aktor: 'ola@fhs.no', Beslutning: 1, Kommentar: 'Med forbehold' }
        ]
    }] });
    sjekk('aktørene, ikke «alle-behandlere»', alle.av, 'kari@fhs.no; ola@fhs.no');
    sjekk('kommentarene merkes med hvem',
        alle.kommentar, 'kari@fhs.no: Enig | ola@fhs.no: Med forbehold');

    // Én behandler: da er det unødvendig å gjenta navnet inne i kommentaren.
    const en = sisteBeslutning({ Behandling: [{
        Steg: 1, Beslutning: 1, Beslutningsvalg: VALG, BehandletAv: 'kari@fhs.no',
        Beslutninger: [{ Aktor: 'kari@fhs.no', Beslutning: 1, Kommentar: 'Godkjent slik den står' }]
    }] });
    sjekk('én kommentar står alene', en.kommentar, 'Godkjent slik den står');

    sjekk('ingen kommentar gir tom streng',
        sisteBeslutning({ Behandling: [{ Steg: 1, Beslutning: 1, Beslutningsvalg: VALG }] }).kommentar, '');
}

// ---------- behandlingstid ----------
{
    sjekk('to dager', behandlingstidDager('2026-09-10T08:00:00Z', '2026-09-12T08:00:00Z'), 2);
    sjekk('samme dag', behandlingstidDager('2026-09-10T08:00:00Z', '2026-09-10T16:00:00Z'), 0);
    // Uferdig skjema har ingen sluttdato. Et tall her ville vokst for hver
    // kjøring av uttrekket.
    sjekk('uten sluttdato', behandlingstidDager('2026-09-10T08:00:00Z', ''), '');
    sjekk('uten startdato', behandlingstidDager('', '2026-09-12T08:00:00Z'), '');
    sjekk('ugyldig dato', behandlingstidDager('ikke en dato', '2026-09-12T08:00:00Z'), '');
    sjekk('negativ tid klippes til 0',
        behandlingstidDager('2026-09-12T08:00:00Z', '2026-09-10T08:00:00Z'), 0);
}

// ---------- hele raden ----------
{
    const definisjon = { Seksjoner: [{ Seksjon_nummer: 1, Felter: [{ Nummer: 1, Type: 'Tekst', Tekst: { Verdi: 'Navn på tiltak' } }] }] };
    const skjema = {
        Skjema_id: '42',
        Innsender_Epost: 'per@fhs.no',
        Opprettet: '2026-09-10T08:00:00Z',
        Skjema_status: 5,
        Seksjoner: [{ Seksjon_nummer: 1, Felter: [{ Nummer: 1, Svar: 'Nytt bygg' }] }],
        Behandling: [{
            Steg: 1, Stegnavn: 'Godkjenning', Beslutning: 1, Beslutningsvalg: VALG,
            BehandletAv: 'kari@fhs.no', BehandletDato: '2026-09-13T08:00:00Z',
            Beslutninger: [{ Aktor: 'kari@fhs.no', Beslutning: 1, Kommentar: 'OK' }]
        }]
    };
    const rad = trekkUtSvar(skjema, definisjon);

    sjekk('svaret er fortsatt med', rad['Navn på tiltak'], 'Nytt bygg');
    sjekk('status', rad.Status, 'Avsluttet');
    sjekk('utfall', rad.Utfall, 'Godkjent');
    sjekk('utfall-steg', rad.UtfallSteg, 'Godkjenning');
    sjekk('utfall-av', rad.UtfallAv, 'kari@fhs.no');
    sjekk('utfall-kommentar', rad.UtfallKommentar, 'OK');
    sjekk('behandlingstid', rad.BehandlingstidDager, 3);
}

// ---------- et skjema uten behandling i det hele tatt ----------
{
    // Ikke alle skjematyper har behandlingssteg. Raden skal ha kolonnene, tomme
    // — ellers blir regnearket ujevnt mellom skjematyper.
    const rad = trekkUtSvar({ Skjema_id: '1', Skjema_status: 2 }, { Seksjoner: [] });
    sjekk('utfall tomt', rad.Utfall, '');
    sjekk('utfall-av tomt', rad.UtfallAv, '');
    sjekk('behandlingstid tom', rad.BehandlingstidDager, '');
    sjekk('men status er satt', rad.Status, 'Under behandling');
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
