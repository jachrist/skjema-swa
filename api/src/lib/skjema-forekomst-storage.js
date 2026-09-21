/**
 * Storage-modul for Skjemaer-tabellen (innsendte og mellomlagrede skjemaer).
 *
 * Tabellstruktur (samme som referanse-appen):
 *   Skjemaer
 *     PartitionKey = <Skjematype_id>
 *     RowKey       = <Skjema_id>
 *     Egenskaper: Tittel, InnsenderEpost, Skjemastatus, Opprettet, Oppdatert, JSON
 */
const { tabellKlient, sikreTabell } = require('./storage');
const { erKompaktFormat, ekspanderSkjema } = require('./skjema-kompakt');
const skjemaStorage = require('./skjema-storage');
const svargrense = require('./svargrense');

const TABELL = 'Skjemaer';

/**
 * Sikrer at et skjema returneres i fullt format, uansett hvordan det er lagret.
 * Henter skjemadefinisjonen ved behov for å ekspandere kompakt lagring.
 */
async function sikrFulltFormat(skjemaData, defCache = null) {
    if (!skjemaData || !erKompaktFormat(skjemaData)) return skjemaData;
    const skjematypeId = skjemaData.Skjematype_id;
    if (!skjematypeId) return skjemaData;
    // defCache: valgfri Map for løkker som ekspanderer mange skjemaer av samme
    // type — uten den hentes definisjonen på nytt for hvert eneste skjema.
    let def;
    if (defCache) {
        if (!defCache.has(skjematypeId)) defCache.set(skjematypeId, skjemaStorage.hentSkjematype(skjematypeId));
        def = await defCache.get(skjematypeId);
    } else {
        def = await skjemaStorage.hentSkjematype(skjematypeId);
    }
    if (!def || !def.JSON) return skjemaData;
    return ekspanderSkjema(skjemaData, def.JSON);
}

function entityTilSkjema(entity) {
    if (!entity) return null;
    if (!entity.JSON) return null;
    try {
        return JSON.parse(entity.JSON);
    } catch (_) {
        return null;
    }
}

async function hentSkjema(skjemaId, skjematypeId) {
    const tabell = await sikreTabell(TABELL);

    let data = null;
    if (skjematypeId) {
        try {
            const entity = await tabell.getEntity(String(skjematypeId), String(skjemaId));
            data = entityTilSkjema(entity);
        } catch (e) {
            if (e.statusCode === 404) return null;
            throw e;
        }
    } else {
        // Søk på tvers av partisjoner hvis skjematypeId mangler
        const { odata } = require('@azure/data-tables');
        const iter = tabell.listEntities({
            queryOptions: { filter: odata`RowKey eq ${String(skjemaId)}` }
        });
        for await (const entity of iter) {
            data = entityTilSkjema(entity);
            break;
        }
    }
    // Alltid returner fullt format til kalleren
    return await sikrFulltFormat(data);
}

async function lagreSkjema(skjemaData, erNytt = false) {
    const tabell = await sikreTabell(TABELL);

    const skjematypeId = String(skjemaData.Skjematype_id || '0');
    const skjemaId = String(skjemaData.Skjema_id);
    if (!skjemaId) throw new Error('Skjema_id mangler');

    const naa = new Date().toISOString();
    // Skjøt inn tidsstempel i selve skjemadataen slik at det følger med ved
    // parsing (register-visning m.m. leser fra JSON).
    if (erNytt) skjemaData.Opprettet = naa;
    skjemaData.Sist_endret = naa;

    const entity = {
        partitionKey: skjematypeId,
        rowKey: skjemaId,
        Tittel: skjemaData.Skjema_navn || skjemaData.Overskrift || '',
        InnsenderEpost: skjemaData.Innsender_Epost || skjemaData.Innsender_epost || '',
        Skjemastatus: skjemaData.Skjema_status || 0,
        Oppdatert: naa,
        JSON: JSON.stringify(skjemaData)
    };
    if (erNytt) entity.Opprettet = naa;

    await tabell.upsertEntity(entity, 'Merge');
}

/**
 * Rask metadata-only-versjon for register-lista når ingen filtrerbare felt.
 * Bruker Table-storage sin `select` for å hoppe over JSON-kolonnen (som kan
 * være 10-100 KB per rad). ~5-10× raskere for store lister.
 *
 * Returnerer array av { Skjema_id, Skjematype_id, Skjema_navn, Innsender_Epost,
 * Skjema_status, Opprettet, Sist_endret } — SAMME struktur som skjema-liste-
 * endpoint returnerer. Ingen JSON-parse, ingen dekryptering, ingen ekspandering.
 */
async function hentMetadataForType(skjematypeId) {
    const tabell = await sikreTabell(TABELL);
    const { odata } = require('@azure/data-tables');
    const iter = tabell.listEntities({
        queryOptions: {
            filter: odata`PartitionKey eq ${String(skjematypeId)}`,
            select: ['PartitionKey', 'RowKey', 'Tittel', 'InnsenderEpost', 'Skjemastatus', 'Opprettet', 'Oppdatert']
        }
    });
    const ut = [];
    for await (const e of iter) {
        ut.push({
            Skjema_id: e.rowKey,
            Skjematype_id: e.partitionKey,
            Skjema_navn: e.Tittel || '',
            Innsender_Epost: e.InnsenderEpost || '',
            Skjema_status: e.Skjemastatus || 0,
            Opprettet: e.Opprettet || '',
            Sist_endret: e.Oppdatert || ''
        });
    }
    return ut;
}

/**
 * Antall skjemaer og siste dato, per skjematype.
 *
 * Én gjennomgang av tabellen, ikke én spørring per skjematype. Med tjue
 * skjematyper ville det siste vært tjue rundturer for et tall som uansett
 * krever å se på alle radene.
 *
 * `select` er det som gjør det billig: vi henter fire felter per rad, ikke
 * JSON-en. Et skjema kan være titusener av tegn, og her skal vi bare telle.
 *
 * Statusene telles hver for seg fordi «antall utfylte» er tvetydig: et
 * mellomlagret skjema er påbegynt, ikke levert. Kalleren avgjør hva den vil
 * vise — men den skal ikke måtte gjette.
 */
async function hentAntallPerType() {
    const tabell = await sikreTabell(TABELL);
    const kart = new Map();
    const iter = tabell.listEntities({
        queryOptions: { select: ['PartitionKey', 'RowKey', 'Skjemastatus', 'Oppdatert'] }
    });
    for await (const e of iter) {
        const type = String(e.partitionKey || '');
        if (!type) continue;
        if (!kart.has(type)) {
            kart.set(type, { Antall: 0, Mellomlagret: 0, UnderBehandling: 0, Avsluttet: 0, SisteDato: '' });
        }
        const rad = kart.get(type);
        rad.Antall++;
        const status = Number(e.Skjemastatus || 0);
        if (status === 1) rad.Mellomlagret++;
        else if (status === 5) rad.Avsluttet++;
        else rad.UnderBehandling++;

        // Strengsammenligning på ISO-8601 gir kronologi uten Date-parsing —
        // og en ugyldig dato taper mot en gyldig i stedet for å bli NaN.
        const dato = String(e.Oppdatert || '');
        if (dato > rad.SisteDato) rad.SisteDato = dato;
    }
    return kart;
}

/**
 * Hvor mange INNSENDTE skjemaer har denne personen på denne skjematypen?
 *
 * Brukes av svargrensen (`svargrense.js`). `identiteter` er den åpne og den
 * anonymiserte formen av samme person — se den modulen for hvorfor begge må
 * telles.
 *
 * Ett kall per identitet, ikke ett samlet filter: `odata` er en tagget mal som
 * escaper verdiene den får, og en liste av ukjent lengde kan ikke settes inn i
 * den uten å bygge filterstrengen for hånd. To billige spørringer er en bedre
 * pris enn en håndsnekret OData-streng med brukerdata i.
 *
 * `select` hopper over JSON-kolonnen; her skal vi bare telle rader.
 *
 * Mellomlagrede skjemaer (status 1) teller ikke — et utkast er ikke et svar.
 * `unntattSkjemaId` holder raden som er i ferd med å bli lagret utenfor
 * tellingen, slik at et utkast som sendes inn ikke teller seg selv.
 */
async function tellSvarFraBruker(skjematypeId, identiteter, { unntattSkjemaId = null } = {}) {
    const ider = (identiteter || []).map(i => String(i || '').trim().toLowerCase()).filter(Boolean);
    if (ider.length === 0) return 0;

    const tabell = await sikreTabell(TABELL);
    const { odata } = require('@azure/data-tables');
    const sett = new Set();
    for (const id of [...new Set(ider)]) {
        const iter = tabell.listEntities({
            queryOptions: {
                filter: odata`PartitionKey eq ${String(skjematypeId)} and InnsenderEpost eq ${id}`,
                select: ['PartitionKey', 'RowKey', 'Skjemastatus']
            }
        });
        for await (const e of iter) {
            // Regelen for hva som teller ligger i svargrense.js, ikke her —
            // den er prøvbar uten lagringskonto, og skal ikke finnes i to
            // utgaver.
            if (!svargrense.radTellerMot(e, unntattSkjemaId)) continue;
            // Et sett, ikke en teller: skulle de to identitetene mot formodning
            // treffe samme rad, skal den telles én gang.
            sett.add(String(e.rowKey));
        }
    }
    return sett.size;
}

async function hentAlleSkjemaerForType(skjematypeId, { fulltFormat = true } = {}) {
    const tabell = await sikreTabell(TABELL);

    const { odata } = require('@azure/data-tables');
    const resultat = [];
    const iter = tabell.listEntities({
        queryOptions: { filter: odata`PartitionKey eq ${String(skjematypeId)}` }
    });
    for await (const entity of iter) {
        const data = entityTilSkjema(entity);
        if (data) resultat.push(data);
    }

    // For lista trenger vi som regel ikke ekspandere alle — det holder med metadata.
    // Kalleren kan be om fullt format eksplisitt hvis nødvendig.
    if (!fulltFormat) return resultat;

    // Ekspander eventuelle kompakte skjemaer — bruker samme definisjon flere ganger
    let def = null;
    let harHentetDef = false;
    const utvidet = [];
    for (const skjema of resultat) {
        if (!erKompaktFormat(skjema)) { utvidet.push(skjema); continue; }
        if (!harHentetDef) {
            const stObj = await skjemaStorage.hentSkjematype(skjematypeId);
            def = stObj?.JSON || null;
            harHentetDef = true;
        }
        utvidet.push(def ? ekspanderSkjema(skjema, def) : skjema);
    }
    return utvidet;
}

/**
 * Hent skjemaer der brukeren er innsender og skjemaet er i en av statusene
 * som venter på handling fra innsender: mellomlagret (1) eller til revidering (3).
 * Én query mot Skjemaer-tabellen på tvers av partisjoner.
 *
 * Returnerer array med Status-felt så kalleren kan skille dem.
 */
async function hentMineMellomlagrede(upn) {
    if (!upn) return [];
    const tabell = await sikreTabell(TABELL);

    const { odata } = require('@azure/data-tables');
    const upnLower = String(upn).toLowerCase();
    const filter = odata`InnsenderEpost eq ${upnLower} and (Skjemastatus eq ${1} or Skjemastatus eq ${3})`;

    const resultat = [];
    const iter = tabell.listEntities({ queryOptions: { filter } });
    for await (const entity of iter) {
        const data = entityTilSkjema(entity);
        if (!data) continue;
        resultat.push({
            Skjema_id: data.Skjema_id,
            Skjematype_id: data.Skjematype_id || entity.partitionKey,
            Skjema_status: data.Skjema_status || entity.Skjemastatus || 1,
            Sist_endret: data.Sist_endret || entity.Oppdatert || '',
            Opprettet: data.Opprettet || ''
        });
    }
    resultat.sort((a, b) => (b.Sist_endret || '').localeCompare(a.Sist_endret || ''));
    return resultat;
}

async function slettSkjema(skjemaId, skjematypeId) {
    const tabell = tabellKlient(TABELL);
    try {
        await tabell.deleteEntity(String(skjematypeId), String(skjemaId));
        return true;
    } catch (e) {
        if (e.statusCode === 404) return false;
        throw e;
    }
}

module.exports = {
    hentAntallPerType,
    tellSvarFraBruker,
    hentSkjema,
    lagreSkjema,
    hentAlleSkjemaerForType,
    hentMetadataForType,
    hentMineMellomlagrede,
    slettSkjema,
    sikrFulltFormat
};
