/**
 * Dynamisk rolleomfang — «behandleren er klassesjefen for klassen kadetten oppga».
 *
 * Et behandlingssteg kan ha en rollestreng med feltreferanse i omfanget:
 *
 *     "Klassesjef({2-01})"                        posisjonell referanse
 *     "Klassesjef({3f7a1c2e-...})"                referanse via felt-Id
 *
 * Ved innsending erstattes referansen med kadettens svar, og steget lagres med
 * konkret omfang: "Klassesjef(MILM23-1)".
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
 * Klasseverdier fra FasteData-datakilden «Klasser» er sammensatte nøkler på
 * formen "{studieprogram}|{termin}|{klassekode}" (se refresh-fs.js). Omfanget
 * skal være ren klassekode — klassen består over flere terminer selv om
 * nøkkelen ikke gjør det — så vi bruker siste ledd etter «|».
 */
const { finnSvarForFeltRef, finnSvarForFeltViaId } = require('./placeholder');
const rollerStorage = require('./roller-storage');

const FELTREF = /\{([^}]+)\}/g;
const POSISJONELL = /^(\d+)-(\d+)$/;

/** En rollestreng er dynamisk hvis den inneholder minst én feltreferanse. */
function erDynamisk(rolleStreng) {
    return /\{[^}]+\}/.test(String(rolleStreng || ''));
}

/**
 * Siste ledd etter «|». Gjør sammensatte FasteData-nøkler
 * ("BMIL|2025H|MILM23-1") om til den delen rollelista vedlikeholdes på.
 */
function sisteLedd(verdi) {
    const s = String(verdi ?? '').trim();
    const i = s.lastIndexOf('|');
    return (i >= 0 ? s.slice(i + 1) : s).trim();
}

function slaOppSvar(ref, seksjoner) {
    const m = POSISJONELL.exec(ref);
    return m
        ? finnSvarForFeltRef(seksjoner, m[1], m[2])
        : finnSvarForFeltViaId(seksjoner, ref);
}

/**
 * Ekspander én rollestreng mot skjemasvarene.
 * Returnerer { rolle, ulost }. Er referansen ubesvart, beholdes malen uendret
 * (ulost=true) — en halvferdig "Klassesjef()" ville bare skjult problemet.
 */
function ekspanderRolleStreng(rolleStreng, seksjoner) {
    const mal = String(rolleStreng || '');
    let ulost = false;
    const lost = mal.replace(FELTREF, (_treff, ref) => {
        const verdi = sisteLedd(slaOppSvar(String(ref).trim(), seksjoner));
        if (!verdi) { ulost = true; return ''; }
        return verdi;
    });
    return ulost ? { rolle: mal, ulost: true } : { rolle: lost.trim(), ulost: false };
}

/**
 * Ekspander alle dynamiske roller i skjemaets behandlingssteg. Endrer skjemaet
 * in-place.
 *
 * Returnerer { ekspanderte, uloste } til logging — begge er arrays av
 * { steg, mal, rolle }.
 */
function ekspanderBehandling(skjema) {
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
            const { rolle, ulost } = ekspanderRolleStreng(mal, seksjoner);
            if (ulost) uloste.push({ steg: steg.Steg, mal, rolle });
            else ekspanderte.push({ steg: steg.Steg, mal, rolle });
            if (!nye.includes(rolle)) nye.push(rolle);
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
 * Endrer skjemaet in-place. Returnerer array av
 * { steg, roller, reserverolle, dekket } for de stegene som manglet behandler.
 */
async function sikreBehandler(skjema, log = () => {}) {
    const mangler = [];
    for (const steg of (skjema?.Behandling || [])) {
        if (!Array.isArray(steg.RollerMal) || steg.RollerMal.length === 0) continue;
        if (Number(steg.Beslutning || 0) !== 0) continue;
        if ((steg.Personer || []).length > 0 || (steg.Team || []).length > 0) continue;

        let antall = 0;
        for (const r of (steg.Roller || [])) {
            try {
                antall += (await rollerStorage.hentInnehavere(r)).length;
            } catch (e) {
                // Oppslagsfeil skal ikke se ut som «ingen behandler» — da ville
                // vi lagt på reserverollen på feil grunnlag.
                log(`dynamisk-rolle: oppslag av "${r}" feilet — ${e.message}`);
                antall++;
            }
        }
        if (antall > 0) continue;

        const reserve = String(steg.Reserverolle || '').trim();
        if (reserve && !(steg.Roller || []).includes(reserve)) {
            steg.Roller = [...(steg.Roller || []), reserve];
        }
        mangler.push({
            steg: steg.Steg,
            roller: [...(steg.Roller || [])],
            reserverolle: reserve,
            dekket: !!reserve
        });
    }
    return mangler;
}

module.exports = {
    erDynamisk,
    sisteLedd,
    ekspanderRolleStreng,
    ekspanderBehandling,
    sikreBehandler
};
