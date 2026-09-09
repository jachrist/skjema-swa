/**
 * Tester for Planner-notatet som HTML.
 *
 * Bakgrunn: Planner lar oss ikke styre hva oppgavekortet viser.
 * `previewType` er dokumentert som skrivbar på plannerTask, men Graph svarer
 * «This field cannot be modified» (prøvd 09.09.2026). Lenka til skjemaet må
 * derfor ligge i beskrivelsen i stedet, og der må den være en ekte `<a>` for
 * å bli klikkbar.
 *
 * To ting er verdt å teste: at brukerens tekst ikke kan brekke ut som markup,
 * og at lenka kommer med selv når noen har skrevet sitt eget notat. Det siste
 * var feil før — lenka lå bare i fallbacken, så den forsvant i det øyeblikket
 * notatfeltet ble tatt i bruk.
 *
 * Kjøres med:  node api/test/varsling-notat.test.js
 */
const v = require('../src/lib/varsling');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const L = 'https://e.net/evaluering.html?skjematype_id=123&skjema_id=6';

// ---------- lenka er alltid med ----------
{
    sjekk('tomt notat gir bare lenka', v.notatSomHtml('', L),
        `<p><a href="https://e.net/evaluering.html?skjematype_id=123&amp;skjema_id=6">Åpne skjemaet</a></p>`);

    const med = v.notatSomHtml('Se vedlegget', L);
    sjekk('notatet kommer først', med.startsWith('<p>Se vedlegget</p>'), true);
    sjekk('og lenka til slutt', med.endsWith('>Åpne skjemaet</a></p>'), true);
}

{
    // Uten lenke er det ingenting å peke på — da skal notatet stå alene.
    sjekk('uten lenke bare notatet', v.notatSomHtml('Bare tekst', ''), '<p>Bare tekst</p>');
    sjekk('verken notat eller lenke', v.notatSomHtml('', ''), '');
    sjekk('bare mellomrom regnes som tomt', v.notatSomHtml('   \n  ', ''), '');
}

// ---------- brukerens tekst kan ikke brekke ut ----------
{
    // Notatfeltet er fritekst i editoren. Uten escaping ville < og > blitt
    // tolket som markup, og en avbrutt tag kunne ødelagt resten av
    // beskrivelsen.
    sjekk('vinkelparenteser escapes',
        v.notatSomHtml('<script>alert(1)</script>', ''),
        '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    sjekk('ampersand escapes', v.notatSomHtml('Ås & Co', ''), '<p>Ås &amp; Co</p>');
    sjekk('anførselstegn escapes', v.notatSomHtml('Han sa "hei"', ''), '<p>Han sa &quot;hei&quot;</p>');
}

{
    // Adressen havner i et attributt. En & i query-strengen må escapes der òg,
    // ellers er HTML-en ugyldig.
    const ut = v.notatSomHtml('', 'https://e.net/a?x=1&y=2');
    sjekk('ampersand i adressen escapes', ut.includes('x=1&amp;y=2'), true);
    sjekk('og ikke dobbelt', ut.includes('&amp;amp;'), false);
}

// ---------- avsnitt og linjeskift ----------
{
    sjekk('enkelt linjeskift blir br',
        v.notatSomHtml('Linje 1\nLinje 2', ''), '<p>Linje 1<br>Linje 2</p>');
    sjekk('blank linje skiller avsnitt',
        v.notatSomHtml('Første\n\nAndre', ''), '<p>Første</p><p>Andre</p>');
    sjekk('CRLF teller likt',
        v.notatSomHtml('Første\r\n\r\nAndre', ''), '<p>Første</p><p>Andre</p>');
    sjekk('flere blanke linjer gir ikke tomme avsnitt',
        v.notatSomHtml('Én\n\n\n\nTo', ''), '<p>Én</p><p>To</p>');
}

// ---------- i payloaden ----------
async function planner() {
    const skjema = { Skjematype_id: '123', Skjema_id: '6', Seksjoner: [] };
    const felles = {
        emne: 'Emne', lenke: L, skjema, behandlere: [],
        log: () => { }, rolleOppslag: async () => []
    };

    {
        const ut = await v.byggPlanner({}, { skjemanavn: 'Test' }, felles);
        sjekk('uten eget notat: ren tekst har lenka', ut.notat.includes(L), true);
        sjekk('og HTML-varianten har en anker', ut.notat_html.includes('<a href='), true);
    }

    {
        // Her lå feilen: skrev man et notat, forsvant lenka helt.
        const medNotat = { PlannerOppgave: { Notater: 'Husk fristen' } };
        const ut = await v.byggPlanner(medNotat, { skjemanavn: 'Test' }, felles);
        sjekk('eget notat beholder lenka i HTML', ut.notat_html.includes('<a href='), true);
        sjekk('og teksten', ut.notat_html.includes('Husk fristen'), true);
        // Ren tekst er urørt, for bakoverkompatibilitet med en flyt som
        // fortsatt skriver til description.
        sjekk('ren tekst er som før', ut.notat, 'Husk fristen');
    }

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
}

planner().catch(e => { console.error('Testen krasjet:', e); process.exit(1); });
