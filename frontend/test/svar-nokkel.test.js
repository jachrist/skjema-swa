/**
 * Tester for svarNokkel() — koblingen mellom et lagret svar og feltet i
 * definisjonen.
 *
 * Bakgrunn: visningene bygget oppslagskartet fra `seksjon.Nummer` og slo opp
 * med `sek.Seksjon_nummer`. Skjemaer lagret av denne appen har begge, så det
 * gikk bra. Skjemaer fra den opprinnelige Function App-versjonen har bare
 * `Seksjon_nummer` — der ble nøkkelen «undefined-01», og hvert eneste felt
 * viste «(ikke besvart)» selv om svarene lå urørt i rada.
 *
 * Det er den verste formen for feil: den ser ut som tapte data, den rammer
 * alle felt samtidig (så ingenting «virker delvis»), og den rammer bare de
 * eldste skjemaene — de færreste ser etter der.
 *
 * Kjøres med:  node frontend/test/svar-nokkel.test.js
 */
const fs = require('fs');
const path = require('path');

// felt-render.js er en ES-modul med DOM-avhengigheter. Vi klipper ut den ene
// funksjonen og evaluerer den — samme mønster som de andre frontend-testene.
const kilde = fs.readFileSync(path.join(__dirname, '..', 'js', 'felt-render.js'), 'utf8');
const start = kilde.indexOf('export function svarNokkel');
if (start === -1) throw new Error('Fant ikke svarNokkel i felt-render.js');
const slutt = kilde.indexOf('\n}', start) + 2;
const svarNokkel = eval('(' + kilde.slice(start, slutt).replace('export function svarNokkel', 'function') + ')');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    if (faktisk === forventet) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${JSON.stringify(faktisk)}\n      forventet ${JSON.stringify(forventet)}`); }
}

// ---------- de tre formene en seksjon kan ha ----------
{
    // Slik denne appen lagrer (samleSeksjonerFraDom skriver begge).
    sjekk('begge felter satt', svarNokkel({ Seksjon_nummer: 1, Nummer: 1 }, { Nummer: '01' }), '1-01');

    // Slik skjemadefinisjoner og legacy-skjemaer ser ut. Dette er selve feilen.
    sjekk('bare Seksjon_nummer', svarNokkel({ Seksjon_nummer: 1 }, { Nummer: '01' }), '1-01');

    // Slik et ekspandert kompakt skjema kan se ut.
    sjekk('bare Nummer', svarNokkel({ Nummer: 1 }, { Nummer: '01' }), '1-01');
}

// ---------- de tre skal gi SAMME nøkkel ----------
{
    const a = svarNokkel({ Seksjon_nummer: 2, Nummer: 2 }, { Nummer: '03' });
    const b = svarNokkel({ Seksjon_nummer: 2 }, { Nummer: '03' });
    const c = svarNokkel({ Nummer: 2 }, { Nummer: '03' });
    sjekk('lagret form = definisjonsform', a, b);
    sjekk('definisjonsform = ekspandert form', b, c);
}

// ---------- padding av feltnummer ----------
{
    // «1» og «01» er samme felt uansett hvilken side nøkkelen kommer fra.
    sjekk('upadded tall', svarNokkel({ Seksjon_nummer: 1 }, { Nummer: 1 }), '1-01');
    sjekk('upadded streng', svarNokkel({ Seksjon_nummer: 1 }, { Nummer: '1' }), '1-01');
    sjekk('allerede padded', svarNokkel({ Seksjon_nummer: 1 }, { Nummer: '01' }), '1-01');
    sjekk('tosifret røres ikke', svarNokkel({ Seksjon_nummer: 1 }, { Nummer: '12' }), '1-12');
}

// ---------- rene numre, ikke objekter ----------
{
    // index.html har seksjonsnummeret som tall der widgeten bygges.
    sjekk('seksjon som tall', svarNokkel(3, { Nummer: '02' }), '3-02');
    sjekk('begge som tall', svarNokkel(3, 2), '3-02');
}

// ---------- seksjonsnummer 0 ----------
{
    // ?? og ikke ||: seksjon 0 er et gyldig nummer, og || ville falt igjennom
    // til Seksjon_nummer og gitt feil nøkkel.
    sjekk('Nummer=0 faller ikke gjennom', svarNokkel({ Nummer: 0, Seksjon_nummer: 9 }, { Nummer: '01' }), '0-01');
}

// ---------- regresjonen selv ----------
{
    // Den gamle koden bygde kartet slik …
    const lagret = { Seksjon_nummer: 1, Felter: [{ Nummer: '01', Svar: ['Ja'] }] };
    const gammelNokkel = `${lagret.Nummer}-${lagret.Felter[0].Nummer}`;
    sjekk('gammel kode ga undefined-nøkkel', gammelNokkel, 'undefined-01');

    // … og slo opp slik, fra definisjonen.
    const def = { Seksjon_nummer: 1, Felter: [{ Nummer: '01' }] };
    const kart = new Map([[svarNokkel(lagret, lagret.Felter[0]), lagret.Felter[0].Svar]]);
    sjekk('ny kode finner svaret', (kart.get(svarNokkel(def, def.Felter[0])) || [])[0], 'Ja');
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
