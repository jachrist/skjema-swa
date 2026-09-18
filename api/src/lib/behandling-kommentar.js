/**
 * Kommentarene som ble gitt med beslutningene på et behandlingssteg.
 *
 * Kommentaren lagres to steder, avhengig av modus:
 *
 *   Standard («første behandler avgjør») → `steg.Kommentar`
 *   «Alle må avgjøre»                    → `steg.Beslutninger[].Kommentar`
 *
 * Hver leser som bare kjente den ene formen, viste ingenting i den andre
 * modusen — og det så ut som at behandleren ikke hadde skrevet noe. PDF-en
 * leste bare `steg.Kommentar`, mens grensesnittet og datauttrekket bare leste
 * `Beslutninger[]`. Til sammen betydde det at en kommentar aldri var synlig
 * alle stedene den skulle være.
 *
 * Derfor ligger regelen her, ett sted, og alle leser den herfra.
 *
 * MERK: den samme funksjonen finnes i `frontend/js/behandling-kommentar.js`.
 * Sidene kan ikke importere fra `api/`, så den må dupliseres — men
 * `api/test/behandling-kommentar.test.js` kjører BEGGE mot de samme
 * tilfellene og krever samme svar. En kopi som får lov til å drive fra
 * originalen er verre enn to ulike funksjoner, fordi den ser ut som den ene.
 */

/**
 * @returns {{aktor: string, kommentar: string}[]} — tom liste når ingen skrev noe
 */
function kommentarerFor(steg) {
    const ut = [];

    // «Alle må avgjøre»: én kommentar per aktør.
    for (const b of (steg?.Beslutninger || [])) {
        const tekst = String(b?.Kommentar || '').trim();
        if (tekst) ut.push({ aktor: String(b?.Aktor || ''), kommentar: tekst });
    }
    if (ut.length > 0) return ut;

    // Standard: én kommentar på steget, fra den som avgjorde.
    const tekst = String(steg?.Kommentar || '').trim();
    if (tekst) ut.push({ aktor: String(steg?.BehandletAv || ''), kommentar: tekst });
    return ut;
}

/**
 * Kommentarene som én linje, til regneark og lignende.
 *
 * Aktøren tas med bare når det er flere: med én behandler er det unødvendig
 * å gjenta navnet inne i kommentaren, og det er allerede i UtfallAv-kolonnen.
 */
function kommentarLinje(steg) {
    const k = kommentarerFor(steg);
    if (k.length === 0) return '';
    if (k.length === 1) return k[0].kommentar;
    return k.map(x => `${x.aktor}: ${x.kommentar}`).join(' | ');
}

module.exports = { kommentarerFor, kommentarLinje };
