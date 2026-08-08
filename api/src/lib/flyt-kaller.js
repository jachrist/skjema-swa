/**
 * Kaller Power Automate-flyt for varsling.
 *
 * Bruker eksisterende VARSLING_FLOW_URL (samme "tynne" flyt som legacy).
 * Flyten gjør INGEN oppslag, INGEN mal-fletting og INGEN plassholder-erstatning.
 * Alle tekster og verdier MÅ være fullt oppløst før kallet.
 *
 * Env-vars:
 *   VARSLING_FLOW_URL     — PA-endepunkt for behandlings-varsling (epost/teams/planner/teamskanal)
 *   VARSLING_DEAKTIVERT   — 'true' skrur av kall (dry-run til logg)
 *
 * Payload-kontrakt (samme som legacy — se docs/FASE-6A-EPOST.md):
 *   {
 *     handling: 'sendBehandlingsVarsling',
 *     mottakere: [{ epost, navn }],
 *     varslinger: ['epost'],           // 0..4: epost/teams/planner/teamskanal
 *     skjema_id, skjematype_id, skjema_navn, stegnavn,
 *     lenker: [{ epost, url }],        // per-mottaker
 *     base_url,
 *     epost_og_teams: { emne, html }   // kun hvis epost/teams i varslinger
 *   }
 */

function baseUrl() {
    return String(process.env.SWA_URL || '').replace(/\/+$/, '');
}

async function kallVarslingFlyt(payload, log = () => {}) {
    const url = process.env.VARSLING_FLOW_URL;
    if (!url) {
        log('flyt: VARSLING_FLOW_URL ikke satt — hopper over');
        return { status: 'hoppet-over', melding: 'VARSLING_FLOW_URL ikke satt' };
    }
    if (String(process.env.VARSLING_DEAKTIVERT || '').toLowerCase() === 'true') {
        const mottakerListe = (payload.mottakere || []).map(m => m.epost).join(',');
        log(`flyt DRY-RUN: mottakere=${mottakerListe} varslinger=${(payload.varslinger || []).join(',')} emne="${payload.epost_og_teams?.emne || ''}"`);
        return { status: 'deaktivert', mottakere: payload.mottakere || [] };
    }
    try {
        const respons = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!respons.ok) {
            const tekst = await respons.text().catch(() => '');
            log(`flyt FEIL: ${respons.status} — ${tekst.slice(0, 300)}`);
            return { status: 'feil', melding: `HTTP ${respons.status}: ${tekst.slice(0, 300)}` };
        }
        const data = await respons.json().catch(() => ({}));
        log(`flyt OK: mottakere=${(payload.mottakere || []).length} → ${JSON.stringify(data).slice(0, 200)}`);
        return { status: 'ok', respons: data };
    } catch (e) {
        log(`flyt EXCEPTION: ${e.message}`);
        return { status: 'feil', melding: e.message };
    }
}

/**
 * Send e-post-varsling. Enkleste form av kallVarslingFlyt — kun 'epost' som kanal.
 *
 * @param {object} args
 * @param {Array<{epost,navn?}>} args.mottakere
 * @param {string} args.emne
 * @param {string} args.html
 * @param {string} args.skjemaId
 * @param {string} args.skjematypeId
 * @param {string} args.skjemaNavn
 * @param {string} [args.stegnavn]
 * @param {string} [args.lenke]         — felles lenke; per-mottaker lenker bygges automatisk
 * @param {Array<{epost,url}>} [args.lenker] — evt. per-mottaker (overstyrer lenke)
 */
async function sendEpostViaFlyt(args, log = () => {}) {
    const mottakere = (args.mottakere || []).filter(m => m && m.epost);
    if (mottakere.length === 0) return { status: 'hoppet-over', melding: 'Ingen mottakere' };

    const felleslenke = args.lenke || '';
    const lenker = Array.isArray(args.lenker) && args.lenker.length > 0
        ? args.lenker
        : mottakere.map(m => ({ epost: m.epost, url: felleslenke }));

    const payload = {
        handling: 'sendBehandlingsVarsling',
        mottakere: mottakere.map(m => ({ epost: m.epost, navn: m.navn || '' })),
        varslinger: ['epost'],
        skjema_id: args.skjemaId || '',
        skjematype_id: args.skjematypeId || '',
        skjema_navn: args.skjemaNavn || '',
        stegnavn: args.stegnavn || '',
        lenker,
        base_url: baseUrl(),
        epost_og_teams: {
            emne: args.emne || '',
            html: args.html || ''
        }
    };
    return await kallVarslingFlyt(payload, log);
}

module.exports = {
    kallVarslingFlyt,
    sendEpostViaFlyt,
    baseUrl
};
