/**
 * Filstørrelser som tekst.
 *
 * Fram til 16.10.2026 sto formelen `Math.round(bytes / 1024 / 1024 * 10) / 10`
 * i åtte eksemplarer i `admin.html` alene, og i flere varianter ellers: én
 * med `Math.round(bytes / 1024)` kB uten MB-trinn, én med `toFixed(1)`, én
 * med `Math.max(1, …)`. De svarte ikke likt på samme tall.
 *
 * **Og alle avrundet for hardt nedover.** Med én desimal i MB leses alt under
 * ~50 kB som «0 MB». Den første backupen i dev viste «0 MB kryptert», og så
 * tom ut uten å være det — manifestet hadde rader på både `Skjemaer` og
 * `Skjemadefinisjoner`. I pilot og prod, der en backup er titalls megabyte,
 * er feilen usynlig. I et nytt miljø er det nøyaktig når man trenger å se
 * forskjellen på «noen få kB» og «ingenting».
 *
 * Derfor velges enheten etter tallet: byte under 1 kB, så kB, MB, GB, TB.
 * «0 B» betyr da virkelig tomt, og kan ikke forveksles med noe annet.
 *
 * **To eksemplarer finnes likevel, med vilje.** Frontend kan ikke importere
 * fra `api/`, så `api/src/lib/storrelse.js` har den samme funksjonen.
 * `api/test/storrelse.test.js` kjører BEGGE og krever samme svar på hver
 * verdi — regelen får finnes to steder, men ikke svare ulikt.
 *
 * Grenseverdier som står i koden («maks 4 MB») formateres ikke herfra. De er
 * eksakte multipler og leses som tall, ikke som en måling.
 */

/**
 * Antall byte som lesbar tekst, eller `null` hvis tallet ikke gir mening.
 *
 * `null` og ikke «0 B» eller «ukjent»: kallerne skjuler feltet når størrelsen
 * ikke finnes, og «0 B» ville påstått at fila er tom. Forskjellen på «vi vet
 * ikke» og «den er tom» er hele grunnen til at denne funksjonen finnes.
 *
 * Én desimal under 100, hele tall over — «128 MB» er like presist som
 * «128,4 MB» er for den som leser, og kortere. Desimalskilletegnet er komma,
 * som i resten av grensesnittet.
 */
export function formatStorrelse(bytes) {
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
