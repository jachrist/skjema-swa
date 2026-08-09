/**
 * OTP-kodegenerering + lagring.
 *
 * Portert fra legacy med generalisert identifikator: kanal + mottaker
 * (i stedet for kun UPN). Samme sikkerhets-egenskaper som legacy:
 *   - 6 sifre
 *   - 15 min TTL
 *   - 5 forsøk max
 *   - 60s rate-limit på nye koder (samme mottaker)
 *   - Kode lagres KUN som SHA-256(mottaker + ':' + kode) — aldri klartekst
 *   - Én aktiv kode per mottaker (upsert overskriver)
 *
 * Lagring: Tilgangskontroll-tabellen med PartitionKey='OTP',
 * RowKey=hash(kanal + ':' + mottaker) for å unngå ugyldige tegn i RowKey
 * (mobilnr med + osv).
 */
const crypto = require('crypto');
const { tabellKlient } = require('./storage');

const TABELL = 'Tilgangskontroll';
const PK = 'OTP';
const TTL_MIN = 15;
const MAKS_FORSOK = 5;
const RATE_LIMIT_SEK = 60;

async function tabell() {
    const t = tabellKlient(TABELL);
    try { await t.createTable(); } catch (_) { /* fins fra før */ }
    return t;
}

function normaliserMottaker(kanal, mottaker) {
    const s = String(mottaker || '').trim();
    if (kanal === 'epost') return s.toLowerCase();
    if (kanal === 'sms') {
        // Fjern mellomrom, bindestrek. Behold + hvis der.
        return s.replace(/[\s\-()]/g, '');
    }
    return s;
}

function rowKeyFor(kanal, mottaker) {
    // Hash så vi unngår ugyldige tegn i RowKey (mobilnr med +, e-post med @)
    return crypto.createHash('sha256').update(`${kanal}:${mottaker}`).digest('hex');
}

function kodeHash(mottaker, kode) {
    return crypto.createHash('sha256').update(`${mottaker}:${kode}`).digest('hex');
}

function genererKode() {
    // 6 sifre, cryptographically secure
    return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Opprett kode for {kanal, mottaker}. Returnerer:
 *   { status:'ok', kode }                  — kall må sende koden via valgt kanal
 *   { status:'rate-limitert', vent_sek }   — samme mottaker ba om kode < 60s siden
 */
async function opprettKode(kanal, mottaker) {
    const mot = normaliserMottaker(kanal, mottaker);
    if (!mot) throw new Error('Mottaker mangler');
    const t = await tabell();
    const rk = rowKeyFor(kanal, mot);

    // Rate-limit-sjekk
    try {
        const eks = await t.getEntity(PK, rk);
        if (eks?.Utstedt) {
            const alder = (Date.now() - new Date(eks.Utstedt).getTime()) / 1000;
            if (alder < RATE_LIMIT_SEK) {
                return { status: 'rate-limitert', vent_sek: Math.ceil(RATE_LIMIT_SEK - alder) };
            }
        }
    } catch (e) {
        if (e.statusCode !== 404) throw e;
    }

    const kode = genererKode();
    const nu = new Date();
    const utloper = new Date(nu.getTime() + TTL_MIN * 60 * 1000);
    await t.upsertEntity({
        partitionKey: PK,
        rowKey: rk,
        Kanal: kanal,
        MottakerHash: mot ? crypto.createHash('sha256').update(mot).digest('hex') : '',
        KodeHash: kodeHash(mot, kode),
        Utstedt: nu.toISOString(),
        Utloper: utloper.toISOString(),
        Forsok: 0
    }, 'Replace');
    return { status: 'ok', kode, gyldig_minutter: TTL_MIN };
}

/**
 * Verifiser oppgitt kode. Returnerer:
 *   { status:'ok' }                            — kode korrekt (raden slettes)
 *   { status:'feil-kode', forsok_igjen }       — feil kode, mer enn 0 forsøk igjen
 *   { status:'utlopt' }                        — kode utløpt/ikke funnet
 *   { status:'blokkert' }                      — > MAKS_FORSOK feilforsøk (raden slettes)
 */
async function verifiserKode(kanal, mottaker, kode) {
    const mot = normaliserMottaker(kanal, mottaker);
    if (!mot || !kode) return { status: 'utlopt' };
    const t = await tabell();
    const rk = rowKeyFor(kanal, mot);
    let entity;
    try {
        entity = await t.getEntity(PK, rk);
    } catch (e) {
        if (e.statusCode === 404) return { status: 'utlopt' };
        throw e;
    }

    // Utløpt?
    if (entity.Utloper && entity.Utloper < new Date().toISOString()) {
        await t.deleteEntity(PK, rk).catch(() => {});
        return { status: 'utlopt' };
    }

    // For mange forsøk?
    const forsok = Number(entity.Forsok || 0);
    if (forsok >= MAKS_FORSOK) {
        await t.deleteEntity(PK, rk).catch(() => {});
        return { status: 'blokkert' };
    }

    // Constant-time-sammenligning
    const forventet = Buffer.from(String(entity.KodeHash), 'hex');
    const oppgitt = Buffer.from(kodeHash(mot, String(kode)), 'hex');
    const match = forventet.length === oppgitt.length && crypto.timingSafeEqual(forventet, oppgitt);

    if (match) {
        await t.deleteEntity(PK, rk).catch(() => {});
        return { status: 'ok' };
    }

    // Feil kode — inkrementer forsøk
    const nyForsok = forsok + 1;
    if (nyForsok >= MAKS_FORSOK) {
        await t.deleteEntity(PK, rk).catch(() => {});
        return { status: 'blokkert' };
    }
    await t.updateEntity({ partitionKey: PK, rowKey: rk, Forsok: nyForsok }, 'Merge');
    return { status: 'feil-kode', forsok_igjen: MAKS_FORSOK - nyForsok };
}

module.exports = {
    opprettKode,
    verifiserKode,
    normaliserMottaker,
    TTL_MIN,
    MAKS_FORSOK,
    RATE_LIMIT_SEK
};
