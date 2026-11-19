/**
 * Markdown → HTML i backend — tvilling av `parseMarkdown` i
 * frontend/js/felt-render.js, og `escapeHtml` i frontend/js/escape.js.
 *
 * Trengs fordi e-posten til utsending og purring nå kan bygges i API-et
 * (lib/epost-maler.js) i stedet for i flyten, og `skjemabeskrivelse` kan være
 * Markdown. Den skal se ut i e-posten slik den ser ut på utfyllingssiden.
 *
 * Funksjonene er KOPIER, med vilje: frontend kan ikke `require` backend.
 * `api/test/markdown-tvilling.test.js` kjører begge mot de samme tekstene og
 * krever likt svar. Endrer du én, ryker den til den andre er endret likt.
 */

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function parseMarkdown(tekst) {
    if (!tekst) return '';
    let s = escapeHtml(tekst);

    // Overskrifter (må komme før andre transformasjoner)
    s = s.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    s = s.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    s = s.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // Lister — samle sammenhengende linjer. Blokken avsluttes med «\n\n»
    // fordi mønsteret spiser linjeskiftet etter siste punkt (se tvillingen).
    s = s.replace(/(^|\n)((?:- .+(?:\n|$))+)/g, (_m, pre, blokk) => {
        const items = blokk.trim().split(/\n/).map(l => '<li>' + l.replace(/^- /, '') + '</li>').join('');
        return pre + '<ul>' + items + '</ul>\n\n';
    });
    s = s.replace(/(^|\n)((?:\d+\. .+(?:\n|$))+)/g, (_m, pre, blokk) => {
        const items = blokk.trim().split(/\n/).map(l => '<li>' + l.replace(/^\d+\. /, '') + '</li>').join('');
        return pre + '<ol>' + items + '</ol>\n\n';
    });

    // Inline: bold, italic, kode, lenke
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Bilder før lenker, og bare http(s) eller relative adresser.
    s = s.replace(/!\[([^\]]*)\]\((https?:\/\/[^)]+|\/[^)]*)\)/g,
        '<img class="md-bilde" src="$2" alt="$1" loading="lazy">');
    // Lenker: http(s), relative og fragmenter. Ikke javascript:/data:.
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+|\/[^)]*|#[^)]*)\)/g,
        '<a class="md-lenke" href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

    // Avsnitt/linjeskift — dobbel newline til </p><p>, enkel til <br>,
    // men ikke inne i eksisterende blokk-tags.
    s = s.split(/\n\n+/).map(par => {
        const trimmed = par.trim();
        if (!trimmed) return '';
        if (/^<(h[1-6]|ul|ol|li|p|blockquote)/i.test(trimmed)) return trimmed;
        return '<p>' + trimmed.replace(/\n/g, '<br>') + '</p>';
    }).join('');
    return s;
}

/** Ren tekst som HTML: escapet, med avsnitt og linjeskift bevart. */
function tekstSomHtml(tekst) {
    if (!tekst) return '';
    return String(tekst).split(/\n\n+/).map(p => p.trim()).filter(Boolean)
        .map(p => '<p>' + escapeHtml(p).replace(/\n/g, '<br>') + '</p>').join('');
}

module.exports = { escapeHtml, parseMarkdown, tekstSomHtml };
