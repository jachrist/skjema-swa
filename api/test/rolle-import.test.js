/**
 * Importplanen: hva en rollefil faktisk eier.
 *
 * `lagPlan` hadde ingen test i det hele tatt, og det var ikke tilfeldig:
 * modulen gjorde `require('xlsx')` på toppnivå, så den lot seg ikke laste uten
 * `node_modules`. Regelen med mest konsekvens i hele importen var dermed den
 * eneste som aldri ble kjørt i en test. Pakka lastes nå lat, slik storage.js
 * gjør det.
 *
 * Feilen testen finnes for: fila var fasiten for HELE tabellen. Alt med
 * `Kilde: 'import'` som ikke sto i fila ble foreslått fjernet, uansett rolle.
 * En fil med fire «Ansatt FOSK»-rader foreslo derfor å slette 22
 * «Bransjeveileder(...)»-rader fra en tidligere import. Stempelet skiller
 * importert fra manuelt, men sier ingenting om hvilken rolle raden hører til.
 *
 * Fem ting testes:
 *
 *   **Fila eier bare gruppene den nevner.** Det er rettelsen, og den gjengir
 *   det faktiske tilfellet fra 05.10.2026.
 *
 *   **Gruppa er (Rolle, Omfang).** `roller-storage.js` sier at en rolle ER den
 *   kombinasjonen, og lista viser dem som `Bransjeveileder(LOG 24-27)`. En fil
 *   for ett omfang skal ikke rydde i et annet.
 *
 *   **Importen rydder fortsatt i sitt eget.** En rettelse som bare slutter å
 *   slette, ville gjort importen ute av stand til å fjerne noen som har
 *   sluttet — og det er halve poenget med den.
 *
 *   **Manuelle rader står urørt.** Også når de er med i fila. Stempelet er
 *   hele vernet til klassesjefene, som ikke finnes i FS.
 *
 *   **Nøkkelen skiller rader som ligner.** «Ansatt FOSK» uten omfang og
 *   «Ansatt» med omfanget «FOSK» er to ulike rader.
 *
 * Kjøres med:  node api/test/rolle-import.test.js
 */
const fs = require('fs');
const path = require('path');
const { utenKommentarer } = require('../../scripts/test-kilde.js');
const imp = require('../src/lib/rolle-import.js');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const r = (Rolle, Omfang, UPN, ekstra = {}) => ({ Rolle, Omfang, UPN, ...ekstra });
const vis = (rader) => rader.map(x => `${x.Rolle}${x.Omfang ? '(' + x.Omfang + ')' : ''} ${x.UPN}`).sort();

// ---------- det faktiske tilfellet ----------
{
    // Lista slik den sto: fire importerte Bransjeveileder-rader på tre omfang,
    // og én gammel Ansatt FOSK.
    const eksisterende = [
        r('Bransjeveileder', 'LOG 24-27', 'famuller@mil.no', { Kilde: 'import' }),
        r('Bransjeveileder', 'MM 23-26', 'croed@mil.no', { Kilde: 'import' }),
        r('Bransjeveileder', 'MILSIK 24-27', 'jivarsen@mil.no', { Kilde: 'import' }),
        r('Ansatt FOSK', '', 'sluttet@mil.no', { Kilde: 'import' })
    ];
    // Fila inneholder BARE Ansatt FOSK.
    const fila = [
        r('Ansatt FOSK', '', 'tthunshelle@mil.no'),
        r('Ansatt FOSK', '', 'nonordli@mil.no')
    ];
    const p = imp.lagPlan(fila, eksisterende);

    sjekk('de nye legges til', vis(p.leggTil), ['Ansatt FOSK nonordli@mil.no', 'Ansatt FOSK tthunshelle@mil.no']);
    // Dette er feilen: her sto alle tre Bransjeveileder-radene før.
    sjekk('bare den utgåtte i samme rolle fjernes', vis(p.fjern), ['Ansatt FOSK sluttet@mil.no']);
    sjekk('ingen Bransjeveileder røres',
        p.fjern.some(x => x.Rolle === 'Bransjeveileder'), false);
    sjekk('området er oppgitt', p.grupper, [{ Rolle: 'Ansatt FOSK', Omfang: '' }]);
}

// ---------- gruppa er (Rolle, Omfang) ----------
{
    const eksisterende = [
        r('Bransjeveileder', 'LOG 24-27', 'famuller@mil.no', { Kilde: 'import' }),
        r('Bransjeveileder', 'LOG 25-28', 'vmeyer@mil.no', { Kilde: 'import' }),
        r('Bransjeveileder', 'MM 23-26', 'croed@mil.no', { Kilde: 'import' })
    ];
    // Fila dekker ett omfang, og bytter innehaver der.
    const p = imp.lagPlan([r('Bransjeveileder', 'LOG 24-27', 'ny@mil.no')], eksisterende);

    sjekk('den nye kommer inn', vis(p.leggTil), ['Bransjeveileder(LOG 24-27) ny@mil.no']);
    sjekk('den gamle i samme omfang går ut', vis(p.fjern), ['Bransjeveileder(LOG 24-27) famuller@mil.no']);
    sjekk('andre omfang av samme rolle står',
        p.fjern.filter(x => x.Omfang !== 'LOG 24-27'), []);
    sjekk('området er ett omfang', p.grupper, [{ Rolle: 'Bransjeveileder', Omfang: 'LOG 24-27' }]);
}

// ---------- importen rydder fortsatt i sitt eget ----------
{
    // Uten dette kunne rettelsen vært «slett aldri», og da ville en som har
    // sluttet blitt stående som behandler for alltid.
    const eksisterende = [
        r('Emneansvarlig', 'CBU2501', 'sluttet@mil.no', { Kilde: 'import' }),
        r('Emneansvarlig', 'CBU2501', 'blir@mil.no', { Kilde: 'import' })
    ];
    const p = imp.lagPlan([r('Emneansvarlig', 'CBU2501', 'blir@mil.no')], eksisterende);
    sjekk('den utgåtte fjernes', vis(p.fjern), ['Emneansvarlig(CBU2501) sluttet@mil.no']);
    sjekk('den som blir, blir', vis(p.uendret), ['Emneansvarlig(CBU2501) blir@mil.no']);
    sjekk('ingenting legges til', p.leggTil, []);
}

// ---------- manuelle rader står urørt ----------
{
    const eksisterende = [
        r('Ansatt FOSK', '', 'klassesjef@mil.no', { Kilde: 'manuell' }),
        // Uten Kilde i det hele tatt skal også regnes som manuell.
        r('Ansatt FOSK', '', 'gammelrad@mil.no'),
        r('Ansatt FOSK', '', 'importert@mil.no', { Kilde: 'import' })
    ];
    const p = imp.lagPlan([r('Ansatt FOSK', '', 'ny@mil.no')], eksisterende);

    sjekk('manuelle fjernes ikke', vis(p.fjern), ['Ansatt FOSK importert@mil.no']);

    // Er en manuell rad OGSÅ i fila, blir den stående som manuell — å adoptere
    // den ville latt en senere import slette noe et menneske la inn.
    const p2 = imp.lagPlan(
        [r('Ansatt FOSK', '', 'klassesjef@mil.no'), r('Ansatt FOSK', '', 'ny@mil.no')],
        eksisterende);
    sjekk('fila adopterer ikke en manuell rad', vis(p2.manuelle), ['Ansatt FOSK klassesjef@mil.no']);
    sjekk('og den legges ikke til på nytt',
        p2.leggTil.some(x => x.UPN === 'klassesjef@mil.no'), false);
}

// ---------- nøkkelen skiller rader som ligner ----------
{
    // Med mellomrom som skilletegn ble disse to nøyaktig samme nøkkel:
    // «Ansatt» + «FOSK 24-27» og «Ansatt FOSK» + «24-27» gir begge
    // «Ansatt FOSK 24-27».
    const A = r('Ansatt', 'FOSK 24-27', 'a@mil.no');
    const B = r('Ansatt FOSK', '24-27', 'a@mil.no');
    sjekk('rolle med mellomrom vs. omfang', imp.nokkelFor(A) === imp.nokkelFor(B), false);
    sjekk('gruppene er også ulike', imp.gruppeFor(A) === imp.gruppeFor(B), false);

    // UPN er ikke versalfølsomt — lista lagrer små bokstaver.
    sjekk('UPN er ikke versalfølsomt',
        imp.nokkelFor(r('Rolle', '', 'A@MIL.NO')), imp.nokkelFor(r('Rolle', '', 'a@mil.no')));

    // Og de to blandes ikke i en plan heller.
    const p = imp.lagPlan([B], [{ ...A, Kilde: 'import' }]);
    sjekk('ulike roller: ingen fjernes', p.fjern, []);
    sjekk('ulike roller: den nye legges til', vis(p.leggTil), ['Ansatt FOSK(24-27) a@mil.no']);
}

// ---------- tom fil og tom liste ----------
{
    // En tom plan skal ikke foreslå å tømme tabellen. (Serveren avviser en fil
    // uten gyldige rader før den kommer hit, men regelen skal holde av seg
    // selv.)
    const p = imp.lagPlan([], [r('Rolle', '', 'a@mil.no', { Kilde: 'import' })]);
    sjekk('tom fil fjerner ingenting', p.fjern, []);
    sjekk('tom fil eier ingen grupper', p.grupper, []);

    const p2 = imp.lagPlan([r('Rolle', '', 'a@mil.no')], []);
    sjekk('tom liste: alt er nytt', vis(p2.leggTil), ['Rolle a@mil.no']);
}

// ---------- oppdatering av navn ----------
{
    const eksisterende = [r('Rolle', '', 'a@mil.no', { Kilde: 'import', FN: 'Ola', EN: 'Nordmann' })];
    const uendret = imp.lagPlan([r('Rolle', '', 'a@mil.no', { FN: 'Ola', EN: 'Nordmann' })], eksisterende);
    sjekk('likt navn gir uendret', [uendret.uendret.length, uendret.oppdater.length], [1, 0]);

    const endret = imp.lagPlan([r('Rolle', '', 'a@mil.no', { FN: 'Ola', EN: 'Hansen' })], eksisterende);
    sjekk('nytt etternavn gir oppdatering', [endret.uendret.length, endret.oppdater.length], [0, 1]);
    sjekk('og ikke en sletting', endret.fjern, []);
}

// ---------- området vises før admin bekrefter ----------
{
    // «Fjerner 22» er umulig å vurdere uten å vite hva importen HAR LOV til å
    // røre. Planen regner det ut; her sjekkes at tallet faktisk når fram.
    const rot = path.join(__dirname, '..', '..');
    const api = utenKommentarer(fs.readFileSync(path.join(rot, 'api', 'src', 'functions', 'roller.js'), 'utf8'));
    sjekk('serveren sender gruppene', /grupper: plan\.grupper,/.test(api), true);
    sjekk('og teller dem i sammendraget', /grupper: plan\.grupper\.length/.test(api), true);

    const admin = utenKommentarer(fs.readFileSync(path.join(rot, 'frontend', 'admin.html'), 'utf8'));
    sjekk('forhåndsvisningen viser området', /rollerImportOmrade\(r\.grupper\)/.test(admin), true);
    sjekk('funksjonen finnes', /function rollerImportOmrade\(/.test(admin), true);
    sjekk('den sier at resten står', /røres ikke/.test(admin), true);
    // Hjelpeteksten påsto at importen eide alt den hadde lagt inn. Den
    // påstanden var sann, og det var feilen.
    sjekk('hjelpeteksten nevner avgrensningen',
        /eier bare sine egne rader, i de rollene fila nevner/.test(admin), true);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
