/**
 * En mengde skjematype-ID-er lagret under én nøkkel i SystemInnstillinger.
 *
 * To avkrysninger i Administrasjon → Skjematyper bruker den: «Varsle eier» i
 * M365-koblinger (`UbruktVarsel.Av`) og kravet om gevinstskjemaer
 * (`Gevinst.Fritatt`). Begge er lister over unntak, satt av admin, og begge
 * skal ligge utenfor skjematypedefinisjonen — en avkrysning i admin skal ikke
 * endre «sist endret» på en skjematype.
 *
 * Verdien er en JSON-liste. Ødelagt eller manglende verdi leses som tom: et
 * unntak som ikke lar seg lese, er ikke et unntak.
 */

/** Mengden under `nokkel`. Tom ved feil eller ukjent form. */
async function les(nokkel, innstillinger = require('./innstillinger-storage')) {
    try {
        const rad = await innstillinger.hent(nokkel);
        const liste = JSON.parse(rad?.Verdi || '[]');
        return new Set(Array.isArray(liste) ? liste.map(String) : []);
    } catch (_) {
        return new Set();
    }
}

/**
 * Legg `ider` til (`medlem: true`) eller ta dem ut (`false`). Returnerer
 * lista etterpå, sortert med tall i tallrekkefølge.
 */
async function sett(nokkel, ider, medlem, aktor, innstillinger = require('./innstillinger-storage')) {
    const mengde = await les(nokkel, innstillinger);
    for (const id of (ider || []).map(String).filter(Boolean)) {
        if (medlem) mengde.add(id); else mengde.delete(id);
    }
    const liste = [...mengde].sort((a, b) => a.localeCompare(b, 'no', { numeric: true }));
    await innstillinger.sett(nokkel, JSON.stringify(liste), aktor);
    return liste;
}

module.exports = { les, sett };
