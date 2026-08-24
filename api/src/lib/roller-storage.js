/**
 * Rollemedlemskap-tabell.
 *
 * Struktur (samme som referanse-app):
 *   Rollemedlemskap
 *     PartitionKey = Rolle (f.eks. "Emneansvarlig", "Sjef")
 *     RowKey       = "{Omfang}|{upn}" (f.eks. "CBU2501|user@mil.no")
 *     Egenskaper: FN, EN, EP, Kilde, Rollebeskrivelse, SistOppdatert
 *
 * Roller er sammensatt av (Rolle, Omfang) — samme rolle kan gjelde flere
 * områder (avdelinger, emner, prosjekter, ...). En bruker kan ha samme
 * rolle på ulike omfang.
 */
const { tabellKlient, sikreTabell } = require('./storage');
const { odata } = require('@azure/data-tables');

const TABELL = 'Rollemedlemskap';

async function tabell() {
    const t = await sikreTabell(TABELL);
    return t;
}

function radTilInnehaver(entity) {
    const rk = String(entity.rowKey || '');
    const del = rk.indexOf('|');
    const omfang = del > -1 ? rk.substring(0, del) : '';
    const upn = del > -1 ? rk.substring(del + 1) : rk;
    return {
        Rolle: entity.partitionKey,
        Omfang: omfang,
        UPN: upn,
        FN: entity.FN || '',
        EN: entity.EN || '',
        EP: entity.EP || upn,
        Kilde: entity.Kilde || 'manuell',
        Rollebeskrivelse: entity.Rollebeskrivelse || '',
        SistOppdatert: entity.SistOppdatert || null
    };
}

/**
 * Hent alle distinkte (Rolle, Omfang)-grupper med telling.
 * Brukes til oversikt i rolleadmin.
 */
async function hentAlleGrupper() {
    const t = await tabell();
    const grupper = new Map(); // "Rolle||Omfang" → { Rolle, Omfang, Antall }
    for await (const e of t.listEntities()) {
        const rolle = e.partitionKey;
        const rk = String(e.rowKey || '');
        const del = rk.indexOf('|');
        const omfang = del > -1 ? rk.substring(0, del) : '';
        const key = `${rolle}||${omfang}`;
        if (!grupper.has(key)) {
            grupper.set(key, { Rolle: rolle, Omfang: omfang, Antall: 0, Kilder: new Set() });
        }
        const g = grupper.get(key);
        g.Antall++;
        g.Kilder.add(e.Kilde || 'manuell');
    }
    return [...grupper.values()]
        .map(g => ({ ...g, Kilder: [...g.Kilder] }))
        .sort((a, b) => a.Rolle.localeCompare(b.Rolle) || a.Omfang.localeCompare(b.Omfang));
}

/**
 * UPN → { FN, EN } for alle rolleinnehavere med registrert navn.
 *
 * Teamcachen lagrer bare UPN (Power Automate sender ikke navn), så dette er
 * eneste kilde til visningsnavn for personer som ikke er studenter. Tabellen
 * er liten, og kartet bygges med én gjennomgang.
 */
async function hentNavnekart() {
    const t = await tabell();
    const kart = new Map();
    try {
        for await (const e of t.listEntities({ queryOptions: { select: ['RowKey', 'FN', 'EN'] } })) {
            if (!e.FN && !e.EN) continue;
            const rk = String(e.rowKey || '');
            const del = rk.indexOf('|');
            const upn = (del > -1 ? rk.substring(del + 1) : rk).trim().toLowerCase();
            if (!upn || kart.has(upn)) continue;
            kart.set(upn, { FN: e.FN || '', EN: e.EN || '' });
        }
    } catch (e) {
        if (e.statusCode !== 404) throw e;
    }
    return kart;
}

/**
 * Hent innehavere for en gitt rolle+omfang. Rollestreng-format:
 *   "Rolle" — alle omfang
 *   "Rolle(Omfang)" — spesifikt omfang
 */
async function hentInnehavere(rolleStreng) {
    const t = await tabell();
    const m = /^(.+?)(?:\((.+)\))?$/.exec(String(rolleStreng || '').trim());
    if (!m) return [];
    const rolle = m[1].trim();
    const omfang = (m[2] || '').trim();

    const innehavere = [];
    const filter = omfang
        ? odata`PartitionKey eq ${rolle} and RowKey ge ${omfang + '|'} and RowKey lt ${omfang + '|~'}`
        : odata`PartitionKey eq ${rolle}`;

    for await (const e of t.listEntities({ queryOptions: { filter } })) {
        innehavere.push(radTilInnehaver(e));
    }
    return innehavere;
}

/**
 * Sjekk om upn er medlem av rolle. Returnerer boolean.
 */
async function erMedlem(rolleStreng, upn) {
    if (!upn) return false;
    const innehavere = await hentInnehavere(rolleStreng);
    const upnLower = String(upn).toLowerCase();
    return innehavere.some(i => String(i.UPN || '').toLowerCase() === upnLower);
}

async function leggTilInnehaver({ Rolle, Omfang = '', UPN, FN = '', EN = '', Rollebeskrivelse = '', Kilde = 'manuell' }) {
    if (!Rolle || !UPN) throw new Error('Rolle og UPN er påkrevd');
    const t = await tabell();
    const rk = `${Omfang}|${String(UPN).toLowerCase()}`;
    await t.upsertEntity({
        partitionKey: Rolle,
        rowKey: rk,
        FN, EN,
        EP: UPN,
        Kilde,
        Rollebeskrivelse,
        SistOppdatert: new Date().toISOString()
    }, 'Replace');
}

async function fjernInnehaver({ Rolle, Omfang = '', UPN }) {
    if (!Rolle || !UPN) throw new Error('Rolle og UPN er påkrevd');
    const t = await tabell();
    const rk = `${Omfang}|${String(UPN).toLowerCase()}`;
    try {
        await t.deleteEntity(Rolle, rk);
        return true;
    } catch (e) {
        if (e.statusCode === 404) return false;
        throw e;
    }
}

module.exports = {
    hentAlleGrupper,
    hentNavnekart,
    hentInnehavere,
    erMedlem,
    leggTilInnehaver,
    fjernInnehaver
};
