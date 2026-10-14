const { app } = require('@azure/functions');

/**
 * GET /api/ping — helsecheck. Anonym.
 *
 * Svarer også med byggstempelet: hvilken commit API-et faktisk kjører.
 *
 * Det feltet kom 23.09.2026, etter en time brukt på å avgjøre om en rettelse
 * var ute i miljøet. Deploy-jobben var grønn, koden så riktig ut, og
 * API-svaret så gammelt ut — og ingenting kunne skille «ikke deployet» fra
 * «deployet, men feil». Sammenlign `commit` her med `BUILD.commit` i
 * /js/config.js: er de ulike, henger den ene etter.
 *
 * versjon.json skrives av scripts/build-config.js ved deploy og er derfor
 * ikke sjekket inn. Mangler den, kjører vi utenfor en deploy — og da er
 * 'ukjent' det ærlige svaret, ikke en gjetning.
 */
let bygg = { commit: 'ukjent' };
try {
    bygg = require('../versjon.json');
} catch (_) { /* ingen deploy har skrevet den */ }

/**
 * Kom innloggingen fram til funksjonen?
 *
 * Hele tilgangsmodellen hviler på at plattformen setter
 * `x-ms-client-principal` på autentiserte kall. Når noe er galt med
 * innlogging, er det tre helt ulike tilstander som ser like ut utenfra:
 * headeren kom ikke, headeren kom men lot seg ikke lese, eller den kom og
 * var tom. Et 403 kan ikke skille dem, og da er videre feilsøking gjetting.
 *
 * Feltet settes derfor ALLTID, med årsaken i seg. Det er den samme regelen
 * som ga byggstempelet over.
 *
 * **Ingen UPN og ingen rollenavn her.** Endepunktet er anonymt. Det svarer på
 * om innloggingen nådde fram, ikke på hvem du er — det siste krever
 * `/api/system/info` og admin.
 *
 * Skrevet for steg 1 i `docs/BESLUTNING-EGEN-FUNCTION-APP.md`: spørsmålet om
 * SWA sender headeren videre til en lenket backend avgjør hele det
 * forslaget, og det skal besvares med ett kall, ikke med en tolkning.
 */
function principalDiagnose(request) {
    const rå = request?.headers?.get ? request.headers.get('x-ms-client-principal') : null;
    if (!rå) {
        return { headerMottatt: false, kunneLeses: false, harUpn: false, antallRoller: 0,
            merknad: 'ingen x-ms-client-principal — kallet er anonymt, eller plattformen sender den ikke videre' };
    }
    let p;
    try {
        p = JSON.parse(Buffer.from(rå, 'base64').toString('utf8'));
    } catch (e) {
        return { headerMottatt: true, kunneLeses: false, harUpn: false, antallRoller: 0,
            merknad: `headeren kom, men lot seg ikke lese: ${e.message}` };
    }
    const harUpn = !!p?.userDetails;
    return {
        headerMottatt: true,
        kunneLeses: true,
        harUpn,
        antallRoller: Array.isArray(p?.userRoles) ? p.userRoles.length : 0,
        merknad: harUpn ? 'innlogging mottatt og lest' : 'headeren kom og lot seg lese, men userDetails er tom'
    };
}

app.http('ping', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'ping',
    handler: async (request, context) => {
        return {
            jsonBody: {
                status: 'ok',
                tid: new Date().toISOString(),
                miljø: process.env.MILJO || 'ukjent',
                bygg,
                principal: principalDiagnose(request)
            }
        };
    }
});

module.exports = { principalDiagnose };
