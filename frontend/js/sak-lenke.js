/**
 * Sak-lenka: `?t=<token>` i e-posten til en ekstern innsender.
 *
 * Eksterne har ingen innlogging. Lenka i kvitteringen, beslutningsvarselet og
 * samtalevarselet bærer derfor et token bundet til saken (api/src/lib/
 * sak-token.js). Sidene som tar imot den — visning.html, kvittering.html og
 * index.html ved retting — gjør tre ting likt, og de bor her:
 *
 *   1. leser tokenet fra adressen
 *   2. sender det som `x-sak-token` på hvert API-kall
 *   3. tar det med videre i lenker til de andre sidene om samme sak
 *
 * Navnet på parameteren og headeren står ett sted på hver side av API-et.
 * `api/test/sak-token.test.js` leser begge og krever at de stemmer.
 */
export const SAK_PARAM = 't';
export const SAK_HEADER = 'x-sak-token';

/** Tokenet i adressen, eller ''. */
export function sakToken(params) {
    return (params && params.get(SAK_PARAM)) || '';
}

/** Les tokenet og legg det på API-klienten. Returnerer tokenet, eller ''. */
export function brukSakToken(api, params) {
    const t = sakToken(params);
    if (t) api.settHeader(SAK_HEADER, t);
    return t;
}

/** `url` med tokenet lagt på, eller uendret uten token. */
export function medSakToken(url, t) {
    if (!t) return url;
    const [hode, anker] = String(url).split('#');
    const skille = hode.includes('?') ? '&' : '?';
    return `${hode}${skille}${SAK_PARAM}=${encodeURIComponent(t)}${anker !== undefined ? '#' + anker : ''}`;
}
