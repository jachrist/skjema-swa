/**
 * Tester for hvem som kan lese en systeminnstilling.
 *
 * Gevinsttekstene vises i editoren for alle som eier en skjematype, men lå bak
 * en admin-sjekk. Editoren svelger 403-en med `.catch(() => null)`, så en
 * skjemaskaper uten admin fikk «Ikke konfigurert ennå» på noe som var
 * konfigurert — feilen så ut som manglende data, ikke som manglende tilgang.
 *
 * Åpningen er en allowlist, ikke et prefiks. SystemInnstillinger er et
 * generelt nøkkel/verdi-lager, og neste nøkkel som legges der skal kreve admin
 * uten at noen må huske å tenke på det. Derfor tester vi like mye på hva som
 * IKKE er åpent.
 *
 * Kjøres med:  node api/test/innstillinger-lesetilgang.test.js
 */
let modul = null;
try { modul = require('../src/functions/innstillinger'); } catch (_) { /* uten @azure/functions */ }

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

if (!modul?._kanLese) {
    console.log('(hopper over — @azure/functions ikke installert)');
    console.log('\n0 OK, 0 feil, 1 hoppet over');
    process.exit(0);
}
const { _kanLese: kanLese, _LESBARE_FOR_INNLOGGEDE: åpne } = modul;

// erAdmin leser ADMIN_UPNS. Vi setter en kjent admin og bruker en annen
// adresse for den vanlige brukeren.
const før = process.env.ADMIN_UPNS;
process.env.ADMIN_UPNS = 'sjef@fhs.no';

const ADMIN = { 'x-ms-client-principal': Buffer.from(JSON.stringify({ userDetails: 'sjef@fhs.no' })).toString('base64') };
const BRUKER = { 'x-ms-client-principal': Buffer.from(JSON.stringify({ userDetails: 'kari@fhs.no' })).toString('base64') };

function req(headers) {
    const h = new Map(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    return { headers: { get: (n) => h.get(String(n).toLowerCase()) ?? null } };
}

// ---------- innlogging kreves uansett ----------
{
    sjekk('uinnlogget avvises', kanLese(req(), 'Gevinstestimat.Tekst').status, 401);
    sjekk('uinnlogget på admin-nøkkel', kanLese(req(), 'Noe.Hemmelig').status, 401);
}

// ---------- gevinstnøklene er åpne for innloggede ----------
{
    for (const n of ['Gevinstestimat.Tekst', 'Gevinstestimat.SkjemaId',
        'Gevinstrapportering.Tekst', 'Gevinstrapportering.SkjemaId']) {
        sjekk(`vanlig bruker kan lese ${n}`, kanLese(req(BRUKER), n).ok, true);
    }
}

// ---------- alt annet krever fortsatt admin ----------
{
    sjekk('ukjent nøkkel avvises', kanLese(req(BRUKER), 'Noe.Annet').status, 403);
    // Prefiks-treff skal ikke holde — allowlista er eksakte nøkler.
    sjekk('prefiks holder ikke', kanLese(req(BRUKER), 'Gevinstestimat.Hemmelig').status, 403);
    sjekk('tom nøkkel avvises', kanLese(req(BRUKER), '').status, 403);
    sjekk('undefined avvises', kanLese(req(BRUKER), undefined).status, 403);
}

// ---------- admin leser alt ----------
{
    sjekk('admin på ukjent nøkkel', kanLese(req(ADMIN), 'Noe.Annet').ok, true);
    sjekk('admin på gevinstnøkkel', kanLese(req(ADMIN), 'Gevinstestimat.Tekst').ok, true);
}

// ---------- lista skal holdes kort ----------
{
    // Vokser denne, er det verdt et blikk på om det fortsatt er riktig at
    // nøklene er lesbare for alle innloggede.
    sjekk('bare gevinstnøklene er åpne', [...åpne].sort(), [
        'Gevinstestimat.SkjemaId', 'Gevinstestimat.Tekst',
        'Gevinstrapportering.SkjemaId', 'Gevinstrapportering.Tekst'
    ]);
}

if (før === undefined) delete process.env.ADMIN_UPNS; else process.env.ADMIN_UPNS = før;

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
