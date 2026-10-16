/**
 * Filstørrelser som tekst — BACKEND-TVILLINGEN.
 *
 * Originalen er `frontend/js/storrelse.js`. Frontend kan ikke importere fra
 * `api/`, og backend kan ikke importere en ES-modul fra `frontend/` uten et
 * byggsteg, så regelen finnes to steder. Det er den ene formen for duplikat
 * dette repoet godtar — og bare fordi `api/test/storrelse.test.js` kjører
 * BEGGE funksjonene mot den samme lista med verdier og krever samme svar.
 *
 * Endres den ene, feiler testen til den andre er endret likt. Les
 * begrunnelsen for selve formateringen i frontend-fila; den gjentas ikke her,
 * for to forklaringer som skal si det samme er neste kopi i rekka.
 */

function formatStorrelse(bytes) {
    // «Ikke oppgitt» er ikke det samme som null byte. `Number(null)` er 0, så
    // uten denne linja ville et felt som mangler blitt til «0 B» — altså en
    // påstand om at fila er tom.
    if (bytes === null || bytes === undefined || bytes === '') return null;
    const n = Number(bytes);
    if (!Number.isFinite(n) || n < 0) return null;
    // Avrundingen gjøres FØR sammenligningen. Ellers blir 1023,6 til «1024 B»
    // i stedet for «1 kB» — en enhet som ikke finnes i tabellen under.
    const heleByte = Math.round(n);
    if (heleByte < 1024) return `${heleByte} B`;
    // Tabellen står INNE i funksjonen med vilje. Testene klipper funksjonen ut
    // av fila og kjører den alene; en konstant utenfor ville blitt med i
    // kildelesingen, men ikke i kjøringen — og den fellen har kostet tid før.
    const enheter = [
        ['TB', 1024 * 1024 * 1024 * 1024],
        ['GB', 1024 * 1024 * 1024],
        ['MB', 1024 * 1024],
        ['kB', 1024]
    ];
    for (const [navn, faktor] of enheter) {
        if (heleByte < faktor) continue;
        const tall = heleByte / faktor;
        const vist = tall >= 100 ? Math.round(tall) : Math.round(tall * 10) / 10;
        return `${String(vist).replace('.', ',')} ${navn}`;
    }
    return `${heleByte} B`;
}

module.exports = { formatStorrelse };
