/**
 * Bryter per beslutningsvalg: skal innsenderen varsles?
 *
 * Brukerønske fra skjemaer med flere behandlingssteg: innsenderen skal ikke
 * høre fra oss ved hver delbeslutning, bare ved den endelige. Fram til
 * 05.10.2026 var eneste valg standardmelding eller egen melding — aldri
 * «ingen».
 *
 * Fire ting testes, og det første er en sikring og ikke en preferanse:
 *
 *   **Ompuss varsler ALLTID.** Et skjema som sendes tilbake for retting uten
 *   at noen får beskjed, blir liggende til evig tid: innsenderen vet ikke at
 *   ballen er hos hen, og behandleren venter på et svar som aldri kommer.
 *   Bryteren kan ikke slå av den meldingen, og editoren lar den ikke prøve.
 *
 *   **Standard er å varsle.** Skjematyper laget før bryteren fantes har ikke
 *   feltet, og skal oppføre seg som før.
 *
 *   **«På» lagres som fravær av feltet.** En skjematype der bryteren aldri er
 *   rørt, og en der den er slått av og på igjen, skal se like ut i JSON.
 *
 *   **Lagringen hopper faktisk over kallet.** En bryter som bare endrer
 *   avkryssingsboksen er ingen bryter.
 *
 * Kjøres med:  node frontend/test/varsle-innsender.test.js
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

// ---------- regelen ----------
{
    const v = behandling.skalVarsleInnsender;
    sjekk('standard er å varsle', v({ Nummer: 1, Tekst: 'Godkjent' }), true);
    sjekk('eksplisitt på', v({ VarsleInnsender: true }), true);
    sjekk('eksplisitt av', v({ VarsleInnsender: false }), false);
    sjekk('manglende valg varsler', v(null), true);

    // Sikringen. Står den ikke her, er den ikke noe sted.
    sjekk('ompuss varsler alltid', v({ Handling: 'ompuss', VarsleInnsender: false }), true);
    sjekk('ompuss uten bryter varsler', v({ Handling: 'ompuss' }), true);
}

// ---------- lagringen hopper over kallet ----------
{
    const api = utenKommentarer(
        fs.readFileSync(path.join(__dirname, '..', '..', 'api', 'src', 'functions', 'skjemaer.js'), 'utf8'));
    sjekk('beslutningsvarslingen er betinget',
        /if \(skalVarsleInnsender\(valgtValg\)\) \{\s*varslinger\.push\(varsling\.sendBeslutningVarsling\(/.test(api), true);
    // Ferdigvarslingen er en annen melding og skal IKKE slås av av denne
    // bryteren — det er nettopp den innsenderen skal få når alt er ferdig.
    const etter = api.slice(api.indexOf('skalVarsleInnsender(valgtValg)'));
    sjekk('ferdigvarslingen er ikke berørt',
        /varslinger\.push\(varsling\.sendFerdigVarsling\(/.test(etter), true);
    // Og behandlervarslingen til NESTE steg skal gå uansett.
    sjekk('neste steg varsles uansett',
        /varslinger\.push\(varsling\.sendVarslingAktiveSteg\(/.test(etter), true);
}

// ---------- editoren ----------
{
    const editor = utenKommentarer(
        fs.readFileSync(path.join(__dirname, '..', 'editor.html'), 'utf8'));
    sjekk('editor.html ble lest', editor.length > 50000, true);

    sjekk('bryteren finnes', /onchange="setBeslutningsvalgVarsle\(\$\{idx\}, \$\{vIdx\}, this\.checked\)"/.test(editor), true);
    // «På» skal lagres som fravær av feltet.
    sjekk('på lagres som fravær', /if \(pa\) delete valg\.VarsleInnsender;/.test(editor), true);
    sjekk('av lagres eksplisitt', /else valg\.VarsleInnsender = false;/.test(editor), true);

    // Ompuss: boksen er avkrysset og låst.
    sjekk('ompuss låser bryteren', /\$\{erOmpuss \? 'disabled' : ''\}/.test(editor), true);
    sjekk('og den vises som på', /const varsler = erOmpuss \|\| v\.VarsleInnsender !== false;/.test(editor), true);
    // Blir et valg gjort om til ompuss, må dataene ryddes — ellers viser
    // boksen «på» mens JSON-en sier false.
    sjekk('bytte til ompuss rydder bryteren', /if \(v === 'ompuss'\) delete valg\.VarsleInnsender;/.test(editor), true);

    // Meldingsknappen skal ikke invitere til å redigere en melding som ikke sendes.
    sjekk('meldingsknappen deaktiveres når varsling er av',
        /\$\{varsler \? '' : 'disabled/.test(editor), true);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
