/**
 * Statusteksten for et skjema — ett sted.
 *
 * Fram til 05.10.2026 fantes kartet i fem eksemplarer som var uenige om
 * nesten hver verdi: status 3 het «Avvist» to steder og «Til revidering» tre,
 * status 1 het «Utkast» eller «Mellomlagret», status 2 «Innsendt» eller
 * «Under behandling».
 *
 * Statusene som faktisk settes (api/src/functions/skjemaer.js):
 *
 *   1  mellomlagret   standard ved lagring uten innsending
 *   2  innsendt       standard ved innsending
 *   3  til revidering ompuss — sendt tilbake til innsender
 *   5  avsluttet      alle steg ferdige, eller ingen steg definert
 *
 * 0 betyr «ingen status lagret» og oppstår i praksis ikke. 4 settes aldri —
 * den sto som en etikett i register.html uten at noe brukte den.
 *
 * **«Under behandling» har ingen egen status.** Et skjema som er avgjort på
 * steg 1 og venter på steg 2 står fortsatt på 2, akkurat som et ingen har
 * rørt. Det er derfor det finnes to funksjoner her, og ikke én:
 *
 *   `statusTekstFraKode` kjenner bare tallet, og svarer «Innsendt» på 2.
 *   Det er det ærlige svaret når man ikke vet mer — rapportkolonner har bare
 *   tallet.
 *
 *   `statusTekst` ser hele skjemaet og kan skille dem: er minst ett steg
 *   avgjort, er skjemaet under behandling.
 *
 * Et avsluttet skjema heter «Avsluttet» uansett utfall. Innvilget og avslått
 * er beslutninger på steg, ikke statuser på skjemaet (avklart med
 * oppdragsgiver 05.10.2026).
 */

/** Tallet alene. Brukes der hele skjemaet ikke er tilgjengelig. */
export function statusTekstFraKode(kode) {
    switch (Number(kode)) {
        case 1: return 'Mellomlagret';
        case 2: return 'Innsendt';
        case 3: return 'Til revidering';
        case 5: return 'Avsluttet';
        default: return '–';
    }
}

/**
 * Har noen faktisk behandlet et steg?
 *
 * `Beslutning = 5` er «hoppet over» — et steg som ikke skulle kjøre. Det er
 * ikke arbeid noen har gjort, og skal ikke få skjemaet til å se ut som om
 * behandlingen er i gang.
 */
function noenHarBehandlet(skjema) {
    return (skjema?.Behandling || []).some(s => {
        const b = Number(s?.Beslutning || 0);
        return b !== 0 && b !== 5;
    });
}

/**
 * Statusteksten for et helt skjema.
 *
 * Faller tilbake på `statusTekstFraKode` når `Behandling` mangler — da vet vi
 * ikke mer enn tallet, og skal ikke late som.
 */
function erIGang(skjema) {
    if (Array.isArray(skjema?.Behandling)) return noenHarBehandlet(skjema);
    // Registerlista fra /api/skjema-liste er kompakt og har ikke Behandling.
    // Serveren regner ut det samme der (behandling.noenStegErBehandlet) og
    // sender svaret med.
    return skjema?.UnderBehandling === true;
}

export function statusTekst(skjema) {
    const kode = Number(skjema?.Skjema_status ?? 0);
    if (kode === 2 && erIGang(skjema)) return 'Under behandling';
    return statusTekstFraKode(kode);
}

/**
 * Klassen som gir statusmerket farge.
 *
 * Den utledes av TEKSTEN, ikke av tallet, og det er hele poenget: siden
 * «Under behandling» ikke har en egen statuskode, ville en klasse bygget på
 * tallet gitt den fargen til «Innsendt». Da sier merket ett og fargen et
 * annet.
 *
 * Det var `status-${kode}` som sto der før, og det ga den verste varianten:
 * status 5 fikk klassen `status-5`, som ingen av sidene hadde en regel for.
 * Merket har hvit skrift, så «AVSLUTTET» ble hvitt på kortbakgrunnen — og i
 * registeret er den raden lyseblå når den er valgt. Usynlig tekst, ingen
 * feilmelding.
 *
 * Nye tekster får derfor ikke en klasse av seg selv. `skjemastatus.test.js`
 * krever at hver klasse denne kan returnere HAR en bakgrunnsregel på hver side
 * som bruker merket.
 */
const KLASSE_FOR_TEKST = {
    'Mellomlagret': 'status-mellomlagret',
    'Innsendt': 'status-innsendt',
    'Under behandling': 'status-behandling',
    'Til revidering': 'status-revidering',
    'Avsluttet': 'status-avsluttet'
};

export function statusKlasse(skjema) {
    return KLASSE_FOR_TEKST[statusTekst(skjema)] || 'status-ukjent';
}

/** Klassene merket kan få. Testen leser denne i stedet for å gjette. */
export const STATUSKLASSER = [...Object.values(KLASSE_FOR_TEKST), 'status-ukjent'];
