/**
 * Behandlernavn i oppsummeringen.
 *
 * API-et beriker skjemaet med `_behandlere` — ett oppslag per steg, bygget av
 * samme funksjon som avgjør hvem som får varslingen (`varsling.js`):
 *
 *   { "<stegnr>": { kandidater: [{epost, navn}], behandletAv: [{epost, navn}] } }
 *
 * Her bor bare formateringen, og den bor ett sted fordi to sider viser den:
 * `visning.html` (innsenderens oppsummering) og `evaluering.html`
 * (behandlerens side). To kopier ville før eller siden vist samme person på to
 * måter i samme sak.
 *
 * Navnet kan mangle. Brukernavn-tabellen fylles ved innlogging, så en
 * behandler som ennå ikke har logget inn har bare en adresse — og da er
 * adressen alene riktigere enn en tom parentes.
 */

/** «Ola Nordmann (ola@x.no)», eller bare adressen når navnet mangler. */
export function formaterBehandler(b) {
    const epost = String(b?.epost || '').trim();
    const navn = String(b?.navn || '').trim();
    if (!epost) return navn;
    return navn ? `${navn} (${epost})` : epost;
}

/**
 * Linja under et steg: hvem som avgjorde det, eller hvem som kan.
 *
 * Returnerer null når det ikke er noe å si — et hoppet steg har hverken
 * kandidater eller aktør, og en tom «Behandlere:»-linje er verre enn ingen.
 *
 * `behandletAv` går foran: er steget avgjort, er det hvem som FAKTISK gjorde
 * det som er interessant. Kandidatlista svarer på et annet spørsmål, og
 * API-et fyller derfor bare én av dem per steg.
 */
export function behandlerlinje(rad) {
    const gjort = (rad?.behandletAv || []).filter(b => b?.epost);
    if (gjort.length > 0) {
        return `Behandlet av: ${gjort.map(formaterBehandler).join(', ')}`;
    }
    const kan = (rad?.kandidater || []).filter(b => b?.epost);
    if (kan.length > 0) {
        return `Behandlere: ${kan.map(formaterBehandler).join(', ')}`;
    }
    return null;
}
