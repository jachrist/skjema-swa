/**
 * Engangs-seeding av eksempelskjematyper for pilot-testing.
 *
 *   POST /api/seed-eksempel   — admin only, upsert av 3 test-skjematyper
 *
 * Idempotent: kan kjøres flere ganger uten side-effekter.
 * Kan slettes når editoren er på plass.
 */
const { app } = require('@azure/functions');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');
const skjemaStorage = require('../lib/skjema-storage');

function eksempler(adminUpn) {
    return [
        {
            Skjematype_id: '100',
            Skjema_navn: 'Reiseregning',
            Fase: 'Produksjon',
            Skjemaforklaring: {
                Innhold: 'Registrer utgifter etter tjenestereise. Krever kvitteringer som vedlegg.',
                Format: 'Tekst'
            },
            Publikum: { Personer: [adminUpn], Roller: [], Team: [] },
            Eiere: { Personer: [adminUpn], Roller: [], Team: [] },
            Seksjoner: [{
                Seksjon_nummer: 1,
                Seksjon_overskrift: 'Reise-informasjon',
                Felter: [
                    { Nummer: '01', Type: 'Tekst', Tekst: { Verdi: 'Formål', Format: 'Tekst' } },
                    { Nummer: '02', Type: 'Dato', Tekst: { Verdi: 'Reisedato', Format: 'Tekst' } }
                ]
            }]
        },
        {
            Skjematype_id: '101',
            Skjema_navn: 'Kursevaluering',
            Fase: 'Produksjon',
            Skjemaforklaring: {
                Innhold: 'Anonym tilbakemelding etter gjennomført kurs.',
                Format: 'Tekst'
            },
            Publikum: { Personer: [adminUpn], Roller: [], Team: [] },
            Eiere: { Personer: [adminUpn], Roller: [], Team: [] },
            Seksjoner: [{
                Seksjon_nummer: 1,
                Seksjon_overskrift: 'Vurdering',
                Felter: [
                    { Nummer: '01', Type: 'Skala', Tekst: { Verdi: 'Hvor fornøyd var du?', Format: 'Tekst' } }
                ]
            }]
        },
        {
            Skjematype_id: '102',
            Skjema_navn: 'Anskaffelsesforespørsel (utviklings-fase)',
            Fase: 'Utvikling',
            Skjemaforklaring: {
                Innhold: 'Skjematype under utvikling — kun synlig for admin.',
                Format: 'Tekst'
            },
            Publikum: { Personer: [adminUpn], Roller: [], Team: [] },
            Eiere: { Personer: [adminUpn], Roller: [], Team: [] },
            Seksjoner: [{
                Seksjon_nummer: 1,
                Seksjon_overskrift: 'Detaljer',
                Felter: [
                    { Nummer: '01', Type: 'Tekst', Tekst: { Verdi: 'Kort beskrivelse', Format: 'Tekst' } }
                ]
            }]
        }
    ];
}

app.http('seedEksempel', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'seed-eksempel',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        if (!erAdmin(upn)) return { status: 403, jsonBody: { status: 'avvist', melding: 'Krever admin-tilgang' } };

        try {
            const skjema = eksempler(upn);
            for (const s of skjema) {
                await skjemaStorage.lagreSkjematype(s);
            }
            context.log(`seed-eksempel: ${upn} seedet ${skjema.length} skjematyper`);
            return {
                jsonBody: {
                    status: 'ok',
                    antall: skjema.length,
                    ider: skjema.map(s => s.Skjematype_id)
                }
            };
        } catch (e) {
            context.log('seed-eksempel FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});
