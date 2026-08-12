/**
 * Ekstern-flyt-kaller for behandlingssteg med Flyt_url.
 *
 * Payload til PA-flyten:
 *   {
 *     skjema: { ... hele skjemaData ... },
 *     steg: 2,                           // stegnummer denne PA-flyten håndterer
 *     stegnavn: "Godkjenning",
 *     beslutningsvalg: [{Nummer,Tekst,Handling}...],  // valg PA kan bruke i callback
 *     callbackUrl: "https://.../api/skjemaer/{type}/{id}/beslutning"
 *   }
 *
 * PA-flyten fullfører steget ved å POSTe til callbackUrl med:
 *   Header: x-flow-key: <FLOW_CALLBACK_KEY>
 *   Body:   { steg: 2, beslutning: 1, kommentar?: "..." }
 *
 * Fire-and-forget: kallet blokkerer ikke innsending/aktivering. Feil logges
 * men avbryter ikke andre aktive steg. Duplikate callbacks er trygge —
 * beslutning-endpoint returnerer 409 hvis steget allerede er fullført.
 */

function utledSwaBaseUrl() {
    const fra = String(process.env.SWA_URL || '').trim();
    if (fra) return fra.replace(/\/$/, '');
    return '';
}

async function kallEksternFlyt(url, skjema, steg, log = () => {}) {
    if (!url) return { status: 'hoppet-over', melding: 'Ingen URL' };
    if (String(process.env.VARSLING_DEAKTIVERT || '').toLowerCase() === 'true') {
        log(`ekstern-flyt DRY-RUN: url=${url} skjema_id=${skjema?.Skjema_id} steg=${steg?.Steg}`);
        return { status: 'deaktivert' };
    }
    // Bygg callback-URL så PA-flyten kan sette Beslutning uten å konstruere URLen
    const swa = utledSwaBaseUrl();
    const callbackUrl = swa && skjema?.Skjematype_id && skjema?.Skjema_id
        ? `${swa}/api/skjemaer/${encodeURIComponent(skjema.Skjematype_id)}/${encodeURIComponent(skjema.Skjema_id)}/beslutning`
        : '';
    const payload = {
        skjema,
        steg: Number(steg?.Steg) || null,
        stegnavn: steg?.Stegnavn || '',
        beslutningsvalg: Array.isArray(steg?.Beslutningsvalg) ? steg.Beslutningsvalg : [],
        callbackUrl
    };
    try {
        const respons = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!respons.ok) {
            const tekst = await respons.text().catch(() => '');
            log(`ekstern-flyt FEIL: HTTP ${respons.status} — ${tekst.slice(0, 300)}`);
            return { status: 'feil', melding: `HTTP ${respons.status}: ${tekst.slice(0, 300)}` };
        }
        const data = await respons.json().catch(() => ({}));
        log(`ekstern-flyt OK: url=${url.slice(0, 80)}... skjema_id=${skjema?.Skjema_id} steg=${payload.steg}`);
        return { status: 'ok', respons: data };
    } catch (e) {
        log(`ekstern-flyt EXCEPTION: ${e.message}`);
        return { status: 'feil', melding: e.message };
    }
}

module.exports = { kallEksternFlyt };
