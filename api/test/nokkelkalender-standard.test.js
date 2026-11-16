/**
 * Standardinventaret i nøkkelkalenderen — innholdet og «Legg inn» på nytt.
 *
 * 16.11.2026: lista var skrevet for v2. Den hadde to hemmeligheter v3 ikke har,
 * manglet fire den har, og sa at OTP_HMAC_KEY var «trygg å rotere når som
 * helst» — den signerer også utsendingslenker og sak-lenker. Og rader lagt inn
 * før en rettelse ble stående med den gamle teksten, fordi «Legg inn» hoppet
 * over alt som fantes.
 *
 * Testene kjører den ekte seedStandard mot en tabell i minnet, og passer på:
 *   - at teksten oppdateres på eksisterende rader
 *   - at det admin har fylt inn (utløp, notat, ansvarlig, frist) står
 *   - at rader utenfor standarden meldes, ikke slettes
 *   - at secret-navnene i teksten finnes i inventaret (config/env.prod.json)
 *
 * Kjøres med:  node api/test/nokkelkalender-standard.test.js
 */
const fs = require('fs');
const path = require('path');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

process.env.MILJO = 'prod';

// Tabell i minnet, med Merge/Replace slik Table Storage gjør det.
const rader = new Map();
const nokkel = (pk, rk) => `${pk}\u0000${rk}`;
const tabell = {
    async *listEntities(opts) {
        const m = /PartitionKey eq '([^']*)'/.exec(opts?.queryOptions?.filter || '');
        for (const e of rader.values()) if (!m || e.partitionKey === m[1]) yield { ...e };
    },
    async upsertEntity(e, modus) {
        const k = nokkel(e.partitionKey, e.rowKey);
        rader.set(k, modus === 'Merge' ? { ...(rader.get(k) || {}), ...e } : { ...e });
    },
    async createTable() {}
};
const dl = require('../src/lib/delt-lager');
dl.sikreDeltTabell = async () => tabell;

const k = require('../src/lib/nokkelkalender-storage');
const navn = k.STANDARD.map(m => m.Navn);

(async () => {
    // ---------- 1. innholdet ----------
    sjekk('ingen tilkoblingsstreng — v3 bruker identiteten', navn.includes('STORAGE_CONNECTION_STRING'), false);
    sjekk('ingen klienthemmelighet for backup — v3 bruker sertifikat', navn.includes('GRAPH_CLIENT_SECRET'), false);
    for (const n of ['Backup-sertifikatet (GRAPH_CLIENT_CERT_PEM)', 'Deploy-legitimasjon for API-et', 'BACKUP_PASSPHRASE', 'ANTHROPIC_API_KEY']) {
        sjekk(`${n} er med`, navn.includes(n), true);
    }
    const otp = k.STANDARD.find(m => m.Navn === 'OTP_HMAC_KEY');
    sjekk('OTP_HMAC_KEY: sier at utsendingslenker dør', /utsendingslenker/.test(otp.Konsekvens), true);
    sjekk('OTP_HMAC_KEY: og sak-lenkene', /sak-lenker/.test(otp.Konsekvens), true);
    sjekk('OTP_HMAC_KEY: ikke «trygg når som helst»', /[Tt]rygg å rotere når som helst/.test(otp.Rotasjon + otp.Konsekvens), false);
    sjekk('BACKUP_PASSPHRASE roteres ikke', k.STANDARD.find(m => m.Navn === 'BACKUP_PASSPHRASE').Roteres, 'nei');
    sjekk('HASH_SALT roteres ikke', k.STANDARD.find(m => m.Navn === 'HASH_SALT').Roteres, 'nei');
    sjekk('alle typer er kjente', k.STANDARD.every(m => k.TYPER.includes(m.Type)), true);

    // Secret-navnene i teksten («hash-salt») skal finnes i inventaret. Et navn
    // i nøkkelkalenderen som ikke finnes i Key Vault, sender den som roterer,
    // til feil sted. Sertifikatnavnene står ikke i inventaret og er unntatt.
    const inventar = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'config', 'env.prod.json'), 'utf8'));
    const kvNavn = new Set(Object.values(inventar).filter(v => v && v.keyvault).map(v => v.keyvault));
    const nevnt = k.STANDARD.flatMap(m => [...(m.Hvor || '').matchAll(/«([a-z0-9-]+)»/g)].map(x => x[1]));
    sjekk('fant secret-navn i teksten', nevnt.length >= 6, true);
    sjekk('alle finnes i inventaret', nevnt.filter(n => !kvNavn.has(n) && n !== 'authapi'), []);

    // ---------- 2. første gang: alt legges inn ----------
    const r1 = await k.seedStandard('admin@x');
    sjekk('første gang: alt lagt til', [r1.lagtTil, r1.oppdatert, r1.hoppetOver], [k.STANDARD.length, 0, 0]);

    // ---------- 3. admin fyller inn, og en rad har gammel tekst ----------
    const otpId = k.slug('OTP_HMAC_KEY');
    const otpNokkel = nokkel('prod', otpId);
    rader.set(otpNokkel, {
        ...rader.get(otpNokkel),
        Rotasjon: 'Ingen utløpsdato. Trygg å rotere når som helst — velg et tidspunkt med lite trafikk.',
        Utloper: '2027-11-16', Notat: 'Avtalt med FS', Ansvarlig: 'jan@x', VarsleDagerFor: 14,
        SistVarslet: '2026-11-01', SistVarsletTrinn: '14'
    });
    // En rest fra v2, og en egen rad — ingen av dem i standarden.
    rader.set(nokkel('prod', 'storage_connection_string'), { partitionKey: 'prod', rowKey: 'storage_connection_string', Navn: 'STORAGE_CONNECTION_STRING' });
    // En rad i et annet miljø skal ikke røres.
    rader.set(nokkel('production', otpId), { partitionKey: 'production', rowKey: otpId, Navn: 'OTP_HMAC_KEY', Rotasjon: 'gammel' });

    const r2 = await k.seedStandard('admin@x');
    const etter = rader.get(otpNokkel);
    sjekk('gammel tekst oppdateres', [r2.oppdatert, r2.lagtTil], [1, 0]);
    sjekk('ny rotasjonstekst', etter.Rotasjon, otp.Rotasjon);
    sjekk('utløpet står', etter.Utloper, '2027-11-16');
    sjekk('notatet står', etter.Notat, 'Avtalt med FS');
    sjekk('ansvarlig står', etter.Ansvarlig, 'jan@x');
    sjekk('varslingsfristen står', etter.VarsleDagerFor, 14);
    sjekk('varslingshistorikken står', [etter.SistVarslet, etter.SistVarsletTrinn], ['2026-11-01', '14']);
    sjekk('resten meldes', r2.utenforStandard, ['STORAGE_CONNECTION_STRING']);
    sjekk('og slettes ikke', rader.has(nokkel('prod', 'storage_connection_string')), true);
    sjekk('annet miljø urørt', rader.get(nokkel('production', otpId)).Rotasjon, 'gammel');

    // ---------- 4. tredje gang: ingenting å gjøre ----------
    const r3 = await k.seedStandard('admin@x');
    sjekk('tredje gang: alt uendret', [r3.lagtTil, r3.oppdatert, r3.hoppetOver], [0, 0, k.STANDARD.length]);

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
})().catch(e => { console.log('FEIL  testen kastet:', e.message, e.stack); process.exit(1); });
