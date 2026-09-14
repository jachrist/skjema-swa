/**
 * Tester for loggendepunktet flytene skriver til, og nøkkelen som slipper dem inn.
 *
 * To invarianter, begge med en grunn:
 *
 * `flytType` setter «flyt.»-prefiks på alt som skrives utenfra. Uten det kunne
 * en flyt skrive Type: 'utsending.send-forfalte' og legge seg midt blant
 * hendelsene appen selv skriver — og da er revisjonssporet ikke lenger til å
 * stole på.
 *
 * `harFlytNokkel` hasher før sammenligningen. Da er lengdene alltid like,
 * timingSafeEqual kan brukes uten å kreve like lange nøkler, og svartiden
 * røper ikke lengden på den riktige nøkkelen.
 *
 * Kjøres med:  node api/test/flyt-logg.test.js
 */
const { flytType } = require('../src/lib/hendelser-storage');
const { harFlytNokkel } = require('../src/lib/auth');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

// ---------- typen kan ikke utgi seg for å være appens egen ----------
{
    sjekk('vanlig type får prefiks', flytType('test'), 'flyt.test');
    sjekk('tom blir flyt.info', flytType(''), 'flyt.info');
    sjekk('utelatt blir flyt.info', flytType(undefined), 'flyt.info');
    sjekk('bare mellomrom blir flyt.info', flytType('   '), 'flyt.info');

    // Dette er poenget: en flyt skal ikke kunne skrive seg inn som appen.
    sjekk('kan ikke utgi seg for en systemhendelse',
        flytType('utsending.send-forfalte'), 'flyt.utsending.send-forfalte');
    sjekk('og ikke ved å ta med prefikset selv',
        flytType('flyt.test').startsWith('flyt.'), true);
}

{
    // Tegn som kunne forstyrret et filter eller en visning byttes ut.
    sjekk('mellomrom og store bokstaver', flytType('Test Kjøring'), 'flyt.test-kj-ring');
    sjekk('skråstrek overlever ikke', flytType('a/b').includes('/'), false);
    sjekk('anførselstegn heller ikke', flytType('a"b').includes('"'), false);
    sjekk('lengden er begrenset', flytType('x'.repeat(200)).length <= 65, true);
}

// ---------- nøkkelen ----------
const req = (verdi) => ({ headers: { get: (n) => (n === 'x-flow-key' ? verdi : null) } });
const medNokkel = (konfigurert, fn) => {
    const foer = process.env.FLOW_CALLBACK_KEY;
    process.env.FLOW_CALLBACK_KEY = konfigurert;
    try { return fn(); } finally {
        if (foer === undefined) delete process.env.FLOW_CALLBACK_KEY;
        else process.env.FLOW_CALLBACK_KEY = foer;
    }
};

const NOKKEL = 'en-lang-nok-delt-hemmelighet-0123456789';

{
    sjekk('riktig nøkkel slipper inn', medNokkel(NOKKEL, () => harFlytNokkel(req(NOKKEL)).ok), true);

    // Power Automate legger lett på et linjeskift når verdien kommer fra en
    // variabel eller en Compose. Det skal ikke være forskjellen på inn og ute.
    sjekk('linjeskift trimmes bort', medNokkel(NOKKEL, () => harFlytNokkel(req(`${NOKKEL}\n`)).ok), true);
    sjekk('mellomrom rundt likeså', medNokkel(NOKKEL, () => harFlytNokkel(req(`  ${NOKKEL}  `)).ok), true);
}

{
    sjekk('feil nøkkel avvises', medNokkel(NOKKEL, () => harFlytNokkel(req('feil')).ok), false);

    // Ulik lengde skal ikke kaste — det var grunnen til å hashe først.
    sjekk('mye kortere nøkkel avvises pent',
        medNokkel(NOKKEL, () => harFlytNokkel(req('x')).ok), false);
    sjekk('mye lengre også',
        medNokkel(NOKKEL, () => harFlytNokkel(req('x'.repeat(5000))).ok), false);

    sjekk('tom header avvises', medNokkel(NOKKEL, () => harFlytNokkel(req('')).ok), false);
    sjekk('manglende header avvises', medNokkel(NOKKEL, () => harFlytNokkel(req(null)).ok), false);
    sjekk('request uten headers avvises', medNokkel(NOKKEL, () => harFlytNokkel({}).ok), false);
}

{
    // Uten konfigurert nøkkel slipper INGEN inn — heller ikke den som sender
    // tom header. Ellers ville et miljø uten nøkkel vært vidåpent.
    sjekk('uten FLOW_CALLBACK_KEY: ingen slipper inn',
        medNokkel('', () => harFlytNokkel(req(NOKKEL)).ok), false);
    sjekk('og grunnen sier hvorfor',
        medNokkel('', () => harFlytNokkel(req(NOKKEL)).grunn), 'FLOW_CALLBACK_KEY er ikke satt på serveren');
}

{
    // Grunnen er til logg og feilmelding, og skal ikke røpe den riktige verdien.
    const g = medNokkel(NOKKEL, () => harFlytNokkel(req('feil')).grunn);
    sjekk('grunnen røper ikke nøkkelen', g.includes(NOKKEL), false);
    sjekk('og ikke lengden på den', /\d/.test(g), false);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
