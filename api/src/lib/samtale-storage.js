/**
 * Samtale — gruppechat mellom innsender og behandlere, én tråd per skjema.
 *
 * Egen tabell, ikke et felt i skjemaet. Hele skjemaet ligger som ÉN
 * JSON-streng i én Table Storage-rad (`skjema-forekomst-storage.js:94`), og
 * Table Storage har to harde tak: 32 000 tegn per strengfelt og 1 MB per rad.
 * Dagens `Dialog[]` deler det budsjettet med skjemaets egne svar og hele
 * behandlingshistorikken. Hundre innlegg à 300 tegn sprenger det — og ingen
 * håndterer at taket nås. Skrivingen feiler, sannsynligvis midt i en samtale,
 * i en sak som pågår.
 *
 * Det andre problemet er samtidighet: `lagreSkjema` leser hele skjemaet,
 * endrer det og skriver det tilbake uten etag-sjekk. To som skriver samtidig
 * er usannsynlig i et skjema og normalen i en chat — og da overskriver den
 * siste den første, uten at noen får vite det.
 *
 * Én rad per innlegg løser begge. Paginering følger med.
 *
 * INGEN INTERNE INNLEGG. Alt en deltaker skriver, ser alle deltakerne. Det er
 * bestemt (se docs/FASE-SAMTALE.md), og det er ikke en forenkling: den
 * farligste feilen i en slik flate er at noen skriver i den tro at motparten
 * ikke leser. Akkurat den lekkasjen lå i PDF-en til 18.09.2026. Finnes det
 * ikke et skjult modus, kan ingen tro at de er i det.
 *
 * Samtalen er UKRYPTERT, også når skjematypen er kryptert. Brukeren får vite
 * det ved oppstart av samtalen. Se «Det dette koster» i notatet.
 *
 * PK: {skjematypeId}:{skjemaId}
 * RK: {ISO-tid}-{6 tilfeldige tegn}
 * Felter: Avsender, AvsenderNavn, Tekst, Dato, Kilde
 */
// Modulobjekt, ikke destrukturert: tester bytter ut sikreTabell for å slippe
// en ekte lagringskonto.
const storage = require('./storage');
const crypto = require('crypto');

const TABELL = 'Samtale';
const DEMPING = 'SamtaleDemping';

/**
 * Lengste innlegg vi tar imot.
 *
 * Taket i Table Storage er 32 000 tegn per strengfelt, og nå er det ett
 * innlegg per rad — så grensen er per innlegg, ikke per samtale. 4 000 er
 * romslig for en chat og lar oss avvise med en forståelig melding i stedet
 * for å la lagringen feile med en HTTP-kode.
 */
const MAKS_TEGN = 4000;

function sakNokkel(skjematypeId, skjemaId) {
    return `${skjematypeId}:${skjemaId}`;
}

/**
 * En verdi som OData-strengliteral.
 *
 * `storage.odata` gjør det samme, men den laster Azure-SDK-en — og testene
 * her skal kunne kjøre uten `node_modules` (se CLAUDE.md). Et filter bygget
 * med SDK-en kan ikke etterprøves i en test som ikke har den.
 *
 * Reglene for en strengliteral i OData er én: apostrof dobles. Nøklene våre
 * er tidsstempler og id-er, men de kommer fra rute-parametere, og en verdi
 * som ikke kan inneholde en apostrof i dag kan gjøre det i morgen.
 */
function sitat(verdi) {
    return `'${String(verdi).replace(/'/g, "''")}'`;
}

/**
 * Radnøkkel: tidsstempel først, så tilfeldighet.
 *
 * Table Storage sorterer på RowKey som streng. ISO-8601 sorterer da
 * kronologisk av seg selv, og `listEntities` gir innleggene i riktig
 * rekkefølge uten at vi sorterer etterpå.
 *
 * Suffikset er der fordi to innlegg kan treffe samme millisekund. Uten det
 * ville den ene overskrevet den andre — stille, siden upsert ikke klager.
 *
 * Men tilfeldighet alene løser bare kollisjonen, ikke rekkefølgen: to innlegg
 * i samme millisekund ville fått vilkårlig sortering, og et svar kunne vist
 * seg over spørsmålet. Derfor går klokka aldri bakover eller i stå her — er
 * millisekundet brukt, tas det neste.
 *
 * Det gjelder innenfor én prosess. To instanser som skriver i samme
 * millisekund sorteres fortsatt vilkårlig mellom seg, og det er uunngåelig
 * uten en felles teller — rekkefølgen er da også genuint udefinert.
 *
 * `Dato` på innlegget er den ekte tiden. Nøkkelen kan ligge noen millisekunder
 * foran under en byge, og det er nøkkelen som er til for å sortere.
 */
let sisteMs = 0;

function radNokkel(dato = new Date()) {
    const ms = Math.max(dato.getTime(), sisteMs + 1);
    sisteMs = ms;
    return `${new Date(ms).toISOString()}-${crypto.randomBytes(3).toString('hex')}`;
}

function radTilInnlegg(e) {
    return {
        Id: e.rowKey,
        Avsender: e.Avsender || '',
        AvsenderNavn: e.AvsenderNavn || '',
        Tekst: e.Tekst || '',
        Dato: e.Dato || '',
        Kilde: e.Kilde || ''
    };
}

/**
 * Legg til et innlegg. Returnerer innlegget slik det ble lagret.
 *
 * `kilde` skiller innlogget fra token-basert avsender ('swa' | 'otp' |
 * 'utsending'). Uten den kan ikke revisjonssporet svare på hvordan noen kom
 * inn — og i en samtale der eksterne deltar, er det spørsmålet som kommer.
 */
async function leggTil(skjematypeId, skjemaId, { avsender, avsenderNavn = '', tekst, kilde = 'swa' }) {
    const rentTekst = String(tekst == null ? '' : tekst).trim();
    if (!rentTekst) throw new Error('Innlegget er tomt');
    if (rentTekst.length > MAKS_TEGN) {
        throw new Error(`Innlegget er for langt (${rentTekst.length} av maks ${MAKS_TEGN} tegn)`);
    }
    if (!avsender) throw new Error('Innlegget mangler avsender');

    const dato = new Date();
    const rad = {
        partitionKey: sakNokkel(skjematypeId, skjemaId),
        rowKey: radNokkel(dato),
        Avsender: String(avsender).toLowerCase(),
        AvsenderNavn: String(avsenderNavn || ''),
        Tekst: rentTekst,
        Dato: dato.toISOString(),
        Kilde: String(kilde || 'swa')
    };
    const t = await storage.sikreTabell(TABELL);
    // createEntity, ikke upsert: en kollisjon på radnøkkelen skal si fra, ikke
    // overskrive noen andres innlegg.
    await t.createEntity(rad);
    return radTilInnlegg(rad);
}

/**
 * Hent innleggene i en sak, eldste først.
 *
 * `etter` er radnøkkelen til siste innlegg kalleren allerede har. Den er det
 * pollingen bruker: den spør om det som har kommet siden sist, ikke om hele
 * tråden hvert tiende sekund.
 */
async function hentInnlegg(skjematypeId, skjemaId, { etter = '' } = {}) {
    const pk = sakNokkel(skjematypeId, skjemaId);
    const t = await storage.sikreTabell(TABELL);
    const filter = etter
        ? `PartitionKey eq ${sitat(pk)} and RowKey gt ${sitat(etter)}`
        : `PartitionKey eq ${sitat(pk)}`;

    const ut = [];
    try {
        for await (const e of t.listEntities({ queryOptions: { filter } })) {
            ut.push(radTilInnlegg(e));
        }
    } catch (e) {
        if (e.statusCode !== 404) throw e;
    }
    // Table Storage gir radene sortert på RowKey, men rekkefølgen er en del av
    // kontrakten her og skal ikke avhenge av det.
    ut.sort((a, b) => (a.Id < b.Id ? -1 : a.Id > b.Id ? 1 : 0));
    return ut;
}

/**
 * Antall innlegg og dato for det siste.
 *
 * Dette er det datauttrekket skal ha — ikke teksten. Spørsmålet oppdragsgiver
 * stiller er hvor mye kommunikasjon en sakstype krever, og det svarer disse
 * to på uten å legge fritekst med personopplysninger inn i et regneark som
 * lastes ned og sendes rundt.
 */
async function sammendrag(skjematypeId, skjemaId) {
    const innlegg = await hentInnlegg(skjematypeId, skjemaId);
    return {
        Antall: innlegg.length,
        SisteDato: innlegg.length > 0 ? innlegg[innlegg.length - 1].Dato : ''
    };
}

/**
 * Har denne brukeren dempet varsling for denne saken?
 *
 * Feiler oppslaget, svarer vi nei. Et varsel for mye er en irritasjon; et
 * varsel for lite er en sak som blir stående fordi ingen visste at den ventet.
 */
async function erDempet(skjematypeId, skjemaId, upn) {
    const rk = String(upn || '').trim().toLowerCase();
    if (!rk) return false;
    try {
        const t = await storage.sikreTabell(DEMPING);
        const e = await t.getEntity(sakNokkel(skjematypeId, skjemaId), rk);
        return e.Dempet === true;
    } catch (_) {
        return false;
    }
}

async function settDemping(skjematypeId, skjemaId, upn, dempet) {
    const rk = String(upn || '').trim().toLowerCase();
    if (!rk) throw new Error('Mangler bruker');
    const t = await storage.sikreTabell(DEMPING);
    await t.upsertEntity({
        partitionKey: sakNokkel(skjematypeId, skjemaId),
        rowKey: rk,
        Dempet: !!dempet,
        SistEndret: new Date().toISOString()
    }, 'Replace');
    return !!dempet;
}

module.exports = {
    leggTil, hentInnlegg, sammendrag, erDempet, settDemping,
    sakNokkel, radNokkel, sitat, TABELL, DEMPING, MAKS_TEGN
};
