const { app } = require('@azure/functions');
const { tabellKlient } = require('../lib/storage');
const { containerKlient } = require('../lib/blob');
const { hentInnloggetUpn } = require('../lib/auth');

/**
 * GET /api/hello-storage — ende-til-ende-bevis at Table + Blob + Managed Identity fungerer.
 *
 * Skriver én rad til Table Storage og én blob til Blob Storage,
 * leser deretter tilbake de siste 10 radene. Ingen skjema-logikk —
 * kun kjeden.
 *
 * Autentisert (SWA setter x-ms-client-principal).
 */
app.http('helloStorage', {
    methods: ['GET'],
    authLevel: 'anonymous', // SWA gjør auth i sitt lag før request når hit
    route: 'hello-storage',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request) || 'anonym';
        const naa = new Date().toISOString();

        try {
            // Table: skriv rad
            const tabell = tabellKlient('HelloTest');
            try { await tabell.createTable(); } catch (_) { /* fins fra før */ }
            await tabell.upsertEntity({
                partitionKey: 'test',
                rowKey: `${upn}-${Date.now()}`,
                bruker: upn,
                tidspunkt: naa
            }, 'Merge');

            // Blob: skriv liten testfil
            const container = containerKlient('hello-test');
            await container.createIfNotExists();
            const blobNavn = `hei-${Date.now()}.txt`;
            const blob = container.getBlockBlobClient(blobNavn);
            const innhold = `Hei fra ${upn} kl ${naa}`;
            await blob.upload(innhold, Buffer.byteLength(innhold));

            // Les tilbake siste 10 rader
            const siste = [];
            for await (const r of tabell.listEntities()) {
                siste.push({ bruker: r.bruker, tidspunkt: r.tidspunkt });
                if (siste.length >= 10) break;
            }

            return {
                jsonBody: {
                    status: 'ok',
                    bruker: upn,
                    tid: naa,
                    skrev_blob: blobNavn,
                    siste_10_i_tabell: siste
                }
            };
        } catch (e) {
            context.log('hello-storage FEIL:', e.message, e.stack);
            return {
                status: 500,
                jsonBody: { status: 'feil', melding: e.message }
            };
        }
    }
});
