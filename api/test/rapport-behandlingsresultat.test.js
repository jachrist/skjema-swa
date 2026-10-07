/**
 * «Behandlingsresultat» som metadata i rapporter.
 *
 * Ønsket etter at verdivurderingsregisteret kom i produksjon: en rapport må
 * kunne filtrere på hva behandlingen endte med. Statusen (innsendt/avsluttet)
 * svarer ikke på det — «Godkjent», «Avslått» og «Ompuss» er beslutninger på
 * et steg, og rapportmotoren kjente dem ikke.
 *
 * Fire ting testes:
 *
 *   **Utledningen er den samme som alle andre bruker.** `sisteBeslutning` i
 *   datauttrekk.js er den som uttrekket, PDF-en og registerets utfallsfilter
 *   leser. En fjerde tolkning av `Beslutning`-tallet ville før eller siden
 *   gitt en rapport som sa noe annet enn registeret om samme skjema.
 *
 *   **Ubehandlet er tomt, ikke en oppfunnet tekst.** Operatorene `tomt` og
 *   `ikkeTomt` finnes fra før og treffer da riktig — og en eksport inneholder
 *   ikke en verdi ingen har skrevet. Registeret viser «Ikke behandlet» i et
 *   NEDTREKK, som er noe annet: der er det en etikett på et valg, ikke en
 *   verdi i dataene.
 *
 *   **Den virker både som kolonne og som filter.** Det er to ulike veier inn
 *   i `hentMetaVerdi`, og en kilde som bare virker som kolonne er en felle.
 *
 *   **Editoren tilbyr den.** En kilde motoren kjenner, men som ikke står i
 *   nedtrekket, finnes ikke for den som lager rapporten.
 *
 * Kjøres med:  node api/test/rapport-behandlingsresultat.test.js
 */
const fs = require('fs');
const path = require('path');
const { utenKommentarer } = require('../../scripts/test-kilde.js');
const motor = require('../src/lib/rapport-motor');
const { sisteBeslutning } = require('../src/lib/datauttrekk');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const STEG = {
    Steg: 1, Stegnavn: 'Vurdering',
    Beslutningsvalg: [{ Nummer: 1, Tekst: 'Godkjent' }, { Nummer: 2, Tekst: 'Avslått' }, { Nummer: 3, Tekst: 'Ompuss' }]
};
const skjema = (id, beslutning) => ({
    Skjema_id: id, Skjema_status: beslutning ? 5 : 2,
    Behandling: [{ ...STEG, Beslutning: beslutning, BehandletAv: 'dsl@mil.no', BehandletDato: '2026-10-06T10:00:00Z' }]
});
const SPEC = {
    Kolonner: [
        { id: 'id', navn: 'ID', type: 'meta', kilde: 'Skjema_id' },
        { id: 'res', navn: 'Resultat', type: 'meta', kilde: 'Behandlingsresultat' }
    ]
};
const ALLE = [skjema('1', 1), skjema('2', 2), skjema('3', 3), skjema('4', 0), { Skjema_id: '5', Skjema_status: 2 }];
const res = (rader) => rader.map(r => r.verdier.res);

// ---------- som kolonne ----------
{
    const r = motor.kjør(SPEC, ALLE);
    sjekk('alle skjemaer er med', r.rader.length, 5);
    sjekk('teksten fra beslutningsvalget', res(r.rader), ['Godkjent', 'Avslått', 'Ompuss', '', '']);

    // Samme svar som den funksjonen alle andre leser.
    const ulike = ALLE.filter(s =>
        (sisteBeslutning(s)?.tekst || '') !== motor.kjør(SPEC, [s]).rader[0].verdier.res);
    sjekk('samme utledning som sisteBeslutning', ulike, []);
}

// ---------- som filter ----------
{
    const med = (f) => res(motor.kjør({ ...SPEC, Innebygde_filtre: [f] }, ALLE).rader);

    sjekk('eq treffer ett utfall',
        med({ type: 'meta', kilde: 'Behandlingsresultat', operator: 'eq', verdi: 'Godkjent' }), ['Godkjent']);
    // Kasus skal ikke avgjøre — den som skriver filteret har ikke
    // beslutningsvalget foran seg.
    sjekk('kasus spiller ingen rolle',
        med({ type: 'meta', kilde: 'Behandlingsresultat', operator: 'eq', verdi: 'godkjent' }), ['Godkjent']);
    sjekk('in treffer flere',
        med({ type: 'meta', kilde: 'Behandlingsresultat', operator: 'in', verdi: 'Godkjent,Avslått' }),
        ['Godkjent', 'Avslått']);

    // Ubehandlet treffes av `tomt`, som finnes fra før. Derfor trenger ikke
    // dataene en oppfunnet «Ikke behandlet»-verdi.
    sjekk('tomt finner de ubehandlede',
        med({ type: 'meta', kilde: 'Behandlingsresultat', operator: 'tomt' }), ['', '']);
    sjekk('ikkeTomt finner de avgjorte',
        med({ type: 'meta', kilde: 'Behandlingsresultat', operator: 'ikkeTomt' }),
        ['Godkjent', 'Avslått', 'Ompuss']);
}

// ---------- ubehandlet er tomt, ikke en tekst ----------
{
    const kilde = utenKommentarer(
        fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'rapport-motor.js'), 'utf8'));
    sjekk('ingen oppfunnet tekst i motoren', /Ikke behandlet/.test(kilde), false);
    // Og utledningen hentes, ikke gjenskapes.
    sjekk('sisteBeslutning importeres',
        /const \{ sisteBeslutning \} = require\('\.\/datauttrekk'\)/.test(kilde), true);
    sjekk('ingen egen lesing av Beslutning-tallet',
        /Beslutningsvalg[\s\S]{0,80}Nummer/.test(kilde), false);
}

// ---------- editoren tilbyr kilden ----------
{
    const ed = utenKommentarer(
        fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'rapporteditor.html'), 'utf8'));
    sjekk('står i nedtrekket',
        /\{ verdi: 'Behandlingsresultat', tekst: 'Behandlingsresultat' \}/.test(ed), true);

    // Hver kilde editoren tilbyr må motoren kjenne — ellers gir den tomt uten
    // å si fra. Dette er retningen som ryker stille.
    const tilbudte = [...ed.matchAll(/\{ verdi: '([A-Za-z_]+)', tekst: '[^']*' \}/g)]
        .map(m => m[1])
        .filter(v => /^(Skjema_|Innsender_|Opprettet|Sist_endret|Behandlings)/.test(v));
    const ukjente = tilbudte.filter(v => motor.kjør(
        { Kolonner: [{ id: 'x', navn: 'x', type: 'meta', kilde: v }] },
        [{ Skjema_id: '1' }]).rader[0].verdier.x === null);
    sjekk('motoren kjenner alle kildene editoren tilbyr', ukjente, []);
    sjekk('og testen fant faktisk noen', tilbudte.length >= 6, true);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
