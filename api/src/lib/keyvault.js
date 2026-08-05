/**
 * Key Vault-hemmeligheter med Managed Identity.
 *
 * Krever at appens managed identity har rollen "Key Vault Secrets User"
 * på Key Vault-ressursen.
 *
 * Cache: hemmeligheter caches i minne i 5 minutter. Ved rotasjon kan appen
 * restartes for umiddelbar effekt, ellers refreshes automatisk innen 5 min.
 */
const { SecretClient } = require('@azure/keyvault-secrets');
const { DefaultAzureCredential } = require('@azure/identity');

const kvNavn = process.env.KEYVAULT_NAME;
const CACHE_MS = 5 * 60 * 1000;

let client = null;
const cache = new Map(); // navn → { value, hentet }

function kv() {
    if (!kvNavn) throw new Error('KEYVAULT_NAME env-var mangler');
    if (!client) {
        client = new SecretClient(
            `https://${kvNavn}.vault.azure.net`,
            new DefaultAzureCredential()
        );
    }
    return client;
}

async function hentHemmelighet(navn) {
    const naa = Date.now();
    const cachet = cache.get(navn);
    if (cachet && naa - cachet.hentet < CACHE_MS) return cachet.value;

    const svar = await kv().getSecret(navn);
    cache.set(navn, { value: svar.value, hentet: naa });
    return svar.value;
}

function tomCache() {
    cache.clear();
}

module.exports = { hentHemmelighet, tomCache };
