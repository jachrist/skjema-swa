/**
 * Bring-oppdateringen som JOBB — uavhengig av hva som startet den.
 *
 * Jobben har to inngangsporter, og det er hele poenget med at den ligger her:
 *
 *   **HTTP** — `POST /api/postnumre/refresh-bring`, for GitHub Actions-cron i
 *   pilot og prod, og for admin-knappen i alle miljøer.
 *
 *   **Timer** — `app.timer(...)` i dev, der plattformen kjører dem. Se
 *   `KJORER_TIMERE` i `lib/plattform.js`.
 *
 * Statusraden i `CacheMetadata` og hendelsesloggen skrives her, ikke i
 * handlerne. Lå bokføringen i hver inngangsport, ville admin-panelet fått to
 * litt ulike bilder av den samme jobben avhengig av hvem som startet den — og
 * forskjellen ville vært usynlig helt til noen sammenlignet dem.
 *
 * `kilde` er det ENESTE som skiller de to veiene, og den står i statusraden.
 */
const PK = 'Meta';
const RK = 'Postnumre-Bring';

/**
 * Kjør oppdateringen og bokfør utfallet. Kaster aldri.
 *
 * Returnerer resultatet fra Bring-importen, eller `{ status: 'feil' }`.
 * Kallerne velger selv om de venter: HTTP-veien må svare innen SWA-proxyens
 * ~45 sekunder og starter den uten å vente, mens timeren venter — der er det
 * ingen som sitter og ser på en klokke.
 */
async function kjorBringOppdatering({ kilde, log = () => {} } = {}) {
    const bring = require('./bring-postnummer');
    const { tabellKlient } = require('./storage');
    const hendelser = require('./hendelser-storage');

    const startTid = new Date().toISOString();
    const settStatus = async (felter) => {
        try {
            const t = tabellKlient('CacheMetadata');
            await t.upsertEntity({ partitionKey: PK, rowKey: RK, ...felter }, 'Merge');
        } catch (_) { /* statusraden er ikke kritisk */ }
    };

    try {
        const t = tabellKlient('CacheMetadata');
        try { await t.createTable(); } catch (_) { /* fins fra før */ }
    } catch (_) { /* ikke-kritisk */ }
    await settStatus({ Status: 'kjører', Startet: startTid, Kilde: kilde, SistFeil: '' });
    log(`postnumre/refresh-bring: trigget av ${kilde}`);

    try {
        const res = await bring.oppdaterFraBring(log);
        log(`postnumre/refresh-bring: OK — ${JSON.stringify(res)}`);
        await settStatus({
            Status: 'ok', SistOppdatert: new Date().toISOString(),
            AntallRader: res.antallSkrevet, AntallSlettet: res.antallSlettet,
            VarighetSekunder: res.varighetSekunder, SistFeil: ''
        });
        hendelser.logg({
            Type: 'postnumre.bring-oppdatert', Aktor: kilde,
            ObjektType: 'postnumre', ObjektId: 'Bring',
            Melding: `Oppdaterte postnummerregister — ${res.antallSkrevet} skrevet, `
                + `${res.antallSlettet} slettet (${res.varighetSekunder}s)`,
            Detaljer: res
        });
        return { status: 'ok', ...res };
    } catch (e) {
        log(`postnumre/refresh-bring FEIL: ${e.message}`);
        await settStatus({
            Status: 'feil', Ferdig: new Date().toISOString(),
            SistFeil: String(e.message || e).slice(0, 500)
        });
        hendelser.logg({
            Type: 'postnumre.bring-feil', Aktor: kilde,
            ObjektType: 'postnumre', ObjektId: 'Bring',
            Melding: `Bring-oppdatering feilet: ${e.message}`.slice(0, 500)
        });
        return { status: 'feil', melding: String(e.message || e) };
    }
}

module.exports = { kjorBringOppdatering, PK, RK };
