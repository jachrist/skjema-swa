/**
 * Diagnose av en skjematype: hva vil feile når den brukes?
 *
 * Et skjema kan lagres og se helt riktig ut, og likevel være ødelagt på en
 * måte som først viser seg ved første innsending — som regel i en flyt, hos
 * noen andre, uten at skjemaeier får vite det. Et teamnavn med skrivefeil,
 * en bucket som ikke finnes, en rolle ingen er medlem av. Kjøringen blir rød
 * i Power Automate, og det er alt som skjer.
 *
 * Denne modulen svarer på det som kan avgjøres HER, uten nettverk:
 * sammenhenger internt i definisjonen, og roller vi selv eier lista over.
 * Eksterne oppslag — finnes teamet, finnes lista — hører til fase 2 og
 * kommer inn som en egen runde mot en flyt.
 *
 * Skillet er ikke bare praktisk. Reglene her er raske nok til å kjøre ved
 * hver lagring, og de kan prøves uten hverken lagringskonto eller flyt.
 *
 * TRE ALVORSGRADER, og de betyr ulike ting:
 *
 *   feil      — dette VIL ikke virke. En varsling går ingen steder, en
 *               oppgave kan ikke opprettes.
 *   advarsel  — dette virker, men gjør antakelig ikke det eieren tror.
 *               Oppsett som aldri brukes er den vanligste formen.
 *   info      — kan ikke sjekkes på forhånd. Verdien er en plassholder som
 *               først får innhold ved innsending.
 *
 * Den siste er viktigere enn den ser ut. Uten den ville et helt lovlig
 * `Bucket: "{2-3}"` blitt meldt som en feil, og eieren ville jaget noe som
 * er riktig.
 */
const { finnFeltViaRef, finnFeltViaId } = require('./placeholder');

/** Feltreferanser i dynamiske roller og plassholdere: {2-3} eller {felt-id}. */
const FELTREF = /\{([^}]+)\}/g;
const POSISJONELL = /^(\d+)-(\d+)$/;

/** $-plassholdere som erstattPlassholdere fyller ved innsending. */
const DOLLAR = /\$[a-zA-ZæøåÆØÅ_]+/;

const KANALER = ['epost', 'teams', 'planner', 'teamskanal'];

/**
 * Kanalene som er slått på for et steg.
 *
 * Samme regel som `varsling.aktiveKanaler` — tom liste betyr e-post. Den er
 * gjentatt her og ikke importert, fordi varsling.js drar med seg halve
 * varslingsapparatet, og diagnosen skal kunne kjøres av en editor som lagrer.
 * Gjentakelsen er dekket av en test som sammenligner de to.
 */
function aktiveKanaler(steg) {
    const v = Array.isArray(steg?.Varsling) ? steg.Varsling : null;
    if (!v || v.length === 0) return ['epost'];
    return v.filter(k => KANALER.includes(k));
}

/** Inneholder verdien noe som først fylles ut ved innsending? */
function harPlassholder(verdi) {
    const s = String(verdi || '');
    return /\{[^}]+\}/.test(s) || DOLLAR.test(s);
}

/** Feltreferansene i en streng, som råtekst. */
function feltreferanser(verdi) {
    return [...String(verdi || '').matchAll(FELTREF)].map(m => m[1].trim()).filter(Boolean);
}

/** Peker denne referansen på et felt som faktisk finnes i definisjonen? */
function refFinnes(seksjoner, ref) {
    const m = POSISJONELL.exec(ref);
    return m
        ? !!finnFeltViaRef(seksjoner, m[1], m[2])
        : !!finnFeltViaId(seksjoner, ref);
}

function stedFor(steg, nr, del) {
    const navn = String(steg?.Stegnavn || '').trim();
    return `Steg ${nr}${navn ? ` «${navn}»` : ''}${del ? ` · ${del}` : ''}`;
}

/**
 * Antall innehavere i en rolle, som en injisert funksjon.
 *
 * Injisert og ikke importert, slik at reglene kan prøves uten lagringskonto.
 * Standarden slår opp i Rollemedlemskap.
 *
 * Merk at 0 ikke skiller «rollen finnes ikke» fra «rollen er tom» — i denne
 * datamodellen ER en rolle sine medlemsrader, så de to er samme tilstand.
 * Meldingen sier derfor «gir ingen mottakere», som er sant uansett.
 */
async function standardAntallInnehavere(rolleStreng) {
    const rollerStorage = require('./roller-storage');
    try {
        return (await rollerStorage.hentInnehavere(rolleStreng)).length;
    } catch (_) {
        // Et feilet oppslag skal ikke bli til «rollen er tom». Da ville
        // diagnosen meldt feil på noe som er i orden.
        return null;
    }
}

/**
 * Sjekk én rollestreng.
 *
 * Dynamiske roller (`Klassesjef({2-3})`) kan ikke slås opp: rollenavnet er
 * ikke kjent før noen har svart. Men FELTREFERANSEN kan sjekkes, og det er
 * den som faktisk skrives feil — en rolle som peker på et felt som er
 * slettet eller flyttet, gir taust ingen behandler.
 */
async function sjekkRolle(rolle, { seksjoner, sted, antallInnehavere, funn }) {
    const streng = String(rolle || '').trim();
    if (!streng) return;

    const refs = feltreferanser(streng);
    if (refs.length > 0) {
        for (const ref of refs) {
            if (!refFinnes(seksjoner, ref)) {
                funn.push({
                    alvor: 'feil', kode: 'rolle.feltref-mangler', sted,
                    melding: `Rollen «${streng}» viser til feltet {${ref}}, som ikke finnes i skjemaet. `
                        + 'Steget får ingen behandler.'
                });
            }
        }
        if (refs.every(r => refFinnes(seksjoner, r))) {
            funn.push({
                alvor: 'info', kode: 'rolle.dynamisk', sted,
                melding: `Rollen «${streng}» settes sammen av svar i skjemaet og kan ikke sjekkes før innsending.`
            });
        }
        return;
    }

    const antall = await antallInnehavere(streng);
    // Strengt `=== null`, ikke `!antall`: et feilet oppslag skal tie, ikke
    // melde at rollen er tom. Sammenligningen under gjør i praksis det samme,
    // men denne linja sier hvorfor — og hindrer at noen «forenkler» den til
    // `!antall` og dermed gjør et ukjent svar til en feilmelding.
    if (antall === null) return;
    if (antall === 0) {
        funn.push({
            alvor: 'feil', kode: 'rolle.tom', sted,
            melding: `Rollen «${streng}» gir ingen mottakere. Varsling for dette steget går ingen steder.`
        });
    }
}

/** Planner-oppsettet for ett steg. */
function sjekkPlanner(steg, nr, aktiv, funn) {
    const p = steg?.PlannerOppgave;
    const harOppsett = !!(p && (p.TeamOgPlan || p.Bucket || p.Tittel));
    const sted = stedFor(steg, nr, 'Planner');

    if (harOppsett && !aktiv) {
        funn.push({
            alvor: 'advarsel', kode: 'planner.ikke-aktiv', sted,
            melding: 'Planner er satt opp, men «planner» er ikke huket av under Varsling. '
                + 'Oppsettet brukes ikke.'
        });
        return;
    }
    if (!aktiv) return;

    const plan = String(p?.TeamOgPlan || '').trim();
    const bucket = String(p?.Bucket || '').trim();

    // Rødt, i motsetning til Teams-kanal. Editorens hjelpetekst sier at tomme
    // felter overlates til flyten, men det finnes INGEN standardplan å falle
    // tilbake på (bekreftet av oppdragsgiver 22.09.2026). Uten plan blir det
    // ingen oppgave — og ingen som venter på den, får vite det.
    if (!plan) {
        funn.push({
            alvor: 'feil', kode: 'planner.mangler-plan', sted,
            melding: 'Planner er slått på, men «Team og plan» er tom. Det finnes ingen '
                + 'standardplan å falle tilbake på, så ingen oppgave blir opprettet.'
        });
    }
    if (bucket && !plan) {
        funn.push({
            alvor: 'feil', kode: 'planner.bucket-uten-plan', sted,
            melding: `Bucket «${bucket}» er satt uten at «Team og plan» er fylt ut. `
                + 'Uten plan finnes det ingen bucket å legge oppgaven i.'
        });
    }
    // «Team og plan» er ETT felt med TO verdier, skilt med kolon — feltets egen
    // plassholder er «Automatisering:Oppgaver». Skriver man bare teamnavnet,
    // er verdien ikke tom, og alt ser riktig ut. Flyten får da et teamnavn der
    // den venter et par, og finner ingen plan.
    //
    // Med plassholder i verdien kan kolonet komme fra svaret («{1-1}» kan
    // løse seg til «Team:Plan»), og da vet vi ikke nok til å melde feil.
    // Bucket er noe annet enn plan: den HAR et standardvalg. En oppgave uten
    // bucket havner i planens felles bucket, og det virker — den er bare
    // vanskeligere å finne igjen. Meldes bare når planen er satt; er den tom,
    // sier linja over allerede det som må sies.
    if (plan && !bucket) {
        funn.push({
            alvor: 'advarsel', kode: 'planner.mangler-bucket', sted,
            melding: 'Bucket er tom. Oppgaven havner i planens felles bucket.'
        });
    }

    let planAlleredeMeldt = false;
    if (plan && !plan.includes(':')) {
        planAlleredeMeldt = true;
        funn.push(harPlassholder(plan)
            ? {
                alvor: 'info', kode: 'planner.plan-form-ukjent', sted,
                melding: `«Team og plan» er «${plan}». Formen er Team:Plan — kolonet må komme `
                    + 'fra plassholderen, og det kan ikke sjekkes før innsending.'
            }
            : {
                alvor: 'feil', kode: 'planner.plan-uten-plan', sted,
                melding: `«Team og plan» er «${plan}», men mangler plandelen. Formen er `
                    + `Team:Plan — for eksempel «${plan}:Oppgaver». Slik den står nå, finner `
                    + 'flyten ingen plan.'
            });
    }

    // `plan` hoppes over når den alt er meldt over — to info-linjer om samme
    // felt er støy, og den første sier allerede at verdien ikke kan sjekkes.
    for (const [navn, verdi] of [['Team og plan', planAlleredeMeldt ? '' : plan], ['Bucket', bucket]]) {
        if (verdi && harPlassholder(verdi)) {
            funn.push({
                alvor: 'info', kode: 'planner.plassholder', sted,
                melding: `${navn} «${verdi}» inneholder en plassholder og kan ikke sjekkes før innsending.`
            });
        }
    }
}

/**
 * Teamskanal-oppsettet for ett steg.
 *
 * Feltet heter `TeamsKanalInnlegg` — det er navnet editoren skriver og
 * `varsling.js:byggTeamskanal` leser. Første versjon her leste `Teamskanal`,
 * et navn som ikke finnes noe sted, og meldte derfor begge feltene som tomme
 * uansett hva som sto i dem. Testene gikk grønt fordi testdataene brukte det
 * oppdiktede navnet; en test som sammenligner mot varsling.js står nå i
 * skjematype-diagnose.test.js.
 */
function sjekkTeamskanal(steg, nr, aktiv, funn) {
    const t = steg?.TeamsKanalInnlegg;
    const harOppsett = !!(t && (t.Team || t.Kanal || t.Tittel || t.Innhold));
    const sted = stedFor(steg, nr, 'Teams-kanal');

    if (harOppsett && !aktiv) {
        funn.push({
            alvor: 'advarsel', kode: 'teamskanal.ikke-aktiv', sted,
            melding: 'Teams-kanal er satt opp, men «teamskanal» er ikke huket av under Varsling. '
                + 'Oppsettet brukes ikke.'
        });
        return;
    }
    if (!aktiv) return;

    const team = String(t?.Team || '').trim();
    const kanal = String(t?.Kanal || '').trim();

    // Advarsel, ikke feil. Editorens egen hjelpetekst sier «Står team eller
    // kanal tomt, bruker flyten sitt eget standardvalg» — det VIRKER altså,
    // det havner bare et annet sted enn skjemaeier kanskje tror. En rød linje
    // på noe som fungerer er den formen for feilmelding som gjør at folk
    // slutter å lese lista.
    if (!team) {
        funn.push({
            alvor: 'advarsel', kode: 'teamskanal.mangler-team', sted,
            melding: 'Teams-kanal er slått på, men «Team» er tom. Innlegget havner i flytens '
                + 'eget standardteam.'
        });
    }
    if (!kanal) {
        funn.push({
            alvor: 'advarsel', kode: 'teamskanal.mangler-kanal', sted,
            melding: 'Teams-kanal er slått på, men «Kanal» er tom. Innlegget havner i flytens '
                + 'egen standardkanal.'
        });
    }
    for (const [navn, verdi] of [['Team', team], ['Kanal', kanal]]) {
        if (verdi && harPlassholder(verdi)) {
            funn.push({
                alvor: 'info', kode: 'teamskanal.plassholder', sted,
                melding: `${navn} «${verdi}» inneholder en plassholder og kan ikke sjekkes før innsending.`
            });
        }
    }
}

/**
 * SharePoint-lista, på skjematypenivå.
 *
 * De tre delene — adresse, listenavn og kolonner per felt — må stå eller
 * falle sammen. Står to av tre, skjer ingenting, og det er ingenting som
 * sier fra: `oppdaterSPListe` returnerer «hoppet-over».
 */
function sjekkSPListe(def, funn) {
    const adresse = String(def?.SPListeadresse || '').trim();
    const listenavn = String(def?.SPListenavn || '').trim();
    const sted = 'SharePoint-liste';

    const felterMedKolonne = [];
    for (const s of (def?.Seksjoner || [])) {
        for (const f of (s.Felter || [])) {
            if (String(f?.SPListefelt || '').trim()) {
                felterMedKolonne.push(`${s.Seksjon_nummer ?? s.Nummer ?? '?'}-${f.Nummer ?? '?'}`);
            }
        }
    }

    if (adresse && !listenavn) {
        funn.push({
            alvor: 'feil', kode: 'sp.mangler-listenavn', sted,
            melding: 'Adressen til SharePoint-sida er satt, men listenavnet er tomt. Ingenting skrives.'
        });
    }
    if (listenavn && !adresse) {
        funn.push({
            alvor: 'feil', kode: 'sp.mangler-adresse', sted,
            melding: 'Listenavnet er satt, men adressen til SharePoint-sida er tom. Ingenting skrives.'
        });
    }
    if (felterMedKolonne.length > 0 && !(adresse && listenavn)) {
        funn.push({
            alvor: 'feil', kode: 'sp.felt-uten-liste', sted,
            melding: `${felterMedKolonne.length} felt har SharePoint-kolonne, men lista er ikke satt opp. `
                + 'Svarene skrives ingen steder.'
        });
    }
    if (adresse && listenavn && felterMedKolonne.length === 0) {
        funn.push({
            alvor: 'advarsel', kode: 'sp.liste-uten-felt', sted,
            melding: 'Lista er satt opp, men ingen felter har SharePoint-kolonne. Det skrives bare metadata.'
        });
    }
}

/** Har steget i det hele tatt noen som kan behandle det? */
function sjekkMottakere(steg, nr, funn) {
    const antall = (steg?.Personer || []).length
        + (steg?.Roller || []).length
        + (steg?.Team || []).length;
    if (antall === 0) {
        funn.push({
            alvor: 'feil', kode: 'steg.ingen-behandlere', sted: stedFor(steg, nr, ''),
            melding: 'Steget har hverken personer, roller eller team. Ingen kan behandle det.'
        });
    }
}

/* ==================================================================
 * FASE 2: eksterne referanser
 *
 * Reglene over avgjør alt som kan avgjøres her. Resten — finnes teamet,
 * finnes lista, finnes bucketen — må noen andre svare på, og det er flyten
 * som har tilkoblingene.
 *
 * Vi sender BARE det som er verdt å spørre om. En verdi med plassholder kan
 * ikke sjekkes (den får først innhold ved innsending), en tom verdi er alt
 * dekket av reglene over, og en kanal uten team gir ikke noe meningsfullt
 * oppslag. Har skjematypen ingen eksterne referanser, kalles ikke flyten.
 * ================================================================== */

/** Kan denne verdien i det hele tatt slås opp? */
function kanSlaasOpp(verdi) {
    const v = String(verdi || '').trim();
    return v.length > 0 && !harPlassholder(v);
}

/**
 * «Team og plan» deles på FØRSTE kolon.
 *
 * Et plannavn kan inneholde kolon; et teamnavn før det kan det ikke, siden
 * skilletegnet er definert som det første. `split(':')` uten grense ville
 * delt «FFT:Saker: 2026» i tre og mistet halve plannavnet.
 */
function delTeamOgPlan(verdi) {
    const v = String(verdi || '').trim();
    const i = v.indexOf(':');
    if (i === -1) return { team: v, plan: '' };
    return { team: v.slice(0, i).trim(), plan: v.slice(i + 1).trim() };
}

/**
 * Referansene flyten skal slå opp.
 *
 * Hver får en `Id` som er stabil på tvers av kjøringer, slik at svaret kan
 * kobles tilbake uten å gjette på rekkefølge. `Sted` er til visning og
 * gjentas i svaret vårt, ikke i flytens.
 */
function eksterneReferanser(def) {
    const ut = [];
    const steg = Array.isArray(def?.Behandling) ? def.Behandling : [];

    for (let i = 0; i < steg.length; i++) {
        const s = steg[i];
        const nr = s?.Steg ?? (i + 1);
        const kanaler = aktiveKanaler(s);

        if (kanaler.includes('planner')) {
            const { team, plan } = delTeamOgPlan(s?.PlannerOppgave?.TeamOgPlan);
            const bucket = String(s?.PlannerOppgave?.Bucket || '').trim();
            // Plan uten team gir ikke noe oppslag — Planner-planer er ikke
            // globalt unike, de hører til et team.
            if (kanSlaasOpp(team) && kanSlaasOpp(plan)) {
                ut.push({
                    Id: `steg${nr}.plan`, Type: 'plan', Team: team, Plan: plan,
                    Sted: stedFor(s, nr, 'Planner')
                });
                if (kanSlaasOpp(bucket)) {
                    ut.push({
                        Id: `steg${nr}.bucket`, Type: 'bucket', Team: team, Plan: plan, Bucket: bucket,
                        Sted: stedFor(s, nr, 'Planner')
                    });
                }
            }
        }

        if (kanaler.includes('teamskanal')) {
            const t = s?.TeamsKanalInnlegg;
            const team = String(t?.Team || '').trim();
            const kanal = String(t?.Kanal || '').trim();
            if (kanSlaasOpp(team)) {
                ut.push({
                    Id: `steg${nr}.team`, Type: 'team', Team: team,
                    Sted: stedFor(s, nr, 'Teams-kanal')
                });
                // Kanaler er ikke globalt unike heller — de hører til et team.
                if (kanSlaasOpp(kanal)) {
                    ut.push({
                        Id: `steg${nr}.kanal`, Type: 'kanal', Team: team, Kanal: kanal,
                        Sted: stedFor(s, nr, 'Teams-kanal')
                    });
                }
            }
        }
    }

    const adresse = String(def?.SPListeadresse || '').trim();
    const listenavn = String(def?.SPListenavn || '').trim();
    if (kanSlaasOpp(adresse) && kanSlaasOpp(listenavn)) {
        ut.push({
            Id: 'sp.liste', Type: 'sp-liste', Adresse: adresse, Liste: listenavn,
            Sted: 'SharePoint-liste'
        });
        // Kolonnenavnene, én referanse hver. Finnes ikke lista, svarer flyten
        // «finnes-ikke» på alle sammen — og det er riktig: ingen av dem finnes.
        for (const sek of (def?.Seksjoner || [])) {
            for (const f of (sek.Felter || [])) {
                const kol = String(f?.SPListefelt || '').trim();
                if (!kanSlaasOpp(kol)) continue;
                const feltRef = `${sek.Seksjon_nummer ?? sek.Nummer ?? '?'}-${f.Nummer ?? '?'}`;
                ut.push({
                    Id: `sp.kolonne.${feltRef}`, Type: 'sp-kolonne',
                    Adresse: adresse, Liste: listenavn, Kolonne: kol,
                    Sted: `SharePoint-liste · felt ${feltRef}`
                });
            }
        }
    }

    return ut;
}

/** Statusene flyten kan svare med. */
const FLYT_STATUS = ['finnes', 'finnes-ikke', 'ingen-tilgang', 'kan-ikke-sjekkes'];

/**
 * Flett flytens svar inn i funnene.
 *
 * `finnes-ikke` er en feil: navnet peker ingen steder.
 *
 * `ingen-tilgang` er en ADVARSEL, ikke en feil. Flyten kjører som sin egen
 * tilkobling, og at den ikke ser noe betyr ikke at det ikke finnes. Slår man
 * de to sammen, ender skjemaeier med å jage et navn som er helt riktig.
 *
 * Svarer flyten ingenting om referansene — som når den bare kvitterer 200 —
 * blir det ÉN linje, ikke én per referanse. Et halvferdig endepunkt skal
 * ikke fylle skjermen.
 */
function flettFlytsvar(referanser, svar) {
    const funn = [];
    const liste = Array.isArray(svar?.Referanser) ? svar.Referanser : null;

    if (!liste || liste.length === 0) {
        if ((referanser || []).length > 0) {
            funn.push({
                alvor: 'info', kode: 'flyt.ingen-svar', sted: 'Eksterne oppslag',
                melding: `Flyten svarte, men sa ingenting om de ${referanser.length} referansene `
                    + 'som ble sendt. De er ikke sjekket.'
            });
        }
        return funn;
    }

    const perId = new Map(liste.map(r => [String(r?.Id || ''), r]));
    for (const ref of (referanser || [])) {
        const svarFor = perId.get(ref.Id);
        const status = String(svarFor?.Status || '').trim();
        const hva = beskrivReferanse(ref);
        const fraFlyten = String(svarFor?.Melding || '').trim();

        if (!svarFor || !FLYT_STATUS.includes(status)) {
            funn.push({
                alvor: 'info', kode: 'flyt.uten-svar', sted: ref.Sted,
                melding: `${hva} ble ikke sjekket — flyten svarte ikke om den.`
            });
            continue;
        }
        if (status === 'finnes') continue;
        if (status === 'finnes-ikke') {
            funn.push({
                alvor: 'feil', kode: 'flyt.finnes-ikke', sted: ref.Sted,
                melding: `${hva} finnes ikke.${fraFlyten ? ` ${fraFlyten}` : ''}`
            });
            continue;
        }
        if (status === 'ingen-tilgang') {
            funn.push({
                alvor: 'advarsel', kode: 'flyt.ingen-tilgang', sted: ref.Sted,
                melding: `${hva} kunne ikke sjekkes — flyten har ikke tilgang. `
                    + `Navnet kan være riktig.${fraFlyten ? ` ${fraFlyten}` : ''}`
            });
            continue;
        }
        funn.push({
            alvor: 'info', kode: 'flyt.kan-ikke-sjekkes', sted: ref.Sted,
            melding: `${hva} kunne ikke sjekkes.${fraFlyten ? ` ${fraFlyten}` : ''}`
        });
    }
    return funn;
}

/** Menneskelig beskrivelse av en referanse, til meldingene. */
function beskrivReferanse(ref) {
    switch (ref?.Type) {
        case 'plan':       return `Planen «${ref.Plan}» i teamet «${ref.Team}»`;
        case 'bucket':     return `Bucketen «${ref.Bucket}» i planen «${ref.Plan}»`;
        case 'team':       return `Teamet «${ref.Team}»`;
        case 'kanal':      return `Kanalen «${ref.Kanal}» i teamet «${ref.Team}»`;
        case 'sp-liste':   return `Lista «${ref.Liste}»`;
        case 'sp-kolonne': return `Kolonnen «${ref.Kolonne}» i lista «${ref.Liste}»`;
        default:           return 'Referansen';
    }
}

/**
 * Kjør hele regelsettet.
 *
 * `antallInnehavere` injiseres av hensyn til testbarheten; utelates den,
 * slås roller opp i Rollemedlemskap.
 *
 * Funnene sorteres med feil først. En liste der en advarsel står over en feil
 * leses ovenfra, og da er det advarselen som får oppmerksomheten.
 */
async function diagnoser(def, { antallInnehavere = standardAntallInnehavere } = {}) {
    const funn = [];
    const seksjoner = def?.Seksjoner || [];

    sjekkSPListe(def, funn);

    const steg = Array.isArray(def?.Behandling) ? def.Behandling : [];
    for (let i = 0; i < steg.length; i++) {
        const s = steg[i];
        const nr = s?.Steg ?? (i + 1);
        const kanaler = aktiveKanaler(s);

        sjekkMottakere(s, nr, funn);
        sjekkPlanner(s, nr, kanaler.includes('planner'), funn);
        sjekkTeamskanal(s, nr, kanaler.includes('teamskanal'), funn);

        for (const rolle of (s?.Roller || [])) {
            await sjekkRolle(rolle, {
                seksjoner, sted: stedFor(s, nr, 'Roller'), antallInnehavere, funn
            });
        }
        const ansvarlig = s?.PlannerOppgave?.AnsvarligRolle;
        if (ansvarlig && kanaler.includes('planner')) {
            await sjekkRolle(ansvarlig, {
                seksjoner, sted: stedFor(s, nr, 'Planner · ansvarlig'), antallInnehavere, funn
            });
        }
    }

    const rang = { feil: 0, advarsel: 1, info: 2 };
    funn.sort((a, b) => rang[a.alvor] - rang[b.alvor]);

    return {
        funn,
        sammendrag: {
            feil: funn.filter(f => f.alvor === 'feil').length,
            advarsel: funn.filter(f => f.alvor === 'advarsel').length,
            info: funn.filter(f => f.alvor === 'info').length
        }
    };
}

module.exports = {
    diagnoser, aktiveKanaler, harPlassholder, feltreferanser, refFinnes,
    sjekkSPListe, KANALER,
    // Fase 2
    eksterneReferanser, flettFlytsvar, delTeamOgPlan, kanSlaasOpp,
    beskrivReferanse, FLYT_STATUS
};
