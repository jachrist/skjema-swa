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

function baseUrl(request) {
    const fra_env = String(process.env.SWA_URL || '').replace(/\/+$/, '');
    if (fra_env) return fra_env;
    // Fallback: utled fra request-headers hvis env-var ikke er satt.
    // SWA-fronten SKAL sette x-forwarded-host til den offentlige *.azurestaticapps.net,
    // men i praksis får vi ofte den interne *.azurewebsites.net-hosten. Filtrer bort
    // interne Function-adresser — de gir dødlenker.
    if (request?.headers?.get) {
        const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || '';
        const proto = request.headers.get('x-forwarded-proto') || 'https';
        if (host && !host.includes('.azurewebsites.net')) {
            return `${proto}://${host}`;
        }
    }
    return '';
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
/**
 * Send varsling via PA-flyt over én eller flere kanaler.
 * varslinger-array kan inneholde: 'epost', 'teams', 'planner', 'teamskanal'.
 * PA-flyten switcher basert på kanal-innhold.
 */
async function sendVarslerViaFlyt(args, log = () => {}) {
    const mottakere = (args.mottakere || []).filter(m => m && m.epost);
    if (mottakere.length === 0) return { status: 'hoppet-over', melding: 'Ingen mottakere' };
    const varslinger = Array.isArray(args.varslinger) && args.varslinger.length > 0 ? args.varslinger : ['epost'];

    const felleslenke = args.lenke || '';
    const lenker = Array.isArray(args.lenker) && args.lenker.length > 0
        ? args.lenker
        : mottakere.map(m => ({ epost: m.epost, url: felleslenke }));

    const base = baseUrl(args.request);
    const payload = {
        handling: 'sendBehandlingsVarsling',
        mottakere: mottakere.map(m => ({ epost: m.epost, navn: m.navn || '' })),
        varslinger,
        skjema_id: args.skjemaId || '',
        skjematype_id: args.skjematypeId || '',
        skjema_navn: args.skjemaNavn || '',
        stegnavn: args.stegnavn || '',
        lenker,
        base_url: base,
        epost_og_teams: {
            emne: args.emne || '',
            html: args.html || ''
        },
        // Ett objekt per kanal, satt bare når kanalen er aktiv. Feltene er
        // ferdig oppløst — flyten skal ikke kunne noe om plassholdere,
        // rollemodellen vår eller hvordan en frist skal regnes ut.
        //
        //   planner    { tittel, plan, bucket, status, prioritet, forfallsdato,
        //                sjekkliste[], sjekkliste_graph{}, notat,
        //                ansvarlige[{epost,navn}] }
        //
        // sjekkliste_graph er de samme punktene i formen Graph vil ha dem på
        // PATCH /planner/tasks/{id}/details — et kart med klientgenererte
        // GUID-nøkler. Det sendes ferdig fordi objekter med dynamiske nøkler
        // er tungvint å bygge i Power Automate.
        //   teamskanal { team, kanal, tittel, innhold }
        //   teams      { tittel, innhold }
        //
        // Tomme strenger betyr «ikke satt» — da skal flyten bruke sitt eget
        // standardvalg, slik den gjorde før kanaloppsettet fantes.
        planner: args.planner || null,
        teamskanal: args.teamskanal || null,
        teams: args.teams || null
    };
    log(`flyt payload: kanaler=[${varslinger.join(',')}] base_url=${base || '(TOM!)'} mottakere=${payload.mottakere.length}`);
    return await kallVarslingFlyt(payload, log);
}

// Bakoverkompatibel wrapper — kun e-post
async function sendEpostViaFlyt(args, log = () => {}) {
    return await sendVarslerViaFlyt({ ...args, varslinger: ['epost'] }, log);
}

/**
 * Send OTP-kode via PA-flyt. Kanal = 'epost' eller 'sms'. Mottaker = e-post
 * eller mobilnummer (E.164-format for SMS anbefales, f.eks. +4741234567).
 *
 * Env: OTP_FLOW_URL — PA-flyt som håndterer begge kanaler via handling.
 * Payload:
 *   { handling: 'sendOtp', kanal, mottaker, kode, gyldig_minutter }
 *
 * PA-flyten forventes å inneholde en switch på kanal:
 *   epost → Office 365 Send an email
 *   sms   → HTTP/connector mot SMS-leverandør (Twilio/Sveve/LinkMobility/ACS)
 */
async function sendOtpViaFlyt({ kanal, mottaker, kode, gyldigMinutter = 15 }, log = () => {}) {
    const url = process.env.OTP_FLOW_URL;
    if (!url) {
        log('otp-flyt: OTP_FLOW_URL ikke satt — hopper over (kode logges NOT for sikkerhet)');
        return { status: 'hoppet-over', melding: 'OTP_FLOW_URL ikke satt' };
    }
    if (String(process.env.VARSLING_DEAKTIVERT || '').toLowerCase() === 'true') {
        // I dry-run logger vi KODE for enkel test — akseptert i pilot.
        log(`otp-flyt DRY-RUN: kanal=${kanal} mottaker=${mottaker} kode=${kode}`);
        return { status: 'deaktivert' };
    }
    try {
        const respons = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ handling: 'sendOtp', kanal, mottaker, kode, gyldig_minutter: gyldigMinutter })
        });
        if (!respons.ok) {
            const tekst = await respons.text().catch(() => '');
            log(`otp-flyt FEIL: HTTP ${respons.status} — ${tekst.slice(0, 300)}`);
            return { status: 'feil', melding: `HTTP ${respons.status}` };
        }
        log(`otp-flyt OK: kanal=${kanal} mottaker=${mottaker.slice(0, 3)}...`);
        return { status: 'ok' };
    } catch (e) {
        log(`otp-flyt EXCEPTION: ${e.message}`);
        return { status: 'feil', melding: e.message };
    }
}

module.exports = {
    kallVarslingFlyt,
    sendEpostViaFlyt,
    sendVarslerViaFlyt,
    sendOtpViaFlyt,
    baseUrl
};
