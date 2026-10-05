/**
 * Hvorfor havnet brukeren på `visning.html`?
 *
 * `evaluering.html` omdirigerer en innsender som ikke har noe å behandle på
 * saken sin (se `skalTilVisning` der). Omdirigeringen er riktig — innsenderen
 * har tilgang til egen sak, men behandlernes grensesnitt er ikke laget for
 * hen — men den var stum: adresselinja byttet fra `evaluering.html` til
 * `visning.html` mens siden lastet, og det eneste brukeren så var at lenken
 * fra e-posten «gikk et annet sted». Det kostet en feilsøkingsrunde på noe som
 * virket som det skulle.
 *
 * Modulen er delt mellom de to sidene med vilje: `evaluering.html` BYGGER
 * lenken og `visning.html` LESER den. Lå navnet på parameteren i to
 * strengliteraler, ville en skrivefeil gitt en omdirigering uten forklaring —
 * altså akkurat den tilstanden dette skulle rette.
 */

export const GRUNN_PARAM = 'grunn';

const GRUNNER = {
    'ingen-behandling': {
        tittel: 'Du ser lesevisningen av saken din',
        tekst: 'Lenken pekte til behandlingssiden, men du er innsender av denne saken '
            + 'og har ingen behandlingsoppgave på den nå. Her finner du hele skjemaet '
            + 'med behandlingshistorikk, samtale og kommentarer. Skal du rette noe, '
            + 'får du en egen lenke til utfylling.'
    }
};

/** Teksten for en grunn, eller `null` for en grunn vi ikke kjenner. */
export function grunnTekst(verdi) {
    return GRUNNER[String(verdi ?? '')] || null;
}

/**
 * Lenka til visningssiden.
 *
 * `grunn` utelates for vanlige lenker (e-postvarslene bygger sine egne i
 * `api/src/lib/varsling.js`) — da vises ikke banneret. En ukjent grunn gir
 * ingen feil her, men `visningsgrunn.test.js` krever at hver grunn en side
 * faktisk sender, finnes i kartet over.
 */
export function visningslenke(skjematypeId, skjemaId, grunn = '', hash = '') {
    const p = new URLSearchParams({ skjematype_id: skjematypeId, skjema_id: skjemaId });
    if (grunn) p.set(GRUNN_PARAM, grunn);
    return `/visning.html?${p.toString()}${hash || ''}`;
}
