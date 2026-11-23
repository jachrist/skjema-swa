/**
 * M365-koblinger: hvilke team og SharePoint-områder skjematypene skriver til.
 *
 * Lagt til 23.11.2026. Flytene som skriver til Microsoft 365 — SharePoint-
 * lister, Planner-oppgaver og innlegg i Teams-kanaler — gjør det som
 * tjenestebrukeren, og den må være invitert inn i hvert team av teameieren.
 * Tilgangen blir liggende etter at skjematypen er sluttet å bruke. Denne
 * oversikten svarer på det spørsmålet teameieren og admin trenger svar på:
 * HVEM skriver hit, og NÅR ble det sist brukt?
 *
 * Én rad per mål (et team eller et SharePoint-område), med skjematypene som
 * skriver dit. Flere skjematyper kan dele samme team — tjenestebrukeren kan
 * meldes ut først når INGEN av dem er i bruk, og det er derfor raden har den
 * nyeste aktiviteten på tvers av dem.
 *
 * Reglene for hvilken kanal som er på, og hvordan «Team:Plan» deles, er
 * diagnosens (lib/skjematype-diagnose.js) — samme svar som «Sjekk oppsettet»
 * gir, ikke en egen lesing.
 *
 * Teams-melding (direktemelding fra Flow bot) og e-post skriver ikke til noe
 * team, og står ikke her.
 */
const { aktiveKanaler, delTeamOgPlan, harPlassholder } = require('./skjematype-diagnose');

/** Nøkkelen et mål grupperes på: type og navn, uten store bokstaver og skråstrek bakerst. */
function nokkel(type, navn) {
    return `${type}|${String(navn || '').trim().replace(/\/+$/, '').toLowerCase()}`;
}

/**
 * Alle M365-mål i én skjematypedefinisjon.
 *
 * Et mål med plassholder (`{2-01}`) får innhold først ved innsending, og kan
 * ikke knyttes til ett team. Det meldes som `dynamisk`, så det ikke forsvinner
 * fra oversikten — det er nettopp de som er vanskeligst å rydde etter.
 *
 * Et tomt team på Teams-kanal betyr flytens eget standardvalg (se editoren).
 *
 * @returns {{ type: 'sharepoint'|'planner'|'teamskanal', mal: string, detalj: string, hvor: string }[]}
 */
function malFor(def) {
    const ut = [];
    const adresse = String(def?.SPListeadresse || '').trim();
    const liste = String(def?.SPListenavn || '').trim();
    if (adresse && liste) {
        ut.push({ type: 'sharepoint', mal: adresse, detalj: `Liste: ${liste}`, hvor: 'SharePoint-liste' });
    }
    const steg = Array.isArray(def?.Behandling) ? def.Behandling : [];
    steg.forEach((s, i) => {
        const nr = s?.Steg ?? (i + 1);
        const kanaler = aktiveKanaler(s);
        if (kanaler.includes('planner')) {
            const { team, plan } = delTeamOgPlan(s?.PlannerOppgave?.TeamOgPlan);
            if (team) {
                ut.push({ type: 'planner', mal: team, detalj: `Plan: ${plan || '(mangler)'}`, hvor: `Steg ${nr}` });
            }
        }
        if (kanaler.includes('teamskanal')) {
            const team = String(s?.TeamsKanalInnlegg?.Team || '').trim();
            const kanal = String(s?.TeamsKanalInnlegg?.Kanal || '').trim();
            ut.push({
                type: 'teamskanal',
                mal: team || '(flytens standardteam)',
                detalj: `Kanal: ${kanal || '(flytens standardkanal)'}`,
                hvor: `Steg ${nr}`
            });
        }
    });
    return ut.map(m => ({ ...m, dynamisk: harPlassholder(m.mal) }));
}

/** ISO-datoen som er nyest, eller '' når ingen er satt. */
function nyest(a, b) {
    return String(a || '') > String(b || '') ? String(a || '') : String(b || '');
}

/**
 * Bygg oversikten.
 *
 * @param skjematyper  `hentAlleSkjematyper()`: `{ id, JSON }[]`
 * @param oversikt     radene fra `byggOversikt` — der står siste aktivitet og
 *                     antall, og det skal være SAMME tall som i tabellen over
 * @returns rader sortert med det som har stått lengst ubrukt først
 */
function byggKoblinger(skjematyper, oversikt) {
    const bruk = new Map((oversikt || []).map(r => [String(r.Skjematype_id), r]));
    const mal = new Map();

    for (const st of (skjematyper || [])) {
        const def = st?.JSON || {};
        const id = String(st?.id ?? def.Skjematype_id ?? '');
        const b = bruk.get(id) || {};
        for (const m of malFor(def)) {
            const k = nokkel(m.type, m.mal);
            if (!mal.has(k)) {
                mal.set(k, { Type: m.type, Mal: m.mal, Dynamisk: m.dynamisk, SisteAktivitet: '', Skjematyper: [] });
            }
            const rad = mal.get(k);
            rad.Skjematyper.push({
                Skjematype_id: id,
                Skjema_navn: def.Skjema_navn || b.Skjema_navn || '',
                Fase: def.Fase || b.Fase || 'Produksjon',
                Detalj: m.detalj,
                Hvor: m.hvor,
                Utfylte: Number(b.Utfylte || 0),
                SisteDato: b.SisteDato || ''
            });
            rad.SisteAktivitet = nyest(rad.SisteAktivitet, b.SisteDato);
        }
    }

    // Lengst ubrukt først: det er de som skal ryddes. Aldri brukt ('') står
    // aller først.
    return [...mal.values()].sort((a, b) =>
        String(a.SisteAktivitet).localeCompare(String(b.SisteAktivitet))
        || String(a.Mal).localeCompare(String(b.Mal), 'no'));
}

module.exports = { byggKoblinger, malFor };
