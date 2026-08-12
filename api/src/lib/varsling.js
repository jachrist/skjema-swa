/**
 * Varsling-koordinator.
 *
 * Kaller VARSLING_FLOW_URL (Power Automate) med ferdig-substituerte tekster.
 * Fase 6a: kun 'epost' som kanal. Teams/Planner/Teamskanal kommer i 6c/d
 * ved å utvide `varslinger`-arrayet i payload — flyten støtter det allerede.
 *
 * Skjematype-strukturer (samme som legacy):
 *   Innsenderkvittering: { Aktiv, Emne, Tekst, Format }
 *   Behandling[]: { ..., Varsling: ['epost'], TilBehandler: { Emne, Tekst, Format },
 *                    FraBehandler: [{ BeslutningNr, Emne, Tekst, Format }] }
 */

const { sendEpostViaFlyt, sendVarslerViaFlyt, baseUrl } = require('./flyt-kaller');
const { erstattPlassholdere, byggKontekst } = require('./placeholder');
const rollerStorage = require('./roller-storage');

function standardKvittering() {
    return {
        Aktiv: true,
        Emne: 'Kvittering: "$skjemanavn" er sendt inn',
        Tekst:
            '<p>Hei,</p>' +
            '<p>Vi har mottatt skjemaet "<b>$skjemanavn</b>" ($skjema_id).</p>' +
            '<p><a href="$lenke">Åpne skjemaet</a></p>' +
            '<p>Med vennlig hilsen<br>FHS</p>'
    };
}

function standardTilBehandler() {
    return {
        Emne: 'Skjema til behandling: "$skjemanavn"',
        Tekst:
            '<p>Hei,</p>' +
            '<p>Du har fått et skjema til behandling: "<b>$skjemanavn</b>" ($skjema_id) — steg: $stegnavn.</p>' +
            '<p><a href="$lenke">Åpne skjemaet</a></p>'
    };
}

function standardFraBehandler() {
    return {
        Emne: 'Skjemaet "$skjemanavn" er behandlet',
        Tekst:
            '<p>Hei,</p>' +
            '<p>Skjemaet "<b>$skjemanavn</b>" ($skjema_id) er behandlet på steg $stegnavn.</p>' +
            '<p>Beslutning: <b>$beslutning</b></p>' +
            '<p><a href="$lenke">Åpne skjemaet</a></p>'
    };
}

function skjemaLenke(skjematypeId, skjemaId, request) {
    const base = baseUrl(request);
    if (!base) return '';
    // Query-param-navn må matche evaluering.html (som leser skjematype_id/skjema_id)
    return `${base}/evaluering.html?skjematype_id=${encodeURIComponent(skjematypeId)}&skjema_id=${encodeURIComponent(skjemaId)}`;
}

function harEpostVarsling(steg) {
    if (!steg) return false;
    if (!steg.Varsling) return true;
    const v = Array.isArray(steg.Varsling) ? steg.Varsling : [];
    return v.includes('epost');
}

// Returnerer valgte kanaler (epost/teams/planner/teamskanal).
// Default (hvis Varsling ikke satt): ['epost'] — matcher tidligere oppførsel.
function aktiveKanaler(steg) {
    const v = Array.isArray(steg?.Varsling) ? steg.Varsling : null;
    if (!v || v.length === 0) return ['epost'];
    return v.filter(k => ['epost', 'teams', 'planner', 'teamskanal'].includes(k));
}

async function samleBehandlerMottakere(steg) {
    // Returnerer array av { epost, navn }
    const seen = new Set();
    const out = [];
    for (const p of (steg?.Personer || [])) {
        const s = String(p || '').trim().toLowerCase();
        if (s && !seen.has(s)) { seen.add(s); out.push({ epost: s, navn: '' }); }
    }
    for (const r of (steg?.Roller || [])) {
        try {
            const innehavere = await rollerStorage.hentInnehavere(r);
            for (const i of innehavere) {
                const ep = String(i.EP || i.UPN || '').trim().toLowerCase();
                if (!ep || seen.has(ep)) continue;
                seen.add(ep);
                const navn = [i.EN, i.FN].filter(Boolean).join(', ');
                out.push({ epost: ep, navn });
            }
        } catch (_) { /* prøv neste */ }
    }
    return out;
}

/**
 * Send innsender-kvittering. Kalles ved innsending.
 * opts: { log, request } — request brukes for base_url-fallback.
 */
async function sendInnsenderKvittering(skjema, skjematype, opts = {}) {
    const log = opts.log || (() => {});
    const kv = skjematype?.Innsenderkvittering || {};
    if (kv.Aktiv === false) {
        log('varsling: Innsenderkvittering deaktivert — hopper over');
        return { status: 'hoppet-over' };
    }
    const til = skjema?.Innsender_Epost || skjema?.Innsender_epost || '';
    if (!til) {
        log('varsling: Ingen innsender-epost på skjema — hopper over');
        return { status: 'hoppet-over' };
    }
    const mal = kv.Aktiv === true || kv.Emne || kv.Tekst ? kv : standardKvittering();
    const lenke = skjemaLenke(skjema.Skjematype_id, skjema.Skjema_id, opts.request);
    const kontekst = byggKontekst({ skjema, skjematype, lenke });
    const emne = erstattPlassholdere(mal.Emne || standardKvittering().Emne, kontekst);
    const html = erstattPlassholdere(mal.Tekst || standardKvittering().Tekst, kontekst);
    return await sendEpostViaFlyt({
        mottakere: [{ epost: til, navn: skjema?.Innsender_Navn || '' }],
        emne, html, lenke,
        skjemaId: skjema.Skjema_id,
        skjematypeId: skjema.Skjematype_id,
        skjemaNavn: kontekst.skjemanavn,
        request: opts.request
    }, log);
}

async function sendBehandlerVarsling(skjema, skjematype, steg, opts = {}) {
    const log = opts.log || (() => {});
    if (!steg) return { status: 'hoppet-over', melding: 'Ingen steg' };
    const kanaler = aktiveKanaler(steg);
    if (kanaler.length === 0) {
        log(`varsling: steg ${steg.Steg} har ingen aktive kanaler — hopper over`);
        return { status: 'hoppet-over' };
    }
    const mottakere = await samleBehandlerMottakere(steg);
    if (mottakere.length === 0) {
        log(`varsling: steg ${steg.Steg} har ingen mottakere — hopper over`);
        return { status: 'hoppet-over' };
    }
    const mal = (steg.TilBehandler?.Emne || steg.TilBehandler?.Tekst) ? steg.TilBehandler : standardTilBehandler();
    const lenke = skjemaLenke(skjema.Skjematype_id, skjema.Skjema_id, opts.request);
    const kontekst = byggKontekst({ skjema, skjematype, steg, lenke });
    const emne = erstattPlassholdere(mal.Emne || standardTilBehandler().Emne, kontekst);
    const html = erstattPlassholdere(mal.Tekst || standardTilBehandler().Tekst, kontekst);
    // Planner-oppgave: bruk emne som tittel + lenke som notat. Frist kan settes
    // av PA-flyten (f.eks. +7 dager fra nå) — SWA sender ingen frist selv.
    const planner = kanaler.includes('planner') ? {
        tittel: emne,
        notat: `Åpne skjemaet: ${lenke}`
    } : null;
    return await sendVarslerViaFlyt({
        mottakere,
        varslinger: kanaler,
        emne, html, lenke,
        planner,
        skjemaId: skjema.Skjema_id,
        skjematypeId: skjema.Skjematype_id,
        skjemaNavn: kontekst.skjemanavn,
        stegnavn: kontekst.stegnavn,
        request: opts.request
    }, log);
}

async function sendVarslingAktiveSteg(skjema, skjematype, aktiveSteg, opts = {}) {
    const log = opts.log || (() => {});
    const resultater = [];
    for (const s of aktiveSteg || []) {
        try {
            resultater.push(await sendBehandlerVarsling(skjema, skjematype, s, opts));
        } catch (e) {
            log(`varsling: FEIL for steg ${s?.Steg}: ${e.message}`);
            resultater.push({ status: 'feil', melding: e.message });
        }
    }
    return resultater;
}

async function sendBeslutningVarsling(skjema, skjematype, steg, beslutningNr, beslutningTekst, kommentar, opts = {}) {
    const log = opts.log || (() => {});
    const til = skjema?.Innsender_Epost || skjema?.Innsender_epost || '';
    if (!til) return { status: 'hoppet-over', melding: 'Ingen innsender-epost' };

    const fraBehandler = Array.isArray(steg?.FraBehandler) ? steg.FraBehandler : [];
    const treff = fraBehandler.find(f => Number(f.BeslutningNr) === Number(beslutningNr));
    const mal = treff && (treff.Emne || treff.Tekst) ? treff : standardFraBehandler();

    const lenke = skjemaLenke(skjema.Skjematype_id, skjema.Skjema_id, opts.request);
    const kontekst = byggKontekst({
        skjema, skjematype, steg,
        beslutningTekst,
        kommentar,
        lenke
    });
    const emne = erstattPlassholdere(mal.Emne || standardFraBehandler().Emne, kontekst);
    const html = erstattPlassholdere(mal.Tekst || standardFraBehandler().Tekst, kontekst);
    return await sendEpostViaFlyt({
        mottakere: [{ epost: til, navn: skjema?.Innsender_Navn || '' }],
        emne, html, lenke,
        skjemaId: skjema.Skjema_id,
        skjematypeId: skjema.Skjematype_id,
        skjemaNavn: kontekst.skjemanavn,
        stegnavn: kontekst.stegnavn,
        request: opts.request
    }, log);
}

module.exports = {
    sendInnsenderKvittering,
    sendBehandlerVarsling,
    sendVarslingAktiveSteg,
    sendBeslutningVarsling,
    _samleBehandlerMottakere: samleBehandlerMottakere,
    _skjemaLenke: skjemaLenke
};
