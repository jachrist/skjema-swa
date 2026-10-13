/**
 * Masseutsending styrt av skjematype-definisjonen.
 *
 * I dag finnes én masseutsending — emneevaluering — og kartleggingen fra det
 * innsendte avsender-skjemaet til `POST /api/utsending` ligger i en
 * Power Automate-flyt. En ny type betyr dermed en ny flyt, og hver flytendring
 * er en firestegs manuell ALM-runde mellom tenantene (docs/FLYT-DEPLOY.md).
 *
 * `byggUtsending` er den kartleggingen, flyttet til kode som kan testes.
 *
 * Det som gjorde dette verdt å teste hardt, er at feilene er TAUSE. En
 * masseutsending går til folk vi ikke ser, med lenker som utløper. Går noe
 * galt i kartleggingen, får vi 200 fra endepunktet og oppdager det når noen
 * spør hvorfor de aldri fikk skjemaet.
 *
 * Fire egenskaper testene holder på:
 *
 *   **Mottakerfeltet må være flervalg.** Dette er den dyreste feilen, og den
 *   ble funnet ved å kjøre modulen og ikke ved å lese den: `alleSvarIFelt` i
 *   placeholder.js leser bare FØRSTE svar på et felt som ikke er flervalg.
 *   Utsendingen ville gått til én av to hundre, og både kallet og svaret
 *   ville sett helt normale ut.
 *
 *   **«Finnes ikke» er ikke «er ubesvart».** De to sender deg til hvert sitt
 *   sted: definisjonen, eller skjemaet som ble fylt ut. Først ga begge samme
 *   melding.
 *
 *   **Feil samles opp.** Den som setter opp en ny masseutsending skal se alt
 *   som er galt i én omgang, ikke ett og ett.
 *
 *   **Ingen kropp når noe er galt.** Et delvis bygget kall er verre enn
 *   ingen: det ville sendt til noen av mottakerne.
 *
 * Kjøres med:  node api/test/utsending-oppsett.test.js
 */
const uo = require('../src/lib/utsending-oppsett');
const { FLERVALGSTYPER } = require('../src/lib/placeholder');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}
/** Minst én feilmelding må matche. Ellers: vis dem, så man ser hva som kom. */
function nevner(navn, res, monster) {
    if (res.feil.some(f => monster.test(f))) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      ingen feil matchet ${monster}\n      fikk: ${JSON.stringify(res.feil)}`); }
}

// ---------- avsender-skjemaet, formet som emneevalueringen ----------
function skjema({ mottakerType = 'Flervalg-dropdown', mottakere = ['a@fhs.no', 'b@fhs.no'],
                  datoer = ['2026-11-01', '2026-11-08', '2026-11-15'] } = {}) {
    return {
        Skjema_id: '412',
        Seksjoner: [
            { Seksjon_nummer: 1, Felter: [
                { Nummer: 1, Svar: ['26H|CBU1503-1'] },
                { Nummer: 2, Svar: ['Militær luftmakt'] },
                { Nummer: 3, Svar: datoer[0] ? [datoer[0]] : [] },
                { Nummer: 4, Svar: datoer[1] ? [datoer[1]] : [] },
                { Nummer: 5, Svar: datoer[2] ? [datoer[2]] : [] }
            ]},
            { Seksjon_nummer: 2, Felter: [
                { Nummer: 1, Type: mottakerType, Svar: mottakere }
            ]}
        ]
    };
}

const OPPSETT = {
    Målskjematype_id: '71',
    Mottakerfelt: '2-01',
    Datoer: { utsendingsdato: '1-03', purredato: '1-04', avslutningsdato: '1-05' },
    Prefilled: { '1-01': { fraFelt: '1-01' } }
};

// ---------- normaltilfellet ----------
{
    const r = uo.byggUtsending(OPPSETT, skjema());
    sjekk('ingen feil', r.feil, []);
    sjekk('målskjematypen', r.kropp?.skjematypeId, '71');
    sjekk('avsenderskjemaet følger med', r.kropp?.senderSkjemaId, '412');
    sjekk('begge mottakerne', r.kropp?.mottakere.map(m => m.mottaker), ['a@fhs.no', 'b@fhs.no']);
    // Datoene normaliseres med SAMME funksjon som endepunktet bruker, så en
    // ugyldig dato oppdages før flyten har kalt oss.
    sjekk('utsendingsdato er normalisert', r.kropp?.utsendingsdato, '2026-11-01T00:00:00.000Z');
    // Avslutning gjelder ut dagen — ellers stenger lenka ved midnatt inn i
    // den datoen som står i skjemaet.
    sjekk('avslutning gjelder ut dagen', r.kropp?.avslutningsdato, '2026-11-15T23:59:59.999Z');
    sjekk('prefilled fra felt', r.kropp?.mottakere[0].prefilled['1-01'], ['26H|CBU1503-1']);
    // Alle tre nøklene alltid satt — «ingen feil» og «koden er ikke deployet»
    // må kunne skilles.
    sjekk('advarsler finnes også når tom', Array.isArray(r.advarsler), true);
}

// ---------- mottakerfeltet må være flervalg ----------
{
    for (const type of ['Tekst', 'Dropdown', '']) {
        const r = uo.byggUtsending(OPPSETT, skjema({ mottakerType: type }));
        nevner(`type "${type}" avvises`, r, /bare ÉTT svar|må være/);
        sjekk(`type "${type}" gir ingen kropp`, r.kropp, null);
    }
    // Og de som ER flervalg skal slippe gjennom — settet leses fra
    // placeholder.js, ikke skrevet av her.
    for (const type of FLERVALGSTYPER) {
        const r = uo.byggUtsending(OPPSETT, skjema({ mottakerType: type }));
        sjekk(`type "${type}" godtas`, r.feil, []);
    }
    sjekk('settet er ikke tomt', FLERVALGSTYPER.size > 0, true);
}

// ---------- finnes ikke vs. ubesvart ----------
{
    const finnesIkke = uo.byggUtsending({ ...OPPSETT, Mottakerfelt: '9-99' }, skjema());
    nevner('felt som ikke finnes sier det', finnesIkke, /finnes ikke/);

    const tomt = uo.byggUtsending(OPPSETT, skjema({ mottakere: [] }));
    nevner('ubesvart felt sier det', tomt, /ubesvart/);
    // De to må IKKE gi samme melding — de sender deg til hvert sitt sted.
    sjekk('meldingene er ulike', finnesIkke.feil[0] === tomt.feil[0], false);

    const ugyldig = uo.byggUtsending({ ...OPPSETT, Mottakerfelt: 'tull' }, skjema());
    nevner('ugyldig referanse sier det', ugyldig, /ikke en feltreferanse/);
}

// ---------- duplikater ----------
{
    // To lenker til samme person: den andre gjør den første ubrukelig.
    const r = uo.byggUtsending(OPPSETT, skjema({ mottakere: ['a@fhs.no', 'A@FHS.NO', 'b@fhs.no'] }));
    sjekk('duplikat fjernet', r.kropp?.mottakere.map(m => m.mottaker), ['a@fhs.no', 'b@fhs.no']);
    sjekk('og det sies fra', r.advarsler.length, 1);
    // En advarsel skal IKKE stoppe utsendingen.
    sjekk('men utsendingen går', r.feil, []);
}

// ---------- datoene ----------
{
    const bakvendt = uo.byggUtsending(OPPSETT, skjema({ datoer: ['2026-11-15', '2026-11-08', '2026-11-01'] }));
    nevner('avslutning før utsending', bakvendt, /avslutningsdato er før utsendingsdato/);
    sjekk('og ingen kropp', bakvendt.kropp, null);

    const purretFor = uo.byggUtsending(OPPSETT, skjema({ datoer: ['2026-11-08', '2026-11-01', '2026-11-15'] }));
    nevner('purring før utsending', purretFor, /purredato er før utsendingsdato/);

    // "2026-02-31" ruller over til 3. mars i JS. Datoen må komme tilbake slik
    // den ble skrevet, ellers er den ugyldig.
    const umulig = uo.byggUtsending(OPPSETT, skjema({ datoer: ['2026-02-31', '', ''] }));
    nevner('umulig dato avvises', umulig, /ikke en gyldig dato/);

    // Datoer er valgfrie: uten purredato purres det ikke.
    const utenPurring = uo.byggUtsending(
        { ...OPPSETT, Datoer: { utsendingsdato: '1-03', avslutningsdato: '1-05' } }, skjema());
    sjekk('purredato kan utelates', utenPurring.feil, []);
    sjekk('og blir tom', utenPurring.kropp?.purredato, '');
}

// ---------- prefill-formene ----------
{
    const r = uo.byggUtsending({ ...OPPSETT, Prefilled: {
        '1-01': { fraFelt: '1-02' },
        '1-02': { tekst: 'Evaluering av {1-02}' },
        '1-03': { emnebeskrivelse: '{1-01}' },
        '1-04': 'ren tekst'
    }}, skjema());
    sjekk('fraFelt', r.kropp?.mottakere[0].prefilled['1-01'], ['Militær luftmakt']);
    sjekk('tekst med referanse', r.kropp?.mottakere[0].prefilled['1-02'], ['Evaluering av Militær luftmakt']);
    // Oppslaget sendes videre som OBJEKT. Endepunktet validerer det og lagrer
    // referansen, ikke teksten — det holder radene små og gir alltid teksten
    // som gjelder når skjemaet fylles ut.
    sjekk('oppslag beholder formen', r.kropp?.mottakere[0].prefilled['1-03'], { emnebeskrivelse: '26H|CBU1503-1' });
    sjekk('ren streng godtas', r.kropp?.mottakere[0].prefilled['1-04'], ['ren tekst']);

    // Oppslagstypene må være de samme som utsending-prefill.js kjenner.
    const prefillKilde = require('fs').readFileSync(
        require('path').join(__dirname, '..', 'src', 'lib', 'utsending-prefill.js'), 'utf8');
    const deres = [...(/OPPSLAGSTYPER = \[([^\]]*)\]/.exec(prefillKilde)?.[1] || '')
        .matchAll(/'([a-zæøå]+)'/g)].map(m => m[1]);
    sjekk('oppslagstypene er de samme', uo.OPPSLAGSTYPER, deres);
}
{
    const r = uo.byggUtsending({ ...OPPSETT, Prefilled: { 'ikke-en-ref': { fraFelt: '1-01' } } }, skjema());
    nevner('ugyldig prefill-nøkkel', r, /ikke en feltreferanse i målskjemaet/);

    const ukjent = uo.byggUtsending({ ...OPPSETT, Prefilled: { '1-01': { finnesIkke: 'x' } } }, skjema());
    nevner('ukjent prefill-form', ukjent, /ukjent form/);
    nevner('og den lister de gyldige', ukjent, /emnebeskrivelse/);

    // Et ubesvart kildefelt er IKKE en feil: det gir et tomt felt hos
    // mottakeren, som er det samme som å ikke forhåndsutfylle det.
    const tomKilde = uo.byggUtsending({ ...OPPSETT, Prefilled: { '1-01': { fraFelt: '1-04' } } },
        skjema({ datoer: ['2026-11-01', '', '2026-11-15'] }));
    sjekk('ubesvart kildefelt er ikke en feil', tomKilde.feil, []);
}

// ---------- feil samles opp ----------
{
    const r = uo.byggUtsending({
        Mottakerfelt: '9-99',
        Datoer: { utsendingsdato: '1-05', avslutningsdato: '1-03' },
        Prefilled: { 'tull': { fraFelt: '1-01' }, '1-01': { ukjent: 'x' } }
    }, skjema());
    // Den som setter opp en ny masseutsending skal se ALT i én omgang.
    sjekk('flere feil samtidig', r.feil.length >= 4, true);
    nevner('manglende målskjematype', r, /Målskjematype_id mangler/);
    // Et delvis bygget kall ville sendt til noen av mottakerne.
    sjekk('ingen kropp når noe er galt', r.kropp, null);
}
{
    const uten = uo.byggUtsending(null, skjema());
    nevner('ingen Utsending-blokk', uten, /ingen Utsending-blokk/);
    sjekk('og ingen kropp', uten.kropp, null);
    sjekk('men nøklene finnes', [Array.isArray(uten.feil), Array.isArray(uten.advarsler)], [true, true]);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
