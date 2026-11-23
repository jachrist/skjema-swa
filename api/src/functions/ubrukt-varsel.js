/**
 * Varsel om ubrukte skjematyper med M365-kobling — se lib/ubrukt-varsel.js.
 *
 *   POST /api/m365-koblinger/varsle-ubrukte
 *     Kjør jobben nå. Admin eller x-scheduler-key. Samme bokføring som timeren.
 *
 *   POST /api/m365-koblinger/varsling
 *     Slå månedsvarselet på eller av for skjematyper. Admin.
 *     Body: { skjematypeIder: ["2", "17"], varsle: true | false }
 *     «Varsle alle» og «Skru av alle» i admin sender alle id-ene i lista.
 *     Svarer med lista over avslåtte etterpå.
 *
 * Timeren registreres bare der timere støttes (lib/plattform.js).
 */
const { app } = require('@azure/functions');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');
const ubruktVarsel = require('../lib/ubrukt-varsel');
const hendelser = require('../lib/hendelser-storage');
const { stotterTimere } = require('../lib/plattform');
const { jobbForId, jobbSchedule, meldTimer } = require('../lib/jobber');

function autorisert(request) {
    const nokkel = request.headers.get('x-scheduler-key');
    const konfigurert = process.env.SCHEDULER_KEY;
    if (nokkel && konfigurert && nokkel === konfigurert) return { ok: true, aktor: 'scheduler' };
    const upn = hentInnloggetUpn(request);
    if (upn && erAdmin(upn)) return { ok: true, aktor: upn };
    return { ok: false };
}

app.http('ubruktVarselKjor', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'm365-koblinger/varsle-ubrukte',
    handler: async (request, context) => {
        const auth = autorisert(request);
        if (!auth.ok) return { status: 403, jsonBody: { status: 'avvist', melding: 'Krever admin eller service-key' } };
        const res = await ubruktVarsel.kjorUbruktVarsel({ kilde: auth.aktor, log: (m) => context.log(m) });
        const status = res.utfall === 'ok' ? 200 : (res.utfall === 'delvis' ? 207 : 500);
        return { status, jsonBody: { status: res.utfall, ...res } };
    }
});

app.http('ubruktVarselInnstilling', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'm365-koblinger/varsling',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        if (!erAdmin(upn)) return { status: 403, jsonBody: { status: 'avvist', melding: 'Kun for administratorer' } };
        const body = await request.json().catch(() => ({}));
        const ider = Array.isArray(body?.skjematypeIder) ? body.skjematypeIder.map(String).filter(Boolean) : [];
        if (ider.length === 0) return { status: 400, jsonBody: { status: 'feil', melding: 'skjematypeIder mangler' } };
        if (typeof body?.varsle !== 'boolean') return { status: 400, jsonBody: { status: 'feil', melding: 'varsle må være true eller false' } };
        try {
            const av = await ubruktVarsel.settVarsling(ider, body.varsle, upn);
            hendelser.logg({
                Type: 'm365-koblinger.varsling', Aktor: upn, ObjektType: 'skjematype',
                ObjektId: ider.length === 1 ? ider[0] : `${ider.length} skjematyper`,
                Melding: `Varsel om ubrukt skjematype ${body.varsle ? 'slått på' : 'slått av'} for ${ider.join(', ')}`.slice(0, 500)
            });
            return { jsonBody: { status: 'ok', avslatte: av } };
        } catch (e) {
            context.log('m365-koblinger/varsling FEIL:', e.message);
            return { status: 500, jsonBody: { status: 'feil', melding: 'Kunne ikke lagre innstillingen' } };
        }
    }
});

if (stotterTimere()) {
    const jobbDef = jobbForId('ubrukt-varsel');
    const valgt = jobbSchedule(jobbDef);
    if (valgt.avvist) console.warn(`ubrukt-varsel-timer: avviste «${valgt.avvist}» — ${valgt.grunn}`);
    else if (valgt.kilde !== 'standard') console.log(`ubrukt-varsel-timer: schedule fra ${valgt.kilde}: ${valgt.schedule}`);

    meldTimer('ubrukt-varsel', 'ubruktVarselTimer', valgt.schedule);
    app.timer('ubruktVarselTimer', {
        schedule: valgt.schedule,
        handler: async (timer, context) => {
            const log = (m) => context.log(m);
            if (timer?.isPastDue) log('ubrukt-varsel-timer: forsinket kjøring');
            await ubruktVarsel.kjorUbruktVarsel({ kilde: 'timer', log });
        }
    });
}
