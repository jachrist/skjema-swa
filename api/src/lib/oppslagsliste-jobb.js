/**
 * Døgnjobben som bygger oppslagslistene.
 *
 * Henter oppsettet, leser forekomstene av kildeskjematypen, dekrypterer dem,
 * bygger radene og skriver dem til `Oppslagsliste`-tabellen.
 *
 * Timer-triggere støttes ikke i SWA Managed Functions, så den kalles av en
 * GitHub Actions cron mot et HTTP-endepunkt — samme mønster som FS-refreshen
 * (`.github/workflows/refresh-oppslagsliste.yml`).
 *
 * `tørr: true` bygger uten å skrive, og gir de første radene tilbake. Det er
 * forhåndsvisningen: en skjematype defineres i prod, og den som setter opp
 * lista må kunne se de genererte strengene mot ekte data FØR noe lagres.
 */
const forekomstStorage = require('./skjema-forekomst-storage');
const skjemaStorage = require('./skjema-storage');
const nokkelStorage = require('./nokkel-storage');
const kryptering = require('./kryptering');
const lagring = require('./oppslagsliste-storage');
const { byggListe } = require('./oppslagsliste');

/** Hvor mange rader forhåndsvisningen viser. Nok til å se formatet, ikke hele lista. */
const FORHANDSVIS_ANTALL = 10;

/**
 * Bygg én liste.
 *
 * Feiler alltid HØYT: et oppsett som peker på en slettet skjematype, eller en
 * merkelapp som ikke finnes, skal gi en melding — ikke en tom liste. En tom
 * liste i et nedtrekk er umulig å skille fra «ingen vurderinger er godkjent
 * ennå», og det var nettopp den forvekslingen som kostet tid sist.
 */
async function byggEn(oppsett, { tørr = false, log = () => {} } = {}) {
    const navn = String(oppsett?.Navn || '').trim();
    const skjematypeId = String(oppsett?.Skjematype_id || '').trim();
    if (!skjematypeId) throw new Error(`Lista "${navn}" mangler skjematype`);

    const st = await skjemaStorage.hentSkjematype(skjematypeId);
    if (!st?.JSON) throw new Error(`Kildeskjematype ${skjematypeId} for "${navn}" finnes ikke`);

    const skjemaer = await forekomstStorage.hentAlleSkjemaerForType(skjematypeId, { fulltFormat: true });
    const dekryptert = await kryptering.dekrypterAlle(
        skjemaer, skjematypeId, nokkelStorage, (m) => log(`${navn}: ${m}`));

    const { rader, hoppet, felter } = byggListe(oppsett, st.JSON, dekryptert);
    log(`${navn}: ${rader.length} rader av ${dekryptert.length} forekomster `
        + `(${hoppet.length} hoppet over), felter ${felter.map(f => f.nokkel).join(', ')}`);

    if (!tørr) {
        await lagring.erstattListe(navn, rader, { log });
        await lagring.settStatus(navn, {
            Status: 'ok', Antall: rader.length, Hoppet: hoppet.length,
            SistKjort: new Date().toISOString(), Melding: ''
        });
    }

    return {
        navn,
        skjematypeId,
        kildeNavn: st.navn || '',
        antallForekomster: dekryptert.length,
        antall: rader.length,
        antallHoppet: hoppet.length,
        felter: felter.map(f => ({ nokkel: f.nokkel, merkelapp: f.merkelapp, prefiks: f.prefiks })),
        // Begge er ALLTID satt, også tomme. Uten det kan «ingen rader ble
        // hoppet over» ikke skilles fra «koden som teller dem er ikke ute».
        forhandsvisning: rader.slice(0, FORHANDSVIS_ANTALL).map(r => r.Tekst),
        hoppet: hoppet.slice(0, FORHANDSVIS_ANTALL),
        skrevet: !tørr
    };
}

/**
 * Bygg alle listene, eller én navngitt.
 *
 * En liste som feiler stopper ikke de andre: ett oppsett med en skrivefeil
 * skal ikke ta hele døgnjobben med seg. Feilen havner i `feil[]` OG i
 * statusraden for den lista, slik at admin-panelet viser den.
 */
async function byggAlle({ bareNavn = null, tørr = false, log = () => {} } = {}) {
    const alle = await lagring.hentOppsett(log);
    const valgte = bareNavn
        ? alle.filter(l => String(l.Navn).trim().toLowerCase() === String(bareNavn).trim().toLowerCase())
        : alle;

    if (bareNavn && valgte.length === 0) {
        throw new Error(`Fant ingen oppslagsliste som heter "${bareNavn}". `
            + `Definerte lister: ${alle.map(l => `"${l.Navn}"`).join(', ') || '(ingen)'}`);
    }

    const resultater = [];
    const feil = [];
    for (const oppsett of valgte) {
        try {
            resultater.push(await byggEn(oppsett, { tørr, log }));
        } catch (e) {
            const navn = String(oppsett?.Navn || '(uten navn)');
            log(`oppslagsliste "${navn}" FEILET: ${e.message}`);
            feil.push({ navn, melding: e.message });
            if (!tørr) {
                await lagring.settStatus(navn, {
                    Status: 'feil', SistKjort: new Date().toISOString(), Melding: e.message
                }).catch(() => {});
            }
        }
    }
    return { antallLister: valgte.length, resultater, feil, tørr };
}

module.exports = { byggEn, byggAlle, FORHANDSVIS_ANTALL };
