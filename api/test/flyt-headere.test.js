/**
 * Tester for avsenderheaderen på utgående flyt-kall.
 *
 * Signaturen i flyt-URL-en (`sig=`) var eneste sperre fram til 14.09.2026.
 * Den som fikk tak i adressen kunne sende en hvilken som helst payload — og
 * siden e-postteksten bygges av felter i payloaden, betyr det en melding som
 * ser ut til å komme fra skjemasystemet, med en lenke til hva som helst. At
 * mottakeren ikke får opp et ekte skjema hjelper lite; verdien for en angriper
 * ligger i avsenderinntrykket.
 *
 * To egenskaper testes, og de trekker i hver sin retning:
 *
 *   Er nøkkelen satt, SKAL den med — ellers har flyten ingenting å sjekke.
 *   Er den ikke satt, skal kallet se ut som før — ellers ville en flyt som
 *   ennå ikke sjekker headeren kunne brekke på utrulling.
 *
 * `flytHeadere()` ble `async` 16.10.2026, da `Authorization` kom til. Her
 * holdes `FLYT_AUTH` usatt, slik at bare nøkkelen prøves — Bearer-delen har
 * sin egen test i `api/test/flyt-auth.test.js`.
 *
 * Kjøres med:  node api/test/flyt-headere.test.js
 */
let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const sti = require.resolve('../src/lib/flyt-kaller');
async function medNokkel(verdi) {
    const foer = process.env.FLOW_CALLBACK_KEY;
    const foerAuth = process.env.FLYT_AUTH;
    delete process.env.FLYT_AUTH;
    if (verdi === undefined) delete process.env.FLOW_CALLBACK_KEY;
    else process.env.FLOW_CALLBACK_KEY = verdi;
    delete require.cache[sti];
    try { return await require(sti).flytHeadere(); } finally {
        if (foer === undefined) delete process.env.FLOW_CALLBACK_KEY;
        else process.env.FLOW_CALLBACK_KEY = foer;
        if (foerAuth === undefined) delete process.env.FLYT_AUTH;
        else process.env.FLYT_AUTH = foerAuth;
        delete require.cache[sti];
    }
}

async function main() {

// ---------- nøkkelen er satt ----------
{
    sjekk('headeren er med', await medNokkel('en-delt-hemmelighet'), {
        'Content-Type': 'application/json',
        'x-flow-key': 'en-delt-hemmelighet'
    });

    // Power Automate legger lett på et linjeskift når verdien kommer fra en
    // variabel. Vi trimmer, slik at vår side aldri er grunnen til at en
    // sammenligning på flytens side feiler.
    sjekk('trimmes', (await medNokkel('  hemmelig\n'))['x-flow-key'], 'hemmelig');
}

// ---------- nøkkelen mangler ----------
{
    // Ingen tom header: en flyt som sjekker «finnes headeren» ville sluppet
    // gjennom en tom streng, og da er sperra verre enn ingen.
    for (const v of [undefined, '', '   ']) {
        sjekk(`uten nøkkel: som før (${JSON.stringify(v)})`,
            await medNokkel(v), { 'Content-Type': 'application/json' });
    }
}

{
    // Content-Type skal alltid med — flytene tar imot JSON.
    sjekk('content-type alltid satt', (await medNokkel('x'))['Content-Type'], 'application/json');
    sjekk('og uten nøkkel også', (await medNokkel(undefined))['Content-Type'], 'application/json');
}

// Uten FLYT_AUTH skal det ikke ligge noen Authorization-header der. En flyt
// som ikke venter et token skal ikke få et.
{
    for (const v of ['en-delt-hemmelighet', undefined]) {
        sjekk(`ingen Authorization uten FLYT_AUTH (${JSON.stringify(v)})`,
            'Authorization' in (await medNokkel(v)), false);
    }
}

}

main().then(() => {
    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
}).catch((e) => { console.log('TESTEN KRASJET:', e.stack); process.exit(1); });
