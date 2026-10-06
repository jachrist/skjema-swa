/**
 * Standardmalene finnes to steder, og de må si det samme.
 *
 * `api/src/lib/varsling.js` eier teksten som FAKTISK sendes når skjematypen
 * ikke har en egen. `frontend/editor.html` viser den samme teksten som forslag
 * i meldingsmodalen, bak «Bruk standard». Frontend kan ikke `require` backend,
 * så kopien må finnes — men da må noe holde dem like.
 *
 * Det gjorde ingenting før 06.10.2026, og de hadde alt glidd fra hverandre:
 * kvitteringen som ble sendt sluttet med «Med vennlig hilsen FHS», forslaget i
 * editoren gjorde det ikke. Trykket du «Bruk standard» og lagret, mistet
 * skjematypen signaturen — uten at noe sa fra, for begge tekstene så riktige
 * ut hver for seg.
 *
 * To ting testes:
 *
 *   **Hver mal er identisk i de to.** Mellomrom og linjeskift mellom tagger
 *   normaliseres bort: editoren skriver `\n` mellom avsnittene for at
 *   HTML-kilden skal være lesbar i tekstfeltet, backend skjøter dem sammen.
 *   Alt annet skal være tegn for tegn likt.
 *
 *   **$kommentar står i beslutningsmalen.** Den ble lagt inn 06.10.2026 etter
 *   at en behandler skrev en begrunnelse som aldri nådde innsenderen:
 *   plassholderen fantes, men ikke i standardteksten, så den som ikke
 *   redigerte malen sendte beslutningen uten begrunnelsen.
 *
 * Kjøres med:  node api/test/standardmaler.test.js
 */
const fs = require('fs');
const path = require('path');
const varsling = require('../src/lib/varsling');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const editor = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'editor.html'), 'utf8');

/**
 * Hent et `forslag: { Emne, Tekst }` ut av editoren, pekt ut av emnelinja.
 *
 * Emnet er nøkkelen fordi det er kort og entydig. Finner vi det ikke, er det
 * en feil i testen eller i editoren — og da skal testen si fra, ikke hoppe
 * over og melde grønt.
 */
function forslagFraEditor(emne) {
    const i = editor.indexOf(`Emne: '${emne}'`) >= 0
        ? editor.indexOf(`Emne: '${emne}'`)
        : editor.indexOf(`Emne: \`${emne}\``);
    if (i < 0) throw new Error(`Fant ikke forslaget med emnet "${emne}" i editor.html`);
    const linjeslutt = editor.indexOf('\n', i);
    const tekstStart = editor.indexOf('Tekst:', linjeslutt);
    if (tekstStart < 0) throw new Error(`Fant ingen Tekst etter emnet "${emne}"`);
    const rest = editor.slice(tekstStart + 'Tekst:'.length);
    const m = /^\s*(['`])([\s\S]*?)\1/.exec(rest);
    if (!m) throw new Error(`Klarte ikke lese Tekst for "${emne}"`);
    // Strengen står i kilden, så `\n` er to tegn der. Gjør dem til linjeskift.
    return { Emne: emne, Tekst: m[2].replace(/\\n/g, '\n') };
}

/** Linjeskift og innrykk MELLOM tagger er layout i kilden, ikke innhold. */
function normaliser(html) {
    return String(html).replace(/>\s+</g, '><').trim();
}

const MALER = [
    ['innsenderkvittering', varsling.standardKvittering()],
    ['melding til behandler', varsling.standardTilBehandler()],
    ['tilbakemelding til innsender', varsling.standardFraBehandler()],
    ['ferdigvarsling', varsling.standardFerdigVarsling()]
];

// ---------- de to kopiene er like ----------
for (const [navn, bak] of MALER) {
    let front;
    try {
        front = forslagFraEditor(bak.Emne);
    } catch (e) {
        feil++; console.log(`FEIL  ${navn}: ${e.message}`);
        continue;
    }
    sjekk(`${navn}: samme emne`, front.Emne, bak.Emne);
    sjekk(`${navn}: samme tekst`, normaliser(front.Tekst), normaliser(bak.Tekst));
}

// ---------- alle fire ble faktisk funnet ----------
{
    // Uten dette kunne regexen over slutte å treffe, og testen ville meldt
    // grønt på null sammenligninger.
    sjekk('fire maler er sammenlignet', MALER.length, 4);
    const funnet = MALER.filter(([, bak]) => {
        try { forslagFraEditor(bak.Emne); return true; } catch { return false; }
    });
    sjekk('alle fire finnes i editoren', funnet.length, 4);
}

// ---------- $kommentar i beslutningsmalen ----------
{
    const fra = varsling.standardFraBehandler();
    sjekk('malen har $kommentar', /\$kommentar/.test(fra.Tekst), true);
    // På linja UNDER beslutningen, som avtalt med oppdragsgiver.
    sjekk('den står etter beslutningen',
        fra.Tekst.indexOf('$beslutning') < fra.Tekst.indexOf('$kommentar'), true);
    // Og før lenka, så begrunnelsen leses før man klikker seg videre.
    sjekk('og før lenka',
        fra.Tekst.indexOf('$kommentar') < fra.Tekst.indexOf('$lenke'), true);

    // De andre malene sendes uten at det finnes en beslutning, så der ville
    // $kommentar alltid blitt tom.
    for (const navn of ['standardKvittering', 'standardTilBehandler', 'standardFerdigVarsling']) {
        sjekk(`${navn} har ikke $kommentar`, /\$kommentar/.test(varsling[navn]().Tekst), false);
    }
}

// ---------- tomt avsnitt blir borte ----------
{
    const { erstattPlassholdere } = require('../src/lib/placeholder');
    const mal = varsling.standardFraBehandler().Tekst;

    const med = erstattPlassholdere(mal, {
        skjemanavn: 'Søknad', skjemaId: '42', stegnavn: 'Vurdering',
        beslutning: 'Innvilget', kommentar: 'Godkjent med forbehold', lenke: 'https://x/y'
    });
    sjekk('kommentaren kommer med', med.includes('<p>Godkjent med forbehold</p>'), true);

    const uten = erstattPlassholdere(mal, {
        skjemanavn: 'Søknad', skjemaId: '42', stegnavn: 'Vurdering',
        beslutning: 'Innvilget', kommentar: '', lenke: 'https://x/y'
    });
    // Uten dette står det en blank linje mellom beslutningen og lenka i
    // annenhver e-post.
    sjekk('tomt avsnitt fjernes', /<p>\s*<\/p>/.test(uten), false);
    sjekk('resten står igjen', uten.includes('Beslutning: <b>Innvilget</b>'), true);
    sjekk('og lenka også', uten.includes('href="https://x/y"'), true);

    // Luft noen har bedt om med vilje skal stå.
    sjekk('&nbsp;-avsnitt røres ikke',
        erstattPlassholdere('<p>&nbsp;</p>', {}), '<p>&nbsp;</p>');
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
