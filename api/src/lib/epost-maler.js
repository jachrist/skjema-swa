/**
 * Tekstene i e-postene flyten skrev selv: engangskode, utsending og purring.
 *
 * Med e-post via Graph (lib/graph-epost.js) er det ingen flyt som setter dem
 * sammen, så de bygges her. Varslingene hadde ferdig tekst fra før
 * (lib/varsling.js); disse tre var de siste der flyten måtte «komponere»
 * (docs/FASE-UTSENDING-SAMMENSLAING.md).
 *
 * Tekstene går til EKSTERNE mottakere. Alt som kommer fra en skjematype —
 * navn, beskrivelse, purretekst — escapes. Beskrivelsen rendres som Markdown
 * når skjematypen sier det, med samme regel som utfyllingssiden.
 *
 * Endres tekstene her, er det dette mottakerne ser. Flytveien er urørt.
 */
const { escapeHtml, parseMarkdown, tekstSomHtml } = require('./markdown');

/** `2026-12-01` eller en ISO-tid → `01.12.2026`. Ellers som den er. */
function dato(verdi) {
    const s = String(verdi || '').trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    return m ? `${m[3]}.${m[2]}.${m[1]}` : s;
}

function beskrivelse(post) {
    const b = post?.skjemabeskrivelse || '';
    if (!b) return '';
    return String(post?.skjemabeskrivelseFormat || '').toLowerCase() === 'markdown' ? parseMarkdown(b) : tekstSomHtml(b);
}

function lenkeOgFrist(post) {
    const frist = post?.avslutningsdato ? `<p>Svarfrist: <b>${escapeHtml(dato(post.avslutningsdato))}</b>.</p>` : '';
    return `<p><a href="${escapeHtml(post?.url || '')}">Åpne skjemaet</a></p>${frist}`
        + '<p>Lenken er personlig. Ikke del den videre.</p>';
}

/** Engangskoden til en ekstern innsender. */
function engangskode({ kode, gyldigMinutter = 15 }) {
    return {
        emne: 'Engangskode til FHS Skjema',
        html: `<p>Koden din er <b style="font-size: 18px; letter-spacing: 2px;">${escapeHtml(kode)}</b></p>`
            + `<p>Den gjelder i ${escapeHtml(gyldigMinutter)} minutter.</p>`
            + '<p>Har du ikke bedt om en kode, kan du se bort fra denne e-posten.</p>'
    };
}

/** Første utsending av en skjemalenke. */
function utsending(post) {
    const navn = post?.skjemanavn || 'et skjema';
    return {
        emne: `Skjema til utfylling: ${navn}`,
        html: '<p>Hei,</p>'
            + `<p>Du er bedt om å fylle ut «<b>${escapeHtml(navn)}</b>».</p>`
            + beskrivelse(post)
            + lenkeOgFrist(post)
    };
}

/** Påminnelse til den som ikke har svart. `purretekst` er skjemaeierens egen. */
function purring(post) {
    const navn = post?.skjemanavn || 'et skjema';
    const egen = String(post?.purretekst || '').trim();
    return {
        emne: `Påminnelse: ${navn}`,
        html: '<p>Hei,</p>'
            + (egen ? tekstSomHtml(egen) : `<p>Vi har ennå ikke fått svaret ditt på «<b>${escapeHtml(navn)}</b>».</p>`)
            + lenkeOgFrist(post)
    };
}

module.exports = { engangskode, utsending, purring, dato };
