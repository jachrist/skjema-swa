/**
 * POST /api/ai/analyser-skjema
 *
 * Analyserer et bilde eller PDF av et papirskjema og returnerer en
 * skjemadefinisjon (JSON). Bruker Anthropic Claude vision.
 *
 * Auth: admin eller medlem av rollen 'Skjemaskaper' (samme regel som
 * POST /api/skjematyper).
 *
 * Body: multipart/form-data med 'fil' (image/* eller application/pdf).
 * Maks 20 MB (Claude accepterer opptil 32 MB base64, vi setter lavere
 * grense for å beskytte mot uheldig bruk).
 *
 * Returnerer: { status: 'ok', skjema: { Skjema_navn, Seksjoner: [...] },
 *               tokens: { input, output } }
 *
 * Env-vars:
 *   ANTHROPIC_API_KEY   — påkrevd (KV-referanse anbefalt)
 *   ANTHROPIC_MODELL    — valgfri, default 'claude-sonnet-5-20260201'
 */
const { app } = require('@azure/functions');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');
const rollerStorage = require('../lib/roller-storage');
const hendelser = require('../lib/hendelser-storage');

const MAKS_STORRELSE = 20 * 1024 * 1024;
const DEFAULT_MODELL = 'claude-sonnet-5-20260201';

const PROMPT = `Analyser det vedlagte skjemaet/spørreskjemaet og konverter det til JSON-strukturen under.

Regler:
1. Identifiser alle seksjoner (grupper av relaterte spørsmål). Hvis dokumentet ikke er tydelig seksjonert, lag én seksjon.
2. For hvert felt/spørsmål, velg riktig type:
   - "Informasjon": Bare tekst som vises, ingen input
   - "Tekst": Fritekstfelt. Sett "Flerlinje": true for lengre svar
   - "Tall": Numerisk input. Sett Min_verdi/Max_verdi hvis det er åpenbart
   - "Skala": Likert-skala eller rating (f.eks. 1-5, 1-10). Legg til Valg-array
   - "Flervalg-dropdown": Nedtrekksmeny med mange alternativer
   - "Flervalg-knapper": Avkrysningsbokser/radioknapper med få alternativer
   - "Opplasting": Filopplasting
   - "Dato", "Tidspunkt": For dato-/klokkeslett-felter
   - "E-post", "Fodselsnummer", "Kontonummer", "Postnummer": For spesifikke formatkontroller
3. Sett Max_valg for Flervalg-knapper (1 for enkeltvalg, høyere for flervalg)
4. Sett Obligatorisk: true for felt som ser påkrevde ut (markert med * eller "påkrevd")
5. Nummerer felter med "01", "02", osv. per seksjon
6. Bruk norsk i alle tekster (oversett hvis originalen er engelsk)

Returner BARE gyldig JSON i dette formatet (ingen forklaring, ingen markdown-code-fences):
{
  "Skjema_navn": "Kort navn på skjemaet",
  "Skjemaforklaring": { "Format": "Tekst", "Innhold": "Beskrivelse hvis den finnes" },
  "Seksjoner": [
    {
      "Seksjon_nummer": 1,
      "Seksjon_overskrift": "Seksjonstittel",
      "Felter": [
        {
          "Nummer": "01",
          "Tekst": { "Format": "Tekst", "Verdi": "Spørsmålstekst" },
          "Type": "Tekst",
          "Obligatorisk": false,
          "Flerlinje": false,
          "Min_verdi": 0,
          "Max_verdi": 100,
          "Max_valg": 1,
          "Valg": [ { "Valg_nr": 1, "Tekst": "Alternativ" } ]
        }
      ]
    }
  ]
}

Ta med bare de feltene som er relevante for hver type (f.eks. ingen Valg for Tekst-felt).`;

/**
 * POST /api/ai/diag — minimal Anthropic-test uten multipart-håndtering.
 * Sender en tekst-hilsen og returnerer respons + timing. Brukes til å
 * verifisere at ANTHROPIC_API_KEY, nettverk mot api.anthropic.com og
 * global fetch alle fungerer i miljøet.
 */
app.http('aiDiag', {
    methods: ['POST', 'GET'],
    authLevel: 'anonymous',
    route: 'ai/diag',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        if (!erAdmin(upn)) return { status: 403, jsonBody: { status: 'feil', melding: 'Krever admin' } };

        const apiKey = String(process.env.ANTHROPIC_API_KEY || '').trim();
        const modell = String(process.env.ANTHROPIC_MODELL || DEFAULT_MODELL).trim();
        const trinn = [];
        const start = Date.now();
        const merk = (navn, ekstra) => trinn.push({ trinn: navn, ms: Date.now() - start, ...(ekstra || {}) });

        try {
            merk('start', {
                node: process.version,
                harFetch: typeof fetch === 'function',
                modell,
                apiKeyLengde: apiKey.length,
                apiKeyPrefiks: apiKey.slice(0, 8)
            });

            if (!apiKey) {
                return { status: 503, jsonBody: { status: 'feil', melding: 'ANTHROPIC_API_KEY ikke satt', trinn } };
            }

            const controller = new AbortController();
            const timeoutHandle = setTimeout(() => controller.abort(), 30_000);
            let resp;
            try {
                resp = await fetch('https://api.anthropic.com/v1/messages', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': apiKey,
                        'anthropic-version': '2023-06-01'
                    },
                    body: JSON.stringify({
                        model: modell,
                        max_tokens: 100,
                        messages: [{ role: 'user', content: 'Svar med kun ordet OK.' }]
                    }),
                    signal: controller.signal
                });
                merk('fetch fullført', { status: resp.status });
            } catch (fe) {
                clearTimeout(timeoutHandle);
                merk('fetch feilet', { navn: fe.name, melding: fe.message });
                return { status: 504, jsonBody: { status: 'feil', melding: `${fe.name}: ${fe.message}`, trinn } };
            }
            clearTimeout(timeoutHandle);

            const tekst = await resp.text();
            merk('response lest', { bytes: tekst.length });

            let json = null;
            try { json = JSON.parse(tekst); merk('json parset'); }
            catch (pe) { merk('json parse feilet', { melding: pe.message }); }

            return {
                jsonBody: {
                    status: resp.ok ? 'ok' : 'feil',
                    httpStatus: resp.status,
                    svar: json?.content?.[0]?.text || tekst.slice(0, 500),
                    tokens: json?.usage || null,
                    trinn,
                    modell
                }
            };
        } catch (e) {
            context.log('ai/diag EXCEPTION:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message, trinn, stack: (e.stack || '').split('\n').slice(0, 6) } };
        }
    }
});

app.http('aiAnalyserSkjema', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'ai/analyser-skjema',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };

        // Samme regel som opprett-skjematype: admin eller medlem av 'Skjemaskaper'
        const admin = erAdmin(upn);
        const skjemaskaper = admin || await rollerStorage.erMedlem('Skjemaskaper', upn).catch(() => false);
        if (!skjemaskaper) return { status: 403, jsonBody: { status: 'feil', melding: 'Krever admin eller rollen "Skjemaskaper"' } };

        const apiKey = String(process.env.ANTHROPIC_API_KEY || '').trim();
        if (!apiKey) return { status: 503, jsonBody: { status: 'feil', melding: 'ANTHROPIC_API_KEY er ikke satt i backend' } };
        const modell = String(process.env.ANTHROPIC_MODELL || DEFAULT_MODELL).trim();

        try {
            // Godta både multipart/form-data OG JSON { filnavn, contentType, base64 }.
            // JSON-varianten er mer robust på tvers av Azure Functions-runtime-versjoner —
            // vi opplevde at multipart-parsing feilte i prod-SWA med 500 uten JSON-respons.
            const reqCt = String(request.headers.get('content-type') || '').toLowerCase();
            let contentType, filnavn, buffer;

            // Multi-image-modus: JSON kan sende { filnavn, bilder: [{contentType, base64}] }
            // Brukes når klient har konvertert PDF til side-bilder med pdf.js.
            let bilderInn = null;

            if (reqCt.includes('application/json')) {
                const body = await request.json();
                filnavn = String(body?.filnavn || 'ukjent');
                if (Array.isArray(body?.bilder) && body.bilder.length > 0) {
                    // Multi-image
                    bilderInn = body.bilder.map(b => ({
                        contentType: String(b?.contentType || 'image/png'),
                        buffer: Buffer.from(String(b?.base64 || ''), 'base64')
                    })).filter(b => b.buffer.length > 0);
                    if (bilderInn.length === 0) return { status: 400, jsonBody: { status: 'feil', melding: 'Ingen gyldige bilder i "bilder"-array' } };
                    contentType = 'multi-image';
                    buffer = Buffer.concat(bilderInn.map(b => b.buffer));
                } else {
                    contentType = String(body?.contentType || '').toLowerCase();
                    const b64Inn = String(body?.base64 || '');
                    if (!b64Inn) return { status: 400, jsonBody: { status: 'feil', melding: 'Mangler base64-felt eller bilder-array i body' } };
                    try { buffer = Buffer.from(b64Inn, 'base64'); }
                    catch (e) { return { status: 400, jsonBody: { status: 'feil', melding: 'Ugyldig base64: ' + e.message } }; }
                }
            } else {
                const fd = await request.formData();
                const fil = fd.get('fil');
                if (!fil || typeof fil === 'string') {
                    return { status: 400, jsonBody: { status: 'feil', melding: 'Mangler fil (multipart-felt "fil") eller JSON-body med base64' } };
                }
                contentType = fil.type || '';
                filnavn = fil.name || 'ukjent';
                buffer = Buffer.from(await fil.arrayBuffer());
            }

            if (!(contentType === 'multi-image' || contentType.startsWith('image/') || contentType === 'application/pdf')) {
                return { status: 400, jsonBody: { status: 'feil', melding: `Ustøttet filtype: ${contentType || '(mangler)'} — bruk bilde eller PDF` } };
            }
            if (buffer.length > MAKS_STORRELSE) {
                return { status: 413, jsonBody: { status: 'feil', melding: `For stor fil (${Math.round(buffer.length / 1024 / 1024)} MB, maks ${MAKS_STORRELSE / 1024 / 1024} MB)` } };
            }

            // Bygg Claude-payload.
            let innhold;
            if (bilderInn) {
                // Multi-image (PDF konvertert til side-bilder klientside)
                innhold = [
                    ...bilderInn.map(b => ({
                        type: 'image',
                        source: { type: 'base64', media_type: b.contentType, data: b.buffer.toString('base64') }
                    })),
                    { type: 'text', text: PROMPT + '\n\nMerk: Dette er flere sider fra samme skjema — kombiner innholdet til én samlet definisjon.' }
                ];
            } else {
                const b64 = buffer.toString('base64');
                const kildeType = contentType === 'application/pdf' ? 'document' : 'image';
                innhold = [
                    { type: kildeType, source: { type: 'base64', media_type: contentType, data: b64 } },
                    { type: 'text', text: PROMPT }
                ];
            }

            context.log(`ai/analyser-skjema: ${upn} sender ${filnavn} (${buffer.length} bytes, ${contentType}) til ${modell}`);
            const start = Date.now();
            const controller = new AbortController();
            const timeoutMs = 90_000;
            const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
            let resp;
            try {
                resp = await fetch('https://api.anthropic.com/v1/messages', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': apiKey,
                        'anthropic-version': '2023-06-01'
                    },
                    body: JSON.stringify({
                        model: modell,
                        max_tokens: 8192,
                        messages: [{ role: 'user', content: innhold }]
                    }),
                    signal: controller.signal
                });
            } catch (fe) {
                clearTimeout(timeoutHandle);
                const varighet = Date.now() - start;
                context.log(`ai/analyser-skjema: fetch feilet etter ${varighet}ms — ${fe.name}: ${fe.message}`);
                const melding = fe.name === 'AbortError'
                    ? `Anthropic svarte ikke innen ${timeoutMs / 1000}s (aborted)`
                    : `Nettverksfeil mot Anthropic: ${fe.name}: ${fe.message}`;
                return { status: 504, jsonBody: { status: 'feil', melding, varighetMs: varighet } };
            }
            clearTimeout(timeoutHandle);
            context.log(`ai/analyser-skjema: fetch OK etter ${Date.now() - start}ms, HTTP ${resp.status}`);

            if (!resp.ok) {
                const feilTekst = await resp.text().catch(() => '');
                context.log(`ai/analyser-skjema: Claude returnerte ${resp.status}: ${feilTekst.slice(0, 400)}`);
                return {
                    status: resp.status === 401 ? 500 : resp.status,
                    jsonBody: {
                        status: 'feil',
                        melding: resp.status === 401
                            ? 'Anthropic avviste API-nøkkelen — sjekk ANTHROPIC_API_KEY i Configuration'
                            : `Anthropic HTTP ${resp.status}: ${feilTekst.slice(0, 300)}`
                    }
                };
            }

            const data = await resp.json();
            const aiTekst = data?.content?.[0]?.text || '';
            const tokens = { input: data?.usage?.input_tokens || 0, output: data?.usage?.output_tokens || 0 };

            // Parse JSON — kan være wrapped i markdown-code-fences hvis modellen ignorerer instruksjonen
            let skjema;
            try {
                const match = aiTekst.match(/\{[\s\S]*\}/);
                if (!match) throw new Error('Ingen JSON i AI-responsen');
                skjema = JSON.parse(match[0]);
            } catch (e) {
                context.log(`ai/analyser-skjema: kunne ikke parse: ${e.message}. Rå: ${aiTekst.slice(0, 500)}`);
                return { status: 502, jsonBody: { status: 'feil', melding: `Kunne ikke parse AI-respons: ${e.message}`, rå: aiTekst.slice(0, 1000) } };
            }

            hendelser.logg({
                Type: 'ai.analyser-skjema',
                Aktor: upn,
                ObjektType: 'ai',
                ObjektId: filnavn,
                Melding: `AI-analyse av ${filnavn} (${Math.round(buffer.length / 1024)} KB) — ${skjema?.Seksjoner?.length || 0} seksjoner, ${(skjema?.Seksjoner || []).reduce((s, sek) => s + (sek.Felter?.length || 0), 0)} felt`,
                Detaljer: { filnavn, storrelseBytes: buffer.length, contentType, modell, tokens }
            });

            return { jsonBody: { status: 'ok', skjema, tokens } };
        } catch (e) {
            context.log('ai/analyser-skjema FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});
