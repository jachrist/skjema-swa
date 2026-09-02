/**
 * svar-reparasjon.js — flytt lagrede svar med når feltnumrene endrer seg.
 *
 * Feltnummer tildeles etter posisjon. Slettes eller flyttes et felt i editoren,
 * forskyves numrene under, og skjemaer som koblet svarene sine på posisjon
 * peker plutselig på nabospørsmålet. Det er verre enn et tomt felt: svaret
 * vises, det ser riktig ut, og ingen oppdager det.
 *
 * Feltets `Id` står stille. Ved å sammenligne forrige lagrede definisjon med
 * den nye kan vi derfor regne ut nøyaktig hvilke posisjoner som har flyttet
 * seg, og skrive svarene over til sine nye plasser.
 *
 * Kartet MÅ komme fra en sammenligning av de to definisjonene på serveren.
 * Etter at den nye definisjonen er lagret er den gamle borte, så analysen må
 * skje før lagring — derfor tar funksjonene her kartet inn, i stedet for å
 * hente definisjoner selv.
 *
 * Skjemaer som allerede bærer feltets Id trenger ingen reparasjon: oppslaget
 * finner dem uansett posisjon. Det er de eldre, kompakte radene uten Id som
 * er sårbare, og det er dem denne jobben er til for.
 */

/** Posisjonsnøkkel, samme form som skjema-kompakt.js bruker. */
function nokkel(sekNr, feltNr) {
    return `${sekNr}-${String(feltNr).padStart(2, '0')}`;
}

/** Map fra feltets Id til posisjonen det har i denne definisjonen. */
function posisjonerPerId(def) {
    const ut = new Map();
    for (const seksjon of (def?.Seksjoner || [])) {
        const sekNr = seksjon.Nummer ?? seksjon.Seksjon_nummer;
        for (const felt of (seksjon.Felter || [])) {
            if (felt.Type === 'Informasjon') continue;
            if (!felt.Id) continue;
            ut.set(felt.Id, nokkel(sekNr, felt.Nummer));
        }
    }
    return ut;
}

/**
 * Hvilke posisjoner har flyttet seg mellom to versjoner av en definisjon?
 *
 * Returnerer { flyttinger: [{ id, fra, til }], fjernet: [id] }.
 *
 * Felt som er fjernet tas med for seg: svarene deres hører til et spørsmål som
 * ikke finnes lenger, og skal ikke skrives over på et annet felt. De blir
 * liggende urørt i raden.
 */
function byggFlyttekart(gammelDef, nyDef) {
    const før = posisjonerPerId(gammelDef);
    const etter = posisjonerPerId(nyDef);

    const flyttinger = [];
    const fjernet = [];
    for (const [id, fra] of før) {
        const til = etter.get(id);
        if (til === undefined) { fjernet.push(id); continue; }
        if (til !== fra) flyttinger.push({ id, fra, til });
    }
    return { flyttinger, fjernet };
}

/**
 * Skriv om posisjonene i ett kompakt skjema.
 *
 * Returnerer { endret, skjema }. Skjemaet er en kopi — kalleren bestemmer om
 * det skal lagres.
 *
 * To ting gjøres samtidig:
 *   1. `sek`/`spm` flyttes til den nye posisjonen
 *   2. `id` stemples inn
 *
 * Punkt 2 er det som gjør at raden ikke trenger denne jobben igjen. Uten den
 * ville hver framtidige omrokering krevd en ny reparasjon.
 */
function reparerKompakt(skjema, flyttinger) {
    const kart = new Map(flyttinger.map(f => [f.fra, f]));
    let endret = false;

    const nyttSvar = (skjema.Svar || []).map(rad => {
        const fra = nokkel(rad.sek, rad.spm);
        const treff = kart.get(fra);
        if (!treff) return rad;

        const [sekStr, spmStr] = treff.til.split('-');
        endret = true;
        return { ...rad, sek: Number(sekStr), spm: spmStr, id: treff.id };
    });

    if (!endret) return { endret: false, skjema };
    return { endret: true, skjema: { ...skjema, Svar: nyttSvar } };
}

/**
 * Trenger dette skjemaet reparasjon?
 *
 * Nei hvis det er fullformat (feltene bærer Id og finnes uansett posisjon),
 * nei hvis alle kompaktrader allerede har `id`, og nei hvis ingen av radene
 * står på en posisjon som har flyttet seg.
 */
function trengerReparasjon(skjema, flyttinger) {
    if (!skjema || !Array.isArray(skjema.Svar) || Array.isArray(skjema.Seksjoner)) return false;
    const berørte = new Set(flyttinger.map(f => f.fra));
    return (skjema.Svar || []).some(rad => !rad.id && berørte.has(nokkel(rad.sek, rad.spm)));
}

/**
 * Gå gjennom alle skjemaer av en type og reparer dem som trenger det.
 *
 * `torrkjor: true` teller uten å skrive. Kalleren bør alltid kjøre tørt først
 * og vise tallet til brukeren — en reparasjon som treffer feil er vanskeligere
 * å oppdage enn en som ikke ble kjørt.
 *
 * deps injiseres for test: { hentAlle, lagre, log }.
 */
async function reparerAlle({ skjematypeId, flyttinger, torrkjor = false }, deps = {}) {
    const log = deps.log || (() => { });
    if (!Array.isArray(flyttinger) || flyttinger.length === 0) {
        return { vurdert: 0, berørte: 0, reparert: 0, feilet: 0, torrkjor };
    }

    const forekomstStorage = deps.forekomstStorage || require('./skjema-forekomst-storage');
    const hentAlle = deps.hentAlle
        || ((id) => forekomstStorage.hentAlleSkjemaerForType(id, { fulltFormat: false }));
    const lagre = deps.lagre || ((s) => forekomstStorage.lagreSkjema(s, false));

    const alle = await hentAlle(skjematypeId);
    let berørte = 0, reparert = 0, feilet = 0;

    for (const skjema of alle) {
        if (!trengerReparasjon(skjema, flyttinger)) continue;
        berørte++;
        if (torrkjor) continue;

        const { endret, skjema: nytt } = reparerKompakt(skjema, flyttinger);
        if (!endret) continue;
        try {
            await lagre(nytt);
            reparert++;
        } catch (e) {
            feilet++;
            log(`svar-reparasjon: kunne ikke lagre skjema ${skjema.Skjema_id}: ${e.message}`);
        }
    }

    return { vurdert: alle.length, berørte, reparert, feilet, torrkjor };
}

module.exports = {
    posisjonerPerId,
    byggFlyttekart,
    reparerKompakt,
    trengerReparasjon,
    reparerAlle
};
