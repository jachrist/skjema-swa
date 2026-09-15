/**
 * Av/på-bryteren for varslingskall.
 *
 * `VARSLING_DEAKTIVERT` er en tørrkjøringsbryter: står den på, bygges hele
 * payloaden og logges, men ingenting sendes. Regelen fantes i fire kopier —
 * to i flyt-kaller.js, én i ekstern-flyt.js og én i sp-liste.js — og fire
 * kopier av en av/på-bryter er fire sjanser til at de svarer forskjellig.
 * Utslaget hadde vært det verste slaget: noen kanaler sender, andre ikke.
 *
 * Nå er det én funksjon, og /api/varsling/diag svarer med resultatet av
 * SAMME funksjon. Det er det som gjør at banneret i admin ikke kan si
 * «sender» mens koden tørrkjører.
 *
 * Testen holder på den ene egenskapen som betyr noe: bare 'true' slår av.
 * En verdi som `1` eller `ja` ser ut som «på» for et menneske, men koden
 * sender da — og det er tryggere enn det motsatte, så lenge det er kjent.
 *
 * Kjøres med:  node api/test/varsling-av.test.js
 */
let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const { varslingAv } = require('../src/lib/flyt-kaller');

function med(verdi) {
    const foer = process.env.VARSLING_DEAKTIVERT;
    if (verdi === undefined) delete process.env.VARSLING_DEAKTIVERT;
    else process.env.VARSLING_DEAKTIVERT = verdi;
    try { return varslingAv(); } finally {
        if (foer === undefined) delete process.env.VARSLING_DEAKTIVERT;
        else process.env.VARSLING_DEAKTIVERT = foer;
    }
}

// ---------- slår av ----------
sjekk('true', med('true'), true);
sjekk('TRUE', med('TRUE'), true);
sjekk('True', med('True'), true);
sjekk('mellomrom rundt', med('  true  '), true);

// ---------- sender ----------
sjekk('false', med('false'), false);
sjekk('tom', med(''), false);
sjekk('usatt', med(undefined), false);
sjekk('1 er ikke true', med('1'), false);
sjekk('ja er ikke true', med('ja'), false);
sjekk('truthy tekst', med('deaktivert'), false);

// ---------- de andre modulene bruker samme bryter ----------
// Lastes uten node_modules: begge er med i den rene logikk-kjøringen, og en
// require som drar inn en Azure-SDK ville brutt den.
{
    const ekstern = require('../src/lib/ekstern-flyt');
    const sp = require('../src/lib/sp-liste');
    sjekk('ekstern-flyt lastet', typeof ekstern === 'object', true);
    sjekk('sp-liste lastet', typeof sp === 'object', true);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
