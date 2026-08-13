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
            const fd = await request.formData();
            const fil = fd.get('fil');
            if (!fil || typeof fil === 'string') {
                return { status: 400, jsonBody: { status: 'feil', melding: 'Mangler fil (multipart-felt "fil")' } };
            }
            const contentType = fil.type || '';
            const filnavn = fil.name || 'ukjent';
            if (!(contentType.startsWith('image/') || contentType === 'application/pdf')) {
                return { status: 400, jsonBody: { status: 'feil', melding: `Ustøttet filtype: ${contentType || '(mangler)'} — bruk bilde eller PDF` } };
            }
            const buffer = Buffer.from(await fil.arrayBuffer());
            if (buffer.length > MAKS_STORRELSE) {
                return { status: 413, jsonBody: { status: 'feil', melding: `For stor fil (${Math.round(buffer.length / 1024 / 1024)} MB, maks ${MAKS_STORRELSE / 1024 / 1024} MB)` } };
            }

            // Bygg Claude-payload. PDF og bilder har litt ulikt format i vision-API.
            const b64 = buffer.toString('base64');
            const kildeType = contentType === 'application/pdf' ? 'document' : 'image';
            const innhold = [
                {
                    type: kildeType,
                    source: { type: 'base64', media_type: contentType, data: b64 }
                },
                { type: 'text', text: PROMPT }
            ];

            context.log(`ai/analyser-skjema: ${upn} sender ${filnavn} (${buffer.length} bytes, ${contentType}) til ${modell}`);
            const resp = await fetch('https://api.anthropic.com/v1/messages', {
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
                })
            });

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
