/**
 * behandling.js — Logikk for aktive behandlingssteg.
 *
 * Et steg er "aktivt" hvis:
 *   - Beslutning = 0 (ikke behandlet ennå)
 *   - AvhengigAv-steget er behandlet (eller ingen avhengighet)
 *   - Vilkår er oppfylt (eller ingen vilkår)
 *
 * En bruker er "behandler" for et steg hvis:
 *   - UPN finnes i steg.Personer, ELLER
 *   - UPN er innehaver av en rolle i steg.Roller (via roller-storage)
 *   - Team-basert behandling kommer med Graph API (fase 8)
 */
const { evaluerVilkar } = require('./vilkar');
const { erRolleMedlem, erTeamMedlem } = require('./tilgang');

function stegErFerdig(steg) {
    return Number(steg?.Beslutning || 0) !== 0;
}

function stegErBlokkertAvAvhengighet(steg, alleSteg) {
    if (!steg?.AvhengigAv) return false;
    const avh = alleSteg.find(s => Number(s.Steg) === Number(steg.AvhengigAv));
    if (!avh) return true; // referanse til ikke-eksisterende steg blokkerer
    return !stegErFerdig(avh);
}

function beregnAktiveSteg(skjema) {
    const behandling = skjema?.Behandling || [];
    const aktive = [];
    for (const steg of behandling) {
        if (stegErFerdig(steg)) continue;
        if (stegErBlokkertAvAvhengighet(steg, behandling)) continue;
        if (steg.Vilkår && !evaluerVilkar(steg.Vilkår, skjema.Seksjoner, behandling)) continue;
        aktive.push(steg);
    }
    return aktive;
}

function brukerErBehandler(steg, upn) {
    if (!upn) return false;
    const upnLower = String(upn).toLowerCase();
    return (steg?.Personer || []).map(p => String(p).toLowerCase()).includes(upnLower);
}

/**
 * Utvidet variant som også sjekker Roller. Krever async pga rolle-oppslag.
 * Bruk denne der behandler-sjekken skjer i request-håndtering.
 */
/**
 * @param {object} [cache] — valgfri memo fra tilgang.lagTilgangsCache(). Send
 *   inn når mange skjemaer sjekkes i samme forespørsel (f.eks. mine-behandlinger);
 *   da slås hver rolle opp én gang i stedet for én gang per skjema.
 */
async function brukerErBehandlerAsync(steg, upn, cache = null) {
    if (brukerErBehandler(steg, upn)) return true;
    const roller = steg?.Roller || [];
    for (const r of roller) {
        try {
            if (await erRolleMedlem(cache, r, upn)) return true;
        } catch (_) { /* prøv neste */ }
    }
    const team = steg?.Team || [];
    for (const t of team) {
        try {
            if (await erTeamMedlem(cache, t, upn)) return true;
        } catch (_) { /* prøv neste */ }
    }
    return false;
}

/**
 * Hvem som fortsatt må avgi beslutning på et «alle må avgjøre»-steg.
 *
 * Kravene er stegets konkrete Personer, hver rollestreng i Roller og hvert Team.
 * En rolle er dekket når én av innehaverne har levert — ett svar per rolle, ikke
 * per person. Det er granulariteten saken har: tre klassesjefer på tre klasser
 * gir tre vurderinger, og at én klasse har to registrerte sjefer betyr ikke at
 * begge må svare. Dekker samme person to roller, dekker det ene svaret begge.
 *
 * Fram til dette telte modusen bare Personer, så et steg med roller falt stille
 * tilbake til «første behandler avgjør».
 *
 * @param {object} steg
 * @param {object} [cache] — memo fra tilgang.lagTilgangsCache()
 * @returns {Promise<{krav: object[], gjenstar: string[], alleLevert: boolean}>}
 */
async function beregnAlleKrav(steg, cache = null) {
    const leverte = [...new Set(
        (steg?.Beslutninger || [])
            .map(b => String(b.Aktor || '').toLowerCase())
            .filter(Boolean)
    )];
    const levertSett = new Set(leverte);
    const krav = [];

    for (const p of (steg?.Personer || [])) {
        const navn = String(p || '').toLowerCase();
        if (!navn || krav.some(k => k.type === 'person' && k.navn === navn)) continue;
        krav.push({ type: 'person', navn, dekket: levertSett.has(navn) });
    }

    for (const [type, liste, erMedlem] of [
        ['rolle', steg?.Roller || [], erRolleMedlem],
        ['team', steg?.Team || [], erTeamMedlem]
    ]) {
        for (const oppforing of liste) {
            const navn = String(oppforing || '');
            if (!navn || krav.some(k => k.type === type && k.navn === navn)) continue;
            let dekket = false;
            for (const aktor of leverte) {
                try {
                    if (await erMedlem(cache, navn, aktor)) { dekket = true; break; }
                } catch (_) { /* oppslagsfeil skal ikke låse steget — prøv neste */ }
            }
            krav.push({ type, navn, dekket });
        }
    }

    return {
        krav,
        gjenstar: krav.filter(k => !k.dekket).map(k => k.navn),
        alleLevert: krav.length > 0 && krav.every(k => k.dekket)
    };
}

function alleStegFerdig(skjema) {
    const behandling = skjema?.Behandling || [];
    if (behandling.length === 0) return true;
    return behandling.every(stegErFerdig);
}

/**
 * Marker steg som "Hoppet over" (Beslutning=5) hvis:
 *   - Ikke behandlet ennå
 *   - Avhengighet er oppfylt (så vilkåret kan evalueres pålitelig)
 *   - Vilkår finnes og er ikke oppfylt
 *
 * Løper fixpunkt — noen skip kan trigge nye skip via Behandling-referanser.
 * Endrer skjemaet in-place. Returnerer antall steg som ble skippet.
 */
function skipStegSomIkkeSkalKjore(skjema) {
    if (!Array.isArray(skjema?.Behandling)) return 0;
    let totalSkippet = 0;
    let endret = true;
    while (endret) {
        endret = false;
        for (const s of skjema.Behandling) {
            if (Number(s.Beslutning || 0) !== 0) continue;
            if (stegErBlokkertAvAvhengighet(s, skjema.Behandling)) continue;
            if (s.Vilkår && !evaluerVilkar(s.Vilkår, skjema.Seksjoner, skjema.Behandling)) {
                s.Beslutning = 5;
                s.BehandletAv = 'system';
                s.BehandletDato = new Date().toISOString();
                totalSkippet++;
                endret = true;
            }
        }
    }
    return totalSkippet;
}

module.exports = {
    beregnAktiveSteg,
    brukerErBehandler,
    brukerErBehandlerAsync,
    beregnAlleKrav,
    alleStegFerdig,
    stegErFerdig,
    stegErBlokkertAvAvhengighet,
    skipStegSomIkkeSkalKjore
};
