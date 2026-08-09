/**
 * OTP-endepunkter.
 *
 *   POST /api/otp/be-om-kode
 *     Body: { kanal: 'epost'|'sms', mottaker: '<e-post eller mobilnr>' }
 *     Anonymt (for ekstern innsender-flyt). Anti-enumerasjon: alltid
 *     status='ok' i respons (også hvis mottaker er ugyldig eller
 *     rate-limitet — logges internt).
 *
 *   POST /api/otp/verifiser-kode
 *     Body: { kanal, mottaker, kode }
 *     Returnerer { status: 'ok', verifikasjonstoken }  ved suksess
 *     eller { status: 'feil-kode'|'utlopt'|'blokkert' }.
 *     Token er HMAC-SHA256-signert og gyldig i 30 min — kan brukes ved
 *     senere kall som bevis på verifisering.
 */
const { app } = require('@azure/functions');
const otp = require('../lib/otp');
const otpToken = require('../lib/otp-token');
const { sendOtpViaFlyt } = require('../lib/flyt-kaller');

const KANALER = new Set(['epost', 'sms']);

function validerKanal(k) { return KANALER.has(k); }
function validerEpost(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim()); }
function validerMobil(s) {
    // Enkel norsk-mobil-validering: +47 + 8 sifre, eller 8 sifre startende med 4/9
    const rens = String(s || '').replace(/[\s\-()]/g, '');
    if (/^\+\d{8,15}$/.test(rens)) return true;
    if (/^[49]\d{7}$/.test(rens)) return true;
    return false;
}

app.http('otpBeOmKode', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'otp/be-om-kode',
    handler: async (request, context) => {
        try {
            const body = await request.json().catch(() => ({}));
            const kanal = String(body.kanal || '').toLowerCase();
            const mottaker = String(body.mottaker || '').trim();

            // Valider — men returner alltid 'ok' for å hindre enumerasjon
            if (!validerKanal(kanal)) {
                context.log(`otp: ugyldig kanal "${kanal}" (ignorert)`);
                return { jsonBody: { status: 'ok' } };
            }
            if (kanal === 'epost' && !validerEpost(mottaker)) {
                context.log(`otp: ugyldig e-post "${mottaker}" (ignorert)`);
                return { jsonBody: { status: 'ok' } };
            }
            if (kanal === 'sms' && !validerMobil(mottaker)) {
                context.log(`otp: ugyldig mobilnr "${mottaker}" (ignorert)`);
                return { jsonBody: { status: 'ok' } };
            }

            const log = (m) => context.log(m);
            const res = await otp.opprettKode(kanal, mottaker);
            if (res.status === 'rate-limitert') {
                context.log(`otp: rate-limitert kanal=${kanal} vent_sek=${res.vent_sek}`);
                return { jsonBody: { status: 'ok', melding: 'Vent litt før du ber om ny kode' } };
            }
            // Send koden via PA-flyt
            const sendResultat = await sendOtpViaFlyt({
                kanal, mottaker, kode: res.kode, gyldigMinutter: res.gyldig_minutter
            }, log);
            if (sendResultat.status === 'feil') {
                context.log(`otp: sending feilet — ${sendResultat.melding}`);
                // Fortsatt returner ok — bruker skal ikke lære av dette
            }
            return { jsonBody: { status: 'ok', gyldig_minutter: res.gyldig_minutter } };
        } catch (e) {
            context.log('otp/be-om-kode FEIL:', e.message, e.stack);
            return { jsonBody: { status: 'ok' } };
        }
    }
});

app.http('otpVerifiserKode', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'otp/verifiser-kode',
    handler: async (request, context) => {
        try {
            const body = await request.json().catch(() => ({}));
            const kanal = String(body.kanal || '').toLowerCase();
            const mottaker = String(body.mottaker || '').trim();
            const kode = String(body.kode || '').trim();

            if (!validerKanal(kanal) || !mottaker || !kode) {
                return { status: 400, jsonBody: { status: 'feil', melding: 'Mangler kanal, mottaker eller kode' } };
            }
            const res = await otp.verifiserKode(kanal, mottaker, kode);
            if (res.status !== 'ok') {
                return { jsonBody: res };
            }
            const verifikasjonstoken = otpToken.utstedToken(kanal, mottaker);
            context.log(`otp: verifisering OK kanal=${kanal} mottaker=${mottaker.slice(0, 3)}...`);
            return { jsonBody: {
                status: 'ok',
                verifikasjonstoken,
                gyldig_minutter: otpToken.TTL_MIN
            }};
        } catch (e) {
            context.log('otp/verifiser-kode FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});
