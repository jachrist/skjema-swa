/**
 * Gevinstoppfølging — nullpunktstatus.
 *
 *   GET /api/gevinst/nullpunkt-status
 *     Auth: innlogget. Hvilke skjematyper som har registrert nullpunkt.
 *     Brukes av skjemaoversikten til å merke de som mangler, og av editoren
 *     når en skjematype settes i produksjon.
 *
 * Én spørring dekker hele oversikten. Alternativet — å sjekke per skjematype —
 * ville gitt én tabellskanning per rad i lista.
 *
 *   POST /api/gevinst/lenke — admin.
 *     Body: { skjematypeId, hva: 'baseline' | 'rapport', mottaker }
 *     Lager en forhåndsutfylt lenke til baseline- eller rapporteringsskjemaet
 *     for skjematypen, til mottakeren (normalt eieren). Admin sender den selv —
 *     det er den manuelle purringen (besluttet 24.11.2026). Raden purres ikke
 *     automatisk. Lenka er personlig: den som åpner den, sender inn som
 *     mottakeren.
 *
 *   POST /api/gevinst/fritak — admin.
 *     Body: { skjematypeIder: [...], fritatt: true | false }
 *     Slår kravet om gevinstskjemaer av eller på for skjematyper.
 */
const crypto = require('crypto');
const { app } = require('@azure/functions');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');
const gevinstSjekk = require('../lib/gevinst-sjekk');
const { FRITATT } = require('../lib/gevinst-status');
const innstillingSett = require('../lib/innstilling-sett');
const innstillinger = require('../lib/innstillinger-storage');
const skjemaStorage = require('../lib/skjema-storage');
const utsendingStorage = require('../lib/utsending-storage');
const utsendingToken = require('../lib/utsending-token');
const hendelser = require('../lib/hendelser-storage');

function admin(request) {
    const upn = hentInnloggetUpn(request);
    if (!upn) return { ok: false, svar: { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } } };
    if (!erAdmin(upn)) return { ok: false, svar: { status: 403, jsonBody: { status: 'avvist', melding: 'Kun for administratorer' } } };
    return { ok: true, upn };
}

app.http('gevinstNullpunktStatus', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'gevinst/nullpunkt-status',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        try {
            const res = await gevinstSjekk.hentDekkede();
            return { jsonBody: res };
        } catch (e) {
            context.log('gevinst/nullpunkt-status FEIL:', e.message);
            // Merkingen er en påminnelse, ikke en tilgangskontroll. Feiler den,
            // skal oversikten fortsatt komme opp — bare uten merker.
            return { jsonBody: { konfigurert: false, baselineTypeId: null, dekkede: [], feil: e.message } };
        }
    }
});

app.http('gevinstLenke', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'gevinst/lenke',
    handler: async (request, context) => {
        const a = admin(request);
        if (!a.ok) return a.svar;
        const body = await request.json().catch(() => ({}));
        const skjematypeId = String(body?.skjematypeId || '').trim();
        const hva = String(body?.hva || '');
        const mottaker = String(body?.mottaker || '').trim().toLowerCase();
        if (!skjematypeId) return { status: 400, jsonBody: { status: 'feil', melding: 'skjematypeId mangler' } };
        if (!['baseline', 'rapport'].includes(hva)) return { status: 400, jsonBody: { status: 'feil', melding: 'hva må være baseline eller rapport' } };
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mottaker)) return { status: 400, jsonBody: { status: 'feil', melding: 'mottaker må være en e-postadresse' } };
        try {
            const nokkel = hva === 'baseline' ? gevinstSjekk.BASELINE : gevinstSjekk.RAPPORT;
            const malTypeId = String((await innstillinger.hent(nokkel))?.Verdi || '').trim();
            if (!malTypeId) {
                return { status: 400, jsonBody: { status: 'feil', melding: `${nokkel} er ikke satt under Administrasjon → Gevinstoppfølging` } };
            }
            const st = await skjemaStorage.hentSkjematype(skjematypeId);
            if (!st) return { status: 404, jsonBody: { status: 'feil', melding: `Skjematype ${skjematypeId} finnes ikke` } };

            // Én rad per (gevinstskjema, skjematype, mottaker): en eier av to
            // skjematyper får to lenker, og den ene overskriver ikke den andre.
            const batchId = `gevinst-${hva}-${skjematypeId}`;
            const jti = crypto.randomBytes(8).toString('hex');
            await utsendingStorage.opprett({
                batchId, mottaker, skjematypeId: malTypeId, jti,
                prefilled: { '1-01': [skjematypeId], '1-02': [st.navn || st.JSON?.Skjema_navn || ''] },
                kanalHint: 'epost', senderSkjemaId: '', opprettetAv: a.upn,
                ikkePurr: true
            });
            const token = utsendingToken.utsted({ batchId, mottaker, skjematypeId: malTypeId, jti });
            const { baseUrl } = require('../lib/utsending-jobb');
            const url = `${baseUrl(request)}/index.html?utsending=${encodeURIComponent(token)}`;
            hendelser.logg({
                Type: 'gevinst.lenke', Aktor: a.upn, ObjektType: 'skjematype', ObjektId: skjematypeId,
                Melding: `Lenke til ${hva === 'baseline' ? 'baseline' : 'gevinstrapportering'} laget for ${mottaker}`
            });
            return { jsonBody: { status: 'ok', url, mottaker, hva, utloper: utsendingToken.valider(token).utloper } };
        } catch (e) {
            context.log('gevinst/lenke FEIL:', e.message);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('gevinstFritak', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'gevinst/fritak',
    handler: async (request, context) => {
        const a = admin(request);
        if (!a.ok) return a.svar;
        const body = await request.json().catch(() => ({}));
        const ider = Array.isArray(body?.skjematypeIder) ? body.skjematypeIder.map(String).filter(Boolean) : [];
        if (ider.length === 0) return { status: 400, jsonBody: { status: 'feil', melding: 'skjematypeIder mangler' } };
        if (typeof body?.fritatt !== 'boolean') return { status: 400, jsonBody: { status: 'feil', melding: 'fritatt må være true eller false' } };
        try {
            const fritatte = await innstillingSett.sett(FRITATT, ider, body.fritatt, a.upn);
            hendelser.logg({
                Type: 'gevinst.fritak', Aktor: a.upn, ObjektType: 'skjematype',
                ObjektId: ider.length === 1 ? ider[0] : `${ider.length} skjematyper`,
                Melding: `Krav om gevinstskjemaer ${body.fritatt ? 'slått av' : 'slått på'} for ${ider.join(', ')}`.slice(0, 500)
            });
            return { jsonBody: { status: 'ok', fritatte } };
        } catch (e) {
            context.log('gevinst/fritak FEIL:', e.message);
            return { status: 500, jsonBody: { status: 'feil', melding: 'Kunne ikke lagre fritaket' } };
        }
    }
});
