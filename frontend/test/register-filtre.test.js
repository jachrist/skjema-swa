/**
 * Søk og utfallsfilter i registeret.
 *
 * To hull, meldt da verdivurderingsregisteret fikk et behandlingssteg:
 *
 *   **Søket fant ikke det lista viser.** Det lette i innsender og ID. For en
 *   skjematype som holder masterdata er begge uinteressante — man søker etter
 *   `epost_privat`, altså etter det som STÅR i oversiktskolonna.
 *
 *   **Utfallet på steget kunne ikke filtreres.** Statusfilteret kjenner bare
 *   skjemastatusen (innsendt/avsluttet). «Godkjent», «Avslått» og «Ompuss» er
 *   beslutninger på et steg, og lista bar dem ikke i det hele tatt.
 *
 * Og ett som lå under: lista har en rask sti som hopper over JSON-en. Den ble
 * brukt for skjematyper uten filtrerbare felt — også når de HADDE
 * behandlingssteg. Da kom `UnderBehandling` aldri med, og et skjema midt i
 * behandling sto som «Innsendt» uten at noe sa fra.
 *
 * Fire ting testes:
 *
 *   **Søket dekker oversiktskolonnene** — og bare dem. Et treff i et skjult
 *   felt gir en rad man ikke kan se hvorfor dukket opp.
 *
 *   **Ubehandlet har et navn.** `null` i et filter er ingenting å velge.
 *
 *   **Utfallene kommer fra dataene.** Beslutningsvalgene heter det
 *   skjemaskaperen kalte dem; en fast liste ville vært feil på neste
 *   skjematype.
 *
 *   **Den raske stien tas ikke når skjematypen har behandling.**
 *
 * Kjøres med:  node frontend/test/register-filtre.test.js
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

// ---------- de ekte funksjonene, klipt ut ----------
const kilde = fs.readFileSync(path.join(__dirname, '..', 'register.html'), 'utf8');
function klipp(navn, slutt = '\n        }') {
    const start = kilde.indexOf(`function ${navn}(`);
    if (start === -1) throw new Error(`Fant ikke ${navn} i register.html`);
    return kilde.slice(start, kilde.indexOf(slutt, start) + slutt.length);
}
const { utfallFor, sokeTekst, IKKE_BEHANDLET } = new Function(`
    const IKKE_BEHANDLET = 'Ikke behandlet';
    ${klipp('utfallFor')}
    ${klipp('sokeTekst')}
    return { utfallFor, sokeTekst, IKKE_BEHANDLET };
`)();

const KOLONNER = [{ nokkel: '1-02' }, { nokkel: '1-03' }];
const rad = (over = {}) => ({
    Skjema_id: '42', Innsender_Epost: 'kari@mil.no',
    FilterSvar: { '1-02': ['epost_privat'], '1-03': ['Personinformasjon (mil)'], '1-09': ['hemmelig_notat'] },
    ...over
});

// ---------- søket ----------
{
    const t = sokeTekst(rad(), KOLONNER);
    sjekk('innsender er med', t.includes('kari@mil.no'), true);
    sjekk('id er med', t.includes('42'), true);
    // Dette er ønsket: søk på det som står i oversiktskolonna.
    sjekk('oversiktskolonna er med', t.includes('epost_privat'), true);
    sjekk('også kolonne to', t.includes('personinformasjon (mil)'), true);
    // Men ikke filtrerbare felt som ikke VISES. En rad som dukker opp uten at
    // noe på den matcher søket, er verre enn ingen treff.
    sjekk('skjulte felt er ikke med', t.includes('hemmelig_notat'), false);
    sjekk('alt er små bokstaver', t, t.toLowerCase());

    // Uten kolonner er søket som før.
    const uten = sokeTekst(rad(), []);
    sjekk('uten kolonner: bare innsender og id', uten.trim(), 'kari@mil.no 42');

    // Et skjema uten FilterSvar skal ikke kaste.
    sjekk('uten FilterSvar', sokeTekst({ Skjema_id: '7' }, KOLONNER).trim(), '7');
}

// ---------- utfallet ----------
{
    sjekk('utfall leses fra serveren',
        utfallFor({ Beslutning: { tekst: 'Godkjent', steg: 'Vurdering' } }), 'Godkjent');
    // «Ikke behandlet» er et valg i nedtrekket. `null` er ingenting å velge.
    sjekk('ubehandlet har et navn', utfallFor({ Beslutning: null }), IKKE_BEHANDLET);
    sjekk('uten feltet i det hele tatt', utfallFor({}), IKKE_BEHANDLET);
    sjekk('uten skjema', utfallFor(null), IKKE_BEHANDLET);
    sjekk('tom tekst teller som ubehandlet', utfallFor({ Beslutning: { tekst: '' } }), IKKE_BEHANDLET);
}

// ---------- siden ----------
{
    const kode = utenKommentarer(kilde);

    sjekk('utfallsfilteret finnes', /id="utfallFilter"/.test(kode), true);
    // Skjult til vi vet at skjematypen har behandling — et tomt nedtrekk er
    // bare i veien.
    sjekk('skjult som utgangspunkt', /id="utfallFilter"[^>]*style="display: none;"/.test(kode), true);
    sjekk('vises bare med behandlingssteg',
        /Array\.isArray\(state\.skjematype\?\.Behandling\)\s*\n?\s*&& state\.skjematype\.Behandling\.length > 0/.test(kode), true);

    // Valgene utledes av dataene. En fast liste ville vært feil på neste
    // skjematype, der valgene heter noe annet.
    sjekk('utfallene kommer fra dataene',
        /\[\.\.\.new Set\(state\.alle\.map\(utfallFor\)\)\]/.test(kode), true);
    // «Ikke behandlet» hører nederst, ikke midt i alfabetet.
    sjekk('ubehandlet sorteres sist', /a === IKKE_BEHANDLET \? 1 : b === IKKE_BEHANDLET \? -1/.test(kode), true);

    sjekk('filteret brukes', /if \(utfall !== '' && utfallFor\(s\) !== utfall\) return false;/.test(kode), true);
    sjekk('søket bruker sokeTekst', /sokeTekst\(s, kolonner\)\.includes\(sok\)/.test(kode), true);
    // Den gamle søketeksten skal ikke stå igjen ved siden av.
    sjekk('ingen egen søkestreng igjen',
        /\(s\.Innsender_Epost \|\| ''\) \+ ' ' \+ \(s\.Skjema_id \|\| ''\)/.test(kode), false);

    // Registeret skal ikke ha sin egen tolkning av Beslutning-tallet.
    sjekk('ingen egen beslutningstolkning i filteret',
        /utfallFor[\s\S]{0,200}Beslutningsvalg/.test(kode), false);
}

// ---------- serveren ----------
{
    const api = utenKommentarer(
        fs.readFileSync(path.join(__dirname, '..', '..', 'api', 'src', 'functions', 'skjemaer.js'), 'utf8'));

    // Samme utledning som datauttrekket og PDF-en bruker.
    sjekk('serveren bruker sisteBeslutning', /const sb = sisteBeslutning\(s\);/.test(api), true);
    sjekk('og sender tekst og steg', /tekst: sb\.tekst, steg: sb\.steg/.test(api), true);
    // Nøkkelen skal alltid finnes — også når ingenting er avgjort. En nøkkel
    // som kan forsvinne kan ikke feilsøkes.
    sjekk('null når ingenting er avgjort', /return sb \? \{ tekst: sb\.tekst, steg: sb\.steg \} : null;/.test(api), true);

    // Den raske stien kan ikke brukes når lista trenger Behandling.
    sjekk('rask sti krever at skjematypen er uten behandling',
        /if \(filterFelt\.length === 0 && !harBehandling\) \{/.test(api), true);
    sjekk('og harBehandling leses av definisjonen',
        /const harBehandling = Array\.isArray\(st\?\.JSON\?\.Behandling\) && st\.JSON\.Behandling\.length > 0;/.test(api), true);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
