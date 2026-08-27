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
const { sikreTabellFra, glemOpprettelse, kontoNavnFra } = require('./storage');

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

function erTabellMangler(e) {
    return e?.statusCode === 404 && /TableNotFound/i.test(`${e.code || ''} ${e.message || ''}`);
}

/**
 * Kjør en operasjon mot tabellen, og oversett «TableNotFound» til noe som
 * faktisk hjelper.
 *
 * `sikreTabellFra` svelger feil fra createTable med vilje — en connection
 * string uten rett til å opprette tabeller skal fortsatt kunne lese tabeller
 * som finnes. Baksiden er at avvisningen dukker opp som TableNotFound på neste
 * kall, langt fra årsaken. Her prøver vi opprettelsen én gang til og lar den
 * egentlige feilen komme fram.
 */
async function medTabell(fn) {
    const t = await tabell();
    try {
        return await fn(t);
    } catch (e) {
        if (!erTabellMangler(e)) throw e;
        glemOpprettelse(CS, TABELL);
        try {
            await t.createTable();
        } catch (opprett) {
            if (opprett.statusCode !== 409) {
                const konto = kontoNavnFra(CS) || 'lagringskontoen';
                throw new Error(
                    `Tabellen ${TABELL} finnes ikke på ${konto}, og kunne ikke opprettes: ` +
                    `${opprett.message}. Enten må SAS-en i TODO_STORAGE_CONNECTION_STRING ` +
                    `tillate ressurstypen Container (srt) og rettigheten Create, eller så må ` +
                    `tabellen opprettes én gang manuelt på lagringskontoen.`
                );
            }
        }
        return await fn(t);
    }
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
    const konto = kontoNavnFra(CS);
    const egenKonto = kontoNavnFra(process.env.STORAGE_CONNECTION_STRING || '');
    // En SAS utstedt på feil lagringskonto er fullt gyldig: appen kobler til,
    // oppretter tabellen, og viser en tom liste uten en eneste feilmelding.
    // Peker den delte strengen på miljøets egen konto, er lista ikke delt med
    // noen — og det er nesten alltid en forveksling ved utstedelsen.
    const sammeSomMiljo = !!(DELT_CS && konto && egenKonto
        && konto.toLowerCase() === egenKonto.toLowerCase());
    return { konto, delt: !!DELT_CS, sammeSomMiljo, miljoKonto: egenKonto };
}

async function listAlle() {
    return medTabell(async (t) => {
        const ut = [];
        for await (const e of t.listEntities({ queryOptions: { filter: `PartitionKey eq '${PK}'` } })) {
            ut.push(fraEntitet(e));
        }
        return ut.sort((a, b) => a.Nummer - b.Nummer);
    });
}

async function hent(nummer) {
    return medTabell(async (t) => {
        try {
            return fraEntitet(await t.getEntity(PK, rk(nummer)));
        } catch (e) {
            // 404 fra en tabell som finnes betyr «punktet finnes ikke».
            // Mangler hele tabellen, skal medTabell få tak i den.
            if (erTabellMangler(e)) throw e;
            if (e.statusCode === 404) return null;
            throw e;
        }
    });
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
    return medTabell(async (t) => {
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
    });
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
    return medTabell(async (t) => {
        try { await t.deleteEntity(PK, rk(nummer)); return true; }
        catch (e) {
            if (erTabellMangler(e)) throw e;
            if (e.statusCode === 404) return false;
            throw e;
        }
    });
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


// ==================== VEDLEGG ====================
//
// Skjermbilder hører ofte til et punkt — «slik ser feilen ut» sier mer enn en
// setning. Filene ligger i blob-containeren todo-vedlegg på samme konto som
// lista, med nummeret som mappe: `0017/skjermbilde.png`. Blob-navnet ER
// fasiten; ingen egen kolonne på raden som kan komme ut av takt med filene.

const { containerKlientFra } = require('./blob');

const VEDLEGG_CONTAINER = 'todo-vedlegg';
const VEDLEGG_MAKS = 4 * 1024 * 1024;

// Bare det som gir mening å lime inn i en oppgaveliste. Ingen kjørbare filer.
const VEDLEGG_TYPER = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
    '.pdf': 'application/pdf', '.txt': 'text/plain', '.log': 'text/plain',
    '.csv': 'text/csv', '.json': 'application/json'
};

/**
 * Filnavn som er trygt som blob-navn og i en nedlastingsdialog. Stier,
 * kontrolltegn og tomme navn er de farlige tilfellene.
 */
const FILNAVN_MAKS = 120;

function trygtFilnavn(navn) {
    // Nettlesere sender av og til hele stien. Ta siste ledd uansett skilletegn.
    const bare = String(navn || '').split('/').pop().split('\\').pop();
    // Kontrolltegn blir mellomrom framfor å forsvinne — ellers limes ordene
    // sammen, og «to<tab>ord.png» blir «toord.png».
    const renset = [...bare]
        .map(c => (c < ' ' ? ' ' : c))
        .filter(c => !'<>:"|?*'.includes(c))
        .join('').replace(/\s+/g, ' ').trim();
    if (!renset) return 'vedlegg';
    if (renset.length <= FILNAVN_MAKS) return renset;
    // Kutt i navnet, ikke i endelsen: det er filtypen som avgjør om vedlegget
    // i det hele tatt godtas.
    const i = renset.lastIndexOf('.');
    const endelse = i > 0 && renset.length - i <= 10 ? renset.slice(i) : '';
    return renset.slice(0, FILNAVN_MAKS - endelse.length) + endelse;
}

function filtype(navn) {
    const i = String(navn || '').lastIndexOf('.');
    return i >= 0 ? String(navn).slice(i).toLowerCase() : '';
}

async function vedleggContainer() {
    const c = containerKlientFra(CS, VEDLEGG_CONTAINER, 'TODO_STORAGE_CONNECTION_STRING');
    try {
        await c.createIfNotExists();
    } catch (e) {
        // Samme felle som med tabellen: en SAS uten rett til å opprette
        // containere feiler her, og ville ellers dukket opp som «BlobNotFound»
        // langt fra årsaken.
        const konto = kontoNavnFra(CS) || 'lagringskontoen';
        // «not authorized ... using this service» betyr at signaturen ikke
        // gjelder for Blob i det hele tatt — en SAS utstedt med bare Table
        // lar tabellen virke mens blobs avvises. Det er en annen sak enn for
        // svake rettigheter, og løses et annet sted i portaldialogen.
        const feilTjeneste = /using this service/i.test(e.message || '');
        throw new Error(
            `Fikk ikke tilgang til containeren ${VEDLEGG_CONTAINER} på ${konto}: ${e.message}. ` +
            (feilTjeneste
                ? `SAS-en i TODO_STORAGE_CONNECTION_STRING gjelder ikke for Blob. Utsted den på nytt ` +
                  `med «Allowed services» = Blob (i tillegg til Table), «Allowed resource types» = ` +
                  `Container + Object, og rettighetene Read/Write/List/Create/Delete.`
                : `SAS-en i TODO_STORAGE_CONNECTION_STRING må ha «Allowed resource types» = ` +
                  `Container + Object og rettighetene Read/Write/List/Create/Delete, eller så må ` +
                  `containeren opprettes én gang manuelt.`));
    }
    return c;
}

function blobNavn(nummer, filnavn) {
    return `${rk(nummer)}/${filnavn}`;
}

async function listVedlegg(nummer) {
    const c = await vedleggContainer();
    const ut = [];
    for await (const b of c.listBlobsFlat({ prefix: `${rk(nummer)}/` })) {
        ut.push({
            Filnavn: b.name.slice(b.name.indexOf('/') + 1),
            Storrelse: b.properties.contentLength || 0,
            ContentType: b.properties.contentType || 'application/octet-stream',
            Lastet: b.properties.lastModified ? new Date(b.properties.lastModified).toISOString() : ''
        });
    }
    return ut.sort((a, b) => a.Filnavn.localeCompare(b.Filnavn));
}

/**
 * Antall vedlegg per punkt, som { '0017': 2 }.
 *
 * Lista trenger bare tallet for å vise bindersen, og ett kall over hele
 * containeren er billigere enn ett per punkt. Feiler blob-tilgangen, får
 * lista stå uten tall framfor å ikke komme opp i det hele tatt.
 */
async function antallVedleggPerPunkt() {
    const ut = {};
    try {
        const c = await vedleggContainer();
        for await (const b of c.listBlobsFlat()) {
            const mappe = b.name.slice(0, b.name.indexOf('/'));
            if (mappe) ut[mappe] = (ut[mappe] || 0) + 1;
        }
    } catch (_) {
        return {};
    }
    return ut;
}

async function lagreVedlegg(nummer, { filnavn, buffer, contentType }) {
    const navn = trygtFilnavn(filnavn);
    const type = filtype(navn);
    if (!VEDLEGG_TYPER[type]) {
        throw new Error(`Filtypen ${type || '(ingen)'} er ikke tillatt. Bruk ${Object.keys(VEDLEGG_TYPER).join(', ')}.`);
    }
    if (!buffer?.length) throw new Error('Filen er tom');
    if (buffer.length > VEDLEGG_MAKS) {
        throw new Error(`Filen er ${Math.round(buffer.length / 1024)} kB — maks ${VEDLEGG_MAKS / 1024 / 1024} MB`);
    }
    const c = await vedleggContainer();
    // Content-Type settes fra filnavnet, ikke fra det klienten oppgir: en
    // nettleser som viser blobben skal aldri kunne lures til å tolke den som
    // noe annet enn filtypen tilsier.
    await c.getBlockBlobClient(blobNavn(nummer, navn)).uploadData(buffer, {
        blobHTTPHeaders: {
            blobContentType: VEDLEGG_TYPER[type],
            blobContentDisposition: `inline; filename="${navn}"`
        }
    });
    return { Filnavn: navn, Storrelse: buffer.length, ContentType: VEDLEGG_TYPER[type] };
}

async function hentVedlegg(nummer, filnavn) {
    const c = await vedleggContainer();
    const b = c.getBlockBlobClient(blobNavn(nummer, trygtFilnavn(filnavn)));
    try {
        const svar = await b.download();
        const biter = [];
        for await (const bit of svar.readableStreamBody) biter.push(bit);
        return {
            buffer: Buffer.concat(biter),
            contentType: svar.contentType || 'application/octet-stream'
        };
    } catch (e) {
        if (e.statusCode === 404) return null;
        throw e;
    }
}

async function slettVedlegg(nummer, filnavn) {
    const c = await vedleggContainer();
    const res = await c.getBlockBlobClient(blobNavn(nummer, trygtFilnavn(filnavn))).deleteIfExists();
    return res.succeeded === true;
}

/** Alle vedlegg for punktet forsvinner med punktet. */
async function slettAlleVedlegg(nummer) {
    let antall = 0;
    try {
        const c = await vedleggContainer();
        for await (const b of c.listBlobsFlat({ prefix: `${rk(nummer)}/` })) {
            await c.getBlockBlobClient(b.name).deleteIfExists();
            antall++;
        }
    } catch (_) {
        // Et punkt skal kunne slettes selv om blob-lageret er utilgjengelig.
    }
    return antall;
}

module.exports = {
    listAlle, hent, opprett, oppdater, slett,
    importerMarkdown, parseMarkdown, tilMarkdown, lagerInfo,
    listVedlegg, lagreVedlegg, hentVedlegg, slettVedlegg, slettAlleVedlegg,
    antallVedleggPerPunkt,
    trygtFilnavn, KATEGORI_STANDARD, STATUS_VERDIER, VEDLEGG_MAKS
};
