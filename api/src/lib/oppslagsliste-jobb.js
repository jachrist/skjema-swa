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

/**
 * Jobbens egen statusrad.
 *
 * De per-liste radene heter `Oppslagsliste-<navn>` og leses av
 * `hentStatus()` i oppslagsliste-storage, som filtrerer på nettopp det
 * prefikset. Jobbraden må derfor IKKE begynne på «Oppslagsliste-»: gjorde
 * den det, ville den dukket opp i admin-panelet som en liste ved navn «Jobb»,
 * med status og alt — en liste ingen har definert, som ingen tør slette.
 *
 * Derfor `Jobb-` foran. Avstanden til «Oppslagsliste-» er med vilje større
 * enn én bokstav; `Oppslaglister-Jobb` ville vært ett tegn fra å matche.
 */
const JOBB_PK = 'Meta';
const JOBB_RK = 'Jobb-Oppslaglister';

/**
 * Kjør døgnjobben og bokfør utfallet. Kaster aldri.
 *
 * To inngangsporter, én bokføring — samme form som `postnummer-jobb.js` og
 * `refresh-fs-jobb.js`. Statusraden her er på JOBBNIVÅ: «kjørte jobben, når,
 * startet av hvem, hvor mange lister». De per-liste radene er uendret, og det
 * er fortsatt de Oppslagslister-fanen viser.
 *
 * **Tørrkjøring bokføres ikke, og skal ikke.** Forhåndsvisningen skriver
 * ingenting, og en statusrad som sa «kjørt 12:04» etter en forhåndsvisning
 * ville vært en påstand om data som aldri ble skrevet.
 *
 * `utfall` skiller tre ting som alle er «ikke grønt» på hver sin måte:
 *   `delvis` — noen lister feilet, andre ble bygget. En død liste gir et tomt
 *              nedtrekk, og det er ikke «ok».
 *   `feil`   — ingen lister ble bygget.
 *   `kastet` — jobben kom aldri i gang (oppsettet kunne ikke leses).
 */
async function kjorOppslagslister({ kilde, bareNavn = null, log = () => {} } = {}) {
    const { tabellKlient } = require('./storage');
    const hendelser = require('./hendelser-storage');

    const startTid = new Date().toISOString();
    const settStatus = async (felter) => {
        try {
            const t = tabellKlient('CacheMetadata');
            await t.upsertEntity({ partitionKey: JOBB_PK, rowKey: JOBB_RK, ...felter }, 'Merge');
        } catch (_) { /* statusraden er ikke kritisk */ }
    };

    await settStatus({ Status: 'kjører', Startet: startTid, Kilde: kilde, SistFeil: '' });
    log(`oppslaglister: trigget av ${kilde}`);

    let res;
    try {
        res = await byggAlle({ bareNavn, tørr: false, log });
    } catch (e) {
        const melding = String(e.message || e);
        log(`oppslaglister FEIL: ${melding}`);
        await settStatus({
            Status: 'feil', Ferdig: new Date().toISOString(),
            SistFeil: melding.slice(0, 500)
        });
        hendelser.logg({
            Type: 'oppslagsliste.feil', Aktor: kilde,
            ObjektType: 'oppslagsliste', ObjektId: bareNavn || '',
            Melding: `Oppslagslistejobben kom ikke i gang: ${melding}`.slice(0, 500)
        });
        return { utfall: 'feil', kastet: true, melding, resultat: null };
    }

    const utfall = res.feil.length === 0 ? 'ok' : (res.resultater.length > 0 ? 'delvis' : 'feil');
    await settStatus({
        Status: utfall,
        Ferdig: new Date().toISOString(),
        SistOppdatert: new Date().toISOString(),
        AntallLister: res.antallLister,
        AntallFeilet: res.feil.length,
        VarighetSekunder: Math.round((Date.now() - Date.parse(startTid)) / 1000),
        SistFeil: res.feil.map(f => `${f.navn}: ${f.melding}`).join(' | ').slice(0, 500)
    });
    hendelser.logg({
        Type: 'oppslagsliste.oppdater', Aktor: kilde,
        ObjektType: 'oppslagsliste', ObjektId: bareNavn || '',
        Melding: `Oppdaterte ${res.resultater.length} av ${res.antallLister} oppslagsliste(r)`
            + (res.feil.length ? `, ${res.feil.length} feilet` : ''),
        Detaljer: {
            resultater: res.resultater.map(r => `${r.navn}: ${r.antall} rader`),
            feil: res.feil.map(f => `${f.navn}: ${f.melding}`)
        }
    });
    return { utfall, kastet: false, melding: null, resultat: res };
}

module.exports = {
    byggEn, byggAlle, kjorOppslagslister, FORHANDSVIS_ANTALL, JOBB_PK, JOBB_RK
};
