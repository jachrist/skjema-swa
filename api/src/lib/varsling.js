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

const crypto = require('crypto');
const { sendEpostViaFlyt, sendVarslerViaFlyt, baseUrl } = require('./flyt-kaller');
const { erstattPlassholdere, byggKontekst } = require('./placeholder');
const rollerStorage = require('./roller-storage');
const dynamiskRolle = require('./dynamisk-rolle');

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

// ==================== KANALOPPSETT PER STEG ====================
//
// E-post har alltid hatt egen mal (TilBehandler). De tre andre kanalene ble
// bygget som «på/av» og arvet e-postteksten, så en Planner-oppgave havnet i
// standardplanen uten frist og et kanalinnlegg gikk dit flyten tilfeldigvis
// pekte. Her får hver kanal sitt eget oppsett på steget.
//
// Alt er valgfritt: er oppsettet tomt, faller vi tilbake på e-postmalen og
// oppfører oss nøyaktig som før. Ingen eksisterende skjematype endrer atferd
// av at feltene finnes.

const PLANNER_STATUS = ['Ikke startet', 'Pågår', 'Ferdig'];
const PLANNER_PRIORITET = ['Lav', 'Medium', 'Viktig', 'Haster'];

function somPlannerOppgave(v) {
    const o = v && typeof v === 'object' ? v : {};
    return {
        Tittel: String(o.Tittel || ''),
        TeamOgPlan: String(o.TeamOgPlan || ''),
        Bucket: String(o.Bucket || ''),
        Status: PLANNER_STATUS.includes(o.Status) ? o.Status : PLANNER_STATUS[0],
        Prioritet: PLANNER_PRIORITET.includes(o.Prioritet) ? o.Prioritet : 'Medium',
        Forfallsdato: String(o.Forfallsdato || ''),
        Sjekkliste: String(o.Sjekkliste || ''),
        Notater: String(o.Notater || ''),
        // Tom = oppgaven tilordnes stegets behandlere, som før.
        AnsvarligRolle: String(o.AnsvarligRolle || '')
    };
}

function somTeamskanal(v) {
    const o = v && typeof v === 'object' ? v : {};
    return {
        Team: String(o.Team || ''),
        Kanal: String(o.Kanal || ''),
        Tittel: String(o.Tittel || ''),
        Innhold: String(o.Innhold || '')
    };
}

function somTeamsMelding(v) {
    const o = v && typeof v === 'object' ? v : {};
    return { Tittel: String(o.Tittel || ''), Innhold: String(o.Innhold || '') };
}

/**
 * Frist for en Planner-oppgave.
 *
 * Godtar `{idag}`, `{idag+N}` og `ÅÅÅÅ-MM-DD`. Alt annet gir tom streng — vi
 * lar heller flyten stå uten frist enn å sende en dato vi har gjettet oss til.
 * `new Date('1. september')` gir 2001-09-01 i V8 uten å klage, og en frist 25
 * år tilbake ville vært verre enn ingen frist.
 */
function løsForfallsdato(verdi, na = new Date()) {
    const s = String(verdi || '').trim();
    if (!s) return '';

    const m = /^\{idag(?:\s*\+\s*(\d{1,4}))?\}$/i.exec(s);
    if (m) {
        const dager = m[1] ? Number(m[1]) : 0;
        const d = new Date(na.getTime());
        d.setUTCDate(d.getUTCDate() + dager);
        return d.toISOString().slice(0, 10);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        const d = new Date(`${s}T00:00:00.000Z`);
        // Fanger 2026-02-31, som Date ellers ruller videre til 3. mars.
        if (!isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s) return s;
    }
    return '';
}

/**
 * Sjekkliste: én linje per punkt, med plassholdere løst og tomme linjer bort.
 * Planner tar maks 20 punkter per oppgave, så vi kutter der.
 */
function byggSjekkliste(tekst, kontekst) {
    return String(tekst || '')
        .split(/\r?\n/)
        .map(l => erstattPlassholdere(l.replace(/^\s*[-*]\s*/, '').trim(), kontekst))
        .filter(Boolean)
        .slice(0, 20);
}

/**
 * Sjekklista i formen Graph vil ha den på `PATCH /planner/tasks/{id}/details`.
 *
 * Graph bruker et kart der nøkkelen er en klientgenerert identifikator — ikke
 * en array. Nøklene tildeles ikke av tjenesten; vi finner dem på selv, og de
 * trenger bare å være unike innenfor oppgaven. Å bygge et objekt med dynamiske
 * nøkler er noe av det klumpeteste Power Automate gjør, så vi sender det
 * ferdig i stedet for å be flyten om å sette det sammen.
 *
 * `orderHint` settes bevisst ikke. Planner sorterer på den, men formatet er en
 * egen sammenligningsalgoritme, og en ugyldig hint gir 400 på hele kallet.
 * Uten hint tildeler Planner sine egne — rekkefølgen kan avvike fra
 * innskrivingen, men oppgaven blir opprettet.
 */
function sjekklisteTilGraph(punkter) {
    const ut = {};
    for (const tekst of punkter) {
        ut[crypto.randomUUID()] = {
            '@odata.type': 'microsoft.graph.plannerChecklistItem',
            title: tekst,
            isChecked: false
        };
    }
    return ut;
}

/**
 * Planner-delen av varslingspayloaden.
 *
 * Er `AnsvarligRolle` satt, løses den til konkrete mottakere her — flyten skal
 * slippe å kunne noe om rollemodellen vår. Løses den til ingen, faller vi
 * tilbake til stegets behandlere framfor å lage en oppgave uten eier.
 */
async function byggPlanner(steg, kontekst, { emne, lenke, skjema, behandlere, log, rolleOppslag = løsMottakere }) {
    const p = somPlannerOppgave(steg?.PlannerOppgave);
    let ansvarlige = behandlere;
    if (p.AnsvarligRolle) {
        const løst = await rolleOppslag({ Roller: [p.AnsvarligRolle] }, skjema, log);
        if (løst.length > 0) ansvarlige = løst;
        else log(`varsling: Planner-ansvarlig "${p.AnsvarligRolle}" har ingen innehavere — bruker behandlerne`);
    }
    const sjekkliste = byggSjekkliste(p.Sjekkliste, kontekst);
    return {
        tittel: erstattPlassholdere(p.Tittel, kontekst) || emne,
        plan: erstattPlassholdere(p.TeamOgPlan, kontekst),
        bucket: erstattPlassholdere(p.Bucket, kontekst),
        status: p.Status,
        prioritet: p.Prioritet,
        forfallsdato: løsForfallsdato(p.Forfallsdato),
        sjekkliste: sjekkliste,
        // Samme punkter, men i Graph-formen — se sjekklisteTilGraph.
        sjekkliste_graph: sjekklisteTilGraph(sjekkliste),
        notat: erstattPlassholdere(p.Notater, kontekst) || `Åpne skjemaet: ${lenke}`,
        ansvarlige: ansvarlige.map(m => ({ epost: m.epost, navn: m.navn || '' }))
    };
}

/** Teams-kanalinnlegg. Tomt team eller kanal betyr at flyten må bruke sin egen. */
function byggTeamskanal(steg, kontekst, { emne, html }) {
    const t = somTeamskanal(steg?.TeamsKanalInnlegg);
    return {
        team: erstattPlassholdere(t.Team, kontekst),
        kanal: erstattPlassholdere(t.Kanal, kontekst),
        tittel: erstattPlassholdere(t.Tittel, kontekst) || emne,
        innhold: erstattPlassholdere(t.Innhold, kontekst) || html
    };
}

/** Direktemelding i Teams. Uten eget oppsett brukes e-postmalen, som før. */
function byggTeamsMelding(steg, kontekst, { emne, html }) {
    const t = somTeamsMelding(steg?.TeamsMelding);
    return {
        tittel: erstattPlassholdere(t.Tittel, kontekst) || emne,
        innhold: erstattPlassholdere(t.Innhold, kontekst) || html
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

function standardFerdigVarsling() {
    return {
        Emne: 'Ferdig behandlet: "$skjemanavn"',
        Tekst:
            '<p>Hei,</p>' +
            '<p>Skjemaet "<b>$skjemanavn</b>" ($skjema_id) er ferdig behandlet.</p>' +
            '<p><a href="$lenke">Åpne skjemaet</a></p>'
    };
}

/**
 * Løs et mottakeroppsett { Personer, Roller } til e-postadresser.
 *
 * Rollestrengene kan ha feltreferanser — "Klassesjef({2-01})" — og de slås opp
 * mot skjemaets svar her og nå, ikke mot det som ble frosset ved innsending.
 * Det er trygt fordi kryptering først skjer i det skjemaet lagres med status 5:
 * så lenge kalleren holder på skjemaet før den lagringen, er svarene i klartekst.
 *
 * Peker referansen på et flervalgsfelt, blir det én rolle per valg — samme
 * regel som for behandlingssteg.
 */
async function løsMottakere(oppsett, skjema, log = () => {}) {
    if (!oppsett) return [];
    const roller = [];
    for (const mal of (oppsett.Roller || [])) {
        if (!dynamiskRolle.erDynamisk(mal)) {
            if (!roller.includes(mal)) roller.push(mal);
            continue;
        }
        try {
            const { roller: løste, ulost } = await dynamiskRolle.ekspanderRolleStreng(mal, skjema?.Seksjoner || []);
            if (ulost) {
                log(`varsling: mottakerrollen "${mal}" viser til et ubesvart felt — hoppes over`);
                continue;
            }
            for (const r of løste) if (!roller.includes(r)) roller.push(r);
        } catch (e) {
            log(`varsling: kunne ikke løse opp mottakerrollen "${mal}" — ${e.message}`);
        }
    }
    // Personer + roller slås sammen og dedupliseres av samleBehandlerMottakere.
    return await samleBehandlerMottakere({ Personer: oppsett.Personer || [], Roller: roller });
}

/**
 * Som løsMottakere, men forteller hva som skjedde med hver enkelt rollestreng.
 *
 * Brukes av varslingsdiagnosen. Uten den er «rollen ga ingen mottakere» umulig
 * å skille fra «feltet ga ingen roller» — begge ender med en tom liste.
 * `vurderte` viser hvilke rollestrenger feltsvarene faktisk ble til, så det
 * synes med én gang om alle valgene i et flervalgsfelt ble lest.
 */
async function forklarMottakere(oppsett, skjema) {
    const roller = [];
    for (const mal of (oppsett?.Roller || [])) {
        if (!dynamiskRolle.erDynamisk(mal)) {
            const innehavere = await rollerStorage.hentInnehavere(mal).catch(() => []);
            roller.push({
                mal, dynamisk: false,
                perRolle: [{ rolle: mal, antallInnehavere: innehavere.length, innehavere: innehavere.map(i => i.EP || i.UPN) }]
            });
            continue;
        }
        let resultat;
        try {
            resultat = await dynamiskRolle.ekspanderRolleStreng(mal, skjema?.Seksjoner || []);
        } catch (e) {
            roller.push({ mal, dynamisk: true, feil: e.message, perRolle: [] });
            continue;
        }
        if (resultat.ulost) {
            roller.push({ mal, dynamisk: true, ulost: true, melding: 'Feltet er ubesvart — ingen roller å slå opp', perRolle: [] });
            continue;
        }
        const perRolle = [];
        for (const r of resultat.roller) {
            const innehavere = await rollerStorage.hentInnehavere(r).catch(() => []);
            perRolle.push({ rolle: r, antallInnehavere: innehavere.length, innehavere: innehavere.map(i => i.EP || i.UPN) });
        }
        roller.push({ mal, dynamisk: true, vurderte: resultat.vurderte, perRolle });
    }
    return { personer: oppsett?.Personer || [], roller };
}

/**
 * Send innsender-kvittering. Kalles ved innsending.
 *
 * `Innsenderkvittering.Kopi` ({ Personer, Roller }) får samme melding. Det er
 * veien til «varsle en rolle når skjemaet er ferdig» for skjematyper uten
 * behandlingssteg: de er ferdige i det de sendes inn, så en egen ferdigvarsling
 * ville bare vært den samme e-posten en gang til.
 *
 * opts: { log, request } — request brukes for base_url-fallback.
 */
async function sendInnsenderKvittering(skjema, skjematype, opts = {}) {
    const log = opts.log || (() => {});
    const kv = skjematype?.Innsenderkvittering || {};
    if (kv.Aktiv === false) {
        log('varsling: Innsenderkvittering deaktivert — hopper over');
        return { status: 'hoppet-over' };
    }
    const til = String(skjema?.Innsender_Epost || skjema?.Innsender_epost || '').trim().toLowerCase();
    const kopi = await løsMottakere(kv.Kopi, skjema, log);
    const mottakere = [
        ...(til ? [{ epost: til, navn: skjema?.Innsender_Navn || '' }] : []),
        ...kopi.filter(k => k.epost !== til)
    ];
    if (mottakere.length === 0) {
        log('varsling: Ingen innsender-epost og ingen kopimottakere — hopper over');
        return { status: 'hoppet-over' };
    }
    if (!til) log(`varsling: ingen innsender-epost, men ${kopi.length} kopimottaker(e) — sender til dem`);

    const mal = kv.Aktiv === true || kv.Emne || kv.Tekst ? kv : standardKvittering();
    const lenke = skjemaLenke(skjema.Skjematype_id, skjema.Skjema_id, opts.request);
    const kontekst = byggKontekst({ skjema, skjematype, lenke });
    const emne = erstattPlassholdere(mal.Emne || standardKvittering().Emne, kontekst);
    const html = erstattPlassholdere(mal.Tekst || standardKvittering().Tekst, kontekst);
    return await sendEpostViaFlyt({
        mottakere,
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
    // Hver kanal får sitt eget oppsett fra steget, med e-postmalen som
    // fallback. Bygges bare for kanaler som faktisk er på, så payloaden ikke
    // vokser med felter flyten skal ignorere.
    const planner = kanaler.includes('planner')
        ? await byggPlanner(steg, kontekst, { emne, lenke, skjema, behandlere: mottakere, log })
        : null;
    const teamskanal = kanaler.includes('teamskanal')
        ? byggTeamskanal(steg, kontekst, { emne, html })
        : null;
    const teams = kanaler.includes('teams')
        ? byggTeamsMelding(steg, kontekst, { emne, html })
        : null;

    return await sendVarslerViaFlyt({
        mottakere,
        varslinger: kanaler,
        emne, html, lenke,
        planner, teamskanal, teams,
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

/**
 * Varsling når hele skjemaet er ferdig behandlet — altså når siste
 * behandlingssteg er avgjort og skjemaet går til status 5.
 *
 * Skjematypen konfigurerer:
 *   Ferdigvarsling: { Aktiv, Mottakere: { Personer, Roller }, Emne, Tekst, Format }
 *
 * Mottakerrollene kan ha feltreferanser, og de løses opp mot svarene i det
 * øyeblikket skjemaet blir ferdig. Kalleren MÅ sende inn skjemaet slik det er
 * før kryptering — se løsMottakere.
 *
 * Skjematyper uten behandlingssteg går rett til ferdig ved innsending. De
 * bruker `Innsenderkvittering.Kopi` i stedet.
 */
async function sendFerdigVarsling(skjema, skjematype, opts = {}) {
    const log = opts.log || (() => {});
    const fv = skjematype?.Ferdigvarsling || {};
    if (fv.Aktiv !== true) {
        // Uten denne linja er «det kom ingen e-post» umulig å skille fra
        // «skjematypen har ikke slått den på».
        log(`varsling: ferdigvarsling ikke aktivert for skjematype ${skjema?.Skjematype_id}`
            + ` (Ferdigvarsling ${skjematype?.Ferdigvarsling ? `finnes, Aktiv=${JSON.stringify(fv.Aktiv)}` : 'mangler helt'})`);
        return { status: 'hoppet-over', melding: 'Ferdigvarsling ikke aktivert' };
    }

    const mottakere = await løsMottakere(fv.Mottakere, skjema, log);
    if (mottakere.length === 0) {
        log('varsling: ferdigvarsling har ingen mottakere — hopper over');
        return { status: 'hoppet-over', melding: 'Ingen mottakere' };
    }

    const lenke = skjemaLenke(skjema.Skjematype_id, skjema.Skjema_id, opts.request);
    const kontekst = byggKontekst({ skjema, skjematype, lenke });
    const emne = erstattPlassholdere(fv.Emne || standardFerdigVarsling().Emne, kontekst);
    const html = erstattPlassholdere(fv.Tekst || standardFerdigVarsling().Tekst, kontekst);
    log(`varsling: ferdigvarsling for ${skjema.Skjema_id} til ${mottakere.length} mottaker(e)`);
    return await sendEpostViaFlyt({
        mottakere,
        emne, html, lenke,
        skjemaId: skjema.Skjema_id,
        skjematypeId: skjema.Skjematype_id,
        skjemaNavn: kontekst.skjemanavn,
        request: opts.request
    }, log);
}

module.exports = {
    sendInnsenderKvittering,
    sendBehandlerVarsling,
    sendVarslingAktiveSteg,
    sendBeslutningVarsling,
    sendFerdigVarsling,
    løsMottakere,
    forklarMottakere,
    _samleBehandlerMottakere: samleBehandlerMottakere,
    _skjemaLenke: skjemaLenke,
    // Kanaloppsett — rene funksjoner, testet i api/test/varsling-kanaler.test.js
    somPlannerOppgave, somTeamskanal, somTeamsMelding,
    løsForfallsdato, byggSjekkliste, sjekklisteTilGraph, byggPlanner, byggTeamskanal, byggTeamsMelding,
    PLANNER_STATUS, PLANNER_PRIORITET
};
