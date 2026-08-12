/**
 * Teammedlemskap — cache av Team-medlemskap oppdatert via Power Automate-flyt
 * mot Microsoft Graph (samme mønster som legacy).
 *
 * PK = Team-navn (case-sensitiv slik det er lagret)
 * RK = UPN (lowercase)
 * Egenskaper: SistOppdatert (ISO)
 *
 * Refresh-strategi: PA-flyt kjører hver 6. time, itererer alle kjente team
 * (fra editor-input) og POSTer oppdatert liste til /api/cache/teammedlemskap.
 * Editoren kan også lazy-loade et team på forespørsel via /api/team/last-medlemmer.
 */
const { tabellKlient } = require('./storage');
const { odata } = require('@azure/data-tables');

const TABELL = 'Teammedlemskap';

async function tabell() {
    const t = tabellKlient(TABELL);
    try { await t.createTable(); } catch (_) { /* fins */ }
    return t;
}

/**
 * Sjekk om UPN er medlem av gitt team.
 */
async function erMedlem(team, upn) {
    if (!team || !upn) return false;
    const t = await tabell();
    try {
        await t.getEntity(String(team), String(upn).toLowerCase());
        return true;
    } catch (e) {
        if (e.statusCode === 404) return false;
        throw e;
    }
}

/**
 * List UPN-er for gitt team.
 */
async function hentMedlemmer(team) {
    if (!team) return [];
    const t = await tabell();
    const ut = [];
    const filter = odata`PartitionKey eq ${String(team)}`;
    for await (const e of t.listEntities({ queryOptions: { filter } })) {
        ut.push(e.rowKey);
    }
    return ut;
}

/**
 * Hent alle kjente team-navn (distinkte PartitionKeys).
 */
async function hentAlleTeamNavn() {
    const t = await tabell();
    const set = new Set();
    try {
        for await (const e of t.listEntities({ queryOptions: { select: ['PartitionKey'] } })) {
            set.add(e.partitionKey);
        }
    } catch (e) {
        if (e.statusCode !== 404) throw e;
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'no'));
}

function normaliserMedlem(m) {
    if (typeof m === 'string') return m.trim().toLowerCase();
    if (typeof m === 'object' && m !== null) {
        const kandidater = [m.Upn, m.upn, m.userPrincipalName, m.UserPrincipalName, m.mail, m.Mail, m.email, m.Email];
        for (const k of kandidater) if (k) return String(k).trim().toLowerCase();
    }
    return '';
}

/**
 * Erstatt medlemskap for ett team. Med append=false slettes alle
 * eksisterende rader for teamet før nye upserts. Med append=true beholdes
 * eksisterende (brukes når PA sender store lister i flere chunker).
 */
async function erstattTeam(teamNavn, medlemmer, { append = false } = {}) {
    const navn = String(teamNavn || '').trim();
    if (!navn) throw new Error('Mangler team-navn');
    const t = await tabell();
    const nu = new Date().toISOString();

    if (!append) {
        // Slett eksisterende for teamet
        const filter = odata`PartitionKey eq ${navn}`;
        for await (const e of t.listEntities({ queryOptions: { filter, select: ['PartitionKey', 'RowKey'] } })) {
            try { await t.deleteEntity(e.partitionKey, e.rowKey); }
            catch (err) { if (err.statusCode !== 404) throw err; }
        }
    }

    const upns = new Set();
    for (const m of (Array.isArray(medlemmer) ? medlemmer : [])) {
        const upn = normaliserMedlem(m);
        if (upn) upns.add(upn);
    }
    let skrevet = 0;
    for (const upn of upns) {
        await t.upsertEntity({ partitionKey: navn, rowKey: upn, SistOppdatert: nu }, 'Replace');
        skrevet++;
    }
    return { Team: navn, modus: append ? 'append' : 'erstatt', antallMedlemmer: skrevet };
}

/**
 * Batch: aksepterer [{Team, Medlemmer, append?}]. Dedupliserer per team
 * hvis samme team forekommer flere ganger i input.
 */
async function erstattBatch(grupper) {
    const liste = Array.isArray(grupper) ? grupper : [];
    const sammenslatt = new Map();
    for (const g of liste) {
        const navn = String(g?.Team || '').trim();
        if (!navn) continue;
        const nokkel = navn.toLowerCase();
        if (!sammenslatt.has(nokkel)) sammenslatt.set(nokkel, { Team: navn, Medlemmer: [], appendAlle: true });
        const entry = sammenslatt.get(nokkel);
        entry.Medlemmer.push(...(Array.isArray(g.Medlemmer) ? g.Medlemmer : []));
        if (g.append !== true) entry.appendAlle = false;
    }
    const resultater = [];
    for (const g of sammenslatt.values()) {
        try {
            const res = await erstattTeam(g.Team, g.Medlemmer, { append: g.appendAlle });
            resultater.push(res);
        } catch (e) {
            resultater.push({ Team: g.Team, feil: e.message });
        }
    }
    return { antallTeam: resultater.length, resultater };
}

async function slettTeam(teamNavn) {
    const navn = String(teamNavn || '').trim();
    if (!navn) return 0;
    const t = await tabell();
    let slettet = 0;
    const filter = odata`PartitionKey eq ${navn}`;
    for await (const e of t.listEntities({ queryOptions: { filter, select: ['PartitionKey', 'RowKey'] } })) {
        try { await t.deleteEntity(e.partitionKey, e.rowKey); slettet++; }
        catch (err) { if (err.statusCode !== 404) throw err; }
    }
    return slettet;
}

module.exports = { erMedlem, hentMedlemmer, hentAlleTeamNavn, erstattTeam, erstattBatch, slettTeam };
