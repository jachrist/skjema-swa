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
// Modulobjekt, ikke destrukturert: tester bytter ut sikreTabell for aa
// slippe en ekte lagringskonto. En destrukturert referanse ville pekt paa
// den opprinnelige funksjonen og gjort stubben virkningslos.
const storage = require('./storage');

const TABELL = 'Rollemedlemskap';

async function tabell() {
    const t = await storage.sikreTabell(TABELL);
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
 * `SistOppdatert` som en ISO-streng, eller null.
 *
 * Datoene sammenlignes som TEKST — ISO-strenger sorterer riktig, og en
 * `new Date(...)` på en ugyldig verdi gir `Invalid Date`, som sammenligner
 * falskt mot alt uten å feile. Derfor må verdien være en streng før den
 * brukes.
 *
 * Men den er ikke garantert å være det. Vår egen kode skriver
 * `toISOString()`, mens Table Storage leverer en `Date` for kolonner som er
 * typet `Edm.DateTime` — og en `Date` sammenlignet med en streng gir `false`
 * i begge retninger. Da ville den nyeste raden aldri vunnet, og rollen sett
 * eldre ut enn den er. Den oversettes derfor, i stedet for å forkastes.
 *
 * Tom streng er ukjent, ikke «år 0». Rader skrevet før feltet fantes har
 * ingen verdi, og de skal telles som ukjente.
 */
function isoDato(verdi) {
    if (verdi instanceof Date) return Number.isNaN(verdi.getTime()) ? null : verdi.toISOString();
    return typeof verdi === 'string' && verdi.trim() ? verdi : null;
}

/**
 * Hent alle distinkte (Rolle, Omfang)-grupper med telling.
 * Brukes til oversikt i rolleadmin.
 *
 * NÅR ROLLEN SIST BLE OPPDATERT følger med, og det er et ønske med en grunn:
 * en rolle som får innehaverne sine fra FS gjennom importen ser helt lik ut
 * enten importen gikk i går eller i fjor. Antallet stemmer, navnene står der,
 * og ingenting i oversikten skiller en fersk liste fra en forlatt.
 *
 * `SistOppdatert` alene er ikke nok til å svare på det. Redigeres én rad for
 * hånd i dag, blir den nyeste datoen dagens — mens importen kan være måneder
 * gammel. Derfor føres datoen PER KILDE: «sist importert» er det tallet som
 * svarer på spørsmålet, og «sist endret manuelt» er et annet spørsmål.
 *
 * `UtenDato` teller rader fra før feltet ble skrevet. Uten den ville en rolle
 * med bare gamle rader sett ut som «aldri oppdatert», og det er en annen
 * påstand enn «vi vet ikke».
 */
async function hentAlleGrupper() {
    const t = await tabell();
    const grupper = new Map(); // "Rolle||Omfang" → gruppe
    for await (const e of t.listEntities()) {
        const rolle = e.partitionKey;
        const rk = String(e.rowKey || '');
        const del = rk.indexOf('|');
        const omfang = del > -1 ? rk.substring(0, del) : '';
        const key = `${rolle}||${omfang}`;
        if (!grupper.has(key)) {
            grupper.set(key, {
                Rolle: rolle, Omfang: omfang, Antall: 0, Kilder: new Set(),
                SistOppdatert: null, SistPerKilde: {}, UtenDato: 0
            });
        }
        const g = grupper.get(key);
        const kilde = e.Kilde || 'manuell';
        g.Antall++;
        g.Kilder.add(kilde);

        const dato = isoDato(e.SistOppdatert);
        if (!dato) { g.UtenDato++; continue; }
        if (!g.SistOppdatert || dato > g.SistOppdatert) g.SistOppdatert = dato;
        const forrige = g.SistPerKilde[kilde];
        if (!forrige || dato > forrige) g.SistPerKilde[kilde] = dato;
    }
    return [...grupper.values()]
        .map(g => ({ ...g, Kilder: [...g.Kilder] }))
        .sort((a, b) => a.Rolle.localeCompare(b.Rolle) || a.Omfang.localeCompare(b.Omfang));
}

/**
 * UPN → { FN, EN } for alle rolleinnehavere med registrert navn.
 *
 * SEKUNDÆR navnekilde. Teammedlemskap er den primære: teamet «Ansatte og
 * studenter ved FHS» er dynamisk og dekker alle interne, og cachen lagrer FN,
 * EN og Navn sammen med UPN.
 *
 * Denne brukes til dem teamet ikke dekker — rolleinnehavere utenfor FHS — og
 * til rader lagret før teamcachen begynte å ta imot navn. Tabellen er liten,
 * og kartet bygges med én gjennomgang.
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
        ? storage.odata`PartitionKey eq ${rolle} and RowKey ge ${omfang + '|'} and RowKey lt ${omfang + '|~'}`
        : storage.odata`PartitionKey eq ${rolle}`;

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

/** Alle rader i tabellen. Importen trenger dem for å se hva som endres. */
async function hentAlle() {
    const t = await tabell();
    const ut = [];
    for await (const e of t.listEntities()) ut.push(radTilInnehaver(e));
    return ut;
}

function radNokkel(Omfang, UPN) {
    return `${Omfang || ''}|${String(UPN).toLowerCase()}`;
}

/**
 * Skriv og slett mange rader i batch-transaksjoner.
 *
 * Table Storage krever at alle handlinger i én transaksjon deler PartitionKey,
 * og tar maks 100 om gangen — derfor grupperes de per rolle. Rad-for-rad er
 * ikke et alternativ: SWA kutter kallet etter 45 sekunder, og en import på
 * noen hundre rader ville hengt stille.
 *
 * @returns {Promise<{skrevet: number, slettet: number, transaksjoner: number}>}
 */
async function utforBatch({ skriv = [], slett = [] }) {
    const t = await tabell();
    const na = new Date().toISOString();
    const grupper = new Map(); // Rolle → handlinger

    const leggTil = (rolle, handling) => {
        if (!grupper.has(rolle)) grupper.set(rolle, []);
        grupper.get(rolle).push(handling);
    };

    for (const r of skriv) {
        leggTil(r.Rolle, ['upsert', {
            partitionKey: r.Rolle,
            rowKey: radNokkel(r.Omfang, r.UPN),
            FN: r.FN || '', EN: r.EN || '', EP: r.UPN,
            Kilde: r.Kilde || 'import',
            Rollebeskrivelse: r.Rollebeskrivelse || '',
            SistOppdatert: na
        }, 'Replace']);
    }
    for (const r of slett) {
        leggTil(r.Rolle, ['delete', {
            partitionKey: r.Rolle,
            rowKey: radNokkel(r.Omfang, r.UPN)
        }]);
    }

    let transaksjoner = 0;
    for (const handlinger of grupper.values()) {
        for (let i = 0; i < handlinger.length; i += 100) {
            await t.submitTransaction(handlinger.slice(i, i + 100));
            transaksjoner++;
        }
    }
    return { skrevet: skriv.length, slettet: slett.length, transaksjoner };
}

/**
 * Alle omfang én bruker har en gitt rolle for.
 *
 * "Emneansvarlig" → ['CBU2501', 'CBU2502'] for den som er emneansvarlig for to
 * emner. Tomt omfang (rollen gjelder uten avgrensning) tas ikke med — en slik
 * rad sier ingenting om hvilke rader brukeren skal se.
 */
async function hentOmfangForBruker(rolle, upn) {
    if (!rolle || !upn) return [];
    const upnLower = String(upn).toLowerCase();
    const innehavere = await hentInnehavere(String(rolle).trim());
    const ut = [];
    for (const i of innehavere) {
        if (String(i.UPN || '').toLowerCase() !== upnLower) continue;
        const omfang = String(i.Omfang || '').trim();
        if (omfang && !ut.includes(omfang)) ut.push(omfang);
    }
    return ut;
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

/**
 * Slett en hel rolle — alle innehaverne i ett omfang, eller i alle.
 *
 * Å fjerne innehaverne én for én etterlater en tom rolle som fortsatt vises i
 * lista og fortsatt kan velges i skjemadefinisjoner. Det er den varianten som
 * gjør at ingen tør rydde: rollen blir stående «i tilfelle».
 *
 * Rollen finnes bare så lenge den har rader — det er ingen egen rolletabell —
 * så sletting er å fjerne radene. Går i batch per partisjon, av samme grunn
 * som utforBatch: SWA kutter kallet etter 45 sekunder, og en rolle med mange
 * innehavere ville ellers hengt stille.
 *
 * Uten `omfang` slettes hele rollen på tvers av omfang. Det er en større
 * handling enn den ser ut som, så kalleren må be om den eksplisitt.
 */
async function slettRolle({ Rolle, Omfang = null }) {
    const rolle = String(Rolle || '').trim();
    if (!rolle) throw new Error('Rolle mangler');

    const t = await tabell();
    const filter = Omfang === null
        ? storage.odata`PartitionKey eq ${rolle}`
        : storage.odata`PartitionKey eq ${rolle} and RowKey ge ${Omfang + '|'} and RowKey lt ${Omfang + '|~'}`;

    const rader = [];
    for await (const e of t.listEntities({ queryOptions: { filter } })) {
        rader.push({ partitionKey: e.partitionKey, rowKey: e.rowKey });
    }
    if (rader.length === 0) return { slettet: 0 };

    for (let i = 0; i < rader.length; i += 100) {
        await t.submitTransaction(rader.slice(i, i + 100).map(r => ['delete', r]));
    }
    return { slettet: rader.length };
}

module.exports = {
    hentAlleGrupper,
    hentNavnekart,
    hentInnehavere,
    hentAlle,
    utforBatch,
    erMedlem,
    hentOmfangForBruker,
    leggTilInnehaver,
    fjernInnehaver,
    slettRolle,
    isoDato
};
