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
            svar.push({
                sek: sekNr,
                spm: String(felt.Nummer).padStart(2, '0'),
                sva: felt.Svar
            });
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

    const svarMap = new Map();
    for (const s of kompaktSvar.Svar) {
        svarMap.set(`${s.sek}-${String(s.spm).padStart(2, '0')}`, s.sva);
    }

    for (const seksjon of (fullt.Seksjoner || [])) {
        const sekNr = seksjon.Nummer ?? seksjon.Seksjon_nummer;
        for (const felt of (seksjon.Felter || [])) {
            if (felt.Type === 'Informasjon') continue;
            const nøkkel = `${sekNr}-${String(felt.Nummer).padStart(2, '0')}`;
            felt.Svar = svarMap.has(nøkkel) ? svarMap.get(nøkkel) : [];
        }
    }
    return fullt;
}

module.exports = { erKompaktFormat, komprimerSkjema, ekspanderSkjema };
