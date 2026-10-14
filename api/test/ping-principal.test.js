/**
 * Diagnosen i /api/ping: kom innloggingen fram?
 *
 * Tre tilstander ser like ut utenfra når innlogging svikter — headeren kom
 * ikke, headeren kom men lot seg ikke lese, eller den kom og var tom. Et 403
 * kan ikke skille dem. Derfor svarer ping alltid, med årsaken i feltet.
 *
 * To ting testes, og den andre er den viktigste:
 *
 *   **Alle feltene settes alltid.** `JSON.stringify` dropper `undefined`, og
 *   et felt som kan forsvinne kan ikke feilsøkes — da er «det gikk galt»
 *   umulig å skille fra «koden er ikke deployet».
 *
 *   **Ingen UPN og ingen rollenavn slipper ut.** Endepunktet er anonymt. Det
 *   skal svare på OM innloggingen nådde fram, ikke på hvem du er. Lekker det
 *   en e-postadresse, har diagnosen gjort skade i stedet for nytte.
 *
 * Kjøres med:  node api/test/ping-principal.test.js
 */
const fs = require('fs');
const path = require('path');
const { hentEksport } = require('../../scripts/test-kilde.js');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const kilde = fs.readFileSync(path.join(__dirname, '..', 'src', 'functions', 'ping.js'), 'utf8');
const principalDiagnose = hentEksport(kilde, 'principalDiagnose');

/** En request-stub med den headeren SWA ville satt. */
function req(headerVerdi) {
    return { headers: { get: (n) => (n === 'x-ms-client-principal' ? headerVerdi : null) } };
}
const base64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');

const UPN = 'ola.nordmann@example.no';
const EKTE = base64({
    identityProvider: 'aad', userId: 'abc', userDetails: UPN,
    userRoles: ['anonymous', 'authenticated', 'admin']
});

const FELTER = ['headerMottatt', 'kunneLeses', 'harUpn', 'antallRoller', 'merknad'];

// ---------- alle feltene, alltid ----------
{
    const tilfeller = {
        'ingen header': req(null),
        'ugyldig base64': req('%%%ikke-base64%%%'),
        'gyldig base64, ikke JSON': req(Buffer.from('ikke json', 'utf8').toString('base64')),
        'JSON uten userDetails': req(base64({ userRoles: ['anonymous'] })),
        'ekte principal': req(EKTE),
        'request uten headers': {}
    };
    for (const [navn, r] of Object.entries(tilfeller)) {
        const d = principalDiagnose(r);
        const mangler = FELTER.filter(f => d[f] === undefined);
        sjekk(`${navn}: ingen felt mangler`, mangler, []);
        // JSON.stringify dropper undefined — sjekk at ingenting faller ut i
        // praksis heller, ikke bare i objektet.
        sjekk(`${navn}: overlever JSON.stringify`,
            Object.keys(JSON.parse(JSON.stringify(d))).sort(), [...FELTER].sort());
        sjekk(`${navn}: merknaden sier noe`, typeof d.merknad === 'string' && d.merknad.length > 15, true);
    }
}

// ---------- de fire utfallene ----------
{
    sjekk('ingen header', principalDiagnose(req(null)).headerMottatt, false);
    sjekk('request uten headers i det hele tatt', principalDiagnose({}).headerMottatt, false);

    const uleselig = principalDiagnose(req(Buffer.from('ikke json', 'utf8').toString('base64')));
    sjekk('uleselig: kom fram', uleselig.headerMottatt, true);
    sjekk('uleselig: kunne ikke leses', uleselig.kunneLeses, false);

    const tom = principalDiagnose(req(base64({ userRoles: ['anonymous'] })));
    sjekk('tom: kom fram og ble lest', [tom.headerMottatt, tom.kunneLeses], [true, true]);
    sjekk('tom: men ingen upn', tom.harUpn, false);

    const ekte = principalDiagnose(req(EKTE));
    sjekk('ekte: alt på plass', [ekte.headerMottatt, ekte.kunneLeses, ekte.harUpn], [true, true, true]);
    sjekk('ekte: teller roller', ekte.antallRoller, 3);
}

// ---------- ingenting om HVEM ----------
//
// Den viktigste sjekken her. Endepunktet er anonymt, og svaret skal ikke bære
// en e-postadresse eller et rollenavn ut til den som spør.
{
    const d = principalDiagnose(req(EKTE));
    const tekst = JSON.stringify(d);
    sjekk('ingen UPN i svaret', tekst.includes(UPN), false);
    sjekk('ingen del av UPN-en heller', tekst.toLowerCase().includes('ola'), false);
    sjekk('ingen rollenavn', tekst.includes('admin') || tekst.includes('authenticated'), false);
    // Antallet er med vilje — det skiller «ingen roller tildelt» fra
    // «rollene kom fram», uten å si hvilke.
    sjekk('men antallet er med', typeof d.antallRoller, 'number');
}

// ---------- ping svarer fortsatt det den gjorde før ----------
//
// Diagnosen er et tillegg. Forsvinner byggstempelet eller miljøet, er den
// opprinnelige nytten borte — og den er grunnen til at ping finnes.
{
    sjekk('ping svarer med bygg', /bygg,?$|bygg,/m.test(kilde), true);
    sjekk('ping svarer med miljø', /miljø: process\.env\.MILJO/.test(kilde), true);
    sjekk('ping er fortsatt anonym', /authLevel: 'anonymous'/.test(kilde), true);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
