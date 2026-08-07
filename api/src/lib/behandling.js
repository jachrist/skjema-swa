/**
 * behandling.js — Logikk for aktive behandlingssteg.
 *
 * Et steg er "aktivt" hvis:
 *   - Beslutning = 0 (ikke behandlet ennå)
 *   - AvhengigAv-steget er behandlet (eller ingen avhengighet)
 *   - Vilkår er oppfylt (eller ingen vilkår)
 *
 * En bruker er "behandler" for et steg hvis UPN finnes i steg.Personer.
 * Roller/Team-basert behandling kommer med masterdata-fasen.
 */
const { evaluerVilkar } = require('./vilkar');

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

function alleStegFerdig(skjema) {
    const behandling = skjema?.Behandling || [];
    if (behandling.length === 0) return true;
    return behandling.every(stegErFerdig);
}

module.exports = {
    beregnAktiveSteg,
    brukerErBehandler,
    alleStegFerdig,
    stegErFerdig,
    stegErBlokkertAvAvhengighet
};
