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
 * Kjøres med:  node api/test/flyt-headere.test.js
 */
let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const sti = require.resolve('../src/lib/flyt-kaller');
function medNokkel(verdi) {
    const foer = process.env.FLOW_CALLBACK_KEY;
    if (verdi === undefined) delete process.env.FLOW_CALLBACK_KEY;
    else process.env.FLOW_CALLBACK_KEY = verdi;
    delete require.cache[sti];
    try { return require(sti).flytHeadere(); } finally {
        if (foer === undefined) delete process.env.FLOW_CALLBACK_KEY;
        else process.env.FLOW_CALLBACK_KEY = foer;
        delete require.cache[sti];
    }
}

// ---------- nøkkelen er satt ----------
{
    sjekk('headeren er med', medNokkel('en-delt-hemmelighet'), {
        'Content-Type': 'application/json',
        'x-flow-key': 'en-delt-hemmelighet'
    });

    // Power Automate legger lett på et linjeskift når verdien kommer fra en
    // variabel. Vi trimmer, slik at vår side aldri er grunnen til at en
    // sammenligning på flytens side feiler.
    sjekk('trimmes', medNokkel('  hemmelig\n')['x-flow-key'], 'hemmelig');
}

// ---------- nøkkelen mangler ----------
{
    // Ingen tom header: en flyt som sjekker «finnes headeren» ville sluppet
    // gjennom en tom streng, og da er sperra verre enn ingen.
    for (const v of [undefined, '', '   ']) {
        sjekk(`uten nøkkel: som før (${JSON.stringify(v)})`,
            medNokkel(v), { 'Content-Type': 'application/json' });
    }
}

{
    // Content-Type skal alltid med — flytene tar imot JSON.
    sjekk('content-type alltid satt', medNokkel('x')['Content-Type'], 'application/json');
    sjekk('og uten nøkkel også', medNokkel(undefined)['Content-Type'], 'application/json');
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
