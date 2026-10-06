/**
 * POST /api/skjemaer/{skjematypeId}/import
 *
 * Importerer rader fra et regneark som skjemaer av skjematypen. Samme jobb som
 * `scripts/importer-skjemaer.js`, og NØYAKTIG de samme reglene: begge kaller
 * `lib/skjema-import.lagPlan`. En import kjørt herfra og en kjørt fra
 * terminalen gir samme resultat på samme fil.
 *
 * Multipart med `fil`, og valgfritt:
 *   bekreft      'true' utfører. Uten den er kallet en tørrkjøring.
 *   nokkelfelt   kolonnen som identifiserer raden — gjør kjøringen idempotent
 *   beslutning   utfallet som skrives på behandlingsstegene
 *   kommentar    begrunnelse på de avgjorte stegene
 *   status       5 (avsluttet, standard) eller 2 (til behandling)
 *   kolonner     JSON: { "kolonneoverskrift": "1-03" }
 *   verdier      JSON: { "TJENESTLIG": "TJENSTLIG" }
 *   skilletegn   for celler med flere verdier (standard «/»)
 *   utenBehandling 'true' — radene står uten behandling, med vitende vilje
 *
 * Tilgang: eier på skjematypen eller admin. Ikke bare admin: den som
 * forvalter et register er eier av skjematypen, og skal kunne fylle det uten
 * å gå via noen andre.
 *
 * Varsling går IKKE ut. Importen skriver direkte, forbi `lagreSkjema`-
 * endepunktet, nettopp fordi 270 rader gjennom den vanlige veien ville sendt
 * 270 e-poster.
 */
const { app } = require('@azure/functions');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');
const skjemaStorage = require('../lib/skjema-storage');
const forekomstStorage = require('../lib/skjema-forekomst-storage');
const { filtrerTyperPåTilgang } = require('../lib/tilgang');
const { genererSkjemaId } = require('../lib/skjema-id');
const hendelser = require('../lib/hendelser-storage');
const imp = require('../lib/skjema-import');

const MAKS_IMPORTFIL = 5 * 1024 * 1024;

async function harEierTilgang(skjematypeId, upn) {
    if (erAdmin(upn)) return true;
    const st = await skjemaStorage.hentSkjematype(skjematypeId);
    if (!st) return false;
    const treff = await filtrerTyperPåTilgang([st], upn, 'Eiere');
    return treff.length > 0;
}

/** JSON fra et skjemafelt. En skrivefeil her skal si HVILKET felt. */
function lesJsonFelt(formData, navn) {
    const rå = String(formData.get(navn) || '').trim();
    if (!rå) return {};
    try {
        const o = JSON.parse(rå);
        if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('må være et objekt');
        return o;
    } catch (e) {
        throw new Error(`Feltet "${navn}" er ikke gyldig JSON: ${e.message}`);
    }
}

app.http('importerSkjemaer', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'skjemaer/{skjematypeId}/import',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };

        const skjematypeId = String(request.params.skjematypeId || '');
        if (!(await harEierTilgang(skjematypeId, upn))) {
            return { status: 403, jsonBody: { status: 'avvist', melding: 'Krever eier-tilgang på skjematypen' } };
        }

        try {
            const formData = await request.formData();
            const fil = formData.get('fil');
            if (!fil || typeof fil === 'string') {
                return { status: 400, jsonBody: { status: 'feil', melding: 'Ingen fil sendt (må hete "fil")' } };
            }
            const buffer = Buffer.from(await fil.arrayBuffer());
            if (buffer.length > MAKS_IMPORTFIL) {
                return { status: 413, jsonBody: { status: 'feil', melding: `For stor fil (maks ${MAKS_IMPORTFIL / 1024 / 1024} MB)` } };
            }

            const bekreft = String(formData.get('bekreft') || '') === 'true';
            const status = Number(formData.get('status')) === 2 ? 2 : 5;
            const beslutning = String(formData.get('beslutning') || '').trim();
            const kommentar = String(formData.get('kommentar') || '');
            const utenBehandling = String(formData.get('utenBehandling') || '') === 'true';

            const st = await skjemaStorage.hentSkjematype(skjematypeId);
            if (!st?.JSON) return { status: 404, jsonBody: { status: 'feil', melding: `Fant ingen skjematype ${skjematypeId}` } };
            const def = st.JSON;

            // Utfallet avklares før fila leses — samme rekkefølge som i skriptet.
            imp.krevBeslutning(def, {
                status, beslutning, utenBehandling, behandletAv: upn,
                hjelp: 'Velg et utfall, kryss av for «uten behandling», eller sett status til «Til behandling».'
            });

            const opsjoner = {
                kolonner: lesJsonFelt(formData, 'kolonner'),
                verdier: lesJsonFelt(formData, 'verdier'),
                skilletegn: String(formData.get('skilletegn') || '') || '/',
                nokkelfelt: String(formData.get('nokkelfelt') || '').trim()
            };
            // Eksisterende rader hentes bare når det finnes et nøkkelfelt å
            // sammenligne med. Uten det er lesingen bortkastet.
            const eksisterende = opsjoner.nokkelfelt
                ? await forekomstStorage.hentAlleSkjemaerForType(skjematypeId)
                : [];

            const plan = imp.lagPlan({
                matrise: imp.lesMatrise(buffer, fil.name), def, eksisterende, opsjoner
            });

            const sammendrag = {
                lest: plan.rader.length + plan.hoppet.length,
                nye: plan.rader.length,
                finnesFraFor: plan.hoppet.length,
                feil: plan.feil.length,
                ulikeFeil: plan.grupper.length
            };
            // Alltid med, også når den er tom — en nøkkel som kan forsvinne
            // kan ikke feilsøkes.
            const forhåndsvisning = {
                status: 'forhandsvisning',
                filnavn: fil.name,
                skjemanavn: def.Skjema_navn || '',
                overskriftsrad: plan.linje + 1,
                kobling: plan.kobling.map(k => ({
                    overskrift: k.overskrift, nokkel: k.felt.nokkel,
                    etikett: k.felt.etikett, beskrivelse: imp.beskrivFelt(k.felt)
                })),
                ukoblede: plan.ukoblede,
                ledige: plan.ledige.map(f => ({ nokkel: f.nokkel, etikett: f.etikett, beskrivelse: imp.beskrivFelt(f) })),
                nokkelfelt: plan.nokkelFelt ? { nokkel: plan.nokkelFelt.nokkel, etikett: plan.nokkelFelt.etikett } : null,
                grupper: plan.grupper,
                eksempler: {
                    nye: plan.rader.slice(0, 10).map(r => ({ radNr: r.radNr, svar: r.svar })),
                    finnesFraFor: plan.hoppet.slice(0, 10)
                },
                sammendrag
            };

            if (!bekreft) return { jsonBody: forhåndsvisning };

            // Feil stopper utførelsen. Tørrkjøringen har alt vist dem; her er
            // det siste sperre før 270 rader skrives.
            if (plan.feil.length > 0) {
                return { status: 400, jsonBody: { ...forhåndsvisning, status: 'feil',
                    melding: `${plan.grupper.length} verdi(er) må rettes først` } };
            }
            if (plan.rader.length === 0) {
                return { jsonBody: { ...forhåndsvisning, status: 'ok', melding: 'Ingenting å importere' } };
            }

            const harBehandling = Array.isArray(def.Behandling) && def.Behandling.length > 0;
            const arvBehandling = status === 2 && harBehandling;
            const naa = new Date().toISOString();
            let skrevet = 0;
            for (const r of plan.rader) {
                const skjema = {
                    Skjema_id: await genererSkjemaId(skjematypeId),
                    Skjematype_id: skjematypeId,
                    Skjema_navn: def.Skjema_navn || '',
                    Innsender_Epost: upn,
                    Innsender_Navn: '',
                    Skjema_status: status,
                    Seksjoner: imp.byggSeksjoner(def, new Map(Object.entries(r.svar))),
                    // Si høyt hvor radene kom fra. «Importert» og «sendt inn av
                    // et menneske» skal kunne skilles i ettertid.
                    Importert: { Fra: fil.name, Rad: r.radNr, Tidspunkt: naa, Av: upn }
                };
                if (arvBehandling) {
                    skjema.Behandling = JSON.parse(JSON.stringify(def.Behandling)).map(s => ({ ...s, Beslutning: 0 }));
                } else if (harBehandling && beslutning) {
                    skjema.Behandling = imp.byggFerdigBehandling(def, beslutning, upn, naa, kommentar);
                }
                await forekomstStorage.lagreSkjema(skjema, true);
                skrevet++;
            }

            context.log(`skjema-import: ${upn} importerte ${skrevet} rader til ${skjematypeId} fra "${fil.name}"`);
            hendelser.logg({
                Type: 'skjema.import', Aktor: upn,
                ObjektType: 'skjematype', ObjektId: skjematypeId,
                Melding: `Importerte ${skrevet} skjema fra "${fil.name}"`,
                Detaljer: { sammendrag, status, beslutning: beslutning || null, filnavn: fil.name }
            });
            return { jsonBody: { ...forhåndsvisning, status: 'ok', skrevet } };
        } catch (e) {
            context.log('skjema-import FEIL:', e.message);
            return { status: 400, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});
