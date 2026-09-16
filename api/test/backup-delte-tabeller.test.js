/**
 * De delte tabellene skal være med i HVER backup, ikke bare de fulle.
 *
 * `TodoPunkter` og `Nokkelkalender` ligger på en egen konto som deles mellom
 * miljøene. Fram til 16.09.2026 ble de tatt kun i fulle kjøringer — søndag
 * natt — med begrunnelsen at de endrer seg sjelden.
 *
 * Det holdt ikke. Oppgavelista brukes daglig fra prod, og da den forsvant i
 * en opprydding 15.09 var nærmeste kopi fra forrige søndag. Et uhell på en
 * onsdag ville kostet seks dagers arbeid.
 *
 * Tabellene er små — titalls rader — så daglig kopi koster nærmest ingenting.
 * Prisen for å ta feil er ikke symmetrisk: litt sløsing hver natt mot en uke
 * tapt arbeid. Denne testen holder på den avveiningen.
 *
 * Kjøres med:  node api/test/backup-delte-tabeller.test.js
 */
let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const backup = require('../src/lib/backup');
const { delteTabellerMed, DELTE_TABELLER, TABELLER_KUN_FULL } = backup;

// ---------- det som er hele poenget ----------
{
    // Delta er ikke lenger et vilkår. Ryker denne, er de delte tabellene
    // tilbake i ukentlig kadens — og det merkes først den dagen noe er borte.
    sjekk('delta tar delte tabeller', delteTabellerMed(true, 'DefaultEndpointsProtocol=…'), true);
    sjekk('full tar delte tabeller', delteTabellerMed(false, 'DefaultEndpointsProtocol=…'), true);
}

// ---------- uten kilde er det ingenting å ta ----------
{
    // Ikke en feil: et miljø uten TODO_STORAGE_CONNECTION_STRING har ingen
    // delt konto. Da skal manifestet ha tom delteTabeller[], og logglinja
    // sier hvorfor.
    sjekk('delta uten connection string', delteTabellerMed(true, ''), false);
    sjekk('full uten connection string', delteTabellerMed(false, ''), false);
    sjekk('undefined', delteTabellerMed(false, undefined), false);
    sjekk('null', delteTabellerMed(true, null), false);
}

// ---------- hvilke tabeller det gjelder ----------
{
    sjekk('TodoPunkter er delt', DELTE_TABELLER.includes('TodoPunkter'), true);
    sjekk('Nokkelkalender er delt', DELTE_TABELLER.includes('Nokkelkalender'), true);

    // Postnumre er den ene som fortsatt er kun-full, og det er riktig: den er
    // stor, endrer seg nesten aldri, og kan re-seedes fra Bring. Skulle en
    // delt tabell havne her, ville den falt ut av deltaene igjen — bakveien
    // inn til nøyaktig den feilen denne testen finnes for.
    for (const navn of DELTE_TABELLER) {
        sjekk(`${navn} er ikke kun-full`, TABELLER_KUN_FULL.includes(navn), false);
    }
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
