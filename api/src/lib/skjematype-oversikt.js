/**
 * Oversikt over skjematyper: eiere, status, antall utfylte og siste dato.
 *
 * Rene funksjoner — sammenstillingen skjer her, oppslagene i endepunktet.
 * Det er ikke bare for testbarhet: hvem som eier en skjematype og hva
 * «utfylt» betyr er avgjørelser, og de bør stå ett sted og kunne etterprøves.
 */

/**
 * Eierne av en skjematype, som lesbar tekst.
 *
 * `Eiere` er en tilgangsstruktur `{ Personer, Roller, Team }`, samme form som
 * Publikum og Behandlere. Alle tre delene tas med — en skjematype eid av en
 * rolle har ingen navngitt person, og en oversikt som bare viste Personer
 * ville vist tomt for nettopp de typene der eierskapet er mest uklart.
 */
function eiereTekst(eiere) {
    const deler = [
        ...(eiere?.Personer || []),
        ...(eiere?.Roller || []),
        ...(eiere?.Team || []).map(t => `Team: ${t}`)
    ].map(x => String(x || '').trim()).filter(Boolean);
    return deler.join(', ');
}

/**
 * Hva «antall utfylte» betyr.
 *
 * Et mellomlagret skjema er påbegynt, ikke levert. Telles det med, ser en
 * skjematype mer brukt ut enn den er — og forskjellen er nettopp det man
 * lurer på når man ser en slik oversikt.
 *
 * Derfor: `Utfylte` er innsendte skjemaer (alt som ikke er mellomlagret), og
 * mellomlagrede vises for seg.
 */
function tellinger(rad) {
    const antall = Number(rad?.Antall || 0);
    const mellomlagret = Number(rad?.Mellomlagret || 0);
    return {
        Utfylte: Math.max(0, antall - mellomlagret),
        Mellomlagret: mellomlagret,
        UnderBehandling: Number(rad?.UnderBehandling || 0),
        Avsluttet: Number(rad?.Avsluttet || 0),
        Totalt: antall
    };
}

/**
 * Sett sammen én rad per skjematype.
 *
 * `antallKart` er `Map` fra `hentAntallPerType()`. En skjematype uten
 * skjemaer skal med i lista med null — den er ofte hele poenget: en
 * skjematype i produksjon som ingen har brukt, er verdt å se.
 */
function byggOversikt(skjematyper, antallKart) {
    const kart = antallKart instanceof Map ? antallKart : new Map(Object.entries(antallKart || {}));
    return (skjematyper || []).map(st => {
        const def = st?.JSON || {};
        const id = String(st?.Skjematype_id ?? def.Skjematype_id ?? '');
        const t = tellinger(kart.get(id));
        return {
            Skjematype_id: id,
            Skjema_navn: def.Skjema_navn || st?.Skjema_navn || '',
            Fase: def.Fase || 'Produksjon',
            Eiere: eiereTekst(def.Eiere),
            Behandlingssteg: Array.isArray(def.Behandling) ? def.Behandling.length : 0,
            Samtale: def.Samtale || 'Av',
            ...t,
            SisteDato: kart.get(id)?.SisteDato || ''
        };
    }).sort(sorterOversikt);
}

/**
 * Mest brukt først, så alfabetisk.
 *
 * En oversikt sortert på navn skjuler det man kom for å se. Den som åpner
 * denne siden lurer på hvilke skjematyper som faktisk er i bruk — og de
 * ubrukte er interessante nettopp fordi de står nederst.
 */
function sorterOversikt(a, b) {
    if (b.Totalt !== a.Totalt) return b.Totalt - a.Totalt;
    return String(a.Skjema_navn).localeCompare(String(b.Skjema_navn), 'no');
}

module.exports = { eiereTekst, tellinger, byggOversikt, sorterOversikt };
