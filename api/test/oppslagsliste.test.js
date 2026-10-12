/**
 * Oppslagslister — svar fra innsendte skjemaer som verdier i et nedtrekk.
 *
 * Ønsket: FHS har verdivurdert informasjonstyper i én skjematype (ett skjema
 * per datapunkt), og andre skjemaer skal kunne velge blant de ferdige
 * vurderingene i stedet for at hver skjemaskaper vedlikeholder sin egen kopi.
 *
 * Testene holder på de egenskapene som gjorde at dette IKKE ble bygget som en
 * direkte kilde, og på de valgene som var nær ved å bli stille feil:
 *
 *   **Utvalget.** Bare forekomster som er Avsluttet ELLER har
 *   behandlingsresultat Godkjent. Det er to ulike akser — Avsluttet er en
 *   `Skjema_status`, Godkjent er et behandlingsresultat uten statuskode — og
 *   regelen ligger i ÉN funksjon nettopp fordi den er den ene linja som må
 *   snus hvis meningen var BEGGE samtidig.
 *
 *   **Merkelapp, ikke feltnummer.** Kildeskjematypen defineres i prod, der
 *   feltnumrene ikke er kjent når oppsettet lages. En merkelapp uten treff
 *   skal STOPPE med de tilgjengelige merkelappene i meldingen — ikke hoppe
 *   over feltet og gi en liste som ser riktig ut og mangler en kolonne.
 *
 *   **Delene står i fast rekkefølge.** Et ubesvart felt gir en tom verdi, ikke
 *   en utelatt del: ellers kan radene ikke leses side om side i nedtrekket.
 *
 *   **Navnet bæres av VERDIEN, ikke av strengen.** Første del er identiteten.
 *   Sjekkes den ved å splitte den sammensatte teksten på « - », går det galt
 *   for et navn som selv inneholder « - » — og bare for noen rader.
 *
 * Kjøres med:  node api/test/oppslagsliste.test.js
 */
const ol = require('../src/lib/oppslagsliste');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}
/**
 * `byggListe` som ÉN rød linje i stedet for en TypeError som tar resten av
 * fila med seg. Et kast her har tidligere skjult alle sjekkene under, og da
 * ser et hull ut som om testen ikke finnes.
 */
function bygg(navn, oppsett, def, skjemaer) {
    try { return ol.byggListe(oppsett, def, skjemaer); }
    catch (e) {
        feil++;
        console.log(`FEIL  ${navn}: byggListe kastet — ${e.message}`);
        return { rader: [], hoppet: [], felter: [] };
    }
}

/** finnFelt som én rød linje i stedet for et kast som stopper fila. */
function felt(navn, katalog, merkelapp) {
    try { return ol.finnFelt(katalog, merkelapp); }
    catch (e) {
        feil++;
        console.log(`FEIL  ${navn}: finnFelt kastet — ${e.message}`);
        return { nokkel: '(kastet)' };
    }
}

function kaster(navn, fn, monster) {
    try { fn(); feil++; console.log(`FEIL  ${navn}\n      kastet ikke`); }
    catch (e) {
        if (monster.test(e.message)) ok++;
        else { feil++; console.log(`FEIL  ${navn}\n      meldingen var "${e.message}"\n      ventet ${monster}`); }
    }
}

// ---------- kilden, lest av skjermdumpen av skjematype 59 ----------
//
// Feltene ligger i TO seksjoner: DATAPUNKT (1 Vurdert av, 2
// Informasjonskategori, 3 Datapunkt (navn), 4 Vurdering, 5 Personopplysning,
// 6 Særlig kategori personopplysninger) og VURDERING (1 Datapunkt, 2
// Datapunkt liste). Merkelappene er hentet derfra og ikke funnet opp her —
// de to siste heter «Datapunkt» og «Datapunkt liste», ikke noe med
// «Vurdering» i seg, og et oppsett bygget på en gjetning ville truffet
// ingenting.
//
// At de spenner over to seksjoner er en egenskap testen skal holde på:
// oppslaget går gjennom alle seksjoner, og en implementasjon som bare så i
// én ville virket for de tre første feltene og tiet om de to siste.
const DEF = { Seksjoner: [
    { Seksjon_nummer: 1, Felter: [
        { Nummer: 1, Tekst: 'Vurdert av' },
        { Nummer: 2, Tekst: 'Informasjonskategori' },
        { Nummer: 3, Tekst: 'Datapunkt (navn)' },
        { Nummer: 4, Tekst: 'Vurdering' },
        { Nummer: 5, Tekst: 'Personopplysning' },
        { Nummer: 6, Tekst: 'Særlig kategori personopplysninger' }
    ]},
    { Seksjon_nummer: 2, Felter: [
        { Nummer: 1, Tekst: 'Datapunkt' },
        { Nummer: 2, Tekst: 'Datapunkt liste' },
        { Nummer: 3, Type: 'Informasjon', Tekst: { Verdi: 'Les dette først', Format: 'Markdown' } }
    ]}
]};

const OPPSETT = { Navn: 'Verdivurderinger', Skjematype_id: '59', Felter: [
    { Merkelapp: 'Datapunkt (navn)', Prefiks: '' },
    { Merkelapp: 'Personopplysning', Prefiks: 'Personopplysning: ' },
    { Merkelapp: 'Særlig kategori personopplysninger', Prefiks: 'Særlig kategori personopplysninger: ' },
    { Merkelapp: 'Datapunkt', Prefiks: 'Datapunkt: ' },
    { Merkelapp: 'Datapunkt liste', Prefiks: 'Datapunkt liste: ' }
]};

/**
 * En forekomst. `status` og `beslutning` settes hver for seg, fordi det er
 * nettopp kombinasjonen av dem utvalget hviler på.
 *
 * Normaltilfellet — det skjermdumpen viser — er AVSLUTTET og Godkjent.
 */
function skjema(id, { navn = 'x', po = 'Ja', sk = 'Nei', v1 = ['TJENSTLIG'], v2 = ['TJENSTLIG'],
                      status = 5, beslutning = 'Godkjent' } = {}) {
    return {
        Skjema_id: id, Skjema_status: status,
        Behandling: beslutning
            ? [{ Steg: 1, Stegnavn: 'Godkjenning', Beslutning: 1,
                 Beslutningsvalg: [{ Nummer: 1, Tekst: beslutning }] }]
            : [],
        Seksjoner: [
            { Seksjon_nummer: 1, Felter: [
                { Nummer: 3, Svar: navn === null ? [] : [navn] },
                { Nummer: 5, Svar: [po] },
                { Nummer: 6, Svar: [sk] }
            ]},
            { Seksjon_nummer: 2, Felter: [
                { Nummer: 1, Svar: v1 },
                { Nummer: 2, Svar: v2 }
            ]}
        ]
    };
}

// ---------- utvalget ----------
{
    // BEGGE deler kreves. De fire kombinasjonene står her, for det er
    // nettopp forvekslingen mellom «og» og «eller» som er lett å gjøre:
    // Avsluttet er en status, Godkjent er et behandlingsresultat.
    sjekk('avsluttet OG godkjent kvalifiserer',
        ol.kvalifiserer(skjema('1', { status: 5, beslutning: 'Godkjent' })), true);
    sjekk('avsluttet uten godkjenning kvalifiserer IKKE',
        ol.kvalifiserer(skjema('2', { status: 5, beslutning: null })), false);
    sjekk('godkjent uten å være avsluttet kvalifiserer IKKE',
        ol.kvalifiserer(skjema('3', { status: 2, beslutning: 'Godkjent' })), false);
    sjekk('hverken eller kvalifiserer ikke',
        ol.kvalifiserer(skjema('4', { status: 2, beslutning: null })), false);

    sjekk('mellomlagret kvalifiserer ikke',
        ol.kvalifiserer(skjema('5', { status: 1, beslutning: 'Godkjent' })), false);
    sjekk('til revidering kvalifiserer ikke',
        ol.kvalifiserer(skjema('6', { status: 3, beslutning: 'Godkjent' })), false);
    // Et annet utfall er et utfall, ikke en godkjenning.
    sjekk('avsluttet men avvist kvalifiserer ikke',
        ol.kvalifiserer(skjema('7', { status: 5, beslutning: 'Avvist' })), false);
    sjekk('godkjent med forbehold er ikke Godkjent',
        ol.kvalifiserer(skjema('8', { status: 5, beslutning: 'Godkjent med forbehold' })), false);
    // Store/små bokstaver skal ikke avgjøre om et datapunkt er med.
    sjekk('ikke følsom for store bokstaver',
        ol.kvalifiserer(skjema('9', { status: 5, beslutning: 'GODKJENT' })), true);
    sjekk('eller for mellomrom rundt',
        ol.kvalifiserer(skjema('10', { status: 5, beslutning: '  Godkjent  ' })), true);
    sjekk('tomt skjema kvalifiserer ikke', ol.kvalifiserer({}), false);
    // Konstanten er ett sted, og det er dette tallet registeret kaller
    // Avsluttet. Endres den, skal testen si fra.
    sjekk('Avsluttet er status 5', ol.STATUS_AVSLUTTET, 5);
    sjekk('og bare Godkjent er godkjent', ol.GODKJENTE_RESULTATER, ['Godkjent']);
}

// ---------- katalogen ----------
{
    const k = ol.feltKatalog(DEF);
    sjekk('åtte felter med merkelapp', k.length, 8);
    sjekk('nøkkelformen er sek-felt', k[0].nokkel, '1-01');
    // Katalogen MÅ spenne over begge seksjonene. En implementasjon som bare
    // så i den første ville virket for navn og personopplysning, og tiet om
    // de to vurderingsfeltene.
    sjekk('begge seksjonene er med',
        [...new Set(k.map(f => f.nokkel.split('-')[0]))], ['1', '2']);
    // Et informasjonsfelt har ingen svar. Står det i oppsettet, skal det si
    // fra — ikke gi en tom del på hver rad.
    sjekk('informasjonsfelt er ikke med', k.some(f => f.merkelapp === 'Les dette først'), false);
    sjekk('tom definisjon gir tom katalog', ol.feltKatalog({}), []);
}

// ---------- oppslag på merkelapp ----------
{
    const k = ol.feltKatalog(DEF);
    sjekk('treffer på merkelapp', felt('merkelapp', k, 'Personopplysning').nokkel, '1-05');
    sjekk('ikke følsom for store bokstaver', felt('store bokstaver', k, 'personOPPLYSNING').nokkel, '1-05');
    sjekk('eller for ekstra mellomrom', felt('mellomrom', k, '  Datapunkt   (navn) ').nokkel, '1-03');
    // Feltnummer godtas også, for den som vil være presis.
    sjekk('treffer på feltnummer', felt('feltnummer', k, '2-02').nokkel, '2-02');
    // «Datapunkt» og «Datapunkt (navn)» er ULIKE felter i ulike seksjoner.
    // En delstrengsammenligning ville slått dem sammen — og med tre felter
    // som alle inneholder «Datapunkt» ville den vært tvetydig for alle tre.
    sjekk('Datapunkt er ikke Datapunkt (navn)', felt('Datapunkt', k, 'Datapunkt').nokkel, '2-01');
    sjekk('og Datapunkt liste er sitt eget', felt('Datapunkt liste', k, 'Datapunkt liste').nokkel, '2-02');

    // Feilmeldingen skal peke på rettelsen, ikke bare si at noe er galt.
    kaster('ukjent merkelapp stopper', () => ol.finnFelt(k, 'Datapunkt navn'), /Fant ikke feltet/);
    kaster('og lister merkelappene som finnes',
        () => ol.finnFelt(k, 'Datapunkt navn'), /"Datapunkt \(navn\)" \(1-03\)/);
    kaster('fra begge seksjonene',
        () => ol.finnFelt(k, 'Datapunkt navn'), /"Datapunkt liste" \(2-02\)/);
    kaster('tom merkelapp stopper', () => ol.finnFelt(k, ''), /mangler/);

    // To felter med samme navn: et stille valg mellom dem er verre enn å stoppe.
    const tvetydig = ol.feltKatalog({ Seksjoner: [{ Seksjon_nummer: 1, Felter: [
        { Nummer: 1, Tekst: 'Vurdering' }, { Nummer: 2, Tekst: 'Vurdering' }
    ]}]});
    kaster('dobbel merkelapp stopper', () => ol.finnFelt(tvetydig, 'Vurdering'), /finnes på 2 felter/);
    kaster('og foreslår feltnummeret', () => ol.finnFelt(tvetydig, 'Vurdering'), /"1-01"/);
}

// ---------- teksten ----------
{
    const r = bygg('hele strengen', OPPSETT, DEF, [
        skjema('236', { navn: 'epost_privat', po: 'Ja', sk: 'Nei',
            v1: ['KAN OFFENTLIGGJØRES', 'TJENSTLIG'], v2: ['TJENSTLIG'] })
    ]);
    // Formen oppdragsgiver ba om, tegn for tegn.
    sjekk('hele strengen', r.rader[0]?.Tekst,
        'epost_privat - Personopplysning: Ja - Særlig kategori personopplysninger: Nei'
        + ' - Datapunkt: KAN OFFENTLIGGJØRES/TJENSTLIG - Datapunkt liste: TJENSTLIG');
    // Verdi = Tekst: det lagrede svaret skal være lesbart i rapport, PDF og
    // arkiv uten et oppslag tilbake til kilden.
    sjekk('verdien er teksten', r.rader[0]?.Verdi, r.rader[0]?.Tekst);
    sjekk('og kilden følger med som sporing', r.rader[0]?.KildeSkjemaId, '236');
    sjekk('flere valg skilles med skråstrek', ol.FLERVERDI_SKILLE, '/');
    sjekk('og delene med bindestrek', ol.DEL_SKILLE, ' - ');
}
{
    // Et ubesvart felt gir en TOM del, ikke en utelatt. Faller delen ut,
    // forskyves resten og radene kan ikke leses side om side.
    const r = bygg('ubesvart felt', OPPSETT, DEF, [skjema('1', { navn: 'a', v2: [] })]);
    sjekk('ubesvart felt gir tom del', r.rader[0]?.Tekst.endsWith('Datapunkt liste: '), true);
    sjekk('og antall deler er uendret', r.rader[0]?.Tekst.split(' - ').length, 5);
}

// ---------- hva som hoppes over ----------
{
    const r = bygg('hva som hoppes over', OPPSETT, DEF, [
        skjema('1', { navn: 'med' }),
        skjema('2', { navn: 'under_arbeid', status: 2, beslutning: null }),
        skjema('3', { navn: null }),
        skjema('4', { navn: 'med' })
    ]);
    sjekk('bare de gyldige blir rader', r.rader.map(x => x.KildeSkjemaId), ['1']);
    sjekk('og resten er forklart', r.hoppet.length, 3);
    sjekk('ikke behandlet', r.hoppet[0]?.grunn, 'ikke avsluttet og godkjent');
    // En oppføring som bare sier « - Personopplysning: Ja» hjelper ingen.
    sjekk('ubesvart navn nevner feltet', /Datapunkt \(navn\)/.test(r.hoppet[1]?.grunn), true);
    // Samme datapunkt vurdert to ganger skal ikke stå dobbelt i nedtrekket.
    sjekk('duplikat hoppes over', r.hoppet[2]?.grunn, 'samme tekst finnes alt i lista');
    // Nøkkelen er ALLTID satt, også tom — ellers kan «ingenting ble hoppet
    // over» ikke skilles fra «koden som teller dem er ikke deployet».
    sjekk('hoppet finnes også når den er tom',
        'hoppet' in bygg('tom inndata', OPPSETT, DEF, []), true);
}

// ---------- navnet bæres av verdien ----------
{
    // Et navn som selv inneholder « - ». Splittes den sammensatte teksten for
    // å finne identiteten, blir svaret feil — og bare for slike rader.
    const r = bygg('navn med skilletegn', OPPSETT, DEF, [
        skjema('1', { navn: 'epost - privat' })
    ]);
    sjekk('navn med skilletegn blir en rad', r.rader.length, 1);
    sjekk('og hoppes ikke over', r.hoppet.length, 0);
    sjekk('teksten begynner med navnet', r.rader[0]?.Tekst.startsWith('epost - privat - Personopplysning'), true);
}
{
    // Prefikset kan SELV inneholde skilletegnet. Her skiller de to måtene å
    // finne identiteten på lag:
    //
    //   deler[0].verdi            → "x"      (riktig: raden skal med)
    //   tekst.split(' - ')[0]     → "A"      og .slice(prefiks.length) → ""
    //                                        (feil: raden faller ut)
    //
    // Uten dette tilfellet overlevde splitt-varianten alle testene, og
    // kommentaren i koden påsto en beskyttelse ingen test kunne se.
    const prefiksMedSkille = { Navn: 'A', Skjematype_id: '59', Felter: [
        { Merkelapp: 'Datapunkt (navn)', Prefiks: 'Datapunkt - navn: ' },
        { Merkelapp: 'Personopplysning', Prefiks: 'Personopplysning: ' }
    ]};
    const r = bygg('prefiks med skilletegn', prefiksMedSkille, DEF, [skjema('1', { navn: 'x' })]);
    sjekk('prefiks som inneholder skilletegnet tar ikke raden', r.rader.length, 1);
    sjekk('og teksten er hel', r.rader[0]?.Tekst, 'Datapunkt - navn: x - Personopplysning: Ja');
}
{
    // ...og en tom første del skal fortsatt hoppes over, selv når prefikset
    // gjør at delen ikke er en tom streng.
    const medPrefiks = { ...OPPSETT, Felter: [
        { Merkelapp: 'Datapunkt (navn)', Prefiks: 'Navn: ' },
        { Merkelapp: 'Personopplysning', Prefiks: 'Personopplysning: ' }
    ]};
    const r = bygg('tomt navn bak prefiks', medPrefiks, DEF, [skjema('1', { navn: null })]);
    sjekk('tomt navn bak et prefiks hoppes også over', r.rader.length, 0);
}

// ---------- sortering og oppsettfeil ----------
{
    const r = bygg('sortering', OPPSETT, DEF, [
        skjema('1', { navn: 'Ørn' }),
        skjema('2', { navn: 'Alfa' }),
        skjema('3', { navn: 'Zulu' })
    ]);
    // Nedtrekket har søk, men rekkefølgen skal være forutsigbar — og norsk:
    // Ø sorteres etter Z.
    sjekk('sortert på norsk', r.rader.map(x => x.Tekst.split(' - ')[0]), ['Alfa', 'Zulu', 'Ørn']);
}
{
    kaster('liste uten navn stopper', () => ol.byggListe({ Felter: [{ Merkelapp: 'x' }] }, DEF, []), /mangler Navn/);
    kaster('liste uten felter stopper', () => ol.byggListe({ Navn: 'A', Felter: [] }, DEF, []), /ingen felter/);
    kaster('kilde uten merkelapper stopper',
        () => ol.byggListe(OPPSETT, { Seksjoner: [] }, []), /ingen felter med merkelapp/);
    // Alle merkelappene slås opp FØR noen rad bygges: en feil i det siste
    // feltet skal ikke komme etter at de andre er skrevet.
    kaster('feil i siste felt stopper før noe bygges',
        () => ol.byggListe({ ...OPPSETT, Felter: [...OPPSETT.Felter, { Merkelapp: 'Finnes ikke' }] },
            DEF, [skjema('1', {})]), /Fant ikke feltet "Finnes ikke"/);
}

// ---------- kompakt lagringsform ----------
{
    // Forekomster lagres også kompakt (`Svar: [{sek, spm, sva}]`).
    // `hentFeltSvar` kjenner begge formene; lista må gjøre det samme, ellers
    // blir eldre rader stående tomme uten at noe sier fra.
    const kompakt = {
        Skjema_id: '9', Skjema_status: 5,
        Behandling: [{ Steg: 1, Beslutning: 1, Beslutningsvalg: [{ Nummer: 1, Tekst: 'Godkjent' }] }],
        Svar: [{ sek: 1, spm: '03', sva: ['kompakt_navn'] }, { sek: 1, spm: '05', sva: ['Ja'] }]
    };
    const r = bygg('kompakt form', { Navn: 'A', Skjematype_id: '59', Felter: [
        { Merkelapp: 'Datapunkt (navn)', Prefiks: '' },
        { Merkelapp: 'Personopplysning', Prefiks: 'Personopplysning: ' }
    ]}, DEF, [kompakt]);
    sjekk('kompakt form leses også', r.rader[0]?.Tekst, 'kompakt_navn - Personopplysning: Ja');
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
