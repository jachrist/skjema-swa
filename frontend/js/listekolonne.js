/**
 * Hvilke felt skal stå i registerlistas oversiktskolonne?
 *
 * Lista viste `#123 — innsender@mil.no` for hver rad. For saker er det
 * riktig — der ER innsenderen og saksnummeret det man leter etter. For en
 * skjematype som brukes som register over masterdata (270 informasjonstyper,
 * ett skjema per datapunkt) er det ubrukelig: man leter etter
 * `epost_privat`, ikke etter sak 123.
 *
 * Skjemaskaperen krysser av «Vis i registerlista» på feltene som skal stå
 * der. Ingen avkrysning gir oppførselen fra før.
 *
 * KOPI av `api/src/lib/listekolonne.js`. Sidene kan ikke `require` fra
 * `api/`, så regelen må finnes to steder — `api/test/listekolonne.test.js`
 * kjører BEGGE mot de samme tilfellene og krever samme svar.
 *
 * Nøkkelen `${sekNr}-${feltNrPadded}` er den samme som `FilterSvar` i
 * `/api/skjema-liste` bruker. Det er ikke tilfeldig: serveren tar med disse
 * feltene i FilterSvar nettopp for at lista skal kunne tegne dem.
 */

/** @returns {{sekNr: string, feltNrPadded: string, nokkel: string, Tekst: string}[]} */
export function listekolonner(skjematype) {
    const ut = [];
    for (const s of (skjematype?.Seksjoner || [])) {
        for (const f of (s?.Felter || [])) {
            if (f?.Listekolonne !== true) continue;
            // Et informasjonsfelt har ingen svar å vise. Uten dette ville en
            // avkrysning der gitt en tom kolonne og ingen forklaring.
            if (f.Type === 'Informasjon') continue;
            const sekNr = String(s.Seksjon_nummer ?? s.Nummer ?? '');
            const feltNrPadded = String(f.Nummer ?? '').padStart(2, '0');
            // `Tekst` er en streng på vanlige felt, men et objekt
            // ({ Verdi, Format }) på informasjonsfelt. De er filtrert bort
            // over, men formen leses defensivt: en «[object Object]» i en
            // etikett er den slags feil ingen melder, bare lever med.
            const tekst = typeof f.Tekst === 'object' && f.Tekst ? (f.Tekst.Verdi ?? '') : (f.Tekst ?? '');
            ut.push({ sekNr, feltNrPadded, nokkel: `${sekNr}-${feltNrPadded}`, Tekst: String(tekst) });
        }
    }
    return ut;
}

