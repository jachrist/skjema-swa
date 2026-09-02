/**
 * skjema-kompakt.js — Kompakt lagringsformat for skjemaer.
 *
 * Separerer svar fra definisjon for å redusere lagringsstørrelse.
 * Fullt format (~10-15 KB) → kompakt format (~0.5-1 KB per skjema).
 *
 * Brukes primært for arkivering av ferdigbehandlede skjemaer.
 * Under aktiv utfylling og behandling beholdes fullt format.
 *
 * Feltnumre paddes alltid med padStart(2, '0') for konsistent nøkkel-matching.
 * Behandling-array overføres uendret ved komprimering/ekspandering.
 */

const METADATA_FELTER = [
    'Skjema_id', 'Skjematype_id', 'Skjemanavn', 'Skjema_navn',
    'Status', 'Skjema_status', 'Behandling_status',
    'Innsender', 'Innsender_Navn', 'Innsender_Epost', 'Innsender_epost',
    'Opprettet', 'Sist_endret',
    'OpprettetDato', 'FerdigbehandletDato'
];

function erKompaktFormat(skjema) {
    return !!skjema && Array.isArray(skjema.Svar) && !Array.isArray(skjema.Seksjoner);
}

/**
 * Komprimer fullt skjema til kompakt format.
 * Beholder metadata, Behandling og vedlegg. Fjerner tomme svar.
 */
function komprimerSkjema(fulltSkjema) {
    if (erKompaktFormat(fulltSkjema)) return fulltSkjema;

    const kompakt = {};
    for (const felt of METADATA_FELTER) {
        if (fulltSkjema[felt] !== undefined) kompakt[felt] = fulltSkjema[felt];
    }
    if (Array.isArray(fulltSkjema.Behandling)) kompakt.Behandling = fulltSkjema.Behandling;
    if (fulltSkjema.vedlegg) kompakt.vedlegg = fulltSkjema.vedlegg;

    const svar = [];
    for (const seksjon of (fulltSkjema.Seksjoner || [])) {
        const sekNr = Number(seksjon.Nummer ?? seksjon.Seksjon_nummer);
        for (const felt of (seksjon.Felter || [])) {
            if (felt.Type === 'Informasjon') continue;
            if (!felt.Svar || felt.Svar.length === 0) continue;
            const rad = {
                sek: sekNr,
                spm: String(felt.Nummer).padStart(2, '0'),
                sva: felt.Svar
            };
            // Feltets stabile Id. Nummer tildeles etter posisjon, så det endrer
            // seg når et felt slettes eller flyttes i editoren — og da peker et
            // gammelt svar på nabospørsmålet i stedet for sitt eget. Id-en står
            // stille, og er derfor den eneste trygge koblingen tilbake.
            if (felt.Id) rad.id = felt.Id;
            // Visningstekst for valglister (klassenavn, personnavn) — lagres bare
            // når den skiller seg fra verdien. Se svarTekstFor() i felt-render.js.
            if (Array.isArray(felt.SvarTekst) && felt.SvarTekst.length > 0) rad.svt = felt.SvarTekst;
            svar.push(rad);
        }
    }
    kompakt.Svar = svar;
    return kompakt;
}

/**
 * Ekspander kompakt skjema til fullt format ved hjelp av skjemadefinisjonen.
 * Ikke-besvarte felter får tom Svar-array.
 */
function ekspanderSkjema(kompaktSvar, skjemadefinisjon) {
    if (!erKompaktFormat(kompaktSvar)) return kompaktSvar;
    if (!skjemadefinisjon) return kompaktSvar; // kan ikke ekspandere uten definisjon

    const fullt = JSON.parse(JSON.stringify(skjemadefinisjon));

    for (const felt of METADATA_FELTER) {
        if (kompaktSvar[felt] !== undefined) fullt[felt] = kompaktSvar[felt];
    }
    if (Array.isArray(kompaktSvar.Behandling)) fullt.Behandling = kompaktSvar.Behandling;
    if (kompaktSvar.vedlegg) fullt.vedlegg = kompaktSvar.vedlegg;

    // To oppslag: på Id og på posisjon. Id vinner når den finnes, for posisjonen
    // kan ha flyttet seg siden svaret ble lagret.
    const påId = new Map();
    const påPosisjon = new Map();
    for (const s of kompaktSvar.Svar) {
        const n = `${s.sek}-${String(s.spm).padStart(2, '0')}`;
        påPosisjon.set(n, s);
        if (s.id) påId.set(s.id, s);
    }

    // Første runde: koble på Id, og merk svaret som brukt. Uten merkingen kunne
    // samme svar blitt tildelt to felter — én gang på Id og én gang på posisjon
    // — og da ville et felt fått nabofeltets svar.
    const brukt = new Set();
    const uløst = [];

    function tildel(felt, treff) {
        felt.Svar = treff.sva;
        if (Array.isArray(treff.svt)) felt.SvarTekst = treff.svt;
        brukt.add(treff);
    }

    for (const seksjon of (fullt.Seksjoner || [])) {
        const sekNr = seksjon.Nummer ?? seksjon.Seksjon_nummer;
        for (const felt of (seksjon.Felter || [])) {
            if (felt.Type === 'Informasjon') continue;
            const nøkkel = `${sekNr}-${String(felt.Nummer).padStart(2, '0')}`;
            const treff = felt.Id ? påId.get(felt.Id) : undefined;
            if (treff) tildel(felt, treff);
            else uløst.push({ felt, nøkkel });
        }
    }

    // Andre runde: posisjon, men bare for svar som ikke alt er koblet på Id.
    // Skjemaer lagret før Id-en kom med har bare denne veien.
    for (const { felt, nøkkel } of uløst) {
        const treff = påPosisjon.get(nøkkel);
        if (treff && !brukt.has(treff)) tildel(felt, treff);
        else felt.Svar = [];
    }
    return fullt;
}

module.exports = { erKompaktFormat, komprimerSkjema, ekspanderSkjema };
