/**
 * Dynamisk rolleomfang — «behandleren er klassesjefen for klassen kadetten oppga».
 *
 * Et behandlingssteg kan ha en rollestreng med feltreferanse i omfanget:
 *
 *     "Klassesjef({2-01})"                        posisjonell referanse
 *     "Klassesjef({3f7a1c2e-...})"                referanse via felt-Id
 *
 * Ved innsending erstattes referansen med kadettens svar, og steget lagres med
 * konkret omfang: "Klassesjef(MILM23-1)". Peker referansen på et flervalgsfelt,
 * gir hvert valg sin egen rolle — tre avhukede klasser blir tre klassesjefer på
 * steget, ikke bare den første.
 *
 * Hvorfor ekspandere ÉN gang ved innsending, og ikke ved hvert oppslag:
 *   - På skjematyper med Krypteres=Svar/Alt ligger svaret som chiffertekst, og
 *     tilgangssjekken i skjemaer.js kjører før dekryptering. Oppslag i
 *     ettertid ville da ikke finne klassen.
 *   - Behandleren skal ikke bytte under saksgangen om kadetten endrer svaret.
 *
 * Det er rollestrengen — ikke personene — som fryses. Legges klassesjefen inn i
 * rollelista i etterkant, får steget behandler uten at skjemaet må røres.
 *
 * Malen tas vare på i `steg.RollerMal`, så et skjema som sendes inn på nytt
 * etter ompuss ekspanderes på nytt fra malen (og ikke fra forrige resultat).
 *
 * Klasseverdier fra FasteData-datakilden «Klasser» er FS' naturlige nøkkel,
 * "{studieprogram}|{kullets start-termin}|{klassekode}" (se refresh-fs.js),
 * mens rollelista vedlikeholdes for hånd og gjerne har klassenavnet admin ser i
 * nedtrekket. Ekspansjonen prøver derfor alle formene (omfang.js) og velger den
 * som faktisk har innehavere. Finnes ingen, brukes den mest lesbare formen, så
 * hendelsesloggen viser admin hvilken rolle som må opprettes.
 */
const { finnAlleSvarForFeltRef, finnAlleSvarForFeltViaId } = require('./placeholder');
const { hentOmfangsalias } = require('./omfang');
const rollerStorage = require('./roller-storage');

const FELTREF = /\{([^}]+)\}/g;
const FELTREF_EN = /\{[^}]+\}/;
const POSISJONELL = /^(\d+)-(\d+)$/;

/** En rollestreng er dynamisk hvis den inneholder minst én feltreferanse. */
function erDynamisk(rolleStreng) {
    return /\{[^}]+\}/.test(String(rolleStreng || ''));
}

function slaOppSvar(ref, seksjoner) {
    const m = POSISJONELL.exec(ref);
    return m
        ? finnAlleSvarForFeltRef(seksjoner, m[1], m[2])
        : finnAlleSvarForFeltViaId(seksjoner, ref);
}

/**
 * Finn rollestrengen for én svarverdi, via alias-formene i omfang.js.
 * Returnerer { rolle, kandidater } — kandidatene tas vare på til logging.
 */
async function rolleForVerdi(mal, verdi) {
    const kandidater = (await hentOmfangsalias(verdi)).map(a => mal.replace(FELTREF, a).trim());
    for (const kandidat of kandidater) {
        try {
            const innehavere = await rollerStorage.hentInnehavere(kandidat);
            if (innehavere.length > 0) return { rolle: kandidat, kandidater };
        } catch (_) { /* prøv neste form */ }
    }
    // Ingen treff: behold den mest lesbare formen (klassenavnet når vi fant det,
    // ellers nøkkelen) og la sikreBehandler/hendelsesloggen si fra.
    return { rolle: kandidater[kandidater.length > 1 ? 1 : 0], kandidater };
}

/**
 * Ekspander én rollestreng mot skjemasvarene.
 *
 * Returnerer { roller, ulost, vurderte }. Er referansen ubesvart, beholdes malen
 * uendret (ulost=true) — en halvferdig "Klassesjef()" ville bare skjult
 * problemet. `vurderte` er alle rollestrengene som ble prøvd, til logging.
 *
 * Et flervalgsfelt gir én rolle per valg: huker kadetten av tre klasser, blir
 * det tre klassesjefer på steget. Steget behandles av den første som svarer —
 * `steg.Roller` har alltid vært en ELLER-liste. Skal alle tre måtte avgjøre, er
 * det `Beslutning_alle`, og den teller i dag bare konkrete `Personer`.
 */
async function ekspanderRolleStreng(rolleStreng, seksjoner) {
    const mal = String(rolleStreng || '');

    const refs = [...mal.matchAll(FELTREF)];
    if (refs.length === 0) return { roller: [mal], ulost: false, vurderte: [mal] };

    const svarPerRef = [];
    for (const [, ref] of refs) {
        const verdier = slaOppSvar(String(ref).trim(), seksjoner);
        if (verdier.length === 0) return { roller: [mal], ulost: true, vurderte: [] };
        svarPerRef.push(verdier);
    }

    // Flere referanser i samme streng er ikke i bruk. Der settes første verdi
    // per referanse inn ordrett, uten alias-oppslag — som før. Å gange ut alle
    // kombinasjonene ville laget roller ingen har bedt om.
    if (refs.length > 1) {
        const rolle = svarPerRef.reduce((s, verdier) => s.replace(FELTREF_EN, verdier[0]), mal).trim();
        return { roller: [rolle], ulost: false, vurderte: [rolle] };
    }

    const roller = [];
    const vurderte = [];
    for (const verdi of svarPerRef[0]) {
        const { rolle, kandidater } = await rolleForVerdi(mal, verdi);
        for (const k of kandidater) if (!vurderte.includes(k)) vurderte.push(k);
        if (rolle && !roller.includes(rolle)) roller.push(rolle);
    }
    return { roller, ulost: false, vurderte };
}

/**
 * Ekspander alle dynamiske roller i skjemaets behandlingssteg. Endrer skjemaet
 * in-place.
 *
 * Returnerer { ekspanderte, uloste } til logging — begge er arrays av
 * { steg, mal, roller }.
 */
async function ekspanderBehandling(skjema) {
    const seksjoner = skjema?.Seksjoner || [];
    const ekspanderte = [];
    const uloste = [];

    for (const steg of (skjema?.Behandling || [])) {
        // Malen vinner over forrige resultat, slik at ompuss + ny innsending
        // gir ny ekspansjon i stedet for å fryse første svar for godt.
        const maler = Array.isArray(steg.RollerMal) && steg.RollerMal.length > 0
            ? steg.RollerMal
            : (Array.isArray(steg.Roller) ? steg.Roller : []);
        if (!maler.some(erDynamisk)) continue;

        steg.RollerMal = [...maler];
        const nye = [];
        for (const mal of maler) {
            if (!erDynamisk(mal)) {
                if (!nye.includes(mal)) nye.push(mal);
                continue;
            }
            const { roller, ulost, vurderte } = await ekspanderRolleStreng(mal, seksjoner);
            if (ulost) uloste.push({ steg: steg.Steg, mal, roller });
            else ekspanderte.push({ steg: steg.Steg, mal, roller, vurderte });
            for (const rolle of roller) if (!nye.includes(rolle)) nye.push(rolle);
        }
        steg.Roller = nye;
    }

    return { ekspanderte, uloste };
}

/**
 * Sikre at ekspanderte steg faktisk har noen å sende til.
 *
 * Rollelista for klassesjefer vedlikeholdes manuelt, så en klasse kan mangle.
 * Får et dynamisk steg ingen innehavere, legges stegets `Reserverolle` til (om
 * satt). Reserverollen kommer i tillegg til — ikke i stedet for — den
 * ekspanderte rollen: fylles klassesjefen inn senere, treffer begge.
 *
 * TELLER PER ROLLE, ikke bare totalt.
 *
 * Ett valg i et flervalgsfelt gir én rolle — tre emner gir
 * Emneansvarlig(CU1), (CU2) og (CU3). Har bare det første en registrert
 * innehaver, er totalen positiv, og steget HAR en behandler. Fram til
 * 26.10.2026 var det alt som ble sjekket, og de to tomme gikk stille
 * igjennom: innsenderen valgte tre emner og fikk behandling av én.
 *
 * Rollelista vedlikeholdes manuelt, så det er en tilstand som oppstår av seg
 * selv — og den eneste som kan rette den, er den som får vite om den.
 *
 * Endrer skjemaet in-place. Returnerer { mangler, delvis }:
 *
 *   mangler — steg UTEN behandler i det hele tatt. Reserverollen er lagt på
 *             der den finnes. Som før.
 *   delvis  — steg som HAR en behandler, men der minst én av de ekspanderte
 *             rollene er tom. Ikke en feil som kan rettes her, men et svar
 *             på «hvorfor fikk bare én av tre emner behandling».
 */
async function sikreBehandler(skjema, log = () => {}) {
    const mangler = [];
    const delvis = [];

    for (const steg of (skjema?.Behandling || [])) {
        if (!Array.isArray(steg.RollerMal) || steg.RollerMal.length === 0) continue;

        // Telles ALLTID, også for steg som er ferdigbehandlet eller har egne
        // personer. En tom rolle er like verdt å vite om der — og å telle er
        // bare lesing. Reserverollen under har fortsatt sine egne vilkår.
        const perRolle = [];
        let antall = 0;
        for (const r of (steg.Roller || [])) {
            try {
                const n = (await rollerStorage.hentInnehavere(r)).length;
                perRolle.push({ rolle: r, antall: n });
                antall += n;
            } catch (e) {
                // Oppslagsfeil skal ikke se ut som «ingen behandler» — da ville
                // vi lagt på reserverollen på feil grunnlag. Av samme grunn
                // skal den heller ikke se ut som en TOM rolle: da ville vi
                // meldt et hull som kanskje ikke finnes.
                log(`dynamisk-rolle: oppslag av "${r}" feilet — ${e.message}`);
                perRolle.push({ rolle: r, antall: null, feil: e.message });
                antall++;
            }
        }

        // `antall === 0` og ikke `!p.antall`: et feilet oppslag har `null`, og
        // vi vet ikke om den rollen er tom. Den holdes utenfor `tomme` — men
        // den stopper ikke meldingen om de ANDRE.
        //
        // Første utgave undertrykte hele meldingen når ett oppslag feilet.
        // Det kastet bort det vi faktisk visste: feilet oppslaget for CU2 mens
        // CU3 svarte 0, er CU3 tom uansett hva CU2 er. Og undertrykkingen
        // gjorde `antall: null` umulig å observere — en vakt ingen test kan
        // skille fra ingenting.
        const tomme = perRolle.filter(p => p.antall === 0).map(p => p.rolle);

        // Delvis dekket: noen har behandler, minst én rolle er sikkert tom.
        if (antall > 0 && tomme.length > 0) {
            delvis.push({
                steg: steg.Steg,
                roller: [...(steg.Roller || [])],
                tomme,
                perRolle,
                mal: [...(steg.RollerMal || [])]
            });
        }

        // Reserverollen — uendrede vilkår.
        if (Number(steg.Beslutning || 0) !== 0) continue;
        if ((steg.Personer || []).length > 0 || (steg.Team || []).length > 0) continue;
        if (antall > 0) continue;

        const reserve = String(steg.Reserverolle || '').trim();
        if (reserve && !(steg.Roller || []).includes(reserve)) {
            steg.Roller = [...(steg.Roller || []), reserve];
        }
        mangler.push({
            steg: steg.Steg,
            roller: [...(steg.Roller || [])],
            perRolle,
            reserverolle: reserve,
            dekket: !!reserve
        });
    }
    return { mangler, delvis };
}

module.exports = {
    erDynamisk,
    ekspanderRolleStreng,
    ekspanderBehandling,
    sikreBehandler
};
