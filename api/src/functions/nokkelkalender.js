/**
 * Nøkkelkalender — hemmeligheter og nøkler med utløpsdato.
 *
 *   GET    /api/nokkelkalender          — hele kalenderen + lagerinfo (admin)
 *   POST   /api/nokkelkalender          — ny rad (admin)
 *   PUT    /api/nokkelkalender/{id}     — endre rad (admin)
 *   DELETE /api/nokkelkalender/{id}     — slett rad (admin)
 *   POST   /api/nokkelkalender/seed     — legg inn standardinventaret (admin)
 *   POST   /api/nokkelkalender/sjekk    — varsle om det som nærmer seg utløp
 *                                          (x-scheduler-key eller admin)
 *
 * Sjekken kjøres daglig av .github/workflows/sjekk-nokler.yml, siden SWA
 * Managed Functions ikke støtter timer-triggere. Den behandler bare rader i
 * sitt eget miljø, så pilot og prod varsler ikke dobbelt om samme rad.
 */
const { app } = require('@azure/functions');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');
const kalender = require('../lib/nokkelkalender-storage');
const hendelser = require('../lib/hendelser-storage');
const { kjorNokkelsjekk } = require('../lib/nokkelkalender-jobb');
const { stotterTimere } = require('../lib/plattform');
const { jobbForId, jobbSchedule, meldTimer } = require('../lib/jobber');

/**
 * Utfall → HTTP-status, ett sted.
 *
 * 502 når varslingen ikke nådde fram er ikke kosmetikk: cron-jobben i
 * GitHub Actions blir rød på den, og det er hele poenget — et varsel som
 * ikke ble sendt skal ikke se ut som en vellykket kjøring.
 */
const STATUS_FOR_UTFALL = {
    ok: 200,
    ingenting: 200,
    'tørrkjørt': 200,
    'mangler-mottakere': 500,
    'varsling-feilet': 502,
    feil: 500
};

function admin(request) {
    const upn = hentInnloggetUpn(request);
    if (!upn) return { ok: false, status: 401, melding: 'Ikke innlogget' };
    if (!erAdmin(upn)) return { ok: false, status: 403, melding: 'Krever admin' };
    return { ok: true, upn };
}

/** Samme mønster som utsending/purre: cron eller admin slipper inn. */
function schedulerEllerAdmin(request) {
    const gitt = request.headers.get('x-scheduler-key');
    const konfigurert = String(process.env.SCHEDULER_KEY || '').trim();
    if (konfigurert && gitt && gitt === konfigurert) return { ok: true, upn: 'scheduler' };
    const upn = hentInnloggetUpn(request);
    if (upn && erAdmin(upn)) return { ok: true, upn };
    return { ok: false, status: 401, melding: 'Krever x-scheduler-key eller admin' };
}

function oppsummering(rader) {
    const tell = (t) => rader.filter(r => r.Tilstand === t).length;
    return {
        totalt: rader.length,
        utløpt: tell('utløpt'),
        kritisk: tell('kritisk'),
        snart: tell('snart'),
        ukjent: tell('ukjent'),
        ok: tell('ok'),
        fast: tell('fast')
    };
}

app.http('nokkelkalenderList', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'nokkelkalender',
    handler: async (request, context) => {
        const a = admin(request);
        if (!a.ok) return { status: a.status, jsonBody: { status: 'feil', melding: a.melding } };
        try {
            const rader = await kalender.listAlle();
            return {
                jsonBody: {
                    rader,
                    lager: kalender.lagerInfo(),
                    miljo: kalender.miljo(),
                    typer: kalender.TYPER,
                    oppsummering: oppsummering(rader)
                }
            };
        } catch (e) {
            context.log('nokkelkalender GET FEIL:', e.message);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('nokkelkalenderOpprett', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'nokkelkalender',
    handler: async (request, context) => {
        const a = admin(request);
        if (!a.ok) return { status: a.status, jsonBody: { status: 'feil', melding: a.melding } };
        try {
            const body = await request.json();
            const rad = await kalender.opprett(body, a.upn);
            hendelser.logg({
                Type: 'nokkelkalender.opprett', Aktor: a.upn,
                ObjektType: 'nokkelkalender', ObjektId: rad.Id,
                Melding: `La til «${rad.Navn}» i ${rad.Miljo}`
            });
            return { status: 201, jsonBody: rad };
        } catch (e) {
            context.log('nokkelkalender POST FEIL:', e.message);
            return { status: 400, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('nokkelkalenderOppdater', {
    methods: ['PUT'],
    authLevel: 'anonymous',
    route: 'nokkelkalender/{id}',
    handler: async (request, context) => {
        const a = admin(request);
        if (!a.ok) return { status: a.status, jsonBody: { status: 'feil', melding: a.melding } };
        try {
            const body = await request.json();
            const m = String(body?.Miljo || kalender.miljo()).toLowerCase();
            const rad = await kalender.oppdater(request.params.id, body, a.upn, m);
            if (!rad) return { status: 404, jsonBody: { status: 'feil', melding: 'Raden finnes ikke' } };
            hendelser.logg({
                Type: 'nokkelkalender.endre', Aktor: a.upn,
                ObjektType: 'nokkelkalender', ObjektId: rad.Id,
                Melding: `Endret «${rad.Navn}»${rad.UtloperFaktisk ? ` — utløper ${rad.UtloperFaktisk.slice(0, 10)}` : ''}`
            });
            return { jsonBody: rad };
        } catch (e) {
            context.log('nokkelkalender PUT FEIL:', e.message);
            return { status: 400, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('nokkelkalenderSlett', {
    methods: ['DELETE'],
    authLevel: 'anonymous',
    route: 'nokkelkalender/{id}',
    handler: async (request, context) => {
        const a = admin(request);
        if (!a.ok) return { status: a.status, jsonBody: { status: 'feil', melding: a.melding } };
        try {
            const m = String(request.query.get('miljo') || kalender.miljo()).toLowerCase();
            const slettet = await kalender.slett(request.params.id, m);
            if (!slettet) return { status: 404, jsonBody: { status: 'feil', melding: 'Raden finnes ikke' } };
            hendelser.logg({
                Type: 'nokkelkalender.slett', Aktor: a.upn,
                ObjektType: 'nokkelkalender', ObjektId: request.params.id,
                Melding: `Slettet «${request.params.id}» fra ${m}`
            });
            return { jsonBody: { status: 'ok' } };
        } catch (e) {
            context.log('nokkelkalender DELETE FEIL:', e.message);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('nokkelkalenderSeed', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'nokkelkalender/seed',
    handler: async (request, context) => {
        const a = admin(request);
        if (!a.ok) return { status: a.status, jsonBody: { status: 'feil', melding: a.melding } };
        try {
            const res = await kalender.seedStandard(a.upn);
            hendelser.logg({
                Type: 'nokkelkalender.seed', Aktor: a.upn,
                ObjektType: 'nokkelkalender', ObjektId: res.miljo,
                Melding: `Standardinventar: ${res.lagtTil} lagt til, ${res.hoppetOver} fantes fra før`
            });
            return { jsonBody: { status: 'ok', ...res } };
        } catch (e) {
            context.log('nokkelkalender seed FEIL:', e.message);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});


// E-postbyggingen (esc, fristTekst, byggEpost) lå her til 17.10.2026. Den
// bor nå i `lib/nokkelkalender-jobb.js`, sammen med resten av sjekken: en lib
// kan ikke importere fra `functions/`, og en kopi av den HTML-en ville vært
// det verste stedet å få to utgaver som svarer ulikt.

/**
 * POST /api/nokkelkalender/sjekk — daglig kontroll.
 *
 * Sender ett samlet varsel til ADMIN_UPNS med alt som har passert et nytt
 * trinn. Ett brev om alle, ikke ett per hemmelighet: en administrator som får
 * seks e-poster leser den første.
 *
 * Body: { tørrkjør?: true } for å se hva som ville blitt sendt uten å sende.
 */
app.http('nokkelkalenderSjekk', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'nokkelkalender/sjekk',
    handler: async (request, context) => {
        const a = schedulerEllerAdmin(request);
        if (!a.ok) return { status: a.status, jsonBody: { status: 'feil', melding: a.melding } };

        const body = await request.json().catch(() => ({}));
        const torrkjor = body?.tørrkjør === true || body?.torrkjor === true;

        // Bokføringen og hele sjekken bor i jobbmodulen, slik at timeren i dev
        // og denne veien gir admin-panelet SAMME bilde av samme kjøring.
        const res = await kjorNokkelsjekk({
            kilde: a.upn, torrkjor, request, log: (m) => context.log(m)
        });

        // Utfallet oversettes til en HTTP-status ETT sted. Kartet er
        // uendret fra før jobben ble flyttet ut: 502 når varslingen ikke
        // nådde fram (cron-jobben skal bli rød), 500 når ADMIN_UPNS mangler.
        const { utfall, ...kropp } = res;
        const status = STATUS_FOR_UTFALL[utfall];
        if (status === undefined) {
            // Et ukjent utfall skal ikke bli 200 ved et uhell.
            context.log(`nokkelkalender/sjekk: ukjent utfall «${utfall}»`);
            return { status: 500, jsonBody: { status: 'feil', utfall, ...kropp } };
        }
        if (status === 200) {
            return { jsonBody: { status: 'ok', ...(utfall === 'tørrkjørt' ? { tørrkjør: true } : {}), ...kropp } };
        }
        return { status, jsonBody: { status: 'feil', ...kropp } };
    }
});

// ==================== TIMER-TRIGGER (steg 5) ====================
//
// Samme vakt og samme form som de tre andre jobbene. Tidspunktet står i
// lib/jobber.js, og testen krever at det er cron-en i sjekk-nokler.yml med et
// sekundfelt foran.
//
// **DENNE SENDER E-POST.** Timeren kjører ALDRI tørt: en tørrkjøring uten
// noen som ser på svaret er bortkastet arbeid, og den ville ikke merket av
// noe uansett.
if (stotterTimere()) {
    const jobbDef = jobbForId('sjekk-nokler');
    const valgt = jobbSchedule(jobbDef);
    if (valgt.avvist) console.warn(`nokkelsjekk-timer: avviste «${valgt.avvist}» — ${valgt.grunn}`);
    else if (valgt.kilde !== 'standard') console.log(`nokkelsjekk-timer: schedule fra ${valgt.kilde}: ${valgt.schedule}`);

    meldTimer('sjekk-nokler', 'nokkelsjekkTimer', valgt.schedule);
    app.timer('nokkelsjekkTimer', {
        schedule: valgt.schedule,
        handler: async (timer, context) => {
            const log = (m) => context.log(m);
            if (timer?.isPastDue) log('nokkelsjekk-timer: forsinket kjøring');
            await kjorNokkelsjekk({ kilde: 'timer', log });
        }
    });
}
