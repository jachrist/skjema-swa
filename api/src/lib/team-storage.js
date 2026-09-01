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
const { tabellKlient, sikreTabell, odata } = require('./storage');

const TABELL = 'Teammedlemskap';

async function tabell() {
    const t = await sikreTabell(TABELL);
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

function radTilMedlem(e) {
    return {
        EP: String(e.rowKey || '').trim().toLowerCase(),
        FN: e.FN || '',
        EN: e.EN || '',
        Navn: e.Navn || ''
    };
}

/**
 * Medlemmer av ett team med navn (der flyten har sendt dem).
 */
async function hentMedlemmerDetaljert(team) {
    if (!team) return [];
    const t = await tabell();
    const ut = [];
    const filter = odata`PartitionKey eq ${String(team)}`;
    for await (const e of t.listEntities({ queryOptions: { filter } })) {
        const m = radTilMedlem(e);
        if (m.EP) ut.push(m);
    }
    return ut;
}

/**
 * Distinkte medlemmer på tvers av alle team. Brukes som «alle personer
 * systemet kjenner» inntil et Entra-oppslag kommer på plass — ett av teamene
 * inneholder alle FHS-brukere.
 */
async function hentAlleMedlemmer() {
    const t = await tabell();
    const perUpn = new Map();
    try {
        for await (const e of t.listEntities()) {
            const m = radTilMedlem(e);
            if (!m.EP) continue;
            // Samme person kan ligge i flere team — behold raden som har navn
            const fins = perUpn.get(m.EP);
            if (!fins || (!fins.FN && !fins.EN && !fins.Navn)) perUpn.set(m.EP, m);
        }
    } catch (e) {
        if (e.statusCode !== 404) throw e;
    }
    return [...perUpn.values()];
}

function forste(...verdier) {
    for (const v of verdier) {
        const s = String(v ?? '').trim();
        if (s) return s;
    }
    return '';
}

/**
 * Normaliserer ett medlem fra PA-flyten til { EP, FN, EN, Navn }.
 *
 * Godtar både vår egen navngivning (Upn/FN/EN) og Graph sin (userPrincipalName/
 * givenName/surname/displayName), slik at flyten kan sende brukerobjektet fra
 * Graph rett videre uten en mellomliggende Select. En ren streng godtas
 * fortsatt — det var formatet før navn ble tatt med.
 *
 * Returnerer null hvis UPN mangler.
 */
function normaliserMedlem(m) {
    if (typeof m === 'string') {
        const ep = m.trim().toLowerCase();
        return ep ? { EP: ep, FN: '', EN: '', Navn: '' } : null;
    }
    if (typeof m !== 'object' || m === null) return null;

    const ep = forste(m.Upn, m.upn, m.UPN, m.userPrincipalName, m.UserPrincipalName,
        m.mail, m.Mail, m.email, m.Email, m.EP).toLowerCase();
    if (!ep) return null;

    return {
        EP: ep,
        FN: forste(m.FN, m.Fornavn, m.givenName, m.GivenName),
        EN: forste(m.EN, m.Etternavn, m.surname, m.Surname),
        // Visningsnavn lagres som det er. Å utlede for-/etternavn fra det ville
        // vært gjetting — «Nordmann, Ola» og «Ola Nordmann» er begge vanlige.
        Navn: forste(m.Navn, m.displayName, m.DisplayName)
    };
}

/**
 * Godtar både en ren array og en connector-/Graph-innpakning ({ value: [...] }
 * eller { Medlemmer: [...] }), slik at PA kan sende resultatet fra connectoren
 * videre uendret.
 */
function medlemsliste(medlemmer) {
    if (Array.isArray(medlemmer)) return medlemmer;
    if (medlemmer && typeof medlemmer === 'object') {
        for (const n of ['value', 'Value', 'Medlemmer', 'medlemmer', 'members', 'Members']) {
            if (Array.isArray(medlemmer[n])) return medlemmer[n];
        }
    }
    return [];
}

// Table Storage tar maks 100 operasjoner per transaksjon, og alle må ha samme
// PartitionKey — som her er team-navnet.
const BATCH_STORRELSE = 100;

/**
 * Kjører operasjoner i transaksjoner i stedet for én HTTP-runde per rad.
 * Et team på 800+ medlemmer ble ellers 1600 sekvensielle kall, og forespørselen
 * rakk ikke gjennom SWA sin tidsgrense på 45 sekunder.
 */
async function kjorTransaksjoner(t, operasjoner) {
    for (let i = 0; i < operasjoner.length; i += BATCH_STORRELSE) {
        const bolk = operasjoner.slice(i, i + BATCH_STORRELSE);
        try {
            await t.submitTransaction(bolk);
        } catch (_) {
            // En transaksjon er alt-eller-ingenting. Faller tilbake til
            // enkeltoperasjoner slik at én rad ikke velter hele bolken.
            for (const [handling, entitet, modus] of bolk) {
                try {
                    if (handling === 'delete') await t.deleteEntity(entitet.partitionKey, entitet.rowKey);
                    else await t.upsertEntity(entitet, modus || 'Replace');
                } catch (err) {
                    if (err.statusCode !== 404) throw err;
                }
            }
        }
    }
}

/**
 * Erstatt medlemskap for ett team. Med append=false fjernes medlemmer som
 * ikke er med i den nye lista. Med append=true beholdes de (brukes når PA
 * sender store lister i flere chunker).
 */
async function erstattTeam(teamNavn, medlemmer, { append = false } = {}) {
    const navn = String(teamNavn || '').trim();
    if (!navn) throw new Error('Mangler team-navn');
    const t = await tabell();
    const nu = new Date().toISOString();

    // Les eksisterende rader først. Navn tas vare på for medlemmer som fortsatt
    // er med, men som kommer inn uten navn — slik at en flyt som ennå ikke er
    // lagt om ikke sletter navn en annen flyt har lagret. To flyter skriver
    // hit: cron-refresh og lazy-load.
    const eksisterende = new Map();
    const filter = odata`PartitionKey eq ${navn}`;
    try {
        for await (const e of t.listEntities({ queryOptions: { filter, select: ['PartitionKey', 'RowKey', 'FN', 'EN', 'Navn'] } })) {
            const m = radTilMedlem(e);
            if (m.EP) eksisterende.set(m.EP, m);
        }
    } catch (e) {
        if (e.statusCode !== 404) throw e;
    }

    // Dedupliser på UPN. Kommer samme person flere ganger, vinner den raden
    // som faktisk har navn — flyten kan sende både berikede og bare rene UPN-er.
    const perUpn = new Map();
    for (const m of medlemsliste(medlemmer)) {
        const norm = normaliserMedlem(m);
        if (!norm) continue;
        const fins = perUpn.get(norm.EP);
        if (!fins || (!fins.FN && !fins.EN && !fins.Navn)) perUpn.set(norm.EP, norm);
    }

    const operasjoner = [];

    // Bare rader som faktisk forsvinner må slettes — de som blir med skrives
    // uansett over av upserten under.
    if (!append) {
        for (const ep of eksisterende.keys()) {
            if (!perUpn.has(ep)) operasjoner.push(['delete', { partitionKey: navn, rowKey: ep }]);
        }
    }
    const fjernet = operasjoner.length;

    let medNavn = 0;
    let beholdt = 0;
    for (const m of perUpn.values()) {
        let { FN, EN, Navn } = m;
        if (FN || EN || Navn) {
            medNavn++;
        } else {
            const gammel = eksisterende.get(m.EP);
            if (gammel && (gammel.FN || gammel.EN || gammel.Navn)) {
                ({ FN, EN, Navn } = gammel);
                beholdt++;
            }
        }
        operasjoner.push(['upsert', {
            partitionKey: navn, rowKey: m.EP,
            FN, EN, Navn,
            SistOppdatert: nu
        }, 'Replace']);
    }

    await kjorTransaksjoner(t, operasjoner);

    return {
        Team: navn, modus: append ? 'append' : 'erstatt',
        antallMedlemmer: perUpn.size, antallMedNavn: medNavn,
        antallNavnBeholdt: beholdt, antallFjernet: fjernet
    };
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
        entry.Medlemmer.push(...medlemsliste(g.Medlemmer));
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

module.exports = {
    erMedlem,
    hentMedlemmer,
    hentMedlemmerDetaljert,
    hentAlleMedlemmer,
    hentAlleTeamNavn,
    erstattTeam,
    erstattBatch,
    slettTeam
};
