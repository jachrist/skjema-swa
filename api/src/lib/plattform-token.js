/**
 * Token fra PLATTFORMENS egen identitet.
 *
 * App Service og Function Apps setter `IDENTITY_ENDPOINT` og
 * `IDENTITY_HEADER` når en managed identity er på, og tilbyr et lokalt
 * endepunkt som gir et token for en ressurs. SWA Managed Functions gjør det
 * IKKE — der er variablene usatt, og det er grunnen til at `lib/keyvault.js`
 * er død kode i pilot og prod.
 *
 * Lå i `functions/mi-diagnose.js` til 16.10.2026, og ble flyttet hit da
 * `lib/flyt-auth.js` trengte den samme veien. En prøve som bygger sitt eget
 * token kan bli grønn mens den ekte veien er rød, og to utgaver av «hvordan
 * ber vi om et token» ville skilt lag på nøyaktig det ene tegnet
 * kommentarene under handler om.
 */

/**
 * Env-variabler PLATTFORMEN setter, ikke vi.
 *
 * App Service og Functions setter disse to når en managed identity er slått
 * på. De står ikke i SWA Configuration, de står ikke i Key Vault, og ingen
 * skal lime inn en verdi for dem noe sted.
 *
 * Erklæringen står her, i koden som leser dem, og
 * `api/test/env-inventar.test.js` leser den herfra. Uten den ville
 * inventartesten krevd at de ble ført opp i `config/env.*.json` som app
 * settings — og da ville inventaret påstått at noen må sette dem. Et
 * inventar som ser komplett ut og ikke er riktig, er verre enn ingen.
 *
 * `IDENTITY_HEADER` er legitimasjon. Den leses her og går bare i
 * `X-IDENTITY-HEADER`-headeren — aldri til et svar, aldri til en feilmelding.
 */
const SATT_AV_PLATTFORMEN = ['IDENTITY_ENDPOINT', 'IDENTITY_HEADER'];

/**
 * Hvorfor `plattform` finnes ved siden av SDK-en: SKRÅSTREKEN.
 *
 * `getToken` tar et *scope* — «<ressurs>/.default» — og på App Service
 * oversetter SDK-en det til plattformens `resource`-parameter ved å klippe
 * av «/.default». Da forsvinner en avsluttende skråstrek i ressursen, og
 * `aud` i tokenet blir `https://service.flow.microsoft.com`.
 *
 * Power Automate krever `https://service.flow.microsoft.com/` — MED
 * skråstrek. Microsofts dokumentasjon sier det rett ut: «Audience values
 * must be an exact match, including trailing slashes.» Det er en bokstavelig
 * strengsammenligning, og den feiler på ett tegn.
 *
 * Plattformens endepunkt tar `resource` ordrett, og det er hele poenget med
 * denne veien. Svaret bærer `ressursSomBleSpurtOm` nettopp for at det skal
 * være synlig hvilken av dem som faktisk ble sendt.
 *
 * `IDENTITY_HEADER` er en hemmelighet og skal ALDRI ut herfra.
 */
async function tokenFraPlattformen(ressurs, klientId) {
    const endepunkt = process.env.IDENTITY_ENDPOINT;
    const nokkel = process.env.IDENTITY_HEADER;
    if (!endepunkt || !nokkel) {
        // Begge settes av plattformen når en managed identity er på. Mangler
        // de, er det identiteten som mangler — ikke tilgangen. Forskjellen
        // er verdt en egen melding.
        throw new Error(`${SATT_AV_PLATTFORMEN.join(' / ')} er ikke satt — `
            + 'ingen managed identity på denne verten');
    }
    const u = new URL(endepunkt);
    u.searchParams.set('api-version', '2019-08-01');
    u.searchParams.set('resource', ressurs);
    // HAR APPEN BARE USER-ASSIGNED IDENTITETER, MÅ KALLET SI HVILKEN.
    //
    // Uten `client_id` svarer endepunktet 400 «Unable to load the proper
    // Managed Identity» — også når appen har nøyaktig én. Målt 16.10.2026 på
    // fa-skjema-3-dev, der identiteten var riktig knyttet til appen og Key
    // Vault-referansene løste seg fint. Prøven feilet altså på seg selv, og
    // meldingen pekte mot oppsettet.
    if (klientId) u.searchParams.set('client_id', klientId);

    const res = await fetch(u, { headers: { 'X-IDENTITY-HEADER': nokkel } });
    const tekst = await res.text();
    if (!res.ok) {
        throw new Error(`identity-endepunktet svarte ${res.status}: ${String(tekst).slice(0, 200)}`);
    }
    let data;
    try {
        data = JSON.parse(tekst);
    } catch (e) {
        throw new Error(`identity-endepunktet ga ikke JSON: ${e.message}`);
    }
    if (!data.access_token) throw new Error('identity-endepunktet ga ingen access_token');
    return {
        token: data.access_token,
        utloper: tidspunkt(data.expires_on),
        scope: null,
        // Plattformen ekkoer ressursen den forsto. Står skråstreken her,
        // overlevde den hele veien.
        ressursSomBleSpurtOm: data.resource ?? '(ikke oppgitt av plattformen)'
    };
}

/**
 * `expires_on` kommer som epoch-sekunder fra noen verter og som dato fra
 * andre. Feltet skal uansett settes, med årsaken i seg hvis det ikke kunne
 * tolkes — en nøkkel som forsvinner kan ikke feilsøkes.
 */
function tidspunkt(verdi) {
    if (verdi === undefined || verdi === null || verdi === '') return '(ikke oppgitt)';
    const tall = Number(verdi);
    if (Number.isFinite(tall)) return new Date(tall * 1000).toISOString();
    const d = new Date(String(verdi));
    return Number.isNaN(d.getTime()) ? `ukjent format: ${verdi}` : d.toISOString();
}

module.exports = { tokenFraPlattformen, tidspunkt, SATT_AV_PLATTFORMEN };
