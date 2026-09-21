/**
 * Kaller Power Automate-flyt for varsling.
 *
 * Bruker eksisterende VARSLING_FLOW_URL (samme "tynne" flyt som legacy).
 * Flyten gjør INGEN oppslag, INGEN mal-fletting og INGEN plassholder-erstatning.
 * Alle tekster og verdier MÅ være fullt oppløst før kallet.
 *
 * Env-vars:
 *   VARSLING_FLOW_URL     — PA-endepunkt for behandlings-varsling (epost/teams/planner/teamskanal)
 *   TEAM_FLOW_URL         — PA-endepunkt for destruktiv team-synk fra rollegruppe
 *   VARSLING_DEAKTIVERT   — 'true' skrur av kall (dry-run til logg)
 *
 * Payload-kontrakt (samme som legacy — se docs/FASE-6A-EPOST.md):
 *   {
 *     handling: 'sendBehandlingsVarsling',   // se args.handling — kun for logg

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

/**
 * Er varslingskall skrudd av?
 *
 * Regelen er én linje, men den fantes i fire kopier — i denne fila to ganger,
 * i ekstern-flyt.js og i sp-liste.js. Fire kopier av en av/på-bryter er fire
 * sjanser til at de svarer forskjellig, og utslaget hadde vært det verste
 * slaget: noen kanaler sender, andre ikke.
 *
 * Den er eksportert fordi /api/varsling/diag skal svare på det SAMME
 * spørsmålet som kallene stiller. Leste diagnosen env-varen på egen hånd,
 * kunne banneret i admin si «sender» mens koden tørrkjørte.
 *
 * Bare strengen 'true' (uansett kasus, med mellomrom rundt) slår av. Alt
 * annet - 'false', '1', tom verdi, usatt - betyr at det sendes.
 */
function varslingAv() {
    return String(process.env.VARSLING_DEAKTIVERT || '').trim().toLowerCase() === 'true';
}

async function kallVarslingFlyt(payload, log = () => {}) {
    const url = process.env.VARSLING_FLOW_URL;
    if (!url) {
        log('flyt: VARSLING_FLOW_URL ikke satt — hopper over');
        return { status: 'hoppet-over', melding: 'VARSLING_FLOW_URL ikke satt' };
    }
    if (varslingAv()) {
        const mottakerListe = (payload.mottakere || []).map(m => m.epost).join(',');
        log(`flyt DRY-RUN: mottakere=${mottakerListe} varslinger=${(payload.varslinger || []).join(',')} emne="${payload.epost_og_teams?.emne || ''}"`);
        return { status: 'deaktivert', mottakere: payload.mottakere || [] };
    }
    try {
        const respons = await fetch(url, {
            method: 'POST',
            headers: flytHeadere(),
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
/**
 * Hvilket miljø kallet kommer fra.
 *
 * Sendes med i payloaden til alle flytene, slik at ÉN flyt kan forgrene på
 * miljø i stedet for at det vedlikeholdes en kopi per miljø. Adressen flyten
 * kalles på sier ingenting — den er den samme uansett hvem som kaller.
 *
 * `backup`-flyten har fått feltet siden den ble laget; dette gjør det samme
 * for resten, med samme feltnavn.
 */
/**
 * Headere for et utgående flyt-kall.
 *
 * Signaturen i flyt-URL-en (`sig=`) var eneste sperre fram til 14.09.2026.
 * Den som fikk tak i adressen kunne sende en hvilken som helst payload — og
 * siden teksten i e-posten bygges av felter i payloaden, betyr det en melding
 * som ser ut til å komme fra skjemasystemet, med en lenke til hva som helst.
 * At mottakeren ikke får opp et ekte skjema hjelper lite; verdien for en
 * angriper ligger i avsenderinntrykket.
 *
 * `x-flow-key` er samme nøkkel flytene allerede sender INN til oss. Symmetrisk
 * og uten en ny hemmelighet å forvalte: den delte nøkkelen viser at det er oss,
 * begge veier.
 *
 * Er den ikke satt, sendes ingen header. Da oppfører kallet seg som før, og en
 * flyt som ennå ikke sjekker headeren merker ingenting — rekkefølgen ved
 * utrulling er derfor fri.
 */
function flytHeadere() {
    const nokkel = String(process.env.FLOW_CALLBACK_KEY || '').trim();
    return nokkel
        ? { 'Content-Type': 'application/json', 'x-flow-key': nokkel }
        : { 'Content-Type': 'application/json' };
}

function miljo() {
    return String(process.env.MILJO || 'ukjent');
}

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
        // Flyten leser ikke denne — all nødvendig input ligger i resten av
        // payloaden. Den finnes for å kunne se i flytens kjørelogg hvilken
        // varsling et kall stammer fra, og er derfor verdt å skille på.
        handling: args.handling || 'sendBehandlingsVarsling',
        // Lar én flyt forgrene på miljø i stedet for én kopi per miljø.
        miljø: miljo(),
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
    if (varslingAv()) {
        // I dry-run logger vi KODE for enkel test — akseptert i pilot.
        log(`otp-flyt DRY-RUN: kanal=${kanal} mottaker=${mottaker} kode=${kode}`);
        return { status: 'deaktivert' };
    }
    try {
        const respons = await fetch(url, {
            method: 'POST',
            headers: flytHeadere(),
            body: JSON.stringify({ handling: 'sendOtp', miljø: miljo(), kanal, mottaker, kode, gyldig_minutter: gyldigMinutter })
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

/**
 * Synkroniser et team fra en rollegruppe (TODO 71).
 *
 * Env: TEAM_FLOW_URL — PA-flyt som melder inn og ut medlemmer i et team.
 * Payload bygges av `team-synk.js`; se den for hvorfor kallet aldri gjøres
 * med tom medlemsliste.
 *
 * `VARSLING_DEAKTIVERT` skrur også av denne. Den bryteren betyr «ikke rør noe
 * utenfor systemet», og en destruktiv teamoppdatering er nettopp det —
 * tydeligere enn en e-post, faktisk.
 *
 * Feiler kallet, returneres status 'feil' i stedet for å kaste. Kalleren
 * kjører flere grupper etter hverandre, og én flyt som er nede skal ikke
 * stoppe resten.
 */
async function kallTeamSynkFlyt(payload, log = () => {}) {
    const url = process.env.TEAM_FLOW_URL;
    if (!url) {
        log('team-flyt: TEAM_FLOW_URL ikke satt — hopper over');
        return { status: 'hoppet-over', melding: 'TEAM_FLOW_URL ikke satt' };
    }
    if (varslingAv()) {
        log(`team-flyt DRY-RUN: team="${payload.TeamNavn || payload.TeamId}" `
            + `rolle=${payload.Rolle}(${payload.Omfang}) medlemmer=${payload.Antall}`);
        return { status: 'deaktivert', antall: payload.Antall };
    }
    // Siste skanse. Sperrene ligger i team-synk.js, men dette kallet melder
    // folk UT av et team, og en tom liste skal ikke kunne nå flyten uansett
    // hvilken vei den kom hit.
    if (!Array.isArray(payload.Medlemmer) || payload.Medlemmer.length === 0) {
        log('team-flyt: tom medlemsliste — kallet ble ikke sendt');
        return { status: 'feil', melding: 'Tom medlemsliste sendes ikke' };
    }
    try {
        const respons = await fetch(url, {
            method: 'POST',
            headers: flytHeadere(),
            body: JSON.stringify(payload)
        });
        if (!respons.ok) {
            const tekst = await respons.text().catch(() => '');
            log(`team-flyt FEIL: HTTP ${respons.status} — ${tekst.slice(0, 300)}`);
            return { status: 'feil', melding: `HTTP ${respons.status}` };
        }
        const data = await respons.json().catch(() => ({}));
        log(`team-flyt OK: ${payload.Rolle}(${payload.Omfang}) → ${payload.Antall} medlemmer`);
        return { status: 'ok', respons: data };
    } catch (e) {
        log(`team-flyt EXCEPTION: ${e.message}`);
        return { status: 'feil', melding: e.message };
    }
}

module.exports = {
    kallVarslingFlyt,
    varslingAv,
    sendEpostViaFlyt,
    sendVarslerViaFlyt,
    sendOtpViaFlyt,
    kallTeamSynkFlyt,
    baseUrl,
    miljo,
    flytHeadere
};
