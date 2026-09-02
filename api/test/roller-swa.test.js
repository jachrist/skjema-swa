/**
 * Tester for rollekilden SWA kaller ved innlogging.
 *
 * Rollen «admin» i staticwebapp.config.json er en SWA-rolle. Den har ingenting
 * med ADMIN_UPNS å gjøre før dette endepunktet knytter dem sammen — og uten
 * det har ingen rollen, så ruter som krever den er stengt for alle. Det skjedde
 * 02.09.2026: da konfigurasjonen omsider trådte i kraft, ble /admin.html
 * utilgjengelig også for administratorene.
 *
 * Den motsatte feilen er verre: gir denne funksjonen «admin» til feil person,
 * åpnes admin-panelet for dem. Derfor testes begge retninger.
 *
 * Kjøres med:  node api/test/roller-swa.test.js
 */
let modul = null;
try { modul = require('../src/functions/roller-swa'); } catch (_) { /* uten @azure/functions */ }

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

if (!modul?._rollerFor) {
    console.log('(hopper over — @azure/functions ikke installert)');
    console.log('\n0 OK, 0 feil, 1 hoppet over');
    process.exit(0);
}
const rollerFor = modul._rollerFor;

const før = process.env.ADMIN_UPNS;
process.env.ADMIN_UPNS = 'sjef@fhs.no, nestsjef@fhs.no';

// ---------- admin får rollen ----------
{
    sjekk('admin', rollerFor({ userDetails: 'sjef@fhs.no' }), ['admin']);
    sjekk('andre admin i lista', rollerFor({ userDetails: 'nestsjef@fhs.no' }), ['admin']);
    // erAdmin sammenligner i lowercase — innlogging kan gi hvilken som helst kasus.
    sjekk('ulik kasus', rollerFor({ userDetails: 'Sjef@FHS.no' }), ['admin']);
}

// ---------- alle andre får ingenting ----------
{
    sjekk('vanlig bruker', rollerFor({ userDetails: 'kari@fhs.no' }), []);
    sjekk('tom userDetails', rollerFor({ userDetails: '' }), []);
    sjekk('userDetails mangler', rollerFor({}), []);
    sjekk('ingen payload', rollerFor(null), []);
    sjekk('undefined', rollerFor(undefined), []);
}

// ---------- ingen snarveier inn ----------
{
    // Delstrenger og lignende adresser skal ikke treffe.
    sjekk('prefiks er ikke nok', rollerFor({ userDetails: 'sjef@fhs.no.example.com' }), []);
    sjekk('suffiks er ikke nok', rollerFor({ userDetails: 'ikke-sjef@fhs.no' }), []);
    sjekk('tom liste i env', (() => {
        const gammel = process.env.ADMIN_UPNS;
        process.env.ADMIN_UPNS = '';
        const r = rollerFor({ userDetails: 'sjef@fhs.no' });
        process.env.ADMIN_UPNS = gammel;
        return r;
    })(), []);
}

// ---------- klienten bestemmer ikke ----------
{
    // Payloaden kommer fra SWA-plattformen, men skulle den bli manipulert,
    // er det bare userDetails som teller — ikke noe felt som sier «roles».
    sjekk('oppgitte roller ignoreres',
        rollerFor({ userDetails: 'kari@fhs.no', roles: ['admin'], userRoles: ['admin'] }), []);
    sjekk('claims ignoreres',
        rollerFor({ userDetails: 'kari@fhs.no', claims: [{ typ: 'roles', val: 'admin' }] }), []);
}

if (før === undefined) delete process.env.ADMIN_UPNS; else process.env.ADMIN_UPNS = før;

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
