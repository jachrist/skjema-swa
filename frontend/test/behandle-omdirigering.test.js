/**
 * En innsender uten behandleroppgave skal til visningssiden.
 *
 * Innsenderen har tilgang til sin egen sak — `skjemaer.js` gir tilgang til
 * `erInnsender` før behandler-sjekken i det hele tatt kjører, og det er
 * tilsiktet. Men lenken i et behandlervarsel bærer ingen identitet, bare
 * `skjematype_id` og `skjema_id`, så hvem du er avgjøres av SWA-sesjonen.
 * Åpnet innsenderen den, havnet hen på en side som heter «Behandle:», med
 * behandlernes grensesnitt og en dialogboks som sto på «Intern».
 *
 * Den ene saken testen finnes for:
 *
 *   **Er du BÅDE innsender og behandler**, skal du ikke sendes bort fra din
 *   egen oppgave. `tilgangsRolle` svarer «innsender» for deg — den sjekken
 *   kommer først, med vilje, så du ser mindre av den interne dialogen. Brukes
 *   den alene til å bestemme hvor du skal, mister du beslutningsknappen på
 *   din egen sak, og ingenting sier fra om hvorfor.
 *
 * Kjøres med:  node frontend/test/behandle-omdirigering.test.js
 */
const fs = require('fs');
const path = require('path');
const { utenKommentarer } = require('../../scripts/test-kilde.js');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const kilde = fs.readFileSync(path.join(__dirname, '..', 'evaluering.html'), 'utf8');

// Klipp regelen ut av siden og kjør den.
const start = kilde.indexOf('function skalTilVisning(');
sjekk('fant regelen', start !== -1, true);
const slutt = kilde.indexOf('\n        }', start) + '\n        }'.length;
const skalTilVisning = new Function(`${kilde.slice(start, slutt)}\nreturn skalTilVisning;`)();

// ---------- ren innsender ----------
{
    sjekk('innsender uten oppgave', skalTilVisning({ _minRolle: 'innsender', _mineStegNumre: [] }), true);
    sjekk('innsender, feltet mangler helt', skalTilVisning({ _minRolle: 'innsender' }), true);
}

// ---------- innsender som OGSÅ er behandler ----------
{
    // Dette er hele grunnen til at regelen ikke bare er «er innsender».
    sjekk('innsender med aktivt steg blir',
        skalTilVisning({ _minRolle: 'innsender', _mineStegNumre: [2] }), false);
    sjekk('flere steg', skalTilVisning({ _minRolle: 'innsender', _mineStegNumre: [1, 3] }), false);
}

// ---------- alle andre blir ----------
{
    for (const rolle of ['behandler', 'eier', 'admin']) {
        sjekk(`${rolle} blir`, skalTilVisning({ _minRolle: rolle, _mineStegNumre: [] }), false);
    }
    // Mangler feltet (eldre API), omdirigeres ingen: å sende en behandler bort
    // fra behandlingssiden er verre enn å la en innsender se en side hen ikke
    // trenger.
    sjekk('uten _minRolle', skalTilVisning({ _mineStegNumre: [] }), false);
    sjekk('tomt skjema', skalTilVisning({}), false);
    sjekk('uten skjema', skalTilVisning(null), false);
    sjekk('ukjent rolle', skalTilVisning({ _minRolle: 'noe-annet' }), false);
}

// ---------- selve omdirigeringen ----------
{
    const kode = utenKommentarer(kilde);

    sjekk('regelen brukes', /if \(skalTilVisning\(skjema\)\)/.test(kode), true);
    sjekk('går til visning.html', /location\.replace\(\s*`\/visning\.html/.test(kode), true);

    // replace, ikke assign: tilbakeknappen skal ikke sende brukeren inn igjen
    // på siden hen nettopp ble ledet bort fra.
    sjekk('bruker replace', /location\.href\s*=\s*[`'"]\/visning\.html/.test(kode), false);

    // ID-ene må følge med, ellers lander hen på en side uten innhold.
    sjekk('tar med skjematype_id', /visning\.html\?skjematype_id=/.test(kode), true);
    sjekk('tar med skjema_id', /skjema_id=\$\{encodeURIComponent\(skjemaId\)\}/.test(kode), true);

    // Skjer FØR rendrer(): ellers tegnes behandlersiden et øyeblikk først.
    sjekk('omdirigerer før siden tegnes',
        kode.indexOf('skalTilVisning(skjema)') < kode.indexOf('rendrer();'), true);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
