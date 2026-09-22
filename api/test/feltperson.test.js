/**
 * Feltperson — «send det til adressen innsenderen oppga».
 *
 * Oppføringen «{2-01}» i en personliste blir til en e-postadresse ved
 * innsending. Det høres enkelt ut, men lista den havner i er ikke bare en
 * mottakerliste: `steg.Personer` er også tilgangslista og kravlista for «alle
 * må avgjøre». En feil her endrer hvem som kan behandle et skjema.
 *
 * Fem ting testes, og fire av dem feiler stille:
 *
 *   **Bare hele oppføringen er en referanse.** "sjef-{2-01}@x.no" skal IKKE
 *   løses opp. Tillater vi innfletting, kan innsenderen selv sette sammen
 *   adressen saksdokumentene går til.
 *
 *   **Bare E-post-felter er gyldige.** Typen har syntakssjekk ved utfylling,
 *   og det er den garantien som gjør referansen trygg. Et Tekst-felt som
 *   tilfeldigvis inneholder en adresse avvises også — regelen skal kunne
 *   leses av felttypen alene. Testen står her fordi «den inneholder jo en
 *   adresse, så la den passere» er den intuitive lempningen.
 *
 *   **Verdier som ikke er e-post forkastes likevel.** Typesjekken sier at
 *   feltet skal være kontrollert, ikke at raden i lagringen er det.
 *
 *   **En ubesvart referanse blir BORTE, ikke stående.** Dette er det motsatte
 *   av dynamisk-rolle.js, og det er med vilje: en rollestreng som blir
 *   stående er inert, mens en personoppføring som blir stående gjør at
 *   `sikreBehandler` hopper over steget og at `beregnAlleKrav` får et krav
 *   ingen kan dekke. Testen finnes fordi «behold malen» er den intuitive
 *   løsningen, og den er feil her.
 *
 *   **De fire grunnene til at det ikke ble noen mottaker holdes fra
 *   hverandre.** «Feltet finnes ikke», «feil type», «ubesvart» og «ugyldig
 *   verdi» har hver sin rettelse, og en samlet melding sender skjemaeier til
 *   feil ende.
 *
 *   **Malen tas vare på.** Uten `PersonerMal` ville ompuss + ny innsending
 *   ekspandert fra forrige resultat, og referansen vært borte for godt.
 *
 * Til slutt sjekkes koblingene: at ekspansjonen faktisk kalles ved
 * innsending, før skip-logikken, og at varslingen bruker den.
 *
 * Kjøres med:  node api/test/feltperson.test.js
 */
const fs = require('fs');
const path = require('path');
const { utenKommentarer } = require('../../scripts/test-kilde.js');
const fp = require('../src/lib/feltperson.js');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

function seksjoner(felter) {
    return [{ Seksjon_nummer: 2, Felter: felter }];
}
const EPOSTFELT = (svar, type = 'E-post') => [{ Nummer: 1, Type: type, Svar: svar }];

// ---------- hele oppføringen, ikke en del av den ----------
{
    sjekk('ren referanse gjenkjennes', fp.erFeltreferanse('{2-01}'), true);
    sjekk('mellomrom rundt tåles', fp.erFeltreferanse('  {2-01} '), true);
    sjekk('innfletting gjenkjennes IKKE', fp.erFeltreferanse('sjef-{2-01}@x.no'), false);
    sjekk('adresse er ikke referanse', fp.erFeltreferanse('ola@example.no'), false);
    sjekk('rollestreng er ikke personreferanse', fp.erFeltreferanse('Klassesjef({2-01})'), false);
    sjekk('referansen leses ut', fp.referansen(' {2-01} '), '2-01');

    // Innflettingen skal passere uendret — ikke løses opp, ikke droppes.
    const r = fp.ekspanderPersoner(['sjef-{2-01}@x.no'], seksjoner(EPOSTFELT(['ola@x.no'])));
    sjekk('innfletting går uendret gjennom', r.personer, ['sjef-{2-01}@x.no']);
}

// ---------- e-postregelen ----------
{
    sjekk('vanlig adresse godtas', fp.erEpost('ola.nordmann@example.no'), true);
    sjekk('uten toppdomene avvises', fp.erEpost('ola@kontoret'), false);
    sjekk('to adresser i én verdi avvises', fp.erEpost('a@b.no, c@d.no'), false);
    sjekk('fritekst avvises', fp.erEpost('Ja'), false);
    sjekk('tom avvises', fp.erEpost(''), false);
}

// ---------- bare E-post-felter ----------
{
    sjekk('typelista har ett medlem', fp.GYLDIGE_FELTTYPER, ['E-post']);

    // Et Tekst-felt med en helt gyldig adresse i skal AVVISES. Det er ikke
    // verdien som er kravet, det er typen.
    const tekst = fp.ekspanderPersoner(['{2-01}'], seksjoner(EPOSTFELT(['ola@x.no'], 'Tekst')));
    sjekk('Tekst-felt gir ingen mottaker', tekst.personer, []);
    sjekk('og grunnen nevner typen', /typen «Tekst»/.test(tekst.uloste[0].grunn), true);

    // Flervalg var mulig før innstrammingen og er det ikke lenger.
    const flervalg = [{ Nummer: 1, Type: 'Flervalg-knapper', Svar: ['a@x.no', 'b@x.no'] }];
    sjekk('flervalgsfelt avvises', fp.ekspanderPersoner(['{2-01}'], seksjoner(flervalg)).personer, []);

    // Felt som ikke finnes skilles fra felt med feil type.
    const borte = fp.ekspanderPersoner(['{9-99}'], seksjoner(EPOSTFELT(['a@x.no'])));
    sjekk('manglende felt har sin egen grunn', borte.uloste[0].grunn, 'feltet finnes ikke');
}

// ---------- oppslag og forkasting ----------
{
    const s = seksjoner(EPOSTFELT(['Ola@Example.NO']));
    const r = fp.ekspanderPersoner(['{2-01}'], s);
    sjekk('referansen blir adressen', r.personer, ['ola@example.no']);
    sjekk('ingenting uløst', r.uloste.length, 0);

    const ugyldig = fp.ekspanderPersoner(['{2-01}'], seksjoner(EPOSTFELT(['Ja'])));
    sjekk('ugyldig verdi gir ingen mottaker', ugyldig.personer, []);
    sjekk('og rapporteres som ugyldig', ugyldig.ugyldige[0].verdi, 'Ja');
    sjekk('og som uløst, med grunn',
        ugyldig.uloste[0].grunn, 'ingen gyldig e-postadresse');
}

// ---------- ubesvart forsvinner, og malen blir IKKE stående ----------
{
    const tomt = fp.ekspanderPersoner(['{2-01}', 'fast@x.no'], seksjoner(EPOSTFELT([])));
    sjekk('ubesvart referanse er borte fra lista', tomt.personer, ['fast@x.no']);
    sjekk('malen står ikke igjen', tomt.personer.includes('{2-01}'), false);
    sjekk('grunnen er ubesvart', tomt.uloste[0].grunn, 'ubesvart');

    // Samme, men gjennom stegekspansjonen — det er der konsekvensen ligger.
    const skjema = {
        Seksjoner: seksjoner(EPOSTFELT([])),
        Behandling: [{ Steg: 1, Personer: ['{2-01}'] }]
    };
    fp.ekspanderBehandlingPersoner(skjema);
    sjekk('steget står igjen uten personer', skjema.Behandling[0].Personer, []);
    // Nettopp dette gjør at sikreBehandler ikke hopper over steget.
    sjekk('og telles derfor som «uten behandler»',
        (skjema.Behandling[0].Personer || []).length > 0, false);
}

// ---------- én referanse gir én mottaker ----------
{
    // E-post er ikke en flervalgstype, så placeholder.js kutter etter første
    // verdi. Det er regelen som skal gjelde her også — ikke en egen.
    const enkelt = fp.ekspanderPersoner(['{2-01}'], seksjoner(EPOSTFELT(['a@x.no', 'b@x.no'])));
    sjekk('bare første verdi brukes', enkelt.personer, ['a@x.no']);
}

// ---------- malen tas vare på ----------
{
    const skjema = {
        Seksjoner: seksjoner(EPOSTFELT(['ola@x.no'])),
        Behandling: [{ Steg: 1, Personer: ['{2-01}', 'fast@x.no'] }]
    };
    fp.ekspanderBehandlingPersoner(skjema);
    sjekk('malen lagres', skjema.Behandling[0].PersonerMal, ['{2-01}', 'fast@x.no']);
    sjekk('resultatet er adressene', skjema.Behandling[0].Personer, ['ola@x.no', 'fast@x.no']);

    // Andre gang — som etter ompuss — skal ekspandere fra MALEN, ikke fra
    // forrige resultat. Uten det er referansen borte for godt.
    skjema.Seksjoner = seksjoner(EPOSTFELT(['kari@x.no']));
    fp.ekspanderBehandlingPersoner(skjema);
    sjekk('ny innsending gir ny adresse', skjema.Behandling[0].Personer, ['kari@x.no', 'fast@x.no']);
}

// ---------- steg uten referanser røres ikke ----------
{
    const skjema = { Seksjoner: [], Behandling: [{ Steg: 1, Personer: ['a@x.no'] }] };
    const endret = fp.ekspanderBehandlingPersoner(skjema);
    sjekk('steg uten referanse rapporteres ikke', endret.length, 0);
    sjekk('og får ingen PersonerMal', skjema.Behandling[0].PersonerMal, undefined);
}

// ---------- koblingene ----------
function les(...deler) {
    return utenKommentarer(fs.readFileSync(path.join(__dirname, '..', 'src', ...deler), 'utf8'));
}
{
    const skjemaer = les('functions', 'skjemaer.js');
    sjekk('ekspansjonen kalles ved innsending',
        /feltperson\.ekspanderBehandlingPersoner\(skjemaData\)/.test(skjemaer), true);

    // Rekkefølgen er regelen: skip-logikken og sikreBehandler leser
    // steg.Personer, og en uløst referanse der ville telt som en behandler.
    const iEkspansjon = skjemaer.indexOf('ekspanderBehandlingPersoner');
    const iSkip = skjemaer.indexOf('skipStegSomIkkeSkalKjore(skjemaData)');
    const iSikre = skjemaer.indexOf('sikreBehandler(skjemaData');
    sjekk('ekspansjonen finnes', iEkspansjon > -1, true);
    sjekk('den kommer før skip-logikken', iEkspansjon < iSkip, true);
    sjekk('og før sikreBehandler', iEkspansjon < iSikre, true);

    const varsling = les('lib', 'varsling.js');
    sjekk('løsMottakere ekspanderer personene',
        /feltperson\.ekspanderPersoner\(/.test(varsling), true);
    // Den ekspanderte lista må være den som faktisk brukes — ikke oppsettets.
    sjekk('og bruker resultatet',
        /samleBehandlerMottakere\(\{ Personer: personer, Roller: roller \}\)/.test(varsling), true);
    sjekk('uekspanderte referanser sendes ikke til',
        /feltperson\.erFeltreferanse\(p\)\) continue/.test(varsling), true);

    const diagnose = les('lib', 'skjematype-diagnose.js');
    sjekk('diagnosen sjekker personreferanser', /function sjekkPerson\(/.test(diagnose), true);
    sjekk('manglende felt er rødt', /alvor: 'feil', kode: 'person\.feltref-mangler'/.test(diagnose), true);
    sjekk('feil felttype er rødt', /alvor: 'feil', kode: 'person\.feltref-type'/.test(diagnose), true);
    // Diagnosen må bruke ekspansjonens typeliste, ikke sin egen.
    sjekk('typelista leses fra feltperson',
        /feltperson\.GYLDIGE_FELTTYPER\.includes\(type\)/.test(diagnose), true);
}

// ---------- diagnosen, i praksis ----------
{
    const diagnose = require('../src/lib/skjematype-diagnose.js');
    const ingenOppslag = { antallInnehavere: async () => 1 };

    const def = {
        Seksjoner: [{ Seksjon_nummer: 2, Felter: [
            { Nummer: 1, Type: 'E-post', Tekst: { Verdi: 'Din e-post' } },
            { Nummer: 2, Type: 'Tekst', Tekst: { Verdi: 'Leders navn' } }
        ] }],
        Behandling: [{ Steg: 1, Personer: ['{2-01}', '{2-02}', '{9-99}'], Roller: [] }]
    };
    const koder = (r) => r.funn.map(f => f.kode);

    return diagnose.diagnoser(def, ingenOppslag).then(r => {
        sjekk('e-postfelt gir info', koder(r).includes('person.dynamisk'), true);
        sjekk('tekstfelt gir funn', koder(r).includes('person.feltref-type'), true);
        sjekk('og det er rødt',
            r.funn.find(f => f.kode === 'person.feltref-type').alvor, 'feil');
        sjekk('manglende felt gir feil', koder(r).includes('person.feltref-mangler'), true);

        // Ferdigvarslingen har samme fallgruve og skal ikke være usynlig.
        return diagnose.diagnoser({
            Seksjoner: def.Seksjoner,
            Ferdigvarsling: { Mottakere: { Personer: ['{9-99}'] } }
        }, ingenOppslag);
    }).then(r => {
        sjekk('ferdigvarslingen sjekkes også', koder(r).includes('person.feltref-mangler'), true);
        sjekk('og stedet sier hvor', r.funn[0].sted, 'Ferdigvarsling · mottakere');
        console.log(`\n${ok} OK, ${feil} feil`);
        process.exit(feil ? 1 : 0);
    });
}
