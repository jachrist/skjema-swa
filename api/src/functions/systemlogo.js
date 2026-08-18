/**
 * Systemmerking — logo + graderingsadvarsel som vises øverst til venstre på
 * alle sider.
 *
 *   GET /api/systemlogo — { url, tittel, advarsel } (anonymous)
 *
 * Anonymt fordi utfyllingssiden også brukes av eksterne respondenter via OTP,
 * og advarselen om at data må være ugraderte er nettopp da viktigst å få frem.
 * Innholdet er ikke sensitivt: et logo-filnavn og to faste tekster.
 *
 * Verdiene ligger i SystemInnstillinger og settes fra admin-panelet:
 *   SystemLogo      — filnavn i logo-containeren (tom = ingen logo)
 *   SystemTittel    — standard "FHS Skjemasystem"
 *   SystemAdvarsel  — standard "Kun ugraderte data"
 */
const { app } = require('@azure/functions');
const innstillinger = require('../lib/innstillinger-storage');

const STANDARD_TITTEL = 'FHS Skjemasystem';
const STANDARD_ADVARSEL = 'Kun ugraderte data';

app.http('systemlogoHent', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'systemlogo',
    handler: async (request, context) => {
        try {
            const [logo, tittel, advarsel] = await Promise.all([
                innstillinger.hent('SystemLogo'),
                innstillinger.hent('SystemTittel'),
                innstillinger.hent('SystemAdvarsel')
            ]);
            const filnavn = (logo?.Verdi || '').trim();
            return {
                jsonBody: {
                    url: filnavn ? `/api/logo/${encodeURIComponent(filnavn)}` : '',
                    filnavn,
                    tittel: (tittel?.Verdi || '').trim() || STANDARD_TITTEL,
                    advarsel: (advarsel?.Verdi || '').trim() || STANDARD_ADVARSEL
                }
            };
        } catch (e) {
            // Merkingen skal aldri velte en side — fall tilbake til tekstvarianten.
            context.log('systemlogo GET FEIL:', e.message);
            return { jsonBody: { url: '', filnavn: '', tittel: STANDARD_TITTEL, advarsel: STANDARD_ADVARSEL } };
        }
    }
});
