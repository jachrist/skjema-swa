/**
 * Statusteksten — ett sted, og ett ord per situasjon.
 *
 * Kartet fantes i fem eksemplarer som var uenige om nesten hver verdi: status
 * 3 het «Avvist» to steder og «Til revidering» tre, status 1 het «Utkast»
 * eller «Mellomlagret», status 2 «Innsendt» eller «Under behandling».
 *
 * Det som gjorde dette vanskeligere enn en vanlig opprydding, er at én av
 * situasjonene oppdragsgiver beskrev **ikke har en status i det hele tatt**:
 * et skjema som er avgjort på steg 1 og venter på steg 2 står fortsatt på 2,
 * akkurat som et ingen har rørt. Den forskjellen må utledes.
 *
 * Fem ting testes:
 *
 *   **De fem situasjonene får hver sitt ord.** Det er avtalen med
 *   oppdragsgiver 05.10.2026.
 *
 *   **Avsluttet er avsluttet, uansett utfall.** Innvilget og avslått er
 *   beslutninger på steg, ikke statuser på skjemaet.
 *
 *   **Et hoppet steg er ikke behandling.** `Beslutning = 5` betyr at steget
 *   ikke skulle kjøre. Teller det som arbeid, ser et skjema ingen har rørt ut
 *   som om det er i gang.
 *
 *   **Tallet alene lyver ikke.** Rapportkolonner har bare statusen. Da er
 *   «Innsendt» det ærlige svaret på 2 — ikke en gjetning på «Under
 *   behandling».
 *
 *   **Frontend og bakende er enige om utledningen.** Registerlista er kompakt
 *   og bærer ikke `Behandling`; serveren regner ut det samme og sender
 *   `UnderBehandling`. To regler for «har noen behandlet et steg» ville før
 *   eller siden gitt to ulike svar i to visninger av samme skjema.
 *
 * Kjøres med:  node frontend/test/skjemastatus.test.js
 */
const fs = require('fs');
const path = require('path');
const { utenKommentarer } = require('../../scripts/test-kilde.js');
const behandling = require('../../api/src/lib/behandling.js');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const kilde = fs.readFileSync(path.join(__dirname, '..', 'js', 'skjemastatus.js'), 'utf8');
const { statusTekst, statusTekstFraKode } = (function () {
    const modul = {};
    // eslint-disable-next-line no-eval
    eval(kilde.replace(/^export /gm, '')
        + '\nmodul.statusTekst = statusTekst; modul.statusTekstFraKode = statusTekstFraKode;');
    return modul;
})();

// ---------- de fem situasjonene ----------
{
    sjekk('påbegynt, ikke sendt inn',
        statusTekst({ Skjema_status: 1 }), 'Mellomlagret');

    sjekk('innsendt, avventer behandling',
        statusTekst({ Skjema_status: 2, Behandling: [{ Steg: 1, Beslutning: 0 }] }), 'Innsendt');

    sjekk('sendt tilbake for korreksjon',
        statusTekst({ Skjema_status: 3 }), 'Til revidering');

    sjekk('behandlet på et steg, går videre',
        statusTekst({ Skjema_status: 2, Behandling: [{ Steg: 1, Beslutning: 1 }, { Steg: 2, Beslutning: 0 }] }),
        'Under behandling');

    sjekk('ferdig behandlet',
        statusTekst({ Skjema_status: 5, Behandling: [{ Steg: 1, Beslutning: 1 }] }), 'Avsluttet');
}

// ---------- avsluttet er avsluttet ----------
{
    // Avslått på siste steg er like avsluttet som innvilget. Utfallet står i
    // beslutningen, ikke i statusen.
    sjekk('avslått er også avsluttet',
        statusTekst({ Skjema_status: 5, Behandling: [{ Steg: 1, Beslutning: 2 }] }), 'Avsluttet');
    // Skjematype uten behandlingssteg går rett til 5 ved innsending.
    sjekk('uten steg: avsluttet', statusTekst({ Skjema_status: 5, Behandling: [] }), 'Avsluttet');
}

// ---------- hoppet steg er ikke behandling ----------
{
    sjekk('hoppet steg teller ikke',
        statusTekst({ Skjema_status: 2, Behandling: [{ Steg: 1, Beslutning: 5 }] }), 'Innsendt');
    sjekk('hoppet + avgjort teller',
        statusTekst({ Skjema_status: 2, Behandling: [{ Steg: 1, Beslutning: 5 }, { Steg: 2, Beslutning: 1 }] }),
        'Under behandling');
}

// ---------- tallet alene ----------
{
    sjekk('bare kode: 1', statusTekstFraKode(1), 'Mellomlagret');
    // «Innsendt» og ikke «Under behandling»: uten Behandling vet vi ikke, og
    // skal ikke late som.
    sjekk('bare kode: 2', statusTekstFraKode(2), 'Innsendt');
    sjekk('bare kode: 3', statusTekstFraKode(3), 'Til revidering');
    sjekk('bare kode: 5', statusTekstFraKode(5), 'Avsluttet');
    sjekk('0 er ukjent', statusTekstFraKode(0), '–');
    // 4 settes aldri av koden. Den sto som etikett i register.html.
    sjekk('4 settes aldri og har ingen tekst', statusTekstFraKode(4), '–');

    sjekk('uten Behandling faller den tilbake',
        statusTekst({ Skjema_status: 2 }), 'Innsendt');
}

// ---------- registerlista: serverens flagg ----------
{
    sjekk('flagget brukes når Behandling mangler',
        statusTekst({ Skjema_status: 2, UnderBehandling: true }), 'Under behandling');
    sjekk('flagget av gir innsendt',
        statusTekst({ Skjema_status: 2, UnderBehandling: false }), 'Innsendt');
    // Behandling vinner når den finnes — den er førstehånds.
    sjekk('Behandling vinner over flagget',
        statusTekst({ Skjema_status: 2, UnderBehandling: true, Behandling: [{ Beslutning: 0 }] }), 'Innsendt');
}

// ---------- samme utledning i begge ender ----------
{
    const tilfeller = [
        { Behandling: [] },
        { Behandling: [{ Beslutning: 0 }] },
        { Behandling: [{ Beslutning: 1 }] },
        { Behandling: [{ Beslutning: 5 }] },
        { Behandling: [{ Beslutning: 5 }, { Beslutning: 2 }] },
        { Behandling: [{ Beslutning: 0 }, { Beslutning: 0 }] },
        {}
    ];
    const ulike = tilfeller.filter(t => {
        const frontend = statusTekst({ ...t, Skjema_status: 2 }) === 'Under behandling';
        return frontend !== behandling.noenStegErBehandlet(t);
    });
    sjekk('frontend og bakende utleder likt', ulike, []);

    // Og serveren må faktisk sende flagget — ellers er registerlista blind.
    const api = utenKommentarer(
        fs.readFileSync(path.join(__dirname, '..', '..', 'api', 'src', 'functions', 'skjemaer.js'), 'utf8'));
    sjekk('lista bærer UnderBehandling',
        /UnderBehandling: noenStegErBehandlet\(s\)/.test(api), true);
}

// ---------- sidene bruker modulen ----------
{
    const frontend = path.join(__dirname, '..');
    for (const [fil, fn] of [
        ['visning.html', 'statusTekst'],
        ['register.html', 'statusTekst'],
        ['rapport.html', 'statusTekstFraKode']
    ]) {
        const kode = utenKommentarer(fs.readFileSync(path.join(frontend, fil), 'utf8'));
        sjekk(`${fil} importerer ${fn}`,
            new RegExp(`import \\{ ${fn} \\} from '\\./js/skjemastatus\\.js'`).test(kode), true);
        sjekk(`${fil} bruker den`, new RegExp(`${fn}\\(`).test(kode.split("import {").pop()), true);
    }
    // rapport.html har BARE tallet — den kan ikke bruke den rike varianten.
    const rapport = utenKommentarer(fs.readFileSync(path.join(frontend, 'rapport.html'), 'utf8'));
    sjekk('rapporten bruker ikke den rike varianten',
        /[^a-zA-Z]statusTekst\(/.test(rapport), false);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
