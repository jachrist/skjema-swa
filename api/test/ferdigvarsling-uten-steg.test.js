/**
 * Ferdigvarslingen sendes også for skjematyper uten behandlingssteg.
 *
 * Fram til 26.11.2026 ble den holdt tilbake når skjematypen ikke hadde
 * steg, med kvitteringens Kopi som kanalen der. Editoren lot den likevel
 * slås på, uten å si fra, og den som hadde slått den på fikk ingenting.
 *
 * Testen leser innsendingsveien i skjemaer.js og krever at
 * ferdigvarslingen bare avhenger av at skjemaet ble ferdig ved innsending.
 * `sendFerdigVarsling` sjekker selv om den er slått på.
 *
 * Kjøres med:  node api/test/ferdigvarsling-uten-steg.test.js
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

const kilde = utenKommentarer(fs.readFileSync(path.join(__dirname, '..', 'src', 'functions', 'skjemaer.js'), 'utf8'));
const start = kilde.indexOf('const bleFerdigVedInnsending');
const blokk = kilde.slice(start, kilde.indexOf('startBakgrunnsjobb', start));
sjekk('innsendingsveien finnes', start > 0 && blokk.length > 0, true);

const m = /\.\.\.\(([^?]+)\?\s*\[varsling\.sendFerdigVarsling\(/.exec(blokk);
sjekk('ferdigvarslingen sendes ved innsending', !!m, true);
sjekk('og vilkåret er bare at skjemaet ble ferdig', (m?.[1] || '').trim(), 'bleFerdigVedInnsending');

// Om den er slått på, avgjør sendFerdigVarsling selv — den skal ikke sende
// når Aktiv ikke er true.
const varsling = require('../src/lib/varsling');
varsling.sendFerdigVarsling({ Skjema_id: '1', Skjematype_id: '9' }, { Ferdigvarsling: { Aktiv: false } })
    .then((r) => {
        sjekk('avslått ferdigvarsling sendes ikke', r.status, 'hoppet-over');
        return varsling.sendFerdigVarsling({ Skjema_id: '1', Skjematype_id: '9' }, {});
    })
    .then((r) => {
        sjekk('manglende ferdigvarsling sendes ikke', r.status, 'hoppet-over');
        console.log(`\n${ok} OK, ${feil} feil`);
        process.exit(feil ? 1 : 0);
    })
    .catch((e) => { console.log('FEIL  testen kastet:', e.message); process.exit(1); });
