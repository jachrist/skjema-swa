/**
 * Utfallet av en varsling skal alltid sette spor.
 *
 * To steder sender varslinger: beslutningsveien og innsendingsveien i
 * `functions/skjemaer.js`. De gjorde det ULIKT.
 *
 * Beslutningsveien ble rettet en gang, med denne begrunnelsen i koden:
 * «allSettled i stedet for all: resultatene ble kastet før, så en varsling
 * som ble hoppet over etterlot seg ingen spor.»
 *
 * Innsendingsveien beholdt `Promise.all(...).catch(...)`. Den fanger bare en
 * REJECT — og `kallVarslingFlyt` kaster ikke; den returnerer
 * `{ status: 'feil' }`. Et kall som ble hoppet over, tørrkjørt eller feilet
 * ved innsending etterlot seg derfor ingenting i det hele tatt.
 *
 * 16.10.2026 ble en flyt ikke kalt i dev, og loggen var helt tom. Diagnosen
 * sa at alt var i orden — den svarer på «ville den sendt NÅ», ikke på «hva
 * skjedde den gangen». Uten et spor fra den gangen er de to umulige å skille.
 *
 * Testen holder tre ting:
 *
 *   **Hjelperen logger hvert utfall som ikke er `ok`**, også når funksjonen
 *   returnerte en liste (det gjør `sendVarslingAktiveSteg`).
 *
 *   **Begge veiene bruker den samme hjelperen.** Ikke to kodeblokker som
 *   gjør omtrent det samme — det var nettopp det som drev fra hverandre.
 *
 *   **Et lagret skjema som ikke varsler noen, sier det.** Den tause tredje
 *   saken: `gikkTilBehandling` er usann, og før sto det ingenting i loggen.
 *
 * Kjøres med:  node api/test/varsling-utfall.test.js
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

const rot = path.join(__dirname, '..', '..');
const les = (...p) => fs.readFileSync(path.join(rot, ...p), 'utf8');

// Den EKTE funksjonen, hentet ut av modulen som produserer den.
const { loggVarslingsutfall } = require('../src/lib/varsling');

async function samle(varslinger, merkelapp = 'test') {
    const linjer = [];
    await loggVarslingsutfall(varslinger, (m) => linjer.push(m), merkelapp);
    return linjer;
}

async function main() {

// ---------- 1. hvert utfall som ikke er ok ----------
{
    sjekk('ok logges ikke', await samle([Promise.resolve({ status: 'ok' })]), []);

    sjekk('hoppet-over logges',
        await samle([Promise.resolve({ status: 'hoppet-over', melding: 'Ingen mottakere' })]),
        ['varsling (test): hoppet-over — Ingen mottakere']);

    sjekk('deaktivert logges',
        await samle([Promise.resolve({ status: 'deaktivert' })]),
        ['varsling (test): deaktivert']);

    sjekk('feil logges',
        await samle([Promise.resolve({ status: 'feil', melding: 'HTTP 401' })]),
        ['varsling (test): feil — HTTP 401']);

    // sendVarslingAktiveSteg returnerer en LISTE, ett utfall per steg. Uten
    // utpakkingen her ville den aldri logget noe — og det er den som sender
    // behandlervarslingen.
    sjekk('liste pakkes ut',
        await samle([Promise.resolve([
            { status: 'ok' },
            { status: 'hoppet-over', melding: 'Ingen mottakere' },
            { status: 'feil', melding: 'HTTP 500' }
        ])]),
        ['varsling (test): hoppet-over — Ingen mottakere', 'varsling (test): feil — HTTP 500']);

    // En avvist promise er noe annet enn et utfall, og skal ses som det.
    sjekk('reject logges',
        await samle([Promise.reject(new Error('alt gikk galt'))]),
        ['varsling (test): FEIL — alt gikk galt']);

    // Én som feiler skal ikke skjule de andre. Det var hele forskjellen på
    // `all` og `allSettled`.
    sjekk('en som feiler skjuler ikke resten',
        await samle([
            Promise.reject(new Error('først')),
            Promise.resolve({ status: 'feil', melding: 'så' }),
            Promise.resolve({ status: 'ok' })
        ]),
        ['varsling (test): FEIL — først', 'varsling (test): feil — så']);

    // Merkelappen skiller de to veiene fra hverandre i loggen.
    sjekk('merkelappen er med',
        (await samle([Promise.resolve({ status: 'feil' })], 'innsending'))[0],
        'varsling (innsending): feil');
}

// ---------- 2. den kaster aldri ----------
//
// Logging skal aldri velte en innsending. Alt under er former som har dukket
// opp fra ekte kallere.
{
    let kastet = null;
    try {
        await samle([
            Promise.resolve(null),
            Promise.resolve(undefined),
            Promise.resolve('en streng'),
            Promise.resolve([null, { status: 'feil' }]),
            Promise.reject('ikke en Error')
        ]);
    } catch (e) { kastet = e.message; }
    sjekk('kaster ikke på rare returverdier', kastet, null);

    // Heller ikke når selve log-funksjonen er ødelagt.
    let kastet2 = null;
    try {
        await loggVarslingsutfall([Promise.resolve({ status: 'feil' })], () => { throw new Error('logg nede'); }, 'x');
    } catch (e) { kastet2 = e.message; }
    sjekk('kaster ikke når loggingen selv feiler', kastet2, null);
}

// ---------- 3. begge veiene bruker den ----------
{
    const kode = utenKommentarer(les('api', 'src', 'functions', 'skjemaer.js'));

    sjekk('to kall til hjelperen',
        (kode.match(/varsling\.loggVarslingsutfall\(/g) || []).length, 2);
    sjekk('begge merkelappene finnes',
        /'beslutning'\)/.test(kode) && /'innsending'\)/.test(kode), true);

    // `Promise.all` på varslinger er nettopp formen som svelget utfallene.
    // `Promise.allSettled` hører hjemme i varsling.js, ikke her.
    sjekk('ingen Promise.all på varslinger i skjemaer.js',
        /Promise\.all\(/.test(kode), false);
    sjekk('og ingen egen allSettled-blokk heller',
        /Promise\.allSettled\(/.test(kode), false);

    // Hjelperen finnes ett sted.
    const varslingKode = utenKommentarer(les('api', 'src', 'lib', 'varsling.js'));
    sjekk('hjelperen bruker allSettled', /Promise\.allSettled\(/.test(varslingKode), true);
}

// ---------- 4. den tause tredje saken ----------
//
// Et lagret skjema som IKKE gikk til behandling varsler ingen. Før sto det
// ingenting i loggen om det, og «jeg lagret, og det kom ingen e-post» var
// ikke til å skille fra «kallet feilet».
{
    const kode = utenKommentarer(les('api', 'src', 'functions', 'skjemaer.js'));
    sjekk('ingen-varsling sier fra', /lagring: ingen varsling/.test(kode), true);
    // Med begge statusene i seg — ellers sier linja ikke hvorfor.
    const m = /lagring: ingen varsling[\s\S]{0,300}?\);/.exec(kode);
    sjekk('fant linja', !!m, true);
    // BEGGE statusene, navngitt hver for seg. En sjekk på bare «Skjema_status»
    // var grønn da den nåværende ble fjernet — den forrige inneholder jo det
    // samme ordet.
    sjekk('den har statusen nå',
        /skjemaKlartekst\.Skjema_status/.test(m?.[0] || ''), true);
    sjekk('og den forrige', /eksisterende\?\.Skjema_status/.test(m?.[0] || ''), true);
    sjekk('og om det var en innsending', /erInnsending/.test(m?.[0] || ''), true);

    // Og innsendingsveien sier hva den er i ferd med å gjøre, ikke bare hva
    // som gikk galt. En tom logg skal bety «koden kjørte ikke», ikke «den
    // kjørte og sa ingenting».
    sjekk('innsendingen logger at den varsler', /innsending: varsler \$\{/.test(kode), true);
}

}

main().then(() => {
    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
}).catch((e) => { console.log('TESTEN KRASJET:', e.stack); process.exit(1); });
