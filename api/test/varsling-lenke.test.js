/**
 * Tester for hvilken side en varslingslenke peker til.
 *
 * Behandlere skal til evaluering.html, der beslutningen tas. Innsenderen skal
 * ikke dit: kvitteringen er en bekreftelse, ikke en oppgave, og evaluering.html
 * gir dessuten ingen tilgang for den som bare har sendt inn — mottakeren møter
 * en tom side eller en avvisning.
 *
 * Feilen er lett å gjeninnføre, for lenka bygges av samme funksjon i alle
 * varslingene og standardverdien er behandlersiden.
 *
 * Kjøres med:  node api/test/varsling-lenke.test.js
 */
const { _skjemaLenke: skjemaLenke } = require('../src/lib/varsling');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    if (faktisk === forventet) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${faktisk}\n      forventet ${forventet}`); }
}

const før = process.env.SWA_URL;
process.env.SWA_URL = 'https://eksempel.net';

// ---------- standard er behandlersiden ----------
{
    sjekk('uten side-argument', skjemaLenke('7', '42', null),
        'https://eksempel.net/evaluering.html?skjematype_id=7&skjema_id=42');
}

// ---------- kvitteringen peker til sin egen side ----------
{
    sjekk('kvittering', skjemaLenke('7', '42', null, 'kvittering.html'),
        'https://eksempel.net/kvittering.html?skjematype_id=7&skjema_id=42');
    sjekk('visning', skjemaLenke('7', '42', null, 'visning.html'),
        'https://eksempel.net/visning.html?skjematype_id=7&skjema_id=42');
}

// ---------- parameternavn må matche sidene ----------
{
    // Sidene leser skjematype_id og skjema_id. Endres navnene her, får
    // mottakeren en side uten innhold og ingen feilmelding.
    const l = skjemaLenke('7', '42', null, 'kvittering.html');
    sjekk('har skjematype_id', l.includes('skjematype_id=7'), true);
    sjekk('har skjema_id', l.includes('skjema_id=42'), true);
}

// ---------- id-er escapes ----------
{
    sjekk('spesialtegn escapes', skjemaLenke('a b', 'x&y', null, 'kvittering.html'),
        'https://eksempel.net/kvittering.html?skjematype_id=a%20b&skjema_id=x%26y');
}

// ---------- uten base_url ----------
{
    delete process.env.SWA_URL;
    // Tom lenke er riktig: en halv URL i en e-post er verre enn ingen.
    sjekk('ingen base gir tom lenke', skjemaLenke('7', '42', null, 'kvittering.html'), '');
}

if (før === undefined) delete process.env.SWA_URL; else process.env.SWA_URL = før;

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
