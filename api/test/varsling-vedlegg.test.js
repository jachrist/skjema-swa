/**
 * Tester for vedlegg på Planner-oppgaven.
 *
 * Bakgrunn: en feltreferanse til et vedleggsfelt ga bare filnavnet — og siden
 * Opplasting ikke er en flervalgstype, ble fil nummer to og tre kuttet uten et
 * ord. Behandleren måtte innom skjemaet uansett.
 *
 * Nå sendes vedleggene med oppgaven, både i lesbar form og i den formen Graph
 * vil ha dem på `PATCH /planner/tasks/{id}/details`.
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

const BASE = 'https://eksempel.net';
const skjema = (felter) => ({
    Skjematype_id: '123', Skjema_id: '6',
    Seksjoner: [{ Seksjon_nummer: 1, Felter: felter }]
});

// ---------- alle filene tas med ----------
{
    const s = skjema([
        { Nummer: '01', Type: 'Tekst', Svar: ['noe'] },
        { Nummer: '02', Type: 'Opplasting', Svar: ['tilbud.pdf', 'kontrakt.docx'] }
    ]);
    const ut = v.vedleggFraSkjema(s, BASE);
    sjekk('begge filene med', ut.map(x => x.filnavn), ['tilbud.pdf', 'kontrakt.docx']);
    sjekk('adressen peker på nedlastingsendepunktet', ut[0].url,
        'https://eksempel.net/api/vedlegg-fil/123/6/tilbud.pdf');
}

{
    // Flere vedleggsfelt i samme skjema skal alle med.
    const s = {
        Skjematype_id: '1', Skjema_id: '2',
        Seksjoner: [
            { Felter: [{ Type: 'Opplasting', Svar: ['a.pdf'] }] },
            { Felter: [{ Type: 'Opplasting', Svar: ['b.pdf'] }] }
        ]
    };
    sjekk('på tvers av seksjoner', v.vedleggFraSkjema(s, BASE).map(x => x.filnavn), ['a.pdf', 'b.pdf']);
}

// ---------- ingen vedlegg ----------
{
    sjekk('skjema uten vedleggsfelt', v.vedleggFraSkjema(skjema([{ Type: 'Tekst', Svar: ['x'] }]), BASE), []);
    sjekk('ubesvart vedleggsfelt', v.vedleggFraSkjema(skjema([{ Type: 'Opplasting', Svar: [] }]), BASE), []);
    sjekk('tomt filnavn hoppes over', v.vedleggFraSkjema(skjema([{ Type: 'Opplasting', Svar: ['', '  '] }]), BASE), []);
    sjekk('tomt skjema', v.vedleggFraSkjema(null, BASE), []);
}

// ---------- filnavn med tegn som må kodes ----------
{
    const s = skjema([{ Type: 'Opplasting', Svar: ['Tilbud fra Ås & Co.pdf'] }]);
    const ut = v.vedleggFraSkjema(s, BASE);
    sjekk('filnavnet er URL-kodet i adressen',
        ut[0].url.endsWith('/Tilbud%20fra%20%C3%85s%20%26%20Co.pdf'), true);
    sjekk('men står ukodet i alias', ut[0].filnavn, 'Tilbud fra Ås & Co.pdf');
}

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

// ---------- byggPlanner tar dem med ----------
async function planner() {
    const s = skjema([{ Type: 'Opplasting', Svar: ['tilbud.pdf'] }]);
    const ut = await v.byggPlanner({}, { skjemanavn: 'Test' }, {
        emne: 'Emne', lenke: 'https://eksempel.net/evaluering.html?a=1',
        skjema: s, behandlere: [], log: () => { }, rolleOppslag: async () => []
    });
    // Skjemalenka ligger først. Hensikten er at den skal vises på
    // oppgavekortet uten at noen må åpne oppgaven, så rekkefølgen er ikke
    // kosmetikk — den er hele poenget med at den er med.
    sjekk('skjemalenka først, så vedleggene',
        ut.vedlegg.map(x => x.filnavn), ['Lenke til skjemaet', 'tilbud.pdf']);
    sjekk('lenka peker på skjemaet', ut.vedlegg[0].url, 'https://eksempel.net/evaluering.html?a=1');
    sjekk('og har type Other', ut.vedlegg[0].type, 'Other');
    sjekk('bare lenka i Graph-form', Object.keys(ut.vedlegg_graph).length, 1);

    // ---------- vedleggene holdes UTE av references ----------
    {
        // De laa her til aa begynne med, men Planner velger selv hva kortet
        // viser og foretrekker et bilde. Et skjermbilde blant vedleggene
        // kapret dermed kortet, og lenka ble liggende usett. Med bare lenka
        // som referanse er det ingenting aa kapre.
        const ref = Object.values(ut.vedlegg_graph);
        sjekk('kun skjemalenka er referanse', ref.map(r => r.alias), ['Lenke til skjemaet']);
        sjekk('men vedlegget staar fortsatt i lista',
            ut.vedlegg.map(x => x.filnavn), ['Lenke til skjemaet', 'tilbud.pdf']);
        sjekk('lenka har previewPriority', ref[0].previewPriority, ' !');
    }

    // ---------- skjema uten vedlegg ----------
    {
        const tomt = await v.byggPlanner({}, { skjemanavn: 'Test' }, {
            emne: 'Emne', lenke: 'https://eksempel.net/evaluering.html?a=1',
            skjema: skjema([{ Type: 'Tekst', Svar: ['x'] }]),
            behandlere: [], log: () => { }, rolleOppslag: async () => []
        });
        sjekk('lenka står alene når det ikke finnes vedlegg',
            tomt.vedlegg.map(x => x.filnavn), ['Lenke til skjemaet']);
    }

    // Uten lenke har vi ingenting å peke på — verken skjemaet eller
    // vedleggene. En halv adresse i en oppgave er verre enn ingen.
    const utenBase = await v.byggPlanner({}, { skjemanavn: 'Test' }, {
        emne: 'Emne', lenke: '', skjema: s, behandlere: [], log: () => { },
        rolleOppslag: async () => []
    });
    sjekk('uten base-URL sendes ingen vedlegg', utenBase.vedlegg, []);
    sjekk('og tomt Graph-kart', utenBase.vedlegg_graph, {});

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
}

planner().catch(e => { console.error('Testen krasjet:', e); process.exit(1); });
