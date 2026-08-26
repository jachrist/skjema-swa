/**
 * Todo-lista — utestående punkter i skjemasystemet.
 *
 * Lista skal finnes i én versjon på tvers av miljøene, og bor derfor på
 * dev-tenantens lagringskonto. Både pilot og prod peker dit via
 * TODO_STORAGE_CONNECTION_STRING. Delt nøkkel er eneste vei: Managed Identity
 * virker ikke over tenantgrenser. Er varen ikke satt, faller vi tilbake til
 * miljøets eget lager — da får man en lokal kopi, og UI-et sier fra om det.
 *
 * PK = 'Todo', RK = nummeret nullpadet til fire siffer ('0007'). Table Storage
 * sorterer RowKey som streng, så padingen er det som holder 7 foran 26.
 * Nummer gjenbrukes ikke: nye punkter legges alltid bakerst, slik at
 * «punkt 17» betyr det samme i dag og om en måned.
 */
const { sikreTabellFra, kontoNavnFra } = require('./storage');

const TABELL = 'TodoPunkter';
const PK = 'Todo';

const DELT_CS = process.env.TODO_STORAGE_CONNECTION_STRING || '';
const CS = DELT_CS || process.env.STORAGE_CONNECTION_STRING || '';

const KATEGORI_STANDARD = 'Brukerønsker';
const STATUS_VERDIER = ['åpen', 'ferdig'];

function rk(nummer) {
    return String(Math.trunc(Number(nummer))).padStart(4, '0');
}

async function tabell() {
    return sikreTabellFra(CS, TABELL, 'TODO_STORAGE_CONNECTION_STRING');
}

function fraEntitet(e) {
    return {
        Nummer: Number(e.Nummer ?? Number(e.rowKey)),
        Tekst: e.Tekst || '',
        Status: STATUS_VERDIER.includes(e.Status) ? e.Status : 'åpen',
        Kategori: e.Kategori || KATEGORI_STANDARD,
        Notat: e.Notat || '',
        Opprettet: e.Opprettet || null,
        OpprettetAv: e.OpprettetAv || '',
        SistEndret: e.SistEndret || null,
        EndretAv: e.EndretAv || '',
        Ferdig: e.Ferdig || null
    };
}

/** Hvilket lager lista faktisk ligger i — vises i admin-panelet. */
function lagerInfo() {
    return { konto: kontoNavnFra(CS), delt: !!DELT_CS };
}

async function listAlle() {
    const t = await tabell();
    const ut = [];
    for await (const e of t.listEntities({ queryOptions: { filter: `PartitionKey eq '${PK}'` } })) {
        ut.push(fraEntitet(e));
    }
    return ut.sort((a, b) => a.Nummer - b.Nummer);
}

async function hent(nummer) {
    const t = await tabell();
    try {
        return fraEntitet(await t.getEntity(PK, rk(nummer)));
    } catch (e) {
        if (e.statusCode === 404) return null;
        throw e;
    }
}

async function nesteNummer(t) {
    let hoyeste = 0;
    for await (const e of t.listEntities({
        queryOptions: { filter: `PartitionKey eq '${PK}'`, select: ['RowKey'] }
    })) {
        const n = Number(e.rowKey);
        if (Number.isFinite(n) && n > hoyeste) hoyeste = n;
    }
    return hoyeste + 1;
}

/**
 * Nytt punkt bakerst i lista. createEntity (ikke upsert) gjør at to
 * administratorer som oppretter samtidig kolliderer med 409 i stedet for at
 * den ene overskriver den andre — da prøver vi neste ledige nummer.
 */
async function opprett({ tekst, kategori, notat }, av) {
    const t = await tabell();
    const na = new Date().toISOString();
    let nummer = await nesteNummer(t);
    for (let forsok = 0; forsok < 5; forsok++) {
        const entitet = {
            partitionKey: PK,
            rowKey: rk(nummer),
            Nummer: nummer,
            Tekst: String(tekst || '').trim(),
            Status: 'åpen',
            Kategori: String(kategori || KATEGORI_STANDARD).trim() || KATEGORI_STANDARD,
            Notat: String(notat || ''),
            Opprettet: na,
            OpprettetAv: String(av || ''),
            SistEndret: na,
            EndretAv: String(av || ''),
            Ferdig: ''
        };
        try {
            await t.createEntity(entitet);
            return fraEntitet(entitet);
        } catch (e) {
            if (e.statusCode !== 409) throw e;
            nummer++;
        }
    }
    throw new Error('Fant ikke et ledig nummer — prøv igjen.');
}

async function oppdater(nummer, felter, av) {
    const t = await tabell();
    const finnes = await hent(nummer);
    if (!finnes) return null;

    const endring = {
        partitionKey: PK, rowKey: rk(nummer),
        SistEndret: new Date().toISOString(), EndretAv: String(av || '')
    };
    if (felter.Tekst !== undefined) endring.Tekst = String(felter.Tekst).trim();
    if (felter.Kategori !== undefined) endring.Kategori = String(felter.Kategori).trim() || KATEGORI_STANDARD;
    if (felter.Notat !== undefined) endring.Notat = String(felter.Notat);
    if (felter.Status !== undefined) {
        const s = STATUS_VERDIER.includes(felter.Status) ? felter.Status : 'åpen';
        endring.Status = s;
        // Ferdigtidspunktet settes når punktet krysses av, og tømmes hvis det
        // gjenåpnes. Uendret status rører den ikke.
        if (s !== finnes.Status) endring.Ferdig = s === 'ferdig' ? new Date().toISOString() : '';
    }

    await t.updateEntity(endring, 'Merge');
    return fraEntitet({ ...finnes, ...endring, rowKey: rk(nummer) });
}

async function slett(nummer) {
    const t = await tabell();
    try { await t.deleteEntity(PK, rk(nummer)); return true; }
    catch (e) { if (e.statusCode === 404) return false; throw e; }
}

/**
 * Les punkter ut av Markdown på formen «12. [x] tekst», med `##`-overskrifter
 * som kategori. Formatet er det docs/TODO.md brukte, så den gamle lista kan
 * limes rett inn.
 */
function parseMarkdown(md) {
    const punkter = [];
    let kategori = KATEGORI_STANDARD;
    for (const linje of String(md || '').split(/\r?\n/)) {
        const overskrift = /^#{2,6}\s+(.+?)\s*$/.exec(linje);
        if (overskrift) { kategori = overskrift[1]; continue; }
        // «7.[ ]» uten mellomrom forekom i den gamle fila — derfor \.\s*
        const punkt = /^\s*(\d+)\.\s*\[([ xX])\]\s*(.*)$/.exec(linje);
        if (!punkt) continue;
        const tekst = punkt[3].trim();
        if (!tekst) continue;
        punkter.push({
            Nummer: Number(punkt[1]),
            Status: punkt[2].toLowerCase() === 'x' ? 'ferdig' : 'åpen',
            Kategori: kategori,
            Tekst: tekst
        });
    }
    return punkter;
}

/**
 * Engangsimport av en eksisterende liste. Numre som allerede finnes rører vi
 * ikke, så importen kan kjøres om igjen uten å lage duplikater eller
 * overskrive endringer gjort i panelet.
 */
async function importerMarkdown(md, av) {
    const punkter = parseMarkdown(md);
    if (punkter.length === 0) return { lagtTil: 0, hoppetOver: 0, lest: 0 };

    const t = await tabell();
    const finnes = new Set((await listAlle()).map(p => p.Nummer));
    const na = new Date().toISOString();
    let lagtTil = 0, hoppetOver = 0;

    for (const p of punkter) {
        if (finnes.has(p.Nummer)) { hoppetOver++; continue; }
        await t.upsertEntity({
            partitionKey: PK,
            rowKey: rk(p.Nummer),
            Nummer: p.Nummer,
            Tekst: p.Tekst,
            Status: p.Status,
            Kategori: p.Kategori,
            Notat: '',
            Opprettet: na,
            OpprettetAv: String(av || ''),
            SistEndret: na,
            EndretAv: String(av || ''),
            Ferdig: p.Status === 'ferdig' ? na : ''
        }, 'Replace');
        finnes.add(p.Nummer);
        lagtTil++;
    }
    return { lagtTil, hoppetOver, lest: punkter.length };
}

/** Skriv lista tilbake til Markdown — til deling utenfor appen. */
function tilMarkdown(punkter) {
    const kategorier = [];
    for (const p of punkter) if (!kategorier.includes(p.Kategori)) kategorier.push(p.Kategori);

    const linjer = [
        '# Utestående punkter skjemasystem',
        '',
        `Hentet fra admin-panelet ${new Date().toISOString().slice(0, 10)}. Lista vedlikeholdes der.`
    ];
    for (const k of kategorier) {
        linjer.push('', `## ${k}`, '');
        for (const p of punkter.filter(x => x.Kategori === k)) {
            linjer.push(`${p.Nummer}. [${p.Status === 'ferdig' ? 'x' : ' '}] ${p.Tekst}`);
        }
    }
    return linjer.join('\n') + '\n';
}

module.exports = {
    listAlle, hent, opprett, oppdater, slett,
    importerMarkdown, parseMarkdown, tilMarkdown, lagerInfo,
    KATEGORI_STANDARD, STATUS_VERDIER
};
