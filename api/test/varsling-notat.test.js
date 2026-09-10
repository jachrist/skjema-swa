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

// ---------- adresser blir lenker ----------
{
    // Feltet lover i editoren at «adresser blir klikkbare». Det er den
    // eneste maaten aa faa en lenke inn i notatet paa, saa den maa taale at
    // adressen staar midt i en setning.
    const A = 'https://e.net/a?x=1&y=2';

    sjekk('adressen blir en anker',
        v.notatSomHtml(`Se ${A} her`, ''),
        '<p>Se <a href="https://e.net/a?x=1&amp;y=2">https://e.net/a?x=1&amp;y=2</a> her</p>');

    // Her laa feilen: medLenker kjoerte paa den ESCAPEDE linja, saa
    // hermetegnet var allerede blitt &quot; — som ikke inneholder noe ", og
    // dermed ble spist av adressemoensteret sammen med alt som fulgte.
    sjekk('adresse i anfoerselstegn stopper ved hermetegnet',
        v.notatSomHtml(`Se "${A}" her`, ''),
        '<p>Se &quot;<a href="https://e.net/a?x=1&amp;y=2">https://e.net/a?x=1&amp;y=2</a>&quot; her</p>');

    // Punktum som avslutter setningen hoerer ikke til adressen.
    sjekk('punktum faller utenfor lenka',
        v.notatSomHtml(`Se ${A}.`, ''),
        '<p>Se <a href="https://e.net/a?x=1&amp;y=2">https://e.net/a?x=1&amp;y=2</a>.</p>');
    sjekk('komma ogsaa',
        v.notatSomHtml(`Se ${A}, og les`, ''),
        '<p>Se <a href="https://e.net/a?x=1&amp;y=2">https://e.net/a?x=1&amp;y=2</a>, og les</p>');

    sjekk('parentes faller utenfor lenka',
        v.notatSomHtml(`Se (${A})`, ''),
        '<p>Se (<a href="https://e.net/a?x=1&amp;y=2">https://e.net/a?x=1&amp;y=2</a>)</p>');

    // Escapingen skal fortsatt gjelde teksten rundt.
    sjekk('markup rundt adressen escapes fortsatt',
        v.notatSomHtml(`<b>Se</b> ${A}`, ''),
        '<p>&lt;b&gt;Se&lt;/b&gt; <a href="https://e.net/a?x=1&amp;y=2">https://e.net/a?x=1&amp;y=2</a></p>');

    // To adresser paa samme linje skal begge bli lenker.
    const to = v.notatSomHtml(`${A} og https://e.net/b`, '');
    sjekk('to adresser gir to ankere', (to.match(/<a href=/g) || []).length, 2);

    // Notatet peker allerede et sted, saa skjemalenka skal ikke foeyes til.
    sjekk('eget notat med adresse faar ikke lenka i tillegg',
        (v.notatSomHtml(`Se ${A}`, L).match(/<a href=/g) || []).length, 1);
}

// ---------- Markdown-lenke gir egen lenketekst ----------
{
    const A = 'https://e.net/a?x=1&y=2';

    // Uten denne formen sto valget mellom en lang, uleselig adresse midt i
    // beskrivelsen, eller raa HTML i et felt som escaper alt. Det siste ble
    // proevd paa dev 10.09.2026 og kom ut som synlig markup i Planner.
    sjekk('markdown-lenke gir egen tekst',
        v.notatSomHtml(`[Bruk denne lenka](${A})`, ''),
        '<p><a href="https://e.net/a?x=1&amp;y=2">Bruk denne lenka</a></p>');

    sjekk('midt i en setning',
        v.notatSomHtml(`Husk fristen. [Aapne](${A}) naar du er klar.`, ''),
        '<p>Husk fristen. <a href="https://e.net/a?x=1&amp;y=2">Aapne</a> naar du er klar.</p>');

    // Lenketeksten er brukerens, og skal escapes som all annen tekst.
    sjekk('markup i lenketeksten escapes',
        v.notatSomHtml(`[<b>Hei</b>](${A})`, ''),
        '<p><a href="https://e.net/a?x=1&amp;y=2">&lt;b&gt;Hei&lt;/b&gt;</a></p>');

    // Bare http og https. Adressen havner i en href vi selv bygger, og et
    // fritekstfelt skal ikke kunne faa javascript: eller data: inn dit.
    for (const d of ['javascript:alert(1)', 'data:text/html,<script>', 'ftp://e.net/a', '/lokal/sti']) {
        sjekk(`avvist protokoll staar som tekst: ${d}`,
            v.notatSomHtml(`[Klikk](${d})`, '').startsWith('<p>[Klikk]('), true);
    }

    // Notatet peker allerede et sted, saa skjemalenka skal ikke foeyes til.
    sjekk('markdown-lenke teller som en adresse',
        (v.notatSomHtml(`[Aapne](${A})`, L).match(/<a href=/g) || []).length, 1);

    // Begge formene skal kunne staa i samme notat.
    const blandet = v.notatSomHtml(`[Aapne](${A}) eller https://e.net/b`, '');
    sjekk('markdown og naken adresse side om side',
        (blandet.match(/<a href=/g) || []).length, 2);
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
