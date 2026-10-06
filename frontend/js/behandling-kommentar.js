/**
 * Kommentarene som ble gitt med beslutningene på et behandlingssteg.
 *
 * KOPI av `api/src/lib/behandling-kommentar.js`. Sidene kan ikke importere fra
 * `api/`, så regelen må finnes to steder — men `api/test/behandling-kommentar.test.js`
 * kjører BEGGE mot de samme tilfellene og krever samme svar. Endres den ene,
 * må den andre endres i samme slengen.
 *
 * Kommentaren lagres to steder, avhengig av modus:
 *
 *   Standard («første behandler avgjør») → `steg.Kommentar`
 *   «Alle må avgjøre»                    → `steg.Beslutninger[].Kommentar`
 *
 * Hver leser som bare kjente den ene formen, viste ingenting i den andre
 * modusen — og det så ut som at behandleren ikke hadde skrevet noe.
 */

/** @returns {{aktor: string, kommentar: string}[]} — tom liste når ingen skrev noe */
export function kommentarerFor(steg) {
    const ut = [];

    for (const b of (steg?.Beslutninger || [])) {
        const tekst = String(b?.Kommentar || '').trim();
        if (tekst) ut.push({ aktor: String(b?.Aktor || ''), kommentar: tekst });
    }
    if (ut.length > 0) return ut;

    const tekst = String(steg?.Kommentar || '').trim();
    if (tekst) ut.push({ aktor: String(steg?.BehandletAv || ''), kommentar: tekst });
    return ut;
}

/**
 * Stilen på en kommentarlinje under et behandlingssteg.
 *
 * Inline, ikke en klasse. Stegraden er en flex-boks på alle de tre sidene, og
 * `width: 100%` er det som gjør at kommentaren får en linje for seg selv i
 * stedet for å bli klemt inn ved siden av stegnavnet.
 *
 * `kommentarerSomHtml` satte klassen `beh-kommentar`, og den klassen hadde
 * ingen regel på noen side. I registeret ble kommentaren derfor et navnløst
 * flex-element uten bredde — den sto i markupen, men var i praksis ikke til å
 * se. Visning og evaluering hadde hver sin kopi av stilen under, og de var
 * like fordi noen hadde klippet dem; ingenting holdt dem like.
 */
export const KOMMENTAR_STIL = 'width: 100%; font-size: 11px; color: var(--text-secondary);'
    + ' border-left: 2px solid var(--border-color); padding-left: 8px; margin-top: 4px;';

/**
 * Kommentarene som HTML, til bruk under et behandlingssteg.
 *
 * `escape` sendes inn i stedet for å importeres: `felt-render.js` er tung, og
 * denne modulen brukes av sider som ellers ikke trenger den.
 */
export function kommentarerSomHtml(steg, escape) {
    const k = kommentarerFor(steg);
    if (k.length === 0) return '';
    const rader = k.map(x => `<div style="${KOMMENTAR_STIL}">`
        + (x.aktor ? `<em>${escape(x.aktor)}:</em> ` : '')
        + `${escape(x.kommentar)}</div>`);
    return rader.join('');
}
