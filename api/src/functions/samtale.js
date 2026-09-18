/**
 * Samtale — gruppechat mellom innsender og behandlere på én sak.
 *
 *   GET  /api/skjemaer/{skjematypeId}/{skjemaId}/samtale?etter={id}
 *   POST /api/skjemaer/{skjematypeId}/{skjemaId}/samtale          { tekst }
 *   POST /api/skjemaer/{skjematypeId}/{skjemaId}/samtale/demping  { dempet }
 *
 * `etter` er pollingens hele poeng: klienten spør om det som har kommet siden
 * sist, ikke om hele tråden hvert tiende sekund. SWA Managed Functions har
 * hverken WebSockets eller SignalR, så polling er det vi har.
 *
 * Alt en deltaker skriver, ser alle deltakerne. Det finnes ingen intern-modus
 * her, og det er bestemt (docs/FASE-SAMTALE.md): finnes det ikke et skjult
 * modus, kan ingen tro at de er i det.
 *
 * Tre autentiseringsveier, som ellers i skjema-API-et — SWA-cookie,
 * OTP-token og utsendings-token. Reglene ligger i `lib/ekstern-auth.js`, ikke
 * her.
 */
const { app } = require('@azure/functions');
const { hentInnloggetUpn } = require('../lib/auth');
const { velgAuthvei, autentiserEkstern, eksternInnsenderUpn } = require('../lib/ekstern-auth');
const forekomstStorage = require('../lib/skjema-forekomst-storage');
const skjemaStorage = require('../lib/skjema-storage');
const samtaleStorage = require('../lib/samtale-storage');
const samtaleTilgang = require('../lib/samtale-tilgang');
const utsendingToken = require('../lib/utsending-token');
const brukernavn = require('../lib/brukernavn-storage');
const varsling = require('../lib/varsling');

const RUTE = 'skjemaer/{skjematypeId}/{skjemaId}/samtale';

function avvis(status, melding) {
    return { status, jsonBody: { status: status === 403 ? 'avvist' : 'feil', melding } };
}

/**
 * Finn saken og deltakeren, eller et ferdig svar som skal returneres.
 *
 * Felles for alle tre endepunktene. Ligger her og ikke i tre kopier — det er
 * den samme feilen som lot interne dialog-innlegg slippe ut i PDF-en: én regel
 * som bare fantes ett av stedene den gjaldt.
 */
async function finnSakOgDeltaker(request, context) {
    const { skjematypeId, skjemaId } = request.params;
    const upn = hentInnloggetUpn(request);

    const skjema = await forekomstStorage.hentSkjema(skjemaId, skjematypeId);
    if (!skjema) return { svar: avvis(404, 'Skjema ikke funnet') };

    let eksternId = null;
    let kilde = 'swa';
    const vei = velgAuthvei(request, upn);

    if (vei === 'utsending') {
        const v = utsendingToken.valider(request.headers.get('x-utsending-token'));
        if (!v?.gyldig) return { svar: avvis(401, v?.melding || 'Ugyldig utsendingslenke') };
        // Tokenet er utstedt for én skjematype. Uten denne sjekken kunne et
        // gyldig token brukes mot en annen type — og selv om innsender-matchen
        // under ville stoppet det i praksis, er det ikke den sjekken som er
        // ment å bære det.
        if (v.skjematypeId && String(v.skjematypeId) !== String(skjematypeId)) {
            return { svar: avvis(403, 'Lenken gjelder en annen skjematype') };
        }
        // Rått mottaker-felt, ikke eksternInnsenderUpn: det er slik
        // `lagreSkjema` skriver Innsender_Epost for utsendinger, og de to må
        // stemme overens for at innsenderen skal kjenne igjen sin egen sak.
        eksternId = v.mottaker;
        kilde = 'utsending';
    } else if (vei === 'ekstern') {
        const forsøk = await autentiserEkstern(request, skjematypeId);
        // Ugyldig token, men innlogget: behandle som vanlig bruker. Samme
        // mønster som lagreSkjema.
        if (forsøk.ok) {
            eksternId = eksternInnsenderUpn(forsøk.mottaker, forsøk.kanal);
            kilde = 'otp';
        } else if (!upn) {
            return { svar: avvis(401, forsøk.melding || 'Ikke innlogget') };
        }
    }

    // Navnet er til visning i tråden. Eksterne har ikke noe vi kjenner —
    // `byggKontekst`-mønsteret gjelder her også: adressen er mindre pen enn et
    // navn, og alltid sann.
    let navn = '';
    if (!eksternId && upn) {
        try { navn = (await brukernavn.losNavn(request, upn)).navn || ''; }
        catch (_) { /* best-effort — et manglende navn skal ikke stoppe et innlegg */ }
    }

    const deltaker = await samtaleTilgang.finnDeltaker({
        skjema, skjematypeId, upn, eksternId, navn, kilde
    });
    if (!deltaker) {
        context.log(`samtale: avvist for ${eksternId || upn || '(anonym)'} på ${skjematypeId}/${skjemaId}`);
        return { svar: avvis(403, 'Ingen tilgang til denne samtalen') };
    }

    // Innstillingen bor på skjematypen, ikke på skjemaet. Uten behandlingssteg
    // svarer den 'Av' uansett hva som står lagret.
    const st = await skjemaStorage.hentSkjematype(skjematypeId);
    const innstilling = samtaleTilgang.samtaleInnstilling(st?.JSON || null);
    if (innstilling === 'Av') {
        return { svar: avvis(404, 'Denne skjematypen har ikke samtale') };
    }

    return { skjema, skjematypeId, skjemaId, deltaker, innstilling };
}

app.http('samtaleHent', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: RUTE,
    handler: async (request, context) => {
        try {
            const funn = await finnSakOgDeltaker(request, context);
            if (funn.svar) return funn.svar;

            const etter = request.query.get('etter') || '';
            const innlegg = await samtaleStorage.hentInnlegg(funn.skjematypeId, funn.skjemaId, { etter });

            // Ved polling er `innlegg` bare det nye, og da sier lengden
            // ingenting om tråden. Antallet må hentes for seg — ellers ville en
            // innsender som poller mistet skriveretten så snart svaret var
            // tomt.
            const antallInnlegg = etter
                ? (await samtaleStorage.sammendrag(funn.skjematypeId, funn.skjemaId)).Antall
                : innlegg.length;

            const apen = samtaleTilgang.samtaleErAapen(funn.skjema);
            const rolle = funn.deltaker.rolle;
            const grunnlag = { rolle, innstilling: funn.innstilling, antallInnlegg, apen };

            return {
                jsonBody: {
                    innlegg,
                    antallInnlegg,
                    // Klienten trenger alle tre for å tegne riktig: en lukket
                    // samtale skal vises uten skrivefelt, og en tom samtale
                    // innsenderen ikke kan starte skal ikke vises i det hele
                    // tatt.
                    apen,
                    synlig: samtaleTilgang.samtaleErSynlig(grunnlag),
                    kanSkrive: samtaleTilgang.kanSkrive(grunnlag),
                    minRolle: rolle,
                    kanDempe: samtaleTilgang.kanDempe(rolle),
                    dempet: samtaleTilgang.kanDempe(rolle)
                        ? await samtaleStorage.erDempet(funn.skjematypeId, funn.skjemaId, funn.deltaker.id)
                        : false
                }
            };
        } catch (e) {
            context.log('samtale GET FEIL:', e.message);
            return avvis(500, 'Kunne ikke hente samtalen');
        }
    }
});

app.http('samtaleSkriv', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: RUTE,
    handler: async (request, context) => {
        try {
            const funn = await finnSakOgDeltaker(request, context);
            if (funn.svar) return funn.svar;

            if (!samtaleTilgang.samtaleErAapen(funn.skjema)) {
                return avvis(409, 'Samtalen er lukket fordi saken er avsluttet');
            }

            // Hvem som kan skrive det FØRSTE innlegget avgjøres av
            // skjematypen. Sjekken gjøres her og ikke bare i grensesnittet:
            // et skjult skrivefelt er ingen tilgangskontroll.
            const antallInnlegg = (await samtaleStorage.sammendrag(funn.skjematypeId, funn.skjemaId)).Antall;
            if (!samtaleTilgang.kanSkrive({
                rolle: funn.deltaker.rolle, innstilling: funn.innstilling, antallInnlegg, apen: true
            })) {
                return avvis(403, 'Samtalen må startes av en behandler');
            }

            const body = await request.json().catch(() => ({}));
            let innlegg;
            try {
                innlegg = await samtaleStorage.leggTil(funn.skjematypeId, funn.skjemaId, {
                    avsender: funn.deltaker.id,
                    avsenderNavn: funn.deltaker.navn,
                    tekst: body?.tekst,
                    kilde: funn.deltaker.kilde
                });
            } catch (e) {
                // Tomt eller for langt innlegg er brukerens feil, ikke serverens.
                return avvis(400, e.message);
            }

            context.log(`samtale: ${funn.deltaker.id} (${funn.deltaker.rolle}) skrev i ${funn.skjematypeId}/${funn.skjemaId}`);

            // Varsling etter at innlegget er lagret, og aldri slik at den kan
            // velte svaret: innlegget ER skrevet, og en feilende e-post skal
            // ikke få klienten til å tro noe annet og la brukeren sende igjen.
            try {
                const st = await skjemaStorage.hentSkjematype(funn.skjematypeId);
                await varsling.sendSamtaleVarsling(funn.skjema, st?.JSON || {}, innlegg, {
                    log: (m) => context.log(m), request
                });
            } catch (e) {
                context.log(`samtale: varsling feilet — ${e.message}`);
            }

            return { status: 201, jsonBody: { status: 'ok', innlegg } };
        } catch (e) {
            context.log('samtale POST FEIL:', e.message);
            return avvis(500, 'Kunne ikke lagre innlegget');
        }
    }
});

app.http('samtaleDemping', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: `${RUTE}/demping`,
    handler: async (request, context) => {
        try {
            const funn = await finnSakOgDeltaker(request, context);
            if (funn.svar) return funn.svar;

            if (!samtaleTilgang.kanDempe(funn.deltaker.rolle)) {
                return avvis(403, 'Innsender kan ikke dempe varsling på egen sak');
            }

            const body = await request.json().catch(() => ({}));
            const dempet = await samtaleStorage.settDemping(
                funn.skjematypeId, funn.skjemaId, funn.deltaker.id, body?.dempet === true);
            return { jsonBody: { status: 'ok', dempet } };
        } catch (e) {
            context.log('samtale demping FEIL:', e.message);
            return avvis(500, 'Kunne ikke lagre innstillingen');
        }
    }
});

// Eksportert for test. Selve reglene bor i lib/samtale-tilgang.js.
module.exports = { _finnSakOgDeltaker: finnSakOgDeltaker };
