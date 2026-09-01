/**
 * Generer neste Skjema_id for en skjematype via optimistisk concurrency
 * (ETag) på Teller-tabellen. Speiler referanse-appens mønster.
 *
 * Tabellstruktur:
 *   Teller
 *     PartitionKey = "Teller"
 *     RowKey       = <Skjematype_id>
 *     Egenskaper: Nummer (int)
 *
 * Returnerer neste nummer som streng ("1", "2", ...).
 *
 * VIKTIG: telleren er ikke alene om å bestemme. Før en ID deles ut,
 * kontrolleres det at den faktisk er ledig.
 *
 * Grunnen er at telleren kan komme ut av takt med dataene, og da er den
 * farlig: `lagreSkjema` bruker upsert, så et nytt skjema med en ID som
 * allerede finnes SKRIVER OVER det gamle i stillhet. Det skjedde på
 * dev-tenanten 01.09.2026 etter at produksjonsdata var kopiert inn uten at
 * Teller fulgte med — telleren begynte på 1, og en ny innsending la seg oppå
 * et eksisterende skjema. Feilen viste seg ikke som en feilmelding, men som et
 * skjema med nye svar og opprinnelig innsender.
 *
 * Kollisjon oppdages her, og telleren repareres én gang ved å flytte den forbi
 * høyeste ID som faktisk er i bruk. Etter det går alt som normalt.
 */
// Via modulobjektet, ikke destrukturert — se samme begrunnelse i backup.js.
const storage = require('./storage');

const TABELL = 'Teller';
const PK = 'Teller';
const SKJEMA_TABELL = 'Skjemaer';
const MAKS_FORSOK = 5;

/** Finnes det allerede et skjema med denne ID-en for skjematypen? */
async function idErOpptatt(skjematypeId, id) {
    try {
        await storage.tabellKlient(SKJEMA_TABELL).getEntity(String(skjematypeId), String(id));
        return true;
    } catch (e) {
        // 404 = ledig ID. Finnes ikke tabellen ennå, er heller ingenting opptatt.
        if (e.statusCode === 404) return false;
        if (/TableNotFound/i.test(`${e.code || ''} ${e.message || ''}`)) return false;
        throw e;
    }
}

/**
 * Høyeste ID som faktisk er i bruk for skjematypen.
 *
 * Kjøres bare når en kollisjon er oppdaget — altså én gang per skjematype
 * etter at telleren har kommet ut av takt. Henter bare RowKey, ikke innholdet.
 */
async function hoyesteBrukteId(skjematypeId) {
    let hoyeste = 0;
    try {
        const t = storage.tabellKlient(SKJEMA_TABELL);
        for await (const e of t.listEntities({
            queryOptions: { filter: storage.odata`PartitionKey eq ${String(skjematypeId)}`, select: ['RowKey'] }
        })) {
            const n = Number(e.rowKey);
            if (Number.isFinite(n) && n > hoyeste) hoyeste = n;
        }
    } catch (e) {
        if (!/TableNotFound/i.test(`${e.code || ''} ${e.message || ''}`)) throw e;
    }
    return hoyeste;
}

/** Les telleren og øk den med én, med ETag mot samtidige innsendinger. */
async function nesteFraTeller(tabell, rk) {
    let entity;
    try {
        entity = await tabell.getEntity(PK, rk);
    } catch (e) {
        if (e.statusCode !== 404) throw e;
        try {
            await tabell.createEntity({ partitionKey: PK, rowKey: rk, Nummer: 1 });
            return 1;
        } catch (createErr) {
            if (createErr.statusCode === 409) return null; // noen andre rakk først
            throw createErr;
        }
    }
    const neste = (entity.Nummer || 0) + 1;
    try {
        await tabell.updateEntity({ partitionKey: PK, rowKey: rk, Nummer: neste }, 'Replace', { etag: entity.etag });
        return neste;
    } catch (e) {
        if (e.statusCode === 412) return null; // noen andre rakk først
        throw e;
    }
}

/** Flytt telleren forbi høyeste ID i bruk. Kalles bare ved kollisjon. */
async function reparerTeller(tabell, rk, tilOgMed) {
    await tabell.upsertEntity({ partitionKey: PK, rowKey: rk, Nummer: tilOgMed }, 'Replace');
}

async function genererSkjemaId(skjematypeId, deps = {}) {
    const opptatt = deps.idErOpptatt || idErOpptatt;
    const hoyeste = deps.hoyesteBrukteId || hoyesteBrukteId;
    const log = deps.log || (() => {});
    const tabell = await storage.sikreTabell(TABELL);
    const rk = String(skjematypeId);

    let harReparert = false;
    for (let forsøk = 0; forsøk < MAKS_FORSOK; forsøk++) {
        const kandidat = await nesteFraTeller(tabell, rk);
        if (kandidat === null) continue; // samtidighetskonflikt — prøv igjen

        if (!(await opptatt(skjematypeId, kandidat))) return String(kandidat);

        // Telleren er ute av takt. Reparer én gang, i stedet for å telle oss
        // oppover én ID om gangen gjennom et helt datasett.
        if (harReparert) {
            log(`skjema-id: ID ${kandidat} for skjematype ${rk} er fortsatt opptatt etter reparasjon`);
            continue;
        }
        harReparert = true;
        const topp = await hoyeste(skjematypeId);
        log(`skjema-id: telleren for skjematype ${rk} var ute av takt (ga ${kandidat}, `
            + `høyeste i bruk er ${topp}) — flyttes forbi. Typisk etter en gjenoppretting `
            + `der Teller ikke fulgte med.`);
        await reparerTeller(tabell, rk, Math.max(topp, kandidat));
    }
    throw new Error(`Kunne ikke generere Skjema_id for skjematype ${rk} etter ${MAKS_FORSOK} forsøk`);
}

module.exports = { genererSkjemaId, idErOpptatt, hoyesteBrukteId };
