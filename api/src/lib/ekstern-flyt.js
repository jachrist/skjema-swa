/**
 * Ekstern-flyt-kaller for behandlingssteg med Flyt_url.
 *
 * Når et behandlingssteg har `Flyt_url`, kalles URL-en med hele skjemaData
 * som JSON-payload i stedet for å vente på manuell behandler-beslutning.
 * PA-flyten må ringe tilbake til POST /api/skjemaer/{type}/{id}/beslutning
 * for å sette Beslutning på steget (via x-flow-key-auth).
 *
 * Fire-and-forget: kallet blokkerer ikke innsending/aktivering. Feil logges
 * men avbryter ikke andre aktive steg.
 */

async function kallEksternFlyt(url, skjema, log = () => {}) {
    if (!url) return { status: 'hoppet-over', melding: 'Ingen URL' };
    if (String(process.env.VARSLING_DEAKTIVERT || '').toLowerCase() === 'true') {
        log(`ekstern-flyt DRY-RUN: url=${url} skjema_id=${skjema?.Skjema_id}`);
        return { status: 'deaktivert' };
    }
    try {
        const respons = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(skjema)
        });
        if (!respons.ok) {
            const tekst = await respons.text().catch(() => '');
            log(`ekstern-flyt FEIL: HTTP ${respons.status} — ${tekst.slice(0, 300)}`);
            return { status: 'feil', melding: `HTTP ${respons.status}: ${tekst.slice(0, 300)}` };
        }
        const data = await respons.json().catch(() => ({}));
        log(`ekstern-flyt OK: url=${url.slice(0, 80)}... skjema_id=${skjema?.Skjema_id}`);
        return { status: 'ok', respons: data };
    } catch (e) {
        log(`ekstern-flyt EXCEPTION: ${e.message}`);
        return { status: 'feil', melding: e.message };
    }
}

module.exports = { kallEksternFlyt };
