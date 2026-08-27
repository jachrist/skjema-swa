/**
 * Utsendinger-tabell — track hvem som fikk lenke, om de har svart, og
 * når de eventuelt sist ble purret.
 *
 * PK = BatchId (streng, satt av kaller — f.eks. sender-skjema-id)
 * RK = Mottaker (lowercase upn eller epost)
 * Egenskaper:
 *   SkjematypeId, Jti, Opprettet, KanalHint,
 *   Prefilled (JSON-streng: { "sek-felt": [verdi(er)] }),
 *   SvarSkjemaId (tom hvis ubesvart), SvarTid (ISO),
 *   SistPurret (ISO), SenderSkjemaId, OpprettetAv,
 *   Purretekst (valgfri tilleggstekst som følger med til purre-flyten),
 *   Utsendingsdato, Purredato, Avslutningsdato, Sendt (alle ISO, alle valgfrie)
 *
 * De tre datoene styrer livsløpet til lenka:
 *
 *   Utsendingsdato  — appen sender lenka denne dagen (cron → UTSENDING_FLOW_URL)
 *                     og setter Sendt. Er den tom, har kalleren sendt selv.
 *   Purredato       — én purring på denne dagen, i stedet for den rullerende
 *                     regelen. Er den tom, purres det etter PURRE_*-tersklene.
 *   Avslutningsdato — etter denne slutter lenka å virke, og det purres ikke mer.
 *
 * Alle tre er tomme for utsendinger opprettet uten dem, og da oppfører raden
 * seg nøyaktig som før feltene fantes.
 */
const { tabellKlient, sikreTabell } = require('./storage');
const { odata } = require('@azure/data-tables');

const TABELL = 'Utsendinger';

async function tabell() {
    const t = await sikreTabell(TABELL);
    return t;
}

function rk(mottaker) {
    return String(mottaker || '').trim().toLowerCase();
}

// Table Storage tåler 32 KiB per egenskap. Prefilled ble tidligere kuttet med
// substring() ved denne grensa — det gir ugyldig JSON, og da faller HELE
// prefillen stille bort ved utlesing (tryParseJson returnerer null). Nå feiler
// vi i stedet med en melding som sier hvem og hvor mye.
const PREFILLED_MAKS = 30000;

// Purreteksten er ment som én setning i en e-post, ikke et brødtekstfelt.
// Taket hindrer at en innlimt HTML-blokk sprenger 32 KiB-grensa per egenskap.
const PURRETEKST_MAKS = 1000;

/**
 * "2026-09-01" eller full ISO-tid → ISO-streng. Ugyldig verdi gir null, så
 * kalleren kan skille «ikke satt» ('') fra «skrivefeil» (null) og avvise.
 *
 * En ren dato uten klokkeslett menes som hele dagen: en avslutningsdato skal
 * gjelde ut dagen, ikke fra midnatt. Grensene settes i UTC, så en frist er i
 * praksis gyldig et par timer inn i neste norske døgn — feil vei å bomme på
 * er å være raus med fristen, ikke streng.
 */
function normaliserDato(verdi, { slutten = false } = {}) {
    const s = String(verdi ?? '').trim();
    if (!s) return '';

    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        const d = new Date(`${s}T00:00:00.000Z`);
        // "2026-02-31" ruller over til 3. mars i JS. Datoen må komme tilbake
        // som den samme for å være ekte.
        if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return null;
        return slutten ? `${s}T23:59:59.999Z` : `${s}T00:00:00.000Z`;
    }

    // Bare streng ISO 8601 godtas videre. new Date() har en slapp fallback som
    // tolker nesten hva som helst — "1. september" blir 2001-09-01 uten et
    // pip, og som avslutningsdato ville det stengt lenka med det samme.
    if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(s)) return null;
    const d = new Date(s.replace(' ', 'T'));
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
}

async function opprett({ batchId, mottaker, skjematypeId, jti, prefilled, kanalHint, senderSkjemaId, opprettetAv, purretekst, utsendingsdato, purredato, avslutningsdato }) {
    const t = await tabell();
    const prefilledJson = prefilled ? JSON.stringify(prefilled) : '';
    if (prefilledJson.length > PREFILLED_MAKS) {
        throw new Error(
            `Prefilled for ${mottaker} er ${prefilledJson.length} tegn — maks ${PREFILLED_MAKS}. ` +
            'Kort ned den lengste verdien (typisk en emnebeskrivelse).'
        );
    }
    await t.upsertEntity({
        partitionKey: String(batchId),
        rowKey: rk(mottaker),
        SkjematypeId: String(skjematypeId),
        Jti: String(jti),
        Opprettet: new Date().toISOString(),
        KanalHint: String(kanalHint || 'epost'),
        Prefilled: prefilledJson,
        SvarSkjemaId: '',
        SvarTid: '',
        SistPurret: '',
        SenderSkjemaId: String(senderSkjemaId || ''),
        OpprettetAv: String(opprettetAv || ''),
        Purretekst: String(purretekst || '').slice(0, PURRETEKST_MAKS),
        Utsendingsdato: normaliserDato(utsendingsdato) || '',
        Purredato: normaliserDato(purredato) || '',
        Avslutningsdato: normaliserDato(avslutningsdato, { slutten: true }) || '',
        Sendt: ''
    }, 'Replace');
}

async function hent(batchId, mottaker) {
    const t = await tabell();
    try {
        const e = await t.getEntity(String(batchId), rk(mottaker));
        return {
            BatchId: e.partitionKey, Mottaker: e.rowKey,
            SkjematypeId: e.SkjematypeId, Jti: e.Jti, Opprettet: e.Opprettet,
            KanalHint: e.KanalHint,
            Prefilled: e.Prefilled ? tryParseJson(e.Prefilled) : null,
            SvarSkjemaId: e.SvarSkjemaId || '', SvarTid: e.SvarTid || '',
            SistPurret: e.SistPurret || '',
            SenderSkjemaId: e.SenderSkjemaId || '', OpprettetAv: e.OpprettetAv || '',
            ...datofelter(e)
        };
    } catch (e) {
        if (e.statusCode === 404) return null;
        throw e;
    }
}

function datofelter(e) {
    return {
        Utsendingsdato: e.Utsendingsdato || '',
        Purredato: e.Purredato || '',
        Avslutningsdato: e.Avslutningsdato || '',
        Sendt: e.Sendt || ''
    };
}

/** Er fristen ute for denne raden? Samme regel overalt. */
function erAvsluttet(rad, nå = new Date().toISOString()) {
    const frist = rad?.Avslutningsdato || '';
    return !!frist && frist < nå;
}

/**
 * Når gikk lenka faktisk ut? Sendt hvis appen sendte den, ellers den planlagte
 * datoen, ellers opprettelsestidspunktet. Det siste er fallbacken for rader
 * laget før datofeltene fantes — de skal oppføre seg som før.
 */
function effektivUtsendingsdato(e) {
    return e.Sendt || e.Utsendingsdato || e.Opprettet;
}

async function markerBesvart(batchId, mottaker, svarSkjemaId) {
    const t = await tabell();
    try {
        await t.updateEntity({
            partitionKey: String(batchId),
            rowKey: rk(mottaker),
            SvarSkjemaId: String(svarSkjemaId),
            SvarTid: new Date().toISOString()
        }, 'Merge');
        return true;
    } catch (e) {
        if (e.statusCode === 404) return false;
        throw e;
    }
}

async function markerPurret(batchId, mottaker) {
    const t = await tabell();
    try {
        await t.updateEntity({
            partitionKey: String(batchId),
            rowKey: rk(mottaker),
            SistPurret: new Date().toISOString()
        }, 'Merge');
    } catch (_) { /* stille */ }
}

async function listBatch(batchId) {
    const t = await tabell();
    const ut = [];
    const filter = odata`PartitionKey eq ${String(batchId)}`;
    for await (const e of t.listEntities({ queryOptions: { filter } })) {
        ut.push({
            BatchId: e.partitionKey, Mottaker: e.rowKey,
            SkjematypeId: e.SkjematypeId, Jti: e.Jti, Opprettet: e.Opprettet,
            KanalHint: e.KanalHint,
            SvarSkjemaId: e.SvarSkjemaId || '', SvarTid: e.SvarTid || '',
            SistPurret: e.SistPurret || '',
            SenderSkjemaId: e.SenderSkjemaId || '', OpprettetAv: e.OpprettetAv || '',
            ...datofelter(e)
        });
    }
    return ut.sort((a, b) => a.Mottaker.localeCompare(b.Mottaker));
}

/**
 * List ubesvarte utsendinger som skal purres nå. Brukes av purre-cron.
 *
 * To regelsett, avhengig av om raden har sin egen purredato:
 *
 *   Med Purredato   — én purring, tidligst på den datoen. Er den først purret,
 *                     kommer det ikke flere. Batchen har sin egen plan.
 *   Uten Purredato  — den rullerende regelen som før: purr så lenge lenka er
 *                     under maksDagerSidenOpprettet gammel, med minst
 *                     minDagerSidenPurring mellom hver.
 *
 * Begge veier gjelder: ikke besvart, lenka faktisk sendt, og fristen ikke ute.
 * Alderen regnes fra den effektive utsendingsdatoen, ikke fra opprettelsen —
 * en lenke som ble laget i juni og sendt i august skal purres fra august.
 */
async function listUbesvarte({ maksDagerSidenOpprettet = 14, minDagerSidenPurring = 3 } = {}) {
    const t = await tabell();
    const nå = Date.now();
    const nåIso = new Date(nå).toISOString();
    const aldersgrense = new Date(nå - maksDagerSidenOpprettet * 24 * 3600 * 1000).toISOString();
    const purreGrense = new Date(nå - minDagerSidenPurring * 24 * 3600 * 1000).toISOString();
    const ut = [];
    for await (const e of t.listEntities()) {
        if (e.SvarSkjemaId) continue;
        if (erAvsluttet(e, nåIso)) continue;                    // fristen er ute
        if (effektivUtsendingsdato(e) > nåIso) continue;        // ikke sendt ennå

        if (e.Purredato) {
            if (e.Purredato > nåIso) continue;                  // for tidlig
            if (e.SistPurret) continue;                         // allerede purret én gang
        } else {
            if (effektivUtsendingsdato(e) < aldersgrense) continue;   // for gammelt, gi opp
            if (e.SistPurret && e.SistPurret > purreGrense) continue; // purret nylig
        }

        ut.push({
            BatchId: e.partitionKey, Mottaker: e.rowKey,
            SkjematypeId: e.SkjematypeId, Jti: e.Jti, Opprettet: e.Opprettet,
            KanalHint: e.KanalHint,
            SenderSkjemaId: e.SenderSkjemaId || '', OpprettetAv: e.OpprettetAv || '',
            Purretekst: e.Purretekst || '',
            ...datofelter(e)
        });
    }
    return ut;
}

/**
 * List utsendinger som skal sendes ut nå: utsendingsdatoen er passert, lenka
 * er ikke sendt før, den er ubesvart, og fristen er ikke ute.
 *
 * Rader uten Utsendingsdato plukkes aldri opp. De ble sendt av kalleren selv
 * da batchen ble opprettet, og skal ikke sendes en gang til.
 */
async function listForfalteUtsendinger() {
    const t = await tabell();
    const nåIso = new Date().toISOString();
    const ut = [];
    for await (const e of t.listEntities()) {
        if (!e.Utsendingsdato) continue;
        if (e.Sendt) continue;
        if (e.SvarSkjemaId) continue;
        if (e.Utsendingsdato > nåIso) continue;
        if (erAvsluttet(e, nåIso)) continue;
        ut.push({
            BatchId: e.partitionKey, Mottaker: e.rowKey,
            SkjematypeId: e.SkjematypeId, Jti: e.Jti, Opprettet: e.Opprettet,
            KanalHint: e.KanalHint,
            SenderSkjemaId: e.SenderSkjemaId || '', OpprettetAv: e.OpprettetAv || '',
            Purretekst: e.Purretekst || '',
            ...datofelter(e)
        });
    }
    return ut;
}

/** Merk at lenka er sendt. Settes bare når flyten faktisk tok imot den. */
async function markerSendt(batchId, mottaker) {
    const t = await tabell();
    try {
        await t.updateEntity({
            partitionKey: String(batchId),
            rowKey: rk(mottaker),
            Sendt: new Date().toISOString()
        }, 'Merge');
    } catch (_) { /* stille */ }
}

function tryParseJson(s) { try { return JSON.parse(s); } catch { return null; } }

module.exports = {
    opprett, hent, markerBesvart, markerPurret, markerSendt,
    listBatch, listUbesvarte, listForfalteUtsendinger,
    normaliserDato, erAvsluttet
};
