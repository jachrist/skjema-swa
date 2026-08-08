/**
 * E-post-avsender via SMTP (nodemailer).
 *
 * Env-vars:
 *   SMTP_HOST         — SMTP-server (f.eks. smtp.office365.com)
 *   SMTP_PORT         — port (typisk 587 for STARTTLS, 465 for SSL)
 *   SMTP_USER         — brukernavn (typisk full e-post)
 *   SMTP_PASS         — passord/app-passord (KV-referanse anbefalt)
 *   SMTP_FROM         — avsenderadresse (default = SMTP_USER)
 *   SMTP_FROM_NAVN    — visningsnavn (valgfritt)
 *   SMTP_SECURE       — 'true' = TLS/SSL fra start, ellers STARTTLS
 *   VARSLING_DEAKTIVERT — 'true' skrur av all utsending (dry-run til logg)
 *
 * Lazy-initialisert transporter — første send() bygger den. Feil ved
 * mangelfull config kastes fra send().
 */

let _transporter = null;

function bygg() {
    const host = process.env.SMTP_HOST;
    const port = Number(process.env.SMTP_PORT || 587);
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    if (!host || !user || !pass) {
        throw new Error('SMTP-config mangler (SMTP_HOST, SMTP_USER, SMTP_PASS)');
    }
    // eslint-disable-next-line global-require
    const nodemailer = require('nodemailer');
    return nodemailer.createTransport({
        host,
        port,
        secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465,
        auth: { user, pass }
    });
}

function transporter() {
    if (!_transporter) _transporter = bygg();
    return _transporter;
}

function avsender() {
    const from = process.env.SMTP_FROM || process.env.SMTP_USER || '';
    const navn = process.env.SMTP_FROM_NAVN;
    return navn ? `"${navn.replace(/"/g, '\\"')}" <${from}>` : from;
}

/**
 * Send én e-post.
 * @param {object} melding — { til, emne, html, tekst? }  til kan være streng eller array
 * @returns {Promise<object>} — { status, messageId? } eller { status:'deaktivert' } / { status:'feil', melding }
 */
async function send(melding, log = () => {}) {
    const { til, emne, html, tekst, replyTo } = melding;
    if (!til || (Array.isArray(til) && til.length === 0)) {
        return { status: 'hoppet-over', melding: 'Ingen mottakere' };
    }
    if (!emne) return { status: 'hoppet-over', melding: 'Emne mangler' };

    const mottakere = Array.isArray(til) ? til : [til];
    const rene = mottakere.map(m => String(m || '').trim()).filter(Boolean);
    if (rene.length === 0) return { status: 'hoppet-over', melding: 'Ingen gyldige mottakere' };

    if (String(process.env.VARSLING_DEAKTIVERT || '').toLowerCase() === 'true') {
        log(`epost DRY-RUN: til=${rene.join(',')} emne="${emne}" (${(html || tekst || '').length} tegn)`);
        return { status: 'deaktivert', mottakere: rene };
    }

    try {
        const res = await transporter().sendMail({
            from: avsender(),
            to: rene.join(', '),
            subject: emne,
            html: html || undefined,
            text: tekst || (html ? html.replace(/<[^>]+>/g, '') : ''),
            replyTo: replyTo || undefined
        });
        log(`epost OK: til=${rene.join(',')} emne="${emne}" messageId=${res.messageId}`);
        return { status: 'ok', messageId: res.messageId, mottakere: rene };
    } catch (e) {
        log(`epost FEIL: til=${rene.join(',')} emne="${emne}" — ${e.message}`);
        return { status: 'feil', melding: e.message, mottakere: rene };
    }
}

module.exports = { send };
