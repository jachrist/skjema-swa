/**
 * Hendelser-tabell (audit-logg).
 *
 * Struktur:
 *   PartitionKey = YYYY-MM (månedlig partisjonering — balanserer spredning og listing)
 *   RowKey       = "{revTs}-{rand}" hvor revTs = 9999999999999 - Date.now(),
 *                  slik at lex-sortering gir nyeste først.
 *   Egenskaper: Tid (ISO), Type, Aktor, ObjektType, ObjektId, Melding, Detaljer (JSON-streng)
 *
 * Skrivinger er fire-and-forget fra kalleren — feiler aldri hovedhandlingen.
 */
const { tabellKlient, sikreTabell, odata } = require('./storage');
const crypto = require('crypto');

const TABELL = 'Hendelser';
const REV_BASE = 9999999999999n; // 13-siffret

async function tabell() {
    const t = await sikreTabell(TABELL);
    return t;
}

function partisjon(dato) {
    return dato.toISOString().substring(0, 7); // YYYY-MM
}

function rowKey(dato) {
    const rev = String(REV_BASE - BigInt(dato.getTime())).padStart(13, '0');
    const rand = crypto.randomBytes(3).toString('hex');
    return `${rev}-${rand}`;
}

/**
 * Registrer én hendelse. Kalles fire-and-forget fra mutasjons-endpoints.
 *
 * @param {Object} h
 * @param {string} h.Type         — kort kode (f.eks. 'skjema.opprett', 'nokkel.rekrypter')
 * @param {string} [h.Aktor]      — UPN som utførte handlingen
 * @param {string} [h.ObjektType] — 'skjema' | 'skjematype' | 'rolle' | 'nokkel' | ...
 * @param {string} [h.ObjektId]   — ID for objektet
 * @param {string} [h.Melding]    — kort menneskelig beskrivelse
 * @param {Object} [h.Detaljer]   — vilkårlig JSON-objekt med kontekst (lagres som streng)
 */
async function logg(h) {
    try {
        const t = await tabell();
        const dato = new Date();
        await t.createEntity({
            partitionKey: partisjon(dato),
            rowKey: rowKey(dato),
            Tid: dato.toISOString(),
            Type: String(h.Type || 'ukjent'),
            Aktor: String(h.Aktor || ''),
            ObjektType: String(h.ObjektType || ''),
            ObjektId: String(h.ObjektId || ''),
            Melding: String(h.Melding || ''),
            Detaljer: h.Detaljer ? JSON.stringify(h.Detaljer).substring(0, 30000) : ''
        });
    } catch (_) { /* stille */ }
}

/**
 * Hent siste N hendelser, evt. filtrert.
 * @param {Object} [opts]
 * @param {number} [opts.antall=100]
 * @param {string} [opts.fraDato]   — ISO-dato (inklusiv)
 * @param {string} [opts.tilDato]   — ISO-dato (inklusiv)
 * @param {string} [opts.type]      — eksakt Type-match
 * @param {string} [opts.aktor]     — case-insensitiv UPN-match
 * @param {string} [opts.objektId]  — eksakt ObjektId-match
 */
async function hentSiste(opts = {}) {
    const t = await tabell();
    const antall = Math.min(Math.max(1, Number(opts.antall) || 100), 500);

    // Bestem partisjon-scope
    const fra = opts.fraDato ? new Date(opts.fraDato) : null;
    const til = opts.tilDato ? new Date(opts.tilDato) : null;
    const partisjoner = [];
    if (fra || til) {
        const start = fra || new Date(Date.now() - 90 * 24 * 3600 * 1000);
        const slutt = til || new Date();
        const d = new Date(start.getFullYear(), start.getMonth(), 1);
        while (d <= slutt) {
            partisjoner.push(partisjon(d));
            d.setMonth(d.getMonth() + 1);
        }
    } else {
        // Uten dato-filter: hent siste 3 månedene
        const nå = new Date();
        for (let i = 0; i < 3; i++) {
            const d = new Date(nå.getFullYear(), nå.getMonth() - i, 1);
            partisjoner.push(partisjon(d));
        }
    }

    const ut = [];
    for (const pk of partisjoner) {
        const filter = odata`PartitionKey eq ${pk}`;
        for await (const e of t.listEntities({ queryOptions: { filter } })) {
            if (opts.type && e.Type !== opts.type) continue;
            if (opts.objektId && String(e.ObjektId) !== String(opts.objektId)) continue;
            if (opts.aktor && String(e.Aktor || '').toLowerCase() !== String(opts.aktor).toLowerCase()) continue;
            if (fra && new Date(e.Tid) < fra) continue;
            if (til && new Date(e.Tid) > til) continue;
            ut.push({
                Tid: e.Tid, Type: e.Type, Aktor: e.Aktor,
                ObjektType: e.ObjektType, ObjektId: e.ObjektId,
                Melding: e.Melding,
                Detaljer: e.Detaljer ? tryParseJson(e.Detaljer) : null
            });
            if (ut.length >= antall) return ut;
        }
    }
    return ut;
}

function tryParseJson(s) {
    try { return JSON.parse(s); } catch (_) { return s; }
}

module.exports = { logg, hentSiste };
