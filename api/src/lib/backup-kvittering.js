/**
 * Kvitteringen fra PA-flyten: hva den BETYR.
 *
 * Flyten melder tilbake om fila landet i OneDrive, og hvor stor den ble.
 * Reglene her er rene — ingen Azure-avhengighet — og lå i
 * `functions/backup.js` til 20.10.2026. Der kunne de ikke testes: fila
 * krever `@azure/functions` på toppnivå, og uten pakka hopper en test over
 * seg selv og melder «0 OK, 0 feil». Altså grønt, uten å ha prøvd noe.
 *
 * Det er samme flytting som `lib/ekstern-auth.js` fikk 18.09.2026, av samme
 * grunn.
 */

/**
 * Hva et størrelsesavvik BETYR.
 *
 * «Opplastingen er ufullstendig» sto her alene til 20.10.2026, og den var
 * beviselig feil i det ene tilfellet som faktisk oppsto: fila i OneDrive var
 * STØRRE enn det vi sendte. 74518 bytes ble til 99360 — nøyaktig
 * `ceil(n/3)*4`, altså base64-lengden. Flyten hadde skrevet den
 * base64-kodede teksten i stedet for å dekode den først.
 *
 * En melding som peker feil vei koster mer enn ingen melding: den sendte
 * feilsøkingen mot et avbrutt opplastingskall, der årsaken var ett uttrykk i
 * en flyt. Forholdet 4/3 er en signatur, og den skal leses.
 *
 * Toleransen fanger også den oppdelte varianten: deles fila i flere deler,
 * base64-kodes hver for seg, og summen treffer ikke `ceil(total/3)*4`
 * nøyaktig — men forholdet er fortsatt 4/3.
 */
function avvikstekst(meldt, vår) {
    const felles = `Fila i OneDrive er ${meldt} bytes, men vi lastet opp ${vår}.`;

    if (vår > 0 && Math.abs(meldt / vår - 4 / 3) < 0.001) {
        return `${felles} Det er base64-forholdet: flyten har skrevet den kodede `
            + 'teksten i stedet for å dekode den først. Fiksen er i flyten — innholdet '
            + 'må gjennom base64ToBinary() før det skrives til OneDrive.';
    }
    if (meldt > vår) {
        return `${felles} Fila er STØRRE enn det vi sendte, så dette er ikke en avbrutt `
            + 'opplasting — noe er lagt til underveis, typisk en koding flyten ikke har reversert.';
    }
    return `${felles} Opplastingen er ufullstendig.`;
}

/**
 * Flyten kan melde «ok» og likevel ha lagt igjen noe annet enn det vi sendte.
 * Størrelsen er den eneste uavhengige kontrollen vi har på den andre siden.
 */
function vurderKvittering({ meldtStatus, meldtStorrelse, vårStorrelse, melding }) {
    const meldt = String(meldtStatus || '').toLowerCase() === 'ok' ? 'ok' : 'feil';
    const tekst = String(melding || '').slice(0, 500);

    if (meldt === 'ok' && meldtStorrelse !== null && vårStorrelse !== null && meldtStorrelse !== vårStorrelse) {
        return { resultat: 'feil', melding: avvikstekst(meldtStorrelse, vårStorrelse) };
    }
    return { resultat: meldt, melding: tekst };
}

module.exports = { vurderKvittering, avvikstekst };
