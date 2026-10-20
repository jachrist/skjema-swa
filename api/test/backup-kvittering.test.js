/**
 * Kvitteringen fra PA-flyten — og hva et størrelsesavvik BETYR.
 *
 * 20.10.2026 meldte en full backup i dev: «Fila i OneDrive er 99360 bytes,
 * men vi lastet opp 74518. Opplastingen er ufullstendig.»
 *
 * Den var beviselig feil. Fila var ikke ufullstendig, den var STØRRE — og
 * 99360 er nøyaktig `ceil(74518/3)*4`, altså base64-lengden. Flyten hadde
 * skrevet den base64-kodede teksten i stedet for å dekode den først.
 *
 * En melding som peker feil vei koster mer enn ingen melding: den sendte
 * feilsøkingen mot et avbrutt opplastingskall, der årsaken var ett uttrykk i
 * en flyt.
 *
 * Reglene lå i `functions/backup.js` og kunne ikke testes derfra: fila
 * krever `@azure/functions` på toppnivå, og uten pakka hopper en test over
 * seg selv og melder «0 OK, 0 feil». Grønt, uten å ha prøvd noe. Samme
 * flytting som `lib/ekstern-auth.js` fikk 18.09.2026.
 *
 * Kjøres med:  node api/test/backup-kvittering.test.js
 */
const { vurderKvittering, avvikstekst } = require('../src/lib/backup-kvittering');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const kvittering = (o) => vurderKvittering({ meldtStatus: 'ok', melding: '', ...o });

// ---------- det ekte tilfellet ----------
//
// Tallene er fra hendelsen, ikke funnet opp. En test med oppdiktede tall
// ville vært grønn uten å dekke det som faktisk skjedde.
{
    const base64Lengde = Math.ceil(74518 / 3) * 4;
    sjekk('74518 bytes gir 99360 i base64', base64Lengde, 99360);

    const r = kvittering({ meldtStorrelse: 99360, vårStorrelse: 74518 });
    sjekk('avviket meldes som feil', r.resultat, 'feil');
    sjekk('og meldingen navngir base64', /base64/.test(r.melding), true);
    sjekk('og sier hvor fiksen er', /i flyten/.test(r.melding), true);
    sjekk('og nevner uttrykket som mangler', /base64ToBinary/.test(r.melding), true);

    // Det gamle, villedende ordet skal IKKE stå her.
    sjekk('og kaller det ikke ufullstendig', /ufullstendig/.test(r.melding), false);

    // Begge tallene skal med — uten dem kan ingen regne etter.
    sjekk('begge størrelsene står i meldingen',
        r.melding.includes('99360') && r.melding.includes('74518'), true);
}

// ---------- oppdelt fil: forholdet holder, nøyaktigheten ikke ----------
//
// Deles fila i deler, base64-kodes hver del for seg. Summen treffer ikke
// ceil(total/3)*4 nøyaktig, men forholdet er fortsatt 4/3. Uten toleransen
// ville den vanligste varianten falt ut av sjekken.
{
    const deler = [10_000_001, 10_000_001, 10_000_001];
    const total = deler.reduce((a, b) => a + b, 0);
    const kodet = deler.reduce((a, b) => a + Math.ceil(b / 3) * 4, 0);
    sjekk('summen av delene treffer ikke nøyaktig', kodet === Math.ceil(total / 3) * 4, false);
    sjekk('men forholdet fanges likevel',
        /base64/.test(kvittering({ meldtStorrelse: kodet, vårStorrelse: total }).melding), true);
}

// ---------- ekte avbrudd: ordet skal fortsatt brukes ----------
//
// Den gamle meldingen var ikke feil i seg selv, bare feil brukt. En for stor
// fil er ikke ufullstendig; en for liten er det.
{
    const r = kvittering({ meldtStorrelse: 40_000, vårStorrelse: 74_518 });
    sjekk('mindre fil meldes som ufullstendig', /ufullstendig/.test(r.melding), true);
    sjekk('og nevner ikke base64', /base64/.test(r.melding), false);
}

// ---------- større, men ikke base64 ----------
{
    const r = kvittering({ meldtStorrelse: 300_000, vårStorrelse: 74_518 });
    sjekk('større fil kalles ikke ufullstendig', /ufullstendig/.test(r.melding), false);
    sjekk('og sies å være større', /STØRRE/.test(r.melding), true);
}

// ---------- det som IKKE skal utløse noe ----------
{
    sjekk('lik størrelse er ok',
        kvittering({ meldtStorrelse: 74_518, vårStorrelse: 74_518 }).resultat, 'ok');

    // Ukjent størrelse er ikke et avvik. Melder flyten ingenting, har vi
    // ingenting å sammenligne — og da skal vi ikke finne på en feil.
    sjekk('ukjent meldt størrelse gir ok',
        kvittering({ meldtStorrelse: null, vårStorrelse: 74_518 }).resultat, 'ok');
    sjekk('ukjent egen størrelse gir ok',
        kvittering({ meldtStorrelse: 99_360, vårStorrelse: null }).resultat, 'ok');

    // Melder flyten feil, er størrelsen uinteressant — flytens egen melding
    // skal fram, ikke vår utledning.
    const r = vurderKvittering({ meldtStatus: 'feil', meldtStorrelse: 99_360, vårStorrelse: 74_518, melding: 'OneDrive svarte 507' });
    sjekk('meldt feil forblir feil', r.resultat, 'feil');
    sjekk('og flytens egen melding beholdes', r.melding, 'OneDrive svarte 507');

    // Null bytes: ingen divisjon, ingen påstand om base64.
    sjekk('vår størrelse 0 gir ingen base64-påstand',
        /base64/.test(avvikstekst(100, 0)), false);
}

// ---------- meldingen fra flyten kortes, men mistes ikke ----------
{
    const lang = 'x'.repeat(900);
    const r = vurderKvittering({ meldtStatus: 'feil', meldtStorrelse: null, vårStorrelse: null, melding: lang });
    sjekk('lang melding kortes til 500', r.melding.length, 500);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
