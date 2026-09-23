/**
 * PB-token-lagring (Tilgangskontroll-tabell).
 *
 * Struktur (samme skjema som legacy for framtidig deling):
 *   PartitionKey = upn (lowercase)
 *   RowKey       = guid (crypto.randomUUID)
 *   Egenskaper: SkjematypeId, Tilgangstype ('pb-eier'), IssuedUTC, ExpiresUTC,
 *               Used, SingleUse (false for PB), Side
 *
 * TTL: 365 dager for pb-eier (matcher legacy).
 * Brukes av /api/pb-token (opprett) og /api/power-bi (validering).
 */
const crypto = require('crypto');
const { tabellKlient, sikreTabell } = require('./storage');

const TABELL = 'Tilgangskontroll';
const TTL_DAGER_PB = 365;

async function tabell() {
    const t = await sikreTabell(TABELL);
    return t;
}

/**
 * Opprett et PB-token for gitt upn + skjematype. Returnerer { guid, utloper }.
 */
async function opprettPbToken({ upn, skjematypeId }) {
    if (!upn || !skjematypeId) throw new Error('upn og skjematypeId er påkrevd');
    const t = await tabell();
    const guid = crypto.randomUUID();
    const nu = new Date();
    const utloper = new Date(nu.getTime() + TTL_DAGER_PB * 24 * 60 * 60 * 1000);
    await t.upsertEntity({
        partitionKey: String(upn).toLowerCase(),
        rowKey: guid,
        SkjematypeId: String(skjematypeId),
        Tilgangstype: 'pb-eier',
        IssuedUTC: nu.toISOString(),
        ExpiresUTC: utloper.toISOString(),
        Used: false,
        SingleUse: false,
        Side: 'datauttrekk.html'
    }, 'Replace');
    return { guid, utloper: utloper.toISOString() };
}

/**
 * Valider PB-token — sjekker at raden finnes, ikke er utløpt, og at
 * SkjematypeId matcher forventet verdi.
 * @returns {Promise<{gyldig:boolean, melding?:string, entity?:object}>}
 */
async function validerPbToken({ upn, guid, skjematypeId }) {
    if (!upn || !guid) return { gyldig: false, melding: 'Mangler upn eller guid' };
    const t = await tabell();
    try {
        const e = await t.getEntity(String(upn).toLowerCase(), String(guid));
        if (e.Tilgangstype !== 'pb-eier') return { gyldig: false, melding: 'Feil tilgangstype' };
        if (skjematypeId && String(e.SkjematypeId) !== String(skjematypeId)) {
            return { gyldig: false, melding: 'Skjematype-ID matcher ikke token' };
        }
        const naa = new Date().toISOString();
        if (e.ExpiresUTC && e.ExpiresUTC < naa) return { gyldig: false, melding: 'Token utløpt' };
        return { gyldig: true, entity: e };
    } catch (err) {
        if (err.statusCode === 404) return { gyldig: false, melding: 'Token ikke funnet' };
        throw err;
    }
}

/**
 * Alle pb-eier-tokenene i dette miljøet, til nøkkelkalenderen.
 *
 * Tabellen deles med OTP-tokenene, som er kortlevde og mange. Filteret på
 * Tilgangstype gjøres derfor i spørringen, ikke i minnet.
 *
 * `SistVarslet` og `SistVarsletTrinn` bor på selve raden. Alternativet var å
 * føre dem i nøkkelkalenderen, men den ligger i en annen lagringskonto og
 * vedlikeholdes manuelt — og et token som opprettes av en skjemaeier i dag
 * ville da ikke hatt noen rad å varsle fra.
 */
async function listPbEierTokens() {
    const t = await tabell();
    const ut = [];
    for await (const e of t.listEntities({
        queryOptions: { filter: "Tilgangstype eq 'pb-eier'" }
    })) {
        ut.push({
            upn: String(e.partitionKey || ''),
            guid: String(e.rowKey || ''),
            skjematypeId: String(e.SkjematypeId || ''),
            utloper: String(e.ExpiresUTC || ''),
            sistVarslet: String(e.SistVarslet || ''),
            sistVarsletTrinn: e.SistVarsletTrinn === undefined || e.SistVarsletTrinn === null || e.SistVarsletTrinn === ''
                ? null : Number(e.SistVarsletTrinn)
        });
    }
    return ut;
}

/**
 * Merk at det er varslet om dette tokenet på gitt trinn.
 *
 * Merge og ikke Replace: raden bærer tokenet selv, og en full erstatning som
 * glemte et felt ville gjort Power BI-koblingen ugyldig. Et varsel er ikke
 * verdt den risikoen.
 */
async function markerVarslet(upn, guid, trinn) {
    const t = await tabell();
    await t.updateEntity({
        partitionKey: String(upn).toLowerCase(),
        rowKey: String(guid),
        SistVarslet: new Date().toISOString(),
        SistVarsletTrinn: String(trinn)
    }, 'Merge');
}

module.exports = {
    opprettPbToken,
    validerPbToken,
    listPbEierTokens,
    markerVarslet,
    TTL_DAGER_PB
};
