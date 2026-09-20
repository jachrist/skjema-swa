/**
 * Arkiv-tabellen: hva som ble arkivert, når, av hvem — og hvilke skjemaer.
 *
 * To formål, og det andre er like viktig som det første:
 *
 *   **Slettingen verifiseres mot den.** Uten et lagret manifest måtte
 *   klienten få lov til å si «slett disse», og da er det klienten som
 *   bestemmer hva som forsvinner.
 *
 *   **Sporet blir igjen.** Den som om to år lurer på hvor skjemaene fra 2025
 *   ble av, finner svaret her: arkiv-ID, dato, hvem, antall, og om
 *   vedleggene fulgte med. Selve dataene er borte — men det skal ikke være
 *   et mysterium at de er det.
 *
 * Raden er liten: ID-lista lagres som JSON i én streng. Table Storage tar
 * 32 000 tegn per felt, så med ~20 tegn per ID rommer den godt over tusen
 * skjemaer. Blir et arkiv større enn det, deles jobben i flere kjøringer —
 * og `lagre` sier fra i stedet for å kutte stille.
 *
 * PK = Skjematype_id, RK = ArkivId
 */
const storage = require('./storage');

const TABELL = 'Arkiv';
const MAKS_TEGN = 30000;

async function tabell() {
    return await storage.sikreTabell(TABELL);
}

function radTilManifest(e) {
    let ider = [];
    try { ider = JSON.parse(e.SkjemaIder || '[]'); } catch (_) { /* tom liste */ }
    return {
        ArkivId: e.rowKey,
        Skjematype_id: e.partitionKey,
        Skjema_navn: e.SkjemaNavn || '',
        Arkivert: e.Arkivert || '',
        ArkivertAv: e.ArkivertAv || '',
        FoerDato: e.FoerDato || '',
        Antall: Number(e.Antall || 0),
        AntallVedlegg: Number(e.AntallVedlegg || 0),
        MedVedlegg: e.MedVedlegg === true,
        Sjekksum: e.Sjekksum || '',
        Slettet: e.Slettet || '',
        SkjemaIder: ider
    };
}

async function lagre(manifest, skjemaIder) {
    const json = JSON.stringify((skjemaIder || []).map(String));
    if (json.length > MAKS_TEGN) {
        throw new Error(
            `Arkivet har for mange skjemaer til å lagres i ett manifest `
            + `(${skjemaIder.length}). Velg en tidligere dato og kjør flere ganger.`);
    }
    const t = await tabell();
    await t.upsertEntity({
        partitionKey: String(manifest.Skjematype_id),
        rowKey: String(manifest.ArkivId),
        SkjemaNavn: String(manifest.Skjema_navn || ''),
        Arkivert: String(manifest.Arkivert || ''),
        ArkivertAv: String(manifest.ArkivertAv || ''),
        FoerDato: String(manifest.FoerDato || ''),
        Antall: Number(manifest.Antall || 0),
        AntallVedlegg: Number(manifest.AntallVedlegg || 0),
        MedVedlegg: !!manifest.MedVedlegg,
        Sjekksum: String(manifest.Sjekksum || ''),
        Slettet: '',
        SkjemaIder: json
    }, 'Replace');
    return manifest.ArkivId;
}

async function hent(skjematypeId, arkivId) {
    try {
        const t = await tabell();
        return radTilManifest(await t.getEntity(String(skjematypeId), String(arkivId)));
    } catch (e) {
        if (e.statusCode === 404) return null;
        throw e;
    }
}

/** Merk at slettingen er gjennomført. Et arkiv uten dette er eksportert, ikke tømt. */
async function merkSlettet(skjematypeId, arkivId, antallSlettet) {
    const t = await tabell();
    const rad = await t.getEntity(String(skjematypeId), String(arkivId));
    rad.Slettet = new Date().toISOString();
    rad.AntallSlettet = Number(antallSlettet || 0);
    await t.upsertEntity(rad, 'Replace');
}

/** Alle arkiv, nyeste først. Til oversikten i admin. */
async function hentAlle() {
    const ut = [];
    try {
        const t = await tabell();
        for await (const e of t.listEntities()) ut.push(radTilManifest(e));
    } catch (e) {
        if (e.statusCode !== 404) throw e;
    }
    return ut.sort((a, b) => String(b.Arkivert).localeCompare(String(a.Arkivert)));
}

module.exports = { lagre, hent, merkSlettet, hentAlle, TABELL, MAKS_TEGN };
