/**
 * Innstillinger per rollegruppe.
 *
 * En rollegruppe er paret (Rolle, Omfang) — «Publikum» for «FFT». I
 * `Rollemedlemskap` finnes bare MEDLEMSRADER; gruppene utledes ved å lese
 * dem. Det holder så lenge alt vi vet om en gruppe kan leses av medlemmene,
 * men team-koblingen kan det ikke:
 *
 * Legges `Team` på hver medlemsrad — slik `Rollebeskrivelse` ligger i dag —
 * forsvinner koblingen når siste medlem fjernes. Teamet blir da stående med
 * gamle medlemmer for alltid, og ingenting i systemet husker at det skulle
 * vedlikeholdes. En gruppe som går fra 40 til 0 er nettopp tilfellet der
 * noen MÅ få vite det.
 *
 * Derfor en egen tabell:
 *
 *   Rollegruppe
 *     PartitionKey = Rolle
 *     RowKey       = Omfang, eller '*' når omfanget er tomt
 *     Team          — teamnavn eller gruppe-ID. Tom = ingen synkronisering.
 *     SisteAntall   — antall medlemmer ved forrige VELLYKKEDE kjøring
 *     SisteSynk     — tidspunkt for samme
 *     SisteStatus   — 'ok' | 'stoppet' | 'feil' | 'hoppet-over'
 *     SisteMelding  — kort forklaring, vises i admin
 *
 * RowKey kan ikke være tom streng i Table Storage, og et tomt omfang er en
 * gyldig gruppe. Derfor stjernen — den er en plasserstreng, ikke et jokertegn.
 */
const storage = require('./storage');

const TABELL = 'Rollegruppe';
const TOMT_OMFANG = '*';

async function tabell() {
    return await storage.sikreTabell(TABELL);
}

function rowKey(omfang) {
    const o = String(omfang || '').trim();
    return o === '' ? TOMT_OMFANG : o;
}

function omfangFra(rk) {
    return String(rk) === TOMT_OMFANG ? '' : String(rk);
}

function radTilGruppe(e) {
    return {
        Rolle: e.partitionKey,
        Omfang: omfangFra(e.rowKey),
        Team: e.Team || '',
        SisteAntall: Number(e.SisteAntall || 0),
        SisteSynk: e.SisteSynk || '',
        SisteStatus: e.SisteStatus || '',
        SisteMelding: e.SisteMelding || ''
    };
}

/** Innstillingene for én gruppe, eller null. */
async function hent(rolle, omfang = '') {
    try {
        const t = await tabell();
        return radTilGruppe(await t.getEntity(String(rolle), rowKey(omfang)));
    } catch (e) {
        if (e.statusCode === 404) return null;
        throw e;
    }
}

/** Alle grupper med innstillinger. Tabellen er liten — én gjennomgang holder. */
async function hentAlle() {
    const ut = [];
    try {
        const t = await tabell();
        for await (const e of t.listEntities()) ut.push(radTilGruppe(e));
    } catch (e) {
        if (e.statusCode !== 404) throw e;
    }
    return ut;
}

/**
 * Sett team-koblingen. Tom streng slår den av.
 *
 * `Merge`, ikke `Replace`: synkroniseringens egne felter (SisteAntall m.m.)
 * skal ikke nullstilles fordi en administrator redigerte teamnavnet.
 */
async function settTeam(rolle, omfang, team) {
    const t = await tabell();
    await t.upsertEntity({
        partitionKey: String(rolle),
        rowKey: rowKey(omfang),
        Team: String(team || '').trim()
    }, 'Merge');
}

/**
 * Skriv resultatet av en kjøring.
 *
 * `SisteAntall` oppdateres BARE når kjøringen gikk gjennom. Skrives det ved
 * en stoppet kjøring, ville grunnlaget for fall-sperren blitt satt til det
 * mistenkelige tallet — og neste kjøring ville sammenlignet med det og sluppet
 * fallet gjennom. Sperren ville dermed slått ut nøyaktig én gang, og aldri
 * mer.
 */
async function settResultat(rolle, omfang, { status, melding = '', antall = null }) {
    const t = await tabell();
    const rad = {
        partitionKey: String(rolle),
        rowKey: rowKey(omfang),
        SisteStatus: String(status || ''),
        SisteMelding: String(melding || '').slice(0, 400),
        SisteSynk: new Date().toISOString()
    };
    if (status === 'ok' && antall !== null) rad.SisteAntall = Number(antall);
    await t.upsertEntity(rad, 'Merge');
}

module.exports = { hent, hentAlle, settTeam, settResultat, rowKey, omfangFra, TABELL, TOMT_OMFANG };
