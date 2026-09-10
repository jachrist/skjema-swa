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
 * Tekst → HTML, trygt.
 *
 * Notatet kommer fra et fritekstfelt i editoren og kan inneholde <, > og &.
 * Sendes det urørt inn i et felt med contentType html, blir det enten
 * bortfiltrert eller tolket som markup — begge deler feil.
 */
function tilHtml(tekst) {
    return String(tekst || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Notatet som HTML, med klikkbare adresser.
 *
 * Planner-oppgavens beskrivelse tar HTML på beta-endepunktet
 * (`notes: { content, contentType: 'html' }`). En bar adresse i ren tekst blir
 * ikke klikkbar der, så adresser gjøres om til ekte `<a>`.
 *
 * Notatfeltet er fritekst i editoren og har `$lenke` som standardinnhold, så
 * den som setter opp steget kan skrive tekst rundt lenka og bestemme hvor den
 * skal stå. Derfor legges det ikke på en lenke automatisk: da ville den som
 * plasserte den selv fått den to ganger.
 *
 * Adressen kan stå bar, eller som `[egen tekst]($lenke)` — se URL_I_TEKST.
 * Alt annet escapes: en avbrutt tag skal ikke kunne ødelegge resten av
 * beskrivelsen.
 *
 * Unntaket er et notat helt uten adresse. Da føyes skjemalenka til, så en
 * oppgave aldri står uten vei tilbake til skjemaet.
 *
 * Bakgrunn: Planner lar oss ikke styre hva kortet viser. `previewType` er
 * dokumentert som skrivbar på plannerTask, men Graph svarer «This field
 * cannot be modified» (prøvd 09.09.2026). Beskrivelsen er derfor det stedet
 * vi faktisk kan legge lenka.
 */
/**
 * Adresser i notatet — enten som Markdown-lenke eller bar.
 *
 * `[Bruk denne lenka]($lenke)` gir lenka en egen tekst. Uten den formen sto
 * valget mellom en lang, uleselig adresse midt i beskrivelsen, eller rå HTML
 * i et felt som escaper alt — og det siste er nettopp det som ble prøvd, og
 * kom ut som synlig markup i Planner.
 *
 * Syntaksen er ikke ny her. `md-editor.js` har en lenkeknapp som setter inn
 * akkurat `[tekst](url)`, og `parseMarkdown` i felt-render.js tolker den på
 * utfyllingssiden. Notatfeltet er dermed det eneste stedet den ikke virket.
 *
 * Bare http og https. Adressen havner i en href vi selv bygger, og `javascript:`
 * og `data:` skal ikke kunne komme dit gjennom et fritekstfelt. Alt annet i
 * parentesen blir stående som vanlig tekst.
 */
const MD_LENKE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/;
const NAKEN_URL = /https?:\/\/[^\s<>"')]+/;
const URL_I_TEKST = new RegExp(`${MD_LENKE.source}|${NAKEN_URL.source}`, 'g');
const HAR_ADRESSE = /https?:\/\//;

/**
 * Tegnsetting som avslutter en setning hører ikke til adressen.
 *
 * «Se $lenke.» er en helt vanlig måte å skrive på, og uten dette havnet
 * punktumet inni href-en. Lenka pekte da på en adresse som ikke finnes.
 * Parenteser og apostrof er allerede utenfor URL_I_TEKST.
 */
const HALE = /[.,;:!?]+$/;

function lagLenke(raaAdresse) {
    const hale = (raaAdresse.match(HALE) || [''])[0];
    const url = raaAdresse.slice(0, raaAdresse.length - hale.length);
    if (!url) return tilHtml(raaAdresse);
    return `<a href="${tilHtml(url)}">${tilHtml(url)}</a>${tilHtml(hale)}`;
}

/**
 * Adressene finnes i den RÅ teksten, ikke i den escapede.
 *
 * Rekkefølgen var motsatt før, og det holdt bare så lenge teksten ikke hadde
 * tegn som escapes. Sto adressen i anførselstegn — «Se "$lenke" her» — var
 * hermetegnet blitt til `&quot;` når mønsteret kjørte, og siden det ikke
 * inneholder noe `"` spiste adressen det og alt som fulgte.
 *
 * Nå deles linja på de rå treffene: teksten rundt escapes, adressen bygges
 * med tilHtml på både href og lenketekst.
 */
function medLenker(raaLinje) {
    let ut = '', sist = 0, m;
    URL_I_TEKST.lastIndex = 0;
    while ((m = URL_I_TEKST.exec(raaLinje)) !== null) {
        ut += tilHtml(raaLinje.slice(sist, m.index));
        // m[1] er satt bare når Markdown-formen traff. Da er lenketeksten
        // brukerens egen; ellers er adressen sin egen tekst.
        ut += m[1] !== undefined
            ? `<a href="${tilHtml(m[2])}">${tilHtml(m[1])}</a>`
            : lagLenke(m[0]);
        sist = m.index + m[0].length;
    }
    return ut + tilHtml(raaLinje.slice(sist));
}

function notatSomHtml(tekst, lenke) {
    const deler = [];
    const raa = String(tekst || '').trim();
    if (raa) {
        // Blanke linjer skiller avsnitt; enkle linjeskift blir <br>.
        for (const avsnitt of raa.split(/\r?\n\s*\r?\n/)) {
            const linjer = avsnitt.split(/\r?\n/).map(medLenker).join('<br>');
            if (linjer.trim()) deler.push(`<p>${linjer}</p>`);
        }
    }
    // Bare når notatet ikke selv peker noe sted.
    if (lenke && !HAR_ADRESSE.test(raa)) {
        deler.push(`<p><a href="${tilHtml(lenke)}">Åpne skjemaet</a></p>`);
    }
    return deler.join('');
}


/**
 * Planners egen typeetikett, utledet av filendelsen.
 *
 * Graph godtar bare et lite, lukket sett: dokumentformatene og «Other». En
 * verdi utenfor det gir 400 på hele details-kallet — ikke bare feil ikon, men
 * ingen oppgavedetaljer i det hele tatt, verken sjekkliste eller referanser.
 * Vi lærte det ved at «url» på skjemalenka veltet kallet 09.09.2026.
 *
 * Derfor er lista bevisst kort. «Pdf» er tatt ut selv om den ser plausibel ut:
 * gevinsten er et litt penere ikon, prisen ved å ta feil er at ingenting
 * kommer fram. Den avveiningen er ikke i tvil.
 */
const PLANNER_REFERANSETYPER = new Set(['Word', 'Excel', 'PowerPoint', 'Other']);

function vedleggstype(filnavn) {
    const e = String(filnavn || '').toLowerCase().split('.').pop();
    if (['doc', 'docx', 'rtf', 'odt'].includes(e)) return 'Word';
    if (['xls', 'xlsx', 'csv', 'ods'].includes(e)) return 'Excel';
    if (['ppt', 'pptx', 'odp'].includes(e)) return 'PowerPoint';
    return 'Other';
}

/**
 * Vedleggene i formen Graph vil ha dem på `PATCH /planner/tasks/{id}/details`.
 *
 * Som sjekklista er dette et kart, ikke en array — men her er NØKKELEN selve
 * adressen, og Graph krever at fire tegn er prosentkodet i den: `%`, `:`, `.`
 * og `@`. Rekkefølgen er ikke likegyldig — `%` må tas først, ellers dobbelkodes
 * de andre.
 *
 * `previewPriority` settes bevisst ikke, av samme grunn som `orderHint` på
 * sjekklistepunktene: formatet er en egen sammenligningsalgoritme, og en ugyldig
 * verdi gir 400 på hele kallet. Uten den tildeler Planner sin egen rekkefølge.
 */
function vedleggTilGraph(vedlegg) {
    const ut = {};
    for (const v of vedlegg) {
        if (!v.url) continue;
        const nokkel = v.url
            .replace(/%/g, '%25')
            .replace(/:/g, '%3A')
            .replace(/\./g, '%2E')
            .replace(/@/g, '%40');
        ut[nokkel] = {
            '@odata.type': 'microsoft.graph.plannerExternalReference',
            alias: v.filnavn,
            // Eksplisitt type går foran filendelsen — skjemalenka er ikke en
            // fil og har ingen endelse å utlede noe av. Men bare hvis Graph
            // kjenner verdien: en ukjent type velter hele kallet, så her er
            // «Other» alltid å foretrekke framfor å gjette.
            type: PLANNER_REFERANSETYPER.has(v.type) ? v.type : vedleggstype(v.filnavn)
        };
        // previewPriority settes bare der den er bedt om, og bare med en verdi
        // Microsoft selv bruker i dokumentasjonen: « !». Formatet er en egen
        // sammenligningsalgoritme, og en verdi vi finner på selv gir 400 på
        // hele details-kallet — altså ingen oppgavedetaljer i det hele tatt.
        //
        // De øvrige referansene står uten. Da tildeler Planner sine egne, og
        // den ene vi har pinnet blir liggende først.
        if (v.previewPriority) ut[nokkel].previewPriority = v.previewPriority;
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

    // Skjemalenka er det eneste vedlegget på oppgaven.
    //
    // Skjemaets egne vedlegg lå her fram til 10.09.2026. De ble tatt ut fordi
    // de ikke tjente noen hensikt: filene nås gjennom skjemaet lenka peker
    // til, ett klikk unna, og adressene er bare brukbare for en behandler som
    // uansett må logge inn. En lang vedleggsliste gjorde oppgaven vanskeligere
    // å lese uten å gi behandleren noe hen ikke allerede hadde.
    const skjemalenke = lenke ? {
        // «Other» er den eneste gyldige verdien for noe som ikke er et
        // dokument. «url» ser riktigere ut, men Graph avviser den — se
        // PLANNER_REFERANSETYPER.
        filnavn: 'Lenke til skjemaet', url: lenke, type: 'Other',
        // « !» er verdien Microsoft bruker i sin egen dokumentasjon for den
        // første referansen. Med bare én referanse betyr den lite, men den er
        // gyldig og koster ingenting.
        previewPriority: ' !'
    } : null;

    const vedlegg = skjemalenke ? [skjemalenke] : [];

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
        // Ren tekst, som før — for en flyt som skriver til `description`.
        notat: erstattPlassholdere(p.Notater, kontekst) || `Åpne skjemaet: ${lenke}`,
        // Samme notat som HTML, med lenka som en ekte <a>. Beta-endepunktets
        // `notes: { content, contentType: 'html' }` tar denne. Lenka er alltid
        // med, også når noen har skrevet sitt eget notat.
        notat_html: notatSomHtml(erstattPlassholdere(p.Notater, kontekst), lenke),
        ansvarlige: ansvarlige.map(m => ({ epost: m.epost, navn: m.navn || '' })),
        // Lesbar form — for en flyt som vil bygge noe eget. Inneholder bare
        // skjemalenka, som `vedlegg_graph`.
        vedlegg,
        // Samme lenke i den formen Graph vil ha den.
        //
        // At lista er kort er ikke tilfeldig. Planner velger selv hva kortet
        // viser og foretrekker et bilde, saa et skjermbilde blant vedleggene
        // kapret kortet og lenka - som er det behandleren faktisk trenger -
        // ble liggende usett. previewType, som skulle styrt det, lar seg ikke
        // sette (se notatSomHtml). Med bare lenka er det ingenting aa kapre.
        vedlegg_graph: vedleggTilGraph(vedlegg)
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

/**
 * Lenke til et skjema.
 *
 * `side` avgjør hvor mottakeren havner. Behandlere skal til evaluering.html,
 * der de kan gjøre en beslutning. Innsenderen skal ikke dit: kvitteringen er
 * en bekreftelse, ikke en oppgave, og evaluering.html gir dessuten ingen
 * tilgang for den som bare har sendt inn.
 *
 * Query-param-navnene må matche sidene, som leser skjematype_id/skjema_id.
 */
function skjemaLenke(skjematypeId, skjemaId, request, side = 'evaluering.html') {
    const base = baseUrl(request);
    if (!base) return '';
    return `${base}/${side}?skjematype_id=${encodeURIComponent(skjematypeId)}&skjema_id=${encodeURIComponent(skjemaId)}`;
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
    const lenke = skjemaLenke(skjema.Skjematype_id, skjema.Skjema_id, opts.request, 'visning.html');
    const kontekst = byggKontekst({ skjema, skjematype, lenke });
    const emne = erstattPlassholdere(mal.Emne || standardKvittering().Emne, kontekst);
    const html = erstattPlassholdere(mal.Tekst || standardKvittering().Tekst, kontekst);
    return await sendEpostViaFlyt({
        handling: 'sendInnsenderKvittering',
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
        handling: 'sendBehandlingsVarsling',
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

    // Beslutningen går til innsenderen, som ikke har tilgang til
    // behandlersiden. visning.html viser skjemaet med beslutningen.
    const lenke = skjemaLenke(skjema.Skjematype_id, skjema.Skjema_id, opts.request, 'visning.html');
    const kontekst = byggKontekst({
        skjema, skjematype, steg,
        beslutningTekst,
        kommentar,
        lenke
    });
    const emne = erstattPlassholdere(mal.Emne || standardFraBehandler().Emne, kontekst);
    const html = erstattPlassholdere(mal.Tekst || standardFraBehandler().Tekst, kontekst);
    return await sendEpostViaFlyt({
        handling: 'sendBeslutningVarsling',
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
        handling: 'sendFerdigVarsling',
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
    // Diagnosen trenger å kunne stille de samme spørsmålene som utsendingen.
    aktiveKanaler, samleBehandlerMottakere,
    // Kanaloppsett — rene funksjoner, testet i api/test/varsling-kanaler.test.js
    somPlannerOppgave, somTeamskanal, somTeamsMelding,
    løsForfallsdato, byggSjekkliste, sjekklisteTilGraph, byggPlanner, byggTeamskanal, byggTeamsMelding,
    vedleggTilGraph, vedleggstype, notatSomHtml, tilHtml,
    PLANNER_STATUS, PLANNER_PRIORITET
};
