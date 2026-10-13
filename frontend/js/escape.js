/**
 * Escaping av verdier som skal inn i HTML.
 *
 * Fram til 13.10.2026 hadde fem filer hver sin kopi av denne logikken, under
 * tre ulike navn — `escapeHtml`, `escHtml`, `escAttr`, `escapeAttr` — og de
 * svarte ikke likt:
 *
 *   `escAttr` i admin.html og `escapeAttr` i editor.html, register.html og
 *   velgskjematype.html erstattet `"` og `'`, men ikke `\`.
 *
 *   `escapeAttr` i datauttrekk.html var `escapeHtml` under et annet navn, og
 *   escapet ikke `'` i det hele tatt.
 *
 * Den første hadde et hull som lot seg utnytte (se `escapeJsIAttributt`
 * under). Den andre hadde det samme hullet, bare større. Og fordi navnene
 * var nesten like, kunne ingen se forskjell på dem der de ble brukt.
 *
 * Dette er den ene kopien. `api/test/html-injeksjon.test.js` krever at ingen
 * fil lager sin egen igjen.
 */

/**
 * Tekst som skal stå MELLOM tagger, eller i en attributt med doble
 * anførselstegn.
 *
 * `'` escapes også. Det er unødvendig for en attributt med `"` rundt, men
 * gratis — og det gjør funksjonen trygg også i enkeltfnutt-attributter, som
 * finnes i denne kodebasen.
 */
export function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Tekst som skal inn i en JS-STRENG inne i en HTML-attributt:
 *
 *     onclick="slettLogo('${escapeJsIAttributt(navn)}')"
 *
 * To lag tolker verdien etter hverandre, og begge må være dekket. Nettleseren
 * HTML-dekoder attributtverdien FØRST, og kjører resultatet som JavaScript
 * ETTERPÅ. Derfor escapes JS-laget først og HTML-laget sist.
 *
 * **Omvendt rekkefølge gir et hull, og det var hullet som fantes her.** Den
 * gamle versjonen erstattet bare `'` med `\'` og rørte ikke `\`. Da slapp
 * dette gjennom:
 *
 *     navn = "\\');alert(1);//"
 *
 * Bakoverstreken ble stående, apostrofen ble til `\'`, og resultatet var
 * `onclick="f('\\');alert(1);//')"`. JavaScript leste `'\\'` som en streng
 * med én bakoverstrek, og alt etter den som kode.
 *
 * Bakoverstreken MÅ derfor escapes først. Gjøres den sist, dobler den opp
 * bakoverstrekene som nettopp ble satt inn foran apostrofene, og hullet er
 * tilbake.
 */
export function escapeJsIAttributt(s) {
    const js = String(s ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'");
    return js
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
