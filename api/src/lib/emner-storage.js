/**
 * Emner + EmneStudenter — masterdata fra FS.
 *
 * Tabeller:
 *   Emner          PK=TerminKort (f.eks. "26H"), RK="{EK}-{VK}"
 *                  Egenskaper: EK, VK, EN, SK, SN, C, Larere (JSON), Hovedlarere (JSON), LU
 *   EmneStudenter  PK="{TerminKort}|{EK}-{VK}", RK=upn (lowercase)
 *                  Egenskaper: EP, FN, EN
 *
 * All skriving er upsert. Full erstatning skjer via slettAllePartisjoner + upsertBatch.
 */
const { tabellKlient } = require('./storage');
const { odata } = require('@azure/data-tables');

const TABELL_EMNER = 'Emner';
const TABELL_STUDENTER = 'EmneStudenter';
const TABELL_FILTERSTUDENT = 'FilterStudent';
const TABELL_META = 'CacheMetadata';

// Tegn som ikke er lovlige i PartitionKey/RowKey i Azure Table Storage.
// Klassekoder og -navn kommer fra FS og er friere enn emnekoder, så de
// må vaskes før de brukes som nøkkelledd.

function trygtNokkelledd(s) {
    let ut = '';
    for (const tegn of String(s ?? '')) {
        if (tegn === '/' || tegn === '\\' || tegn === '#' || tegn === '?') { ut += '_'; continue; }
        const kode = tegn.codePointAt(0);
        if (kode < 0x20 || (kode >= 0x7F && kode <= 0x9F)) { ut += '_'; continue; }
        ut += tegn;
    }
    return ut.trim();
}

/**
 * Bygg PartitionKey for FilterStudent: "{FK}|{FV}", eller bare "{FK}"
 * når filterverdien er tom (gjelder ALLE-partisjonen).
 */
function filterPk(fk, fv) {
    const v = trygtNokkelledd(fv);
    return v ? `${trygtNokkelledd(fk)}|${v}` : trygtNokkelledd(fk);
}

async function tabell(navn) {
    const t = tabellKlient(navn);
    try { await t.createTable(); } catch (_) { /* fins fra før */ }
    return t;
}

// ---------------- skriving ----------------

async function listPartisjoner(navn) {
    const t = await tabell(navn);
    const set = new Set();
    for await (const e of t.listEntities()) set.add(e.partitionKey);
    return [...set];
}

async function slettAlleIPartisjon(navn, pk) {
    const t = await tabell(navn);
    let batch = [];
    for await (const e of t.listEntities({ queryOptions: { filter: odata`PartitionKey eq ${pk}` } })) {
        batch.push({ partitionKey: e.partitionKey, rowKey: e.rowKey });
        if (batch.length >= 100) {
            await t.submitTransaction(batch.map(x => ['delete', x]));
            batch = [];
        }
    }
    if (batch.length > 0) await t.submitTransaction(batch.map(x => ['delete', x]));
}

/**
 * Upsert flere entiteter. Grupperer per PK og deler i batcher av 100.
 * Deduplikerer per (PK, RK) — siste forekomst vinner.
 */
async function upsertBatch(navn, entiteter) {
    if (!entiteter || entiteter.length === 0) return { lagret: 0 };
    const t = await tabell(navn);

    const deduped = new Map();
    for (const e of entiteter) deduped.set(`${e.partitionKey}|${e.rowKey}`, e);

    const perPk = new Map();
    for (const e of deduped.values()) {
        if (!perPk.has(e.partitionKey)) perPk.set(e.partitionKey, []);
        perPk.get(e.partitionKey).push(e);
    }
    for (const gruppe of perPk.values()) {
        for (let i = 0; i < gruppe.length; i += 100) {
            const chunk = gruppe.slice(i, i + 100);
            await t.submitTransaction(chunk.map(e => ['upsert', e, 'Replace']));
        }
    }
    return { lagret: deduped.size };
}

async function settMetadata(kilde, info) {
    const t = await tabell(TABELL_META);
    await t.upsertEntity({
        partitionKey: 'Meta',
        rowKey: kilde,
        SistOppdatert: new Date().toISOString(),
        AntallRader: info.antallRader ?? 0,
        Status: info.status || 'ok',
        SistFeil: info.feil || '',
        ...(info.ekstra || {})
    }, 'Replace');
}

// ---------------- lesing ----------------

function parseJsonArray(streng) {
    if (!streng) return [];
    try { const v = JSON.parse(streng); return Array.isArray(v) ? v : []; }
    catch { return []; }
}

function radTilEmne(row) {
    return {
        Termin: row.partitionKey,
        EK: row.EK,
        VK: row.VK,
        EN: row.EN,
        SK: row.SK,
        SN: row.SN,
        C: row.C,
        Larere: parseJsonArray(row.Larere),
        Hovedlarere: parseJsonArray(row.Hovedlarere),
        LU: row.LU || ''
    };
}

async function hentAlleEmner({ termin, campus } = {}) {
    const t = await tabell(TABELL_EMNER);
    const filterDeler = [];
    if (termin) filterDeler.push(odata`PartitionKey eq ${termin}`);
    if (campus) filterDeler.push(odata`C eq ${campus}`);
    const filter = filterDeler.length > 0 ? filterDeler.join(' and ') : undefined;
    const opts = filter ? { queryOptions: { filter } } : undefined;
    const result = [];
    for await (const row of t.listEntities(opts)) result.push(radTilEmne(row));
    return result;
}

async function hentEmne(termin, emneId) {
    if (!emneId) return null;
    if (termin) {
        try {
            const t = await tabell(TABELL_EMNER);
            const row = await t.getEntity(termin, emneId);
            return radTilEmne(row);
        } catch (e) {
            if (e.statusCode === 404) return null;
            throw e;
        }
    }
    // Uten termin — søk i alle, returner yngste
    const alle = await hentAlleEmner();
    const treff = alle.filter(e => `${e.EK}-${e.VK}` === emneId);
    if (treff.length === 0) return null;
    treff.sort((a, b) => String(b.Termin).localeCompare(String(a.Termin)));
    return treff[0];
}

async function hentEmnerForUpn(upn, rolle = null) {
    if (!upn) return [];
    const upnLower = String(upn).toLowerCase();
    const alle = await hentAlleEmner();
    return alle.filter(e => {
        const treff = (arr) => arr.some(p => (p.EP || '').toLowerCase() === upnLower);
        if (rolle === 'Larer') return treff(e.Larere);
        if (rolle === 'Hovedlarer') return treff(e.Hovedlarere);
        return treff(e.Larere) || treff(e.Hovedlarere);
    });
}

async function hentAlleStudenter() {
    const t = await tabell(TABELL_STUDENTER);
    const result = [];
    for await (const row of t.listEntities()) {
        result.push({
            Termin: String(row.partitionKey).split('|')[0],
            EmneId: String(row.partitionKey).split('|')[1] || '',
            EP: row.EP,
            FN: row.FN,
            EN: row.EN
        });
    }
    return result;
}

async function hentStudenterForEmne(emneId, { termin } = {}) {
    if (!emneId) return [];
    const t = await tabell(TABELL_STUDENTER);
    const filter = termin ? odata`PartitionKey eq ${`${termin}|${emneId}`}` : undefined;
    const opts = filter ? { queryOptions: { filter } } : undefined;
    const result = [];
    for await (const row of t.listEntities(opts)) {
        if (!termin && !String(row.partitionKey).endsWith(`|${emneId}`)) continue;
        result.push({
            Termin: String(row.partitionKey).split('|')[0],
            EmneId: emneId,
            EP: row.EP,
            FN: row.FN,
            EN: row.EN
        });
    }
    return result;
}

// ---------------- FilterStudent ----------------

/**
 * Studenter for ett filter — én partisjonsspørring.
 *
 * @param {string} fk  filterkategori: EK | KL | KU | SP | ALLE
 * @param {string} fv  filterverdi (tom for ALLE)
 */
async function hentStudenterForFilter(fk, fv) {
    const t = await tabell(TABELL_FILTERSTUDENT);
    const pk = filterPk(fk, fv);
    const result = [];
    for await (const row of t.listEntities({ queryOptions: { filter: odata`PartitionKey eq ${pk}` } })) {
        result.push({
            EP: row.EP,
            FN: row.FN,
            EN: row.EN,
            Termin: row.Termin || ''
        });
    }
    return result;
}

/**
 * Metadata-oppslag for dropdown-lister: klasser og kull.
 * Ligger som egne partisjoner i samme tabell (PK="KLASSE" / "KULL"),
 * med RowKey = filterverdien som Studenter-filteret skal ta imot.
 */
async function hentFilterMeta(partisjon) {
    const t = await tabell(TABELL_FILTERSTUDENT);
    const result = [];
    for await (const row of t.listEntities({ queryOptions: { filter: odata`PartitionKey eq ${partisjon}` } })) {
        result.push({
            Verdi: row.rowKey,
            Navn: row.Navn || row.rowKey,
            SP: row.SP || '',
            Termin: row.Termin || '',
            Antall: row.Antall ?? 0
        });
    }
    return result;
}

/**
 * Slett alle rader som ikke tilhører gjeldende generasjon.
 *
 * Kalles ETTER at nye rader er skrevet, slik at det aldri finnes et vindu
 * der tabellen er tom for brukerne. Full enumerering, men kun i nattjobben —
 * samme kostnadsklasse som listPartisjoner() allerede har.
 */
async function slettGamleGenerasjoner(navn, gjeldendeG) {
    const t = await tabell(navn);
    const perPk = new Map();
    for await (const e of t.listEntities()) {
        if (e.G === gjeldendeG) continue;
        if (!perPk.has(e.partitionKey)) perPk.set(e.partitionKey, []);
        perPk.get(e.partitionKey).push({ partitionKey: e.partitionKey, rowKey: e.rowKey });
    }
    let slettet = 0;
    for (const gruppe of perPk.values()) {
        for (let i = 0; i < gruppe.length; i += 100) {
            const chunk = gruppe.slice(i, i + 100);
            await t.submitTransaction(chunk.map(x => ['delete', x]));
            slettet += chunk.length;
        }
    }
    return slettet;
}

async function hentAlleStudieprogrammer() {
    const alle = await hentAlleEmner();
    const set = new Map();
    for (const e of alle) {
        const sk = (e.SK || '').trim();
        if (!sk) continue;
        if (!set.has(sk)) set.set(sk, e.SN || sk);
    }
    return [...set.entries()]
        .map(([SK, SN]) => ({ SK, SN }))
        .sort((a, b) => a.SK.localeCompare(b.SK, 'no'));
}

module.exports = {
    TABELL_EMNER,
    TABELL_STUDENTER,
    TABELL_FILTERSTUDENT,
    filterPk,
    trygtNokkelledd,
    listPartisjoner,
    slettAlleIPartisjon,
    slettGamleGenerasjoner,
    upsertBatch,
    settMetadata,
    hentAlleEmner,
    hentEmne,
    hentEmnerForUpn,
    hentStudenterForEmne,
    hentAlleStudenter,
    hentStudenterForFilter,
    hentFilterMeta,
    hentAlleStudieprogrammer
};
