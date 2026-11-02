/**
 * Omdøping av en rolle — lese, planlegge, og skrive når det er bedt om.
 *
 * Reglene (hva som skrives om, og hvordan) bor i lib/rolle-omdoping.js. Her
 * er bare rekkefølgen og lagringen.
 *
 * ## Forhåndsvisning først
 *
 * Uten `utfor` leses alt og planen returneres — ingenting skrives. Admin ser
 * hvor mange medlemskap, grupper, skjematyper, rapporter og saker som endres,
 * og bekrefter. Samme kode kjører begge gangene; utførelsen bygger planen på
 * nytt i stedet for å stole på en plan fra nettleseren.
 *
 * ## Rekkefølgen ved skriving
 *
 *   1. nye medlemskap        — personene står i BEGGE rollene en stund
 *   2. skjematyper, rapporter, saker, rollegrupper
 *   3. gamle medlemskap      — slettes til slutt
 *
 * Stopper kjøringen midt i, står folk i begge, aldri i ingen. En halvferdig
 * omdøping gir dobbel tilgang til den kjøres på nytt — ikke en sak uten
 * behandler. Kjøringen er idempotent: en ny kjøring finner det som gjenstår.
 *
 * ## Saker
 *
 * Bare skjematyper der definisjonen NEVNER rollen, gjennomgås. Ikke de som
 * vil ENDRES: `Klassesjef({2-01})` i definisjonen endres ikke av et nytt omfang,
 * men sakene har `Klassesjef(MILM23-1)` og skal følge med.
 *
 * Begrensningen er bevisst: å lese ALLE saker i alle typer er det som ville
 * sprengt tidsgrensen. Har en skjematype fjernet rollen fra definisjonen
 * etter at saker ble sendt inn, følger ikke de sakene med. Det står i
 * forhåndsvisningen, så det ikke ser komplett ut når det ikke er.
 *
 * Saker kryptert med Krypteres=Alt har behandlingsstegene i chifferteksten.
 * De dekrypteres med typens nøkkel, skrives om og krypteres på nytt. Mangler
 * nøkkelen, meldes saken — den hoppes ikke over i stillhet.
 */
const regler = require('./rolle-omdoping');

const STATUS_AVSLUTTET = 5;

/** Nevner treet rollen i et rollefelt, uansett omfang? */
function nevnerRolle(tre, rolle) {
    // Et omskriv til et navn som ikke kan finnes, gir en endring for hver
    // forekomst av rollen — samme regel for hva et rollefelt er, ingen kopi.
    const proeve = { type: 'navn', fra: rolle, til: '\u0000' };
    return regler.omskrivTre(tre, proeve).endringer.length > 0;
}

function standardDeps() {
    return {
        roller: require('./roller-storage'),
        grupper: require('./rollegruppe-storage'),
        skjematyper: require('./skjema-storage'),
        rapporter: require('./rapport-storage'),
        saker: require('./skjema-forekomst-storage'),
        nokler: require('./nokkel-storage'),
        kryptering: require('./kryptering')
    };
}

/**
 * @param {object} op       { type: 'navn', fra, til } | { type: 'omfang', rolle, fra, til }
 * @param {object} opt      { utfor = false, log, deps }
 * @returns {Promise<object>} plan med tellinger, og `utfort` når det er skrevet
 */
async function kjorOmdoping(rå, { utfor = false, log = () => {}, deps = standardDeps() } = {}) {
    const op = {
        type: rå?.type,
        fra: String(rå?.fra ?? '').trim(),
        til: String(rå?.til ?? '').trim(),
        ...(rå?.type === 'omfang' ? { rolle: String(rå?.rolle ?? '').trim() } : {})
    };
    const ugyldig = regler.valider(op);
    if (ugyldig) return { status: 'ugyldig', melding: ugyldig, op };

    const rolleNavn = op.type === 'navn' ? op.fra : op.rolle;

    // ---------- les og planlegg ----------
    const alleRader = await deps.roller.hentAlle();
    const medlemskap = regler.planMedlemskap(alleRader, op);
    const maalFinnes = op.type === 'navn'
        ? alleRader.some(r => r.Rolle === op.til)
        : alleRader.some(r => r.Rolle === op.rolle && r.Omfang === op.til);

    const grupper = regler.planGrupper(await deps.grupper.hentAlle(), op);

    const typer = [];
    const typerSomNevner = [];
    for (const st of await deps.skjematyper.hentAlleSkjematyper()) {
        if (!st?.JSON) continue;
        if (nevnerRolle(st.JSON, rolleNavn)) typerSomNevner.push(st);
        const { tre, endringer } = regler.omskrivTre(st.JSON, op);
        if (endringer.length) typer.push({ id: st.id, navn: st.navn, endringer, tre });
    }

    const rapporter = [];
    for (const r of await deps.rapporter.hentAlleRapporttyper()) {
        const json = r?.JSON;
        if (!json) continue;
        const { tre, endringer } = regler.omskrivTre(json, op);
        if (endringer.length) rapporter.push({ id: r.id, navn: r.navn, endringer, tre });
    }

    const saker = [];
    const sakerIkkeLest = [];
    for (const st of typerSomNevner) {
        let nokkel;
        for (const lagret of await deps.saker.hentAlleSkjemaerForType(st.id, { fulltFormat: false })) {
            let data = lagret;
            const kryptert = typeof lagret?.Kryptert === 'string';
            if (kryptert) {
                if (nokkel === undefined) nokkel = await deps.nokler.hentNokkel(st.id);
                if (!nokkel) { sakerIkkeLest.push({ typeId: st.id, sakId: lagret.Skjema_id, grunn: 'nøkkel mangler' }); continue; }
                try { data = deps.kryptering.dekrypterSkjema(lagret, nokkel); }
                catch (e) { sakerIkkeLest.push({ typeId: st.id, sakId: lagret.Skjema_id, grunn: `dekryptering feilet: ${e.message}` }); continue; }
            }
            const { tre, endringer } = regler.omskrivTre(data, op);
            if (!endringer.length) continue;
            saker.push({
                typeId: st.id, typeNavn: st.navn, sakId: data.Skjema_id,
                underBehandling: Number(data.Skjema_status) !== STATUS_AVSLUTTET,
                kryptert, endringer: endringer.length,
                tre: kryptert ? deps.kryptering.krypterSkjema(tre, nokkel, 'Alt') : tre
            });
        }
    }

    const plan = {
        status: utfor ? 'utfort' : 'forhandsvisning',
        op,
        medlemskap: {
            flyttes: medlemskap.slett.length,
            alleredeIMaal: medlemskap.alleredeIMaal,
            maalFinnesFraFor: maalFinnes
        },
        grupper: {
            flyttes: grupper.flytt.length,
            eierRolleEndres: grupper.oppdater.length,
            konflikter: grupper.konflikter
        },
        skjematyper: typer.map(t => ({ id: t.id, navn: t.navn, endringer: t.endringer })),
        rapporter: rapporter.map(r => ({ id: r.id, navn: r.navn, endringer: r.endringer })),
        saker: {
            underBehandling: saker.filter(s => s.underBehandling).length,
            avsluttet: saker.filter(s => !s.underBehandling).length,
            kryptert: saker.filter(s => s.kryptert).length,
            ikkeLest: sakerIkkeLest,
            perType: Object.values(saker.reduce((acc, s) => {
                acc[s.typeId] = acc[s.typeId] || { id: s.typeId, navn: s.typeNavn, antall: 0 };
                acc[s.typeId].antall++;
                return acc;
            }, {}))
        }
    };
    if (!utfor) return plan;

    // ---------- skriv ----------
    // 1. Nye medlemskap først: ingen mister tilgang underveis.
    await deps.roller.utforBatch({ skriv: medlemskap.skriv, slett: [] });
    log(`roller/omdop: ${medlemskap.skriv.length} medlemskap skrevet`);

    // 2. Referansene.
    for (const t of typer) await deps.skjematyper.lagreSkjematype(t.tre);
    for (const r of rapporter) await deps.rapporter.lagreRapporttype(r.tre);
    for (const s of saker) await deps.saker.erstattJson(s.typeId, s.sakId, s.tre);
    for (const g of grupper.flytt) {
        if (g.til) await deps.grupper.skrivGruppe(g.til);
        await deps.grupper.slettGruppe(g.fra.Rolle, g.fra.Omfang);
    }
    for (const g of grupper.oppdater) await deps.grupper.skrivGruppe(g);
    log(`roller/omdop: ${typer.length} skjematyper, ${rapporter.length} rapporter, ${saker.length} saker, ${grupper.flytt.length} grupper`);

    // 3. Gamle medlemskap til slutt.
    await deps.roller.utforBatch({ skriv: [], slett: medlemskap.slett });
    log(`roller/omdop: ${medlemskap.slett.length} gamle medlemskap slettet`);

    return plan;
}

module.exports = { kjorOmdoping, nevnerRolle };
