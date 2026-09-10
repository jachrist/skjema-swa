/**
 * Tester for vedlegget på Planner-oppgaven.
 *
 * Oppgaven har ett vedlegg: lenka til skjemaet. Skjemaets egne vedlegg lå her
 * fram til 10.09.2026, men ble tatt ut — filene nås gjennom skjemaet lenka
 * peker til, og en lang liste gjorde bare oppgaven vanskeligere å lese.
 * Testene under holder på det: et skjema fullt av vedlegg skal ikke gi mer
 * enn den ene lenka.
 *
 * Det følsomme her er nøkkelkodingen. Graph krever at `%`, `:`, `.` og `@` er
 * prosentkodet i selve nøkkelen, og rekkefølgen er ikke likegyldig: tas ikke
 * `%` først, dobbelkodes de andre. En feil her gir 400 på hele details-kallet,
 * altså ingen oppgavedetaljer i det hele tatt — ikke bare manglende vedlegg.
 *
 * Kjøres med:  node api/test/varsling-vedlegg.test.js
 */
const v = require('../src/lib/varsling');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const skjema = (felter) => ({
    Skjematype_id: '123', Skjema_id: '6',
    Seksjoner: [{ Seksjon_nummer: 1, Felter: felter }]
});

// ---------- Graph-formen ----------
{
    const g = v.vedleggTilGraph([{ filnavn: 'tilbud.pdf', url: 'https://eksempel.net/api/vedlegg-fil/123/6/tilbud.pdf' }]);
    const nokler = Object.keys(g);
    sjekk('én nøkkel', nokler.length, 1);

    // Dette er hele poenget: kolon og punktum må være kodet i nøkkelen.
    sjekk('kolon kodet', nokler[0].includes('%3A'), true);
    sjekk('punktum kodet', nokler[0].includes('%2E'), true);
    sjekk('ingen rå kolon igjen', nokler[0].includes(':'), false);
    sjekk('ingen rått punktum igjen', nokler[0].includes('.'), false);

    const ref = g[nokler[0]];
    sjekk('odata-type', ref['@odata.type'], 'microsoft.graph.plannerExternalReference');
    sjekk('alias er filnavnet', ref.alias, 'tilbud.pdf');
    // previewPriority utelates med vilje — en ugyldig verdi gir 400 på hele
    // kallet, akkurat som orderHint på sjekklistepunktene.
    sjekk('ingen previewPriority', 'previewPriority' in ref, false);
}

{
    // Prosenttegn må kodes FØRST. Gjøres det sist, blir %3A til %253A og
    // adressen peker ingen steder.
    const g = v.vedleggTilGraph([{ filnavn: 'a b.pdf', url: 'https://e.net/f/a%20b.pdf' }]);
    const n = Object.keys(g)[0];
    sjekk('eksisterende prosent dobbelkodes ikke feil', n.includes('%2520'), true);
    sjekk('og gir ikke %25253A', n.includes('%25253A'), false);
}

{
    sjekk('vedlegg uten adresse hoppes over', v.vedleggTilGraph([{ filnavn: 'x.pdf', url: '' }]), {});
    sjekk('tom liste gir tomt kart', v.vedleggTilGraph([]), {});
}

// ---------- typen må være en Graph kjenner ----------
{
    // Graph godtar bare dokumentformatene og «Other». En verdi utenfor settet
    // gir 400 på HELE details-kallet — verken sjekkliste eller referanser
    // kommer fram. «url» så riktig ut og veltet flyten 09.09.2026.
    const g = v.vedleggTilGraph([
        { filnavn: 'Lenke til skjemaet', url: 'https://e.net/evaluering.html?a=1', type: 'url' }
    ]);
    const ref = Object.values(g)[0];
    sjekk('ugyldig type forkastes', ref.type, 'Other');
    sjekk('alias er teksten, ikke adressen', ref.alias, 'Lenke til skjemaet');
}

{
    // Gyldige typer slipper gjennom som oppgitt.
    const g = v.vedleggTilGraph([
        { filnavn: 'notat', url: 'https://e.net/a', type: 'Word' },
        { filnavn: 'ark', url: 'https://e.net/b', type: 'Excel' },
        { filnavn: 'lysark', url: 'https://e.net/c', type: 'PowerPoint' },
        { filnavn: 'annet', url: 'https://e.net/d', type: 'Other' }
    ]);
    sjekk('gyldige typer beholdes', Object.values(g).map(r => r.type),
        ['Word', 'Excel', 'PowerPoint', 'Other']);
}

{
    // Feil kasus er også ugyldig for Graph. Da faller vi til filendelsen —
    // her ingen — og lander på «Other».
    const g = v.vedleggTilGraph([{ filnavn: 'x', url: 'https://e.net/x', type: 'word' }]);
    sjekk('feil kasus forkastes', Object.values(g)[0].type, 'Other');
}

// ---------- typeetiketten ----------
{
    // Pdf ser plausibel ut, men Graph godtar den ikke - se
    // PLANNER_REFERANSETYPER. Feil verdi velter hele details-kallet.
    sjekk('pdf blir Other', v.vedleggstype('a.pdf'), 'Other');
    sjekk('word', v.vedleggstype('a.docx'), 'Word');
    sjekk('excel', v.vedleggstype('a.xlsx'), 'Excel');
    sjekk('powerpoint', v.vedleggstype('a.pptx'), 'PowerPoint');
    sjekk('ukjent blir Other', v.vedleggstype('a.zip'), 'Other');
    sjekk('uten endelse blir Other', v.vedleggstype('vedlegg'), 'Other');
    sjekk('store bokstaver teller likt', v.vedleggstype('A.DOCX'), 'Word');
}

// ---------- byggPlanner sender bare lenka ----------
async function planner() {
    const lenke = 'https://eksempel.net/evaluering.html?a=1';
    const bygg = (s) => v.byggPlanner({}, { skjemanavn: 'Test' }, {
        emne: 'Emne', lenke, skjema: s, behandlere: [], log: () => { },
        rolleOppslag: async () => []
    });

    {
        // Et skjema med vedlegg i to felt og to seksjoner. Ingen av filene
        // skal med — det er hele endringen fra 10.09.2026.
        const s = {
            Skjematype_id: '123', Skjema_id: '6',
            Seksjoner: [
                { Felter: [{ Type: 'Opplasting', Svar: ['tilbud.pdf', 'kontrakt.docx'] }] },
                { Felter: [{ Type: 'Opplasting', Svar: ['skjermbilde.png'] }] }
            ]
        };
        const ut = await bygg(s);
        sjekk('bare skjemalenka i lista', ut.vedlegg.map(x => x.filnavn), ['Lenke til skjemaet']);
        sjekk('lenka peker på skjemaet', ut.vedlegg[0].url, lenke);
        sjekk('og har type Other', ut.vedlegg[0].type, 'Other');

        const ref = Object.values(ut.vedlegg_graph);
        sjekk('kun skjemalenka er referanse', ref.map(r => r.alias), ['Lenke til skjemaet']);
        sjekk('lenka har previewPriority', ref[0].previewPriority, ' !');

        // Skjermbildet var det som kapret oppgavekortet. Ingen av adressene
        // til vedleggsfilene skal finnes noe sted i payloaden.
        sjekk('ingen vedlegg-fil-adresse i payloaden',
            JSON.stringify(ut).includes('vedlegg-fil'), false);
    }

    {
        // Skjema uten vedlegg ser likt ut — lenka står alene der også.
        const ut = await bygg(skjema([{ Type: 'Tekst', Svar: ['x'] }]));
        sjekk('lenka står alene uten vedlegg', ut.vedlegg.map(x => x.filnavn), ['Lenke til skjemaet']);
    }

    {
        // Uten lenke har vi ingenting å peke på. En halv adresse i en oppgave
        // er verre enn ingen.
        const ut = await v.byggPlanner({}, { skjemanavn: 'Test' }, {
            emne: 'Emne', lenke: '', skjema: skjema([{ Type: 'Opplasting', Svar: ['a.pdf'] }]),
            behandlere: [], log: () => { }, rolleOppslag: async () => []
        });
        sjekk('uten lenke sendes ingen vedlegg', ut.vedlegg, []);
        sjekk('og tomt Graph-kart', ut.vedlegg_graph, {});
    }

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
}

planner().catch(e => { console.error('Testen krasjet:', e); process.exit(1); });
