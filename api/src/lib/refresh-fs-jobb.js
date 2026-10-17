/**
 * FS-refreshen som JOBB — uavhengig av hva som startet den.
 *
 * Samme form som `postnummer-jobb.js`, og av samme grunn: jobben har to
 * inngangsporter, og bokføringen skal skje ÉTT sted.
 *
 *   **HTTP** — `POST /api/refresh-fs`, for GitHub Actions-cron i pilot og
 *   prod, og for admin-knappen i alle miljøer.
 *
 *   **Timer** — `app.timer(...)` i dev. Se `KJORER_TIMERE` i `lib/plattform.js`.
 *
 * Bokføringen lå i HTTP-handleren til 17.10.2026, i tre `upsertEntity`-kall
 * spredt over en `.then()` og en `.catch()`. Den formen kunne ikke deles med
 * en timer uten å kopieres, og to kopier av «hva skriver vi i statusraden» er
 * nøyaktig feilklassen dette repoet lager flest av.
 *
 * **STATUSRADEN ER `FS-Emner`, og det er med vilje.** Den raden er både
 * jobbens rad og én av kildene FS-fanen viser. Å gi jobben en egen rad ville
 * delt «kjørte jobben» fra «hvor friske er dataene» i to tall som kan svare
 * ulikt. Kolonnene her og de `refresh-fs.js` selv skriver, er disjunkte:
 * herfra kommer Status, Startet, Ferdig, Kilde, VarighetSekunder og SistFeil.
 */
const PK = 'Meta';
const RK = 'FS-Emner';

/**
 * Kjør FS-refreshen og bokfør utfallet. Kaster aldri.
 *
 * Kallerne velger selv om de venter: HTTP-veien må svare innen SWA-proxyens
 * ~45 sekunder og starter den uten å vente, mens timeren venter.
 *
 * **Timeren venter på en jobb som tar 2-4 minutter**, og hele ventetiden er
 * én funksjonskjøring. `host.json` setter ingen `functionTimeout`, så
 * standarden på Consumption gjelder — fem minutter. Marginen er reell, men
 * ikke stor: blir jobben kuttet, står statusraden igjen på «kjører», og det
 * er det synlige tegnet. Se 8n i docs/BESLUTNING-EGEN-FUNCTION-APP.md for
 * app-settingen som hever grensen i dev alene.
 */
async function kjorRefreshFs({ kilde, log = () => {} } = {}) {
    const { refreshFS } = require('./refresh-fs');
    const { tabellKlient } = require('./storage');
    const hendelser = require('./hendelser-storage');

    const startTid = new Date().toISOString();
    const settStatus = async (felter) => {
        try {
            const t = tabellKlient('CacheMetadata');
            await t.upsertEntity({ partitionKey: PK, rowKey: RK, ...felter }, 'Merge');
        } catch (_) { /* statusraden er ikke kritisk */ }
    };

    await settStatus({ Status: 'kjører', Startet: startTid, Kilde: kilde, SistFeil: '' });
    log(`refresh-fs: trigget av ${kilde}`);

    try {
        const res = await refreshFS(log);
        log(`refresh-fs: OK — ${JSON.stringify(res)}`);
        await settStatus({
            Status: 'ok', Ferdig: new Date().toISOString(),
            VarighetSekunder: res.varighetSekunder,
            Terminer: (res.terminer || []).join(','),
            SistFeil: ''
        });
        hendelser.logg({
            Type: 'refresh-fs.oppdatert', Aktor: kilde,
            ObjektType: 'fs', ObjektId: 'FS',
            Melding: `Oppdaterte FS-data på ${res.varighetSekunder}s`
                + (res.terminer?.length ? ` (terminer: ${res.terminer.join(', ')})` : ''),
            Detaljer: res
        });
        return { status: 'ok', ...res };
    } catch (e) {
        log(`refresh-fs FEIL: ${e.message}`);
        await settStatus({
            Status: 'feil', Ferdig: new Date().toISOString(),
            SistFeil: String(e.message || e).slice(0, 500)
        });
        hendelser.logg({
            Type: 'refresh-fs.feil', Aktor: kilde,
            ObjektType: 'fs', ObjektId: 'FS',
            Melding: `FS-refresh feilet: ${e.message}`.slice(0, 500)
        });
        return { status: 'feil', melding: String(e.message || e) };
    }
}

module.exports = { kjorRefreshFs, PK, RK };
