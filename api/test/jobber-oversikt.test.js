/**
 * Jobboversikten — `lib/jobber.js` og `GET /api/jobber`.
 *
 * Fanen i admin svarer på tre spørsmål som ellers krever tre steder å lete:
 * hva som TRIGGER jobben i dette miljøet, NÅR den kjører, og hvordan det gikk
 * sist. Alle tre regnes ut i lib-en, og panelet tolker ingenting selv.
 *
 * Det som holdes fast her, er lært av hva som gjør en slik oversikt verdiløs:
 *
 *   **Triggeren må følge miljøet, ikke gjettes.** Regnet panelet ut «timer» av
 *   at MILJO=dev, ville det svart feil den dagen lista i `lib/plattform.js`
 *   endres i steg 6. En oversikt som er aktivt feil er verre enn ingen.
 *
 *   **I et miljø uten timere har overstyringen ingen virkning**, og en verdi
 *   som likevel er satt må SYNES. Ellers er «jeg satte POSTNUMRE_SCHEDULE i
 *   pilot og ingenting skjedde» en stille feil.
 *
 *   **Én leser av statusraden.** `/api/postnumre/status` leste den samme raden
 *   med sin egen feltmapping. To kopier av «hva heter feltene her» ville gitt
 *   to admin-faner som er uenige om samme jobb — og den uenigheten er taus:
 *   den ene viser «aldri kjørt».
 *
 *   **En feilet lesning tar ikke ned oversikten**, og årsaken står i raden det
 *   gjelder. «Ingen jobber» og «storage svarte ikke» ser ellers likt ut.
 *
 *   **Ingen vei til å ENDRE en schedule.** Endepunktet er lesende, med vilje —
 *   se 8m i docs/BESLUTNING-EGEN-FUNCTION-APP.md.
 *
 * Kjøres med:  node api/test/jobber-oversikt.test.js
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { utenKommentarer } = require('../../scripts/test-kilde.js');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const rot = path.join(__dirname, '..', '..');
const les = (...p) => fs.readFileSync(path.join(rot, ...p), 'utf8');

const { JOBBER, jobbOversikt, lesStatusrad, TOM_STATUS } = require('../src/lib/jobber');

/**
 * Kjør noe med MILJO (og eventuelt en overstyring) satt, og rydd etter seg.
 *
 * `medAsync` finnes fordi `med` rydder FØR et løfte rekker å kjøre ferdig: de
 * første forsøkene her leste MILJO til «ukjent» inne i en handler som så ut
 * til å bli kalt i riktig miljø.
 */
function med({ miljo, schedule }, fn) {
    const foerMiljo = process.env.MILJO;
    const foerSchedule = process.env.POSTNUMRE_SCHEDULE;
    if (miljo === undefined) delete process.env.MILJO; else process.env.MILJO = miljo;
    if (schedule === undefined) delete process.env.POSTNUMRE_SCHEDULE;
    else process.env.POSTNUMRE_SCHEDULE = schedule;
    try { return fn(); } finally {
        if (foerMiljo === undefined) delete process.env.MILJO; else process.env.MILJO = foerMiljo;
        if (foerSchedule === undefined) delete process.env.POSTNUMRE_SCHEDULE;
        else process.env.POSTNUMRE_SCHEDULE = foerSchedule;
    }
}

async function medAsync(valg, fn) {
    const foerMiljo = process.env.MILJO;
    const foerSchedule = process.env.POSTNUMRE_SCHEDULE;
    if (valg.miljo === undefined) delete process.env.MILJO; else process.env.MILJO = valg.miljo;
    if (valg.schedule === undefined) delete process.env.POSTNUMRE_SCHEDULE;
    else process.env.POSTNUMRE_SCHEDULE = valg.schedule;
    try { return await fn(); } finally {
        if (foerMiljo === undefined) delete process.env.MILJO; else process.env.MILJO = foerMiljo;
        if (foerSchedule === undefined) delete process.env.POSTNUMRE_SCHEDULE;
        else process.env.POSTNUMRE_SCHEDULE = foerSchedule;
    }
}

// ---------- 1. triggeren følger miljøet ----------
{
    const dev = med({ miljo: 'dev' }, jobbOversikt);
    sjekk('oversikten har like mange rader som registeret', dev.length, JOBBER.length);
    sjekk('dev trigges av timer', dev[0].trigger, 'timer');
    sjekk('og schedulen er standarden', dev[0].schedule, JOBBER[0].standardSchedule);
    sjekk('og kilden sier det', dev[0].scheduleKilde, 'standard');
    sjekk('og ingenting er ignorert', dev[0].overstyringIgnorert, null);

    for (const miljo of ['pilot', 'production', 'prod', 'staging', undefined]) {
        const o = med({ miljo }, jobbOversikt);
        sjekk(`${miljo}: trigges av GitHub Actions`, o[0].trigger, 'github-actions');
        // Og tidspunktet som vises er workflowens, ikke en app-setting som
        // ikke har virkning her.
        sjekk(`${miljo}: viser standarden`, o[0].schedule, JOBBER[0].standardSchedule);
        sjekk(`${miljo}: og sier hvor den kommer fra`, o[0].scheduleKilde, 'workflow');
        sjekk(`${miljo}: workflownavnet er med`, o[0].workflow, JOBBER[0].workflow);
    }
}

// ---------- 2. overstyringen, i begge retninger ----------
{
    const dev = med({ miljo: 'dev', schedule: '0 */5 * * * *' }, jobbOversikt);
    sjekk('dev bruker overstyringen', dev[0].schedule, '0 */5 * * * *');
    sjekk('og navngir app-settingen', dev[0].scheduleKilde, JOBBER[0].scheduleVar);

    const avvist = med({ miljo: 'dev', schedule: '30 4 15 1,7 *' }, jobbOversikt);
    sjekk('en ugyldig overstyring faller tilbake', avvist[0].schedule, JOBBER[0].standardSchedule);
    sjekk('og den avviste verdien står i svaret', avvist[0].avvist, '30 4 15 1,7 *');
    sjekk('med en grunn', typeof avvist[0].grunn, 'string');

    // DEN STILLE FEILEN: satt i et miljø der den ikke har virkning.
    const pilot = med({ miljo: 'pilot', schedule: '0 */5 * * * *' }, jobbOversikt);
    sjekk('pilot bruker den IKKE', pilot[0].schedule, JOBBER[0].standardSchedule);
    sjekk('men sier at den står der og ignoreres', pilot[0].overstyringIgnorert, '0 */5 * * * *');
    sjekk('og lover ikke at noe ble avvist', pilot[0].avvist, null);

    // Felter som kan forsvinne kan ikke feilsøkes: alle skal ALLTID finnes,
    // også når ingenting er galt.
    for (const nøkkel of ['avvist', 'grunn', 'overstyringIgnorert', 'scheduleKilde', 'registrert']) {
        sjekk(`${nøkkel} er alltid med`, nøkkel in med({ miljo: 'dev' }, jobbOversikt)[0], true);
    }
}

// ---------- 2b. registreringen er en annen påstand enn triggeren ----------
//
// `trigger: 'timer'` sier at MILJØET kjører timere. `registrert` sier at
// nettopp denne jobbens timer faktisk ble registrert i prosessen. Blandes de
// to, kan panelet ikke skille «ingen timer finnes» fra «timeren fyrer ikke» —
// og det var akkurat det spørsmålet som sto ubesvart 17.10.2026.
{
    const { meldTimer, _glemTimere } = require('../src/lib/jobber');
    _glemTimere();
    const foer = med({ miljo: 'dev' }, jobbOversikt);
    sjekk('uten melding er registrert null', foer[0].registrert, null);
    sjekk('men triggeren er fortsatt timer', foer[0].trigger, 'timer');

    meldTimer(JOBBER[0].id, 'enTimer', JOBBER[0].standardSchedule);
    const etter = med({ miljo: 'dev' }, jobbOversikt);
    sjekk('etter melding står navnet der', etter[0].registrert?.navn, 'enTimer');
    sjekk('og schedulen', etter[0].registrert?.schedule, JOBBER[0].standardSchedule);
    sjekk('og de andre jobbene er uberørt', etter[1]?.registrert, null);

    // I et miljø uten timere er feltet null uansett hva som er meldt — der
    // registreres ingen timer, og en «registrert» der ville vært en påstand
    // om noe som ikke skjer.
    sjekk('github-actions-miljø melder aldri registrert',
        med({ miljo: 'pilot' }, jobbOversikt)[0].registrert, null);
    _glemTimere();
}

// ---------- 3. statusraden, én leser ----------
async function statussjekk() {
    const sti = require.resolve('../src/lib/jobber.js');
    const lesMed = async (getEntity) => {
        const ekte = Module._load;
        Module._load = function (forespurt, ...r) {
            if (forespurt === './storage') return { tabellKlient: () => ({ getEntity }) };
            return ekte.call(this, forespurt, ...r);
        };
        delete require.cache[sti];
        try {
            const m = require(sti);
            return await m.lesStatusrad(m.JOBBER[0].statusrad);
        } finally {
            Module._load = ekte;
            delete require.cache[sti];
        }
    };

    // Raden pekes ut av registeret, med de nøklene jobben faktisk skriver.
    let bedtOm = null;
    await lesMed(async (pk, rk) => { bedtOm = [pk, rk]; return {}; });
    const jobbModul = require('../src/lib/postnummer-jobb');
    sjekk('leseren spør om raden jobben skriver', bedtOm, [jobbModul.PK, jobbModul.RK]);

    const rad = await lesMed(async () => ({
        Status: 'ok', SistOppdatert: '2026-10-17T04:31:00Z', AntallRader: 5012,
        AntallSlettet: 3, VarighetSekunder: 44, Startet: '2026-10-17T04:30:00Z',
        Ferdig: '2026-10-17T04:31:00Z', Kilde: 'timer', SistFeil: ''
    }));
    // FELTNAVNENE LESES UT AV JOBBEN, ikke funnet opp i testen: skriver
    // postnummer-jobb.js `AntallRader`, skal leseren svare på `antallRader`.
    sjekk('status leses', rad.status, 'ok');
    sjekk('antall leses', rad.antallRader, 5012);
    sjekk('slettet leses', rad.antallSlettet, 3);
    sjekk('varighet leses', rad.varighetSekunder, 44);
    sjekk('kilde leses — det er det ENESTE som skiller timer fra HTTP', rad.kilde, 'timer');

    // En rad uten kolonnene skal ikke bli «0 rader»: det er en påstand.
    const halv = await lesMed(async () => ({ Status: 'kjører', Startet: 'nå' }));
    sjekk('manglende tall blir null, ikke 0', [halv.antallRader, halv.varighetSekunder], [null, null]);
    sjekk('og status er med', halv.status, 'kjører');

    // 404 = har aldri kjørt. Alle feltene er med likevel.
    const aldri = await lesMed(async () => { const e = new Error('ikke funnet'); e.statusCode = 404; throw e; });
    sjekk('404 gir «aldri kjørt»', aldri, TOM_STATUS);
    sjekk('og det er en kopi, ikke selve konstanten', aldri === TOM_STATUS, false);

    // Alt ANNET er en ekte feil, og skal ikke pyntes til «aldri kjørt» —
    // da ser en manglende tilgang ut som en jobb som ikke er kjørt ennå.
    let kastet = null;
    try {
        await lesMed(async () => { const e = new Error('Forbidden'); e.statusCode = 403; throw e; });
    } catch (e) { kastet = e.message; }
    sjekk('en 403 kastes videre', kastet, 'Forbidden');
}

// ---------- 4. endepunktet ----------
async function endepunktsjekk() {
    const sti = require.resolve('../src/functions/jobber.js');
    const stiLib = require.resolve('../src/lib/jobber.js');

    /**
     * Last endepunktet med stubber, og HOLD DEM INSTALLERT mens handleren
     * kjører. Lagringen lastes LAT inne i `lesStatusrad` — rives stubben
     * etter `require`, treffer handleren den ekte storage.js, og svaret blir
     * «kunne ikke lese statusraden» uansett hva testen forsøkte å prøve.
     */
    const medStubber = async ({ upn, admin, getEntity }, bruk) => {
        let opsjoner = null;
        const ekte = Module._load;
        Module._load = function (forespurt, ...r) {
            if (forespurt === '@azure/functions') {
                return { app: { http: (navn, opts) => { opsjoner = { navn, ...opts }; } } };
            }
            if (forespurt === '../lib/auth') {
                return { hentInnloggetUpn: () => upn, erAdmin: () => admin };
            }
            if (forespurt === './storage') return { tabellKlient: () => ({ getEntity }) };
            return ekte.call(this, forespurt, ...r);
        };
        delete require.cache[sti];
        delete require.cache[stiLib];
        try {
            require(sti);
            return await bruk(opsjoner);
        } finally {
            Module._load = ekte;
            delete require.cache[sti];
            delete require.cache[stiLib];
        }
    };

    const lastHandler = (valg) => medStubber(valg, (o) => o);

    const kjor = async (valg) => medStubber(valg, async (o) => ({
        opsjoner: o,
        svar: await o.handler({ headers: { get: () => null } }, { log: () => {} })
    }));

    const okRad = async () => ({ Status: 'ok', Kilde: 'timer', AntallRader: 5012 });

    // Ruta og metoden, fra den ekte registreringen.
    const reg = await lastHandler({ upn: 'a@b.no', admin: true, getEntity: okRad });
    sjekk('ruta er /api/jobber', reg.route, 'jobber');
    sjekk('og bare GET', reg.methods, ['GET']);

    const uinnlogget = await kjor({ upn: null, admin: false, getEntity: okRad });
    sjekk('uinnlogget avvises', uinnlogget.svar.status, 401);
    const ikkeAdmin = await kjor({ upn: 'a@b.no', admin: false, getEntity: okRad });
    sjekk('ikke-admin avvises', ikkeAdmin.svar.status, 403);

    const god = await medAsync({ miljo: 'dev' }, () => kjor({ upn: 'a@b.no', admin: true, getEntity: okRad }));
    const kropp = god.svar.jsonBody;
    sjekk('admin får svar', god.svar.status, undefined);
    sjekk('miljøet er med', kropp.miljø, 'dev');
    sjekk('alle jobbene er med', kropp.jobber.length, JOBBER.length);
    sjekk('triggeren er med', kropp.jobber[0].trigger, 'timer');
    sjekk('og statusraden', kropp.jobber[0].siste.antallRader, 5012);
    sjekk('ingen statusfeil', kropp.jobber[0].statusFeil, null);
    sjekk('merknaden forklarer triggeren', /timer-trigger/i.test(kropp.merknad), true);

    // «production» er pilot, og merknaden skal si det motsatte der.
    const pilot = await medAsync({ miljo: 'production' }, () => kjor({ upn: 'a@b.no', admin: true, getEntity: okRad }));
    sjekk('pilot: trigges av GitHub Actions', pilot.svar.jsonBody.jobber[0].trigger, 'github-actions');
    sjekk('pilot: merknaden sier at timere ikke kjører',
        /IKKE timer-trigger/i.test(pilot.svar.jsonBody.merknad), true);

    // EN FEILET LESNING TAR IKKE NED OVERSIKTEN.
    const sprekk = await medAsync({ miljo: 'dev' }, () => kjor({
        upn: 'a@b.no', admin: true,
        getEntity: async () => { throw new Error('storage svarte ikke'); }
    }));
    const r = sprekk.svar.jsonBody.jobber[0];
    sjekk('jobben vises likevel', sprekk.svar.jsonBody.jobber.length, JOBBER.length);
    sjekk('schedulen er fortsatt med', r.schedule, JOBBER[0].standardSchedule);
    sjekk('og årsaken står i raden', r.statusFeil, 'storage svarte ikke');
    sjekk('og «siste» er null, ikke en tom status som ser ut som aldri kjørt', r.siste, null);
}

// ---------- 5. ingen vei til å endre en schedule ----------
{
    const kilde = utenKommentarer(les('api', 'src', 'functions', 'jobber.js'));
    sjekk('endepunktet registrerer bare GET', (kilde.match(/app\.http\(/g) || []).length, 1);
    sjekk('ingen POST, PUT eller PATCH', /'(POST|PUT|PATCH|DELETE)'/.test(kilde), false);
    // Og ingen skriving til lagringen herfra.
    sjekk('ingen upsert', /upsertEntity\(|updateEntity\(/.test(kilde), false);
}

statussjekk()
    .then(endepunktsjekk)
    .then(() => {
        console.log(`\n${ok} OK, ${feil} feil`);
        process.exit(feil ? 1 : 0);
    })
    .catch((e) => { console.log('TESTEN KRASJET:', e.stack); process.exit(1); });
