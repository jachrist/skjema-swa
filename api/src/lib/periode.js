/**
 * periode.js — Er en skjematype åpen for utfylling akkurat nå?
 *
 * Format: `Tilgjengelighetsperioder: [{ Fra: "YYYY-MM-DD", Til: "YYYY-MM-DD" }]`
 * - Både Fra og Til er inklusive (hele dagen)
 * - Fra/Til kan være tomme — betyr «ingen grense»
 * - Ingen perioder = alltid tilgjengelig
 * - Én treff er nok (perioder OR-es sammen)
 *
 * **Regelen sto bare ett sted, og det var grensesnittet.** `ErIPeriode` og
 * `KanFylle` i kortlista gjorde at skjemaet ikke lot seg åpne fra oversikten
 * — men `lagreSkjema` spurte aldri. Med utfyllingslenka direkte kunne et
 * stengt skjema både fylles ut og sendes inn. Meldt 20.10.2026.
 *
 * Samme mønster som `svargrense.js`: sperren bor i `lagreSkjema`, og
 * `kan-svare` svarer på det samme så ingen fyller ut et helt skjema før de
 * får vite at det er stengt. Begge leser DENNE fila.
 *
 * HVEM DEN GJELDER. Alle, også eiere og administratorer — samme valg som
 * svargrensen. Kortlista har alltid regnet `KanFylle` som `kanFylle &&
 * iPeriode` for eiere også, så det er den etablerte oppførselen; en eier som
 * skal prøve et stengt skjema, utvider perioden.
 *
 * HVA DEN GJELDER. Alt som skrives av den som fyller ut — både utkast og
 * innsending. Ikke oppdateringer av et skjema som alt ER sendt inn: en
 * behandler som registrerer en beslutning etter at perioden er ute, skal
 * ikke møte en sperre som gjelder utfyllingen. Det er samme skille
 * `svargrense.erNyInnsending` gjør, med én forskjell: et UTKAST utenfor
 * perioden skal også avvises. Det er en bevisst strenghet — fristen gjelder
 * også den som begynte før den gikk ut.
 */

/** Feltnavnet, ett sted. Tre lesere skrev det av fra hverandre før dette. */
const FELT = 'Tilgjengelighetsperioder';

/** Periodene på en skjematype-JSON. Alltid en liste, aldri undefined. */
function perioderFra(skjematypeJson) {
    const p = skjematypeJson && skjematypeJson[FELT];
    return Array.isArray(p) ? p : [];
}

function erTilgjengeligNaa(perioder, naa = new Date()) {
    if (!Array.isArray(perioder) || perioder.length === 0) return true;
    const naaMs = naa.getTime();

    for (const p of perioder) {
        const fra = p?.Fra ? parseDato(p.Fra, false) : -Infinity;
        const til = p?.Til ? parseDato(p.Til, true)  : Infinity;
        if (fra === null || til === null) continue; // ugyldig dato — hopp over
        if (naaMs >= fra && naaMs <= til) return true;
    }
    return false;
}

function parseDato(iso, slutten) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
        slutten ? 23 : 0, slutten ? 59 : 0, slutten ? 59 : 0, slutten ? 999 : 0);
    return d.getTime();
}

/**
 * Skal denne lagringen i det hele tatt prøves mot perioden?
 *
 * Egen navngitt funksjon av samme grunn som `svargrense.maaSjekkes`: et
 * vilkår inne i en handler kan byttes ut med `if (false)` uten at noen test
 * merker det, for kallene rundt står jo fortsatt der. Som regel kan den
 * prøves direkte, og endepunktet må bruke svaret for å komme til sperren.
 *
 * `gammelStatus` er statusen raden hadde FØR denne lagringen. Er den 2 eller
 * mer, er skjemaet alt sendt inn, og dette er behandling — ikke utfylling.
 */
function maaSjekkes({ perioder, gammelStatus }) {
    return Array.isArray(perioder) && perioder.length > 0
        && Number(gammelStatus || 0) < 2;
}

/** 2026-10-20 → 20.10.2026. Tom streng for alt som ikke er en dato. */
function norskDato(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

/**
 * Hva brukeren skal få se når skjemaet er stengt.
 *
 * En melding som bare sier «stengt» sender folk til support for å spørre om
 * når. Står datoene i perioden, skal de med: «åpner 01.11.2026» og «var åpent
 * til 15.10.2026» er to helt ulike beskjeder, og den som leser dem trenger
 * ikke å gjette hvilken som gjelder.
 */
function avvisningstekst(perioder, naa = new Date()) {
    const naaMs = naa.getTime();
    const gyldige = (Array.isArray(perioder) ? perioder : [])
        .filter(p => p && (p.Fra || p.Til));

    const kommende = gyldige
        .filter(p => p.Fra && parseDato(p.Fra, false) > naaMs)
        .sort((a, b) => String(a.Fra).localeCompare(String(b.Fra)));
    if (kommende.length) {
        const p = kommende[0];
        return p.Til
            ? `Skjemaet er åpent for utfylling ${norskDato(p.Fra)}–${norskDato(p.Til)}.`
            : `Skjemaet åpner for utfylling ${norskDato(p.Fra)}.`;
    }

    const passerte = gyldige
        .filter(p => p.Til && parseDato(p.Til, true) < naaMs)
        .sort((a, b) => String(b.Til).localeCompare(String(a.Til)));
    if (passerte.length) {
        return `Utfyllingsperioden er ute — skjemaet var åpent til ${norskDato(passerte[0].Til)}.`;
    }

    return 'Skjemaet er ikke åpent for utfylling nå.';
}

/**
 * Hele dommen, i én form begge kallstedene kan bruke.
 * `{ ok: true }` når skjemaet er åpent, ellers `{ ok: false, melding }`.
 */
function sjekkPeriode(perioder, naa = new Date()) {
    if (erTilgjengeligNaa(perioder, naa)) return { ok: true };
    return { ok: false, melding: avvisningstekst(perioder, naa) };
}

module.exports = {
    erTilgjengeligNaa, perioderFra, maaSjekkes, sjekkPeriode, avvisningstekst, norskDato, FELT
};
