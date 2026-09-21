/**
 * Dialogboksen er intern, og bare intern.
 *
 * Før fantes det to veier til innsenderen: nedtrekket «Til innsender» i
 * dialogboksen, og Samtale. Samme budskap kunne havne to steder, og
 * behandleren måtte vite hvilket valg som gjorde hva. Boksen heter nå
 * «Intern dialog (kun saksbehandlere)», og veien til innsenderen er Samtale.
 *
 * Den forrige testen her («dialog-valg») passet på at innsenderen ikke ble
 * tilbudt et valg API-et avviser. Den regelen gjelder fortsatt — den er bare
 * løst på en annen måte nå: innsenderen får ikke et skrivefelt i det hele
 * tatt, i stedet for et nedtrekk med ett lovlig alternativ.
 *
 * Det testes fire ting:
 *
 *   **Navnet.** Boksen skal si hvem den er for.
 *
 *   **Ingen vei til innsender herfra.** Dukker `value="ekstern"` opp igjen,
 *   er doblingen tilbake.
 *
 *   **Innsenderen får ikke skrivefelt.** Hen kan ikke skrive interne innlegg;
 *   API-et svarer 403. Et felt som sikkert feiler er verre enn ingen felt.
 *   Betingelsen skal komme fra serveren (`_minRolle`), ikke regnes ut i
 *   nettleseren — samme kilde som avgjør hvilke innlegg hen får se.
 *
 *   **API-et avviser fortsatt.** Grensesnittet er ikke tilgangskontroll.
 *
 * Kjøres med:  node frontend/test/intern-dialog.test.js
 */
const fs = require('fs');
const path = require('path');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const rot = path.join(__dirname, '..');
const api = fs.readFileSync(
    path.join(rot, '..', 'api', 'src', 'functions', 'skjemaer.js'), 'utf8');

/** Kommentarene strippes: en test skal ikke kunne bestå på sin egen forklaring. */
const utenKommentarer = (s) => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

// ---------- navnet, på alle sidene som viser boksen ----------
{
    for (const fil of ['evaluering.html', 'register.html']) {
        const kode = utenKommentarer(fs.readFileSync(path.join(rot, fil), 'utf8'));
        sjekk(`${fil}: boksen heter «Intern dialog (kun saksbehandlere)»`,
            kode.includes("'Intern dialog (kun saksbehandlere)'"), true);
        sjekk(`${fil}: ingen boks som bare heter «Dialog»`,
            /textContent = 'Dialog'/.test(kode), false);
    }

    // Innsenderens side viser de gamle innleggene som historikk. Het den
    // «Samtale», ville saker med begge deler hatt to bokser med samme navn.
    const visning = utenKommentarer(fs.readFileSync(path.join(rot, 'visning.html'), 'utf8'));
    sjekk('visning.html: gamle innlegg heter «Tidligere meldinger»',
        visning.includes("'Tidligere meldinger'"), true);
    sjekk('visning.html: ingen boks som bare heter «Dialog»',
        /textContent = 'Dialog'/.test(visning), false);
}

// ---------- ingen vei til innsenderen fra dialogboksen ----------
{
    const kode = utenKommentarer(fs.readFileSync(path.join(rot, 'evaluering.html'), 'utf8'));

    sjekk('nedtrekket er borte', /id="dialog-type"/.test(kode), false);
    sjekk('«Til innsender» kan ikke velges', /value="ekstern"/.test(kode), false);

    // Typen sendes fortsatt — den skal bare alltid være den samme.
    sjekk('innlegg sendes som intern', /const type = 'intern'/.test(kode), true);
    sjekk('og leses ikke fra et felt som ikke finnes',
        /getElementById\('dialog-type'\)/.test(kode), false);
}

// ---------- innsenderen får ikke skrivefelt ----------
{
    const kode = utenKommentarer(fs.readFileSync(path.join(rot, 'evaluering.html'), 'utf8'));

    sjekk('skrivefeltet er betinget', /if \(kanIntern\)/.test(kode), true);
    sjekk('betingelsen leser _minRolle', /kanIntern = skjema\._minRolle/.test(kode), true);
    sjekk('og sammenligner med innsender', /!==\s*'innsender'/.test(kode), true);

    // Selve feltet og knappen skal ligge INNENFOR betingelsen. Ligger de
    // utenfor, vises de uansett hva `kanIntern` er.
    const blokk = kode.slice(kode.indexOf('if (kanIntern)'));
    const slutt = blokk.indexOf('div.appendChild(input);');
    sjekk('feltet ligger inne i betingelsen',
        slutt > -1 && blokk.slice(0, slutt).includes('id="dialog-tekst"'), true);

    // Rollen skal ikke regnes ut i nettleseren.
    sjekk('siden gjetter ikke selv',
        /Innsender_Epost.*toLowerCase.*===.*userDetails/.test(kode), false);
}

// ---------- serveren ----------
{
    const kode = utenKommentarer(api);

    sjekk('_minRolle settes i svaret', /skjema\._minRolle\s*=/.test(kode), true);

    // Samme kilde som filtreringen av interne innlegg. To oppslag kunne gitt
    // to svar — og da vises innlegg etter én regel og tilbys skriving etter en
    // annen.
    sjekk('samme rolle brukes til å skjule innlegg',
        /skjulInterneInnlegg\(skjema, minRolle\)/.test(kode), true);
    sjekk('rollen hentes fra tilgangsRolle',
        /minRolle\s*=\s*await dialogTilgang\.tilgangsRolle\(/.test(kode), true);

    // Og API-et må fortsatt avvise: grensesnittet er ikke tilgangskontroll.
    // Endepunktet tar fortsatt imot 'ekstern' fra behandlere — gamle innlegg
    // skal kunne leses, og en uendret API-kontrakt er ikke i veien for noe.
    sjekk('API-et avviser fortsatt intern fra innsender',
        /type === 'intern' && rolle === 'innsender'/.test(kode), true);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
