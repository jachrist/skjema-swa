/**
 * Timer-trigger i dev — steg 4.
 *
 * De åtte cron-jobbene ligger i GitHub Actions og kaller HTTP-endepunkter med
 * en delt nøkkel, fordi SWA Managed Functions ikke støtter timer-triggere. En
 * frittstående Function App gjør det, og `postnumre/refresh-bring` er den
 * første som flyttes.
 *
 * Fire ting holdes fast, og de er alle lært av hvordan dette går galt:
 *
 *   **Vakten står rundt REGISTRERINGEN.** En timer som registreres på en vert
 *   som ikke støtter dem er ikke en stille no-op — den kan velte oppstarten
 *   for hele appen, og da er HTTP-rutene borte også. Testen laster modulen med
 *   MILJO satt til hvert miljø og teller `app.timer`-kall.
 *
 *   **NCRONTAB har SEKS felt.** GitHub-cron har fem. Skrives GitHub-uttrykket
 *   rett inn, leses «30 4 15 1,7 *» som sekund-minutt-time-dag-måned og
 *   kjører 1,7 ganger i uka i stedet for to ganger i året. Testen leser BEGGE
 *   filene og krever at de er samme uttrykk, med et sekundfelt foran.
 *
 *   **`runOnStartup` er ikke satt.** Den ville kjørt jobben ved hver deploy.
 *
 *   **Begge inngangsportene kjører den SAMME jobben.** Lå bokføringen i hver
 *   handler, ville admin-panelet fått to litt ulike bilder av samme jobb
 *   avhengig av hvem som startet den.
 *
 *   **Overstyringen må kunne skrives feil uten å ta ned appen.**
 *   `POSTNUMRE_SCHEDULE` kommer fra app settings og kan inneholde hva som
 *   helst — og et uttrykk Azure ikke kan tolke feiler nettopp VED
 *   REGISTRERING. Vakten i `lib/jobber.js` prøves begge veier, og den
 *   avviste verdien skal stå i svaret: en verdi som bare forsvinner er
 *   umulig å feilsøke.
 *
 * Kjøres med:  node api/test/timer-trigger.test.js
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

const plattform = require('../src/lib/plattform');

// ---------- 1. vakten svarer riktig ----------
{
    const med = (miljo) => {
        const foer = process.env.MILJO;
        if (miljo === undefined) delete process.env.MILJO;
        else process.env.MILJO = miljo;
        try { return plattform.stotterTimere(); } finally {
            if (foer === undefined) delete process.env.MILJO;
            else process.env.MILJO = foer;
        }
    };
    sjekk('dev kjører timere', med('dev'), true);
    sjekk('pilot gjør ikke', med('pilot'), false);
    // `production` er pilotens gamle navn, og må normaliseres FØR oppslaget.
    // Gjør den ikke det, svarer vakten «nei» av feil grunn i dag — og «ja» av
    // feil grunn den dagen pilot legges inn i lista.
    sjekk('production er pilot, ikke et ukjent miljø', med('production'), false);
    sjekk('prod gjør ikke', med('prod'), false);
    sjekk('lokal gjør ikke', med('lokal'), false);
    sjekk('ukjent miljø gjør ikke', med('staging'), false);
    sjekk('usatt gjør ikke', med(undefined), false);

    // ALIASET MÅ NORMALISERES FØR OPPSLAGET, og det kan ikke prøves på de
    // ekte listene: ingen av dem inneholder et alias-mål ennå. Med et
    // innsendt sett kan det prøves i dag, og feilen blir fanget nå i stedet
    // for den dagen pilot legges inn i lista i steg 6.
    const medSett = (miljo, sett) => {
        const foer = process.env.MILJO;
        process.env.MILJO = miljo;
        try { return plattform.gjelderHer(sett); } finally {
            if (foer === undefined) delete process.env.MILJO;
            else process.env.MILJO = foer;
        }
    };
    sjekk('production treffer en liste med pilot i',
        medSett('production', new Set(['pilot'])), true);
    sjekk('og treffer ikke en liste med production i',
        medSett('production', new Set(['production'])), false);
    sjekk('store bokstaver og mellomrom teller ikke',
        medSett('  PRODUCTION \n', new Set(['pilot'])), true);
}

// ---------- 2. registreringen skjer bare der ----------
//
// Den ekte modulen lastes, med en stubbet @azure/functions som teller
// registreringene. Det er forskjellen på å lese koden og å kjøre den: en vakt
// som står inne i handleren i stedet for rundt `app.timer` ser nesten lik ut.
//
// Lasteren brukes av både 2 og 3: den gir den EKTE formen — opsjonene Azure
// faktisk ville fått — i stedet for et regulæruttrykk mot kildekoden. Den tar
// derfor også overstyringen, slik at `POSTNUMRE_SCHEDULE` kan prøves på veien
// den virkelig går: lest ved modullast, inne i vakten.
const stiPostnumre = require.resolve('../src/functions/postnumre.js');
const lastMed = (miljo, overstyring) => {
    const timere = [];
    const ruter = [];
    const ekte = Module._load;
    Module._load = function (forespurt, ...r) {
        if (forespurt === '@azure/functions') {
            return {
                app: {
                    http: (navn, opts) => ruter.push({ navn, opts }),
                    timer: (navn, opts) => timere.push({ navn, opts })
                }
            };
        }
        return ekte.call(this, forespurt, ...r);
    };
    const foer = process.env.MILJO;
    const foerSchedule = process.env.POSTNUMRE_SCHEDULE;
    process.env.MILJO = miljo;
    if (overstyring === undefined) delete process.env.POSTNUMRE_SCHEDULE;
    else process.env.POSTNUMRE_SCHEDULE = overstyring;
    delete require.cache[stiPostnumre];
    // plattform.js og jobber.js leser env ved KALL, ikke ved last, så de
    // trenger ingen cache-tømming — men postnumre.js gjør vakten og
    // schedule-oppslaget ved LAST.
    try { require(stiPostnumre); } finally {
        Module._load = ekte;
        if (foer === undefined) delete process.env.MILJO;
        else process.env.MILJO = foer;
        if (foerSchedule === undefined) delete process.env.POSTNUMRE_SCHEDULE;
        else process.env.POSTNUMRE_SCHEDULE = foerSchedule;
        delete require.cache[stiPostnumre];
    }
    return { timere, ruter };
};

{
    const dev = lastMed('dev');
    sjekk('dev registrerer én timer', dev.timere.length, 1);
    sjekk('og den heter noe gjenkjennelig', dev.timere[0]?.navn, 'postnumreTimer');
    sjekk('dev registrerer rutene også', dev.ruter.length > 0, true);

    for (const miljo of ['production', 'prod', 'staging']) {
        const m = lastMed(miljo);
        sjekk(`${miljo} registrerer INGEN timer`, m.timere.length, 0);
        // Og rutene er uberørt — vakten skal ikke ha slått ut noe annet.
        sjekk(`${miljo} har like mange ruter som dev`, m.ruter.length, dev.ruter.length);
    }
}

// ---------- 3. NCRONTAB mot GitHub-cron ----------
//
// Tidspunktet står i `lib/jobber.js` fra 17.10.2026, og det er DET registeret
// som leses her — ikke et regulæruttrykk mot `schedule:` i postnumre.js. Den
// linja er ikke et uttrykk lenger, den er et oppslag, og en test som leter
// etter en literal der ville blitt grønn av å finne ingenting.
{
    const { JOBBER, jobbSchedule, gyldigNcrontab, overstyring } = require('../src/lib/jobber');
    sjekk('registeret har jobber', JOBBER.length > 0, true);

    for (const jobb of JOBBER) {
        sjekk(`${jobb.id}: standardSchedule har seks felt`,
            String(jobb.standardSchedule).split(/\s+/).length, 6);

        // DEN EGENTLIGE SJEKKEN. Timeren i dev og cron-workflowen mot pilot og
        // prod skal beskrive SAMME tidspunkt, og i dette tilfellet betyr det
        // bokstavelig talt samme uttrykk med «0 » foran. Endres den ene uten
        // den andre, kjører miljøene på ulik klokke — og ingenting feiler, det
        // bare skjer til feil tid.
        if (!jobb.workflow) continue;
        const wf = les('.github', 'workflows', jobb.workflow);
        const w = /- cron: '([^']+)'/.exec(wf);
        sjekk(`${jobb.id}: fant cron i ${jobb.workflow}`, !!w, true);
        const github = w?.[1] || '';
        sjekk(`${jobb.id}: GitHub-cron har fem felt`, github.split(/\s+/).length, 5);
        sjekk(`${jobb.id}: timeren og workflowen beskriver samme tidspunkt`,
            jobb.standardSchedule, `0 ${github}`);
    }

    // Kommentarene må bort: ordet står i forklaringen rett over schedulen, og
    // en sjekk på at noe IKKE finnes blir ellers rød av sin egen begrunnelse.
    sjekk('runOnStartup er ikke satt',
        /runOnStartup/.test(utenKommentarer(les('api', 'src', 'functions', 'postnumre.js'))), false);

    // ---- vakten mot et uttrykk Azure ikke kan tolke ----
    //
    // Verdien kommer fra en app-setting, og `app.timer(...)` feiler VED
    // REGISTRERING på et uttrykk den ikke forstår — altså på den måten som
    // kan ta ned hele appen. Vakten må derfor holde, og den må holde på det
    // som faktisk skrives feil: fem felt limt inn fra en GitHub-workflow.
    sjekk('seks felt er gyldig', gyldigNcrontab('0 30 4 15 1,7 *'), true);
    sjekk('fem felt er ikke', gyldigNcrontab('30 4 15 1,7 *'), false);
    sjekk('sju felt er ikke', gyldigNcrontab('0 0 30 4 15 1,7 *'), false);
    sjekk('tom er ikke', gyldigNcrontab(''), false);
    sjekk('udefinert er ikke', gyldigNcrontab(undefined), false);
    sjekk('intervallformen er gyldig', gyldigNcrontab('0 */5 * * * *'), true);
    sjekk('ukedagsnavn er gyldig', gyldigNcrontab('0 0 9 * * MON-FRI'), true);
    sjekk('slingrende mellomrom teller ikke', gyldigNcrontab('  0  30 4 15 1,7 * '), true);
    sjekk('søppeltegn er ikke gyldig', gyldigNcrontab('0 30 4 15 1,7 ;rm'), false);

    // ---- overstyringen leses, for HVER jobb i lista ----
    //
    // `overstyring()` er en switch på `scheduleVar`, fordi navnet må stå
    // SKREVET UT for at env-inventaret skal se app-settingen. Prisen er at en
    // ny jobb i steg 5 kan få en `scheduleVar` uten en `case` — og da er
    // overstyringen en stille no-op. Her settes env-varen for hver jobb i
    // lista, og det kreves at den leses.
    for (const jobb of JOBBER) {
        sjekk(`${jobb.id}: har en scheduleVar`, typeof jobb.scheduleVar, 'string');
        const foer = process.env[jobb.scheduleVar];
        process.env[jobb.scheduleVar] = 'prøveverdi-fra-testen';
        try {
            sjekk(`${jobb.id}: ${jobb.scheduleVar} leses`,
                overstyring(jobb), 'prøveverdi-fra-testen');
        } finally {
            if (foer === undefined) delete process.env[jobb.scheduleVar];
            else process.env[jobb.scheduleVar] = foer;
        }
    }

    // ---- og den avviste verdien forsvinner ikke i stillhet ----
    //
    // «Jeg satte den, og jobben kjører fortsatt på gammel tid» ser likt ut
    // enten verdien ble avvist, aldri lest, eller satt i feil miljø. Da må
    // svaret bære årsaken.
    const medSchedule = (verdi, jobb) => {
        const foer = process.env[jobb.scheduleVar];
        if (verdi === undefined) delete process.env[jobb.scheduleVar];
        else process.env[jobb.scheduleVar] = verdi;
        try { return jobbSchedule(jobb); } finally {
            if (foer === undefined) delete process.env[jobb.scheduleVar];
            else process.env[jobb.scheduleVar] = foer;
        }
    };
    const postnumre = JOBBER.find(j => j.id === 'postnumre-bring');
    sjekk('fant postnummerjobben', !!postnumre, true);

    const uten = medSchedule(undefined, postnumre);
    sjekk('uten overstyring gjelder standarden', uten.schedule, postnumre.standardSchedule);
    sjekk('og kilden sier det', uten.kilde, 'standard');
    sjekk('og ingenting er avvist', 'avvist' in uten, false);

    const tom = medSchedule('   ', postnumre);
    sjekk('bare mellomrom er ingen overstyring', tom.kilde, 'standard');
    sjekk('og det er ikke en avvist verdi heller', 'avvist' in tom, false);

    const gyldig = medSchedule('0 */5 * * * *', postnumre);
    sjekk('en gyldig overstyring gjelder', gyldig.schedule, '0 */5 * * * *');
    sjekk('og kilden navngir app-settingen', gyldig.kilde, postnumre.scheduleVar);

    const ugyldig = medSchedule('30 4 15 1,7 *', postnumre);
    sjekk('en ugyldig overstyring faller tilbake', ugyldig.schedule, postnumre.standardSchedule);
    sjekk('og sier at den ble avvist', ugyldig.avvist, '30 4 15 1,7 *');
    // `String(... || '')`: en mutasjon som fjerner `grunn` skal gjøre DENNE
    // sjekken rød, ikke velte hele testfila før de neste rekker å kjøre.
    sjekk('og navngir app-settingen i grunnen',
        String(ugyldig.grunn || '').includes(postnumre.scheduleVar), true);
    sjekk('og peker på sekundfeltet', /sekund/i.test(ugyldig.grunn), true);

    // ---- HELE VEIEN: det Azure faktisk ville fått ----
    //
    // Resolveren kan svare riktig mens registreringen fortsatt sender
    // standarden — det er to ting, og det er den siste som bestemmer når
    // jobben kjører. Her leses opsjonene `app.timer` ble kalt med.
    sjekk('registrert schedule uten overstyring',
        lastMed('dev').timere[0]?.opts?.schedule, postnumre.standardSchedule);
    sjekk('registrert schedule MED overstyring',
        lastMed('dev', '0 */5 * * * *').timere[0]?.opts?.schedule, '0 */5 * * * *');
    sjekk('registrert schedule med en ugyldig overstyring',
        lastMed('dev', '30 4 15 1,7 *').timere[0]?.opts?.schedule, postnumre.standardSchedule);

    // Og app-settingen må stå i inventaret — ellers er den usynlig for den
    // som setter opp miljøet. `env-inventar.test.js` krever det av alt koden
    // leser; her kreves det at den leses med navnet skrevet ut, som er det
    // scanneren der ser.
    const jobberKilde = utenKommentarer(les('api', 'src', 'lib', 'jobber.js'));
    for (const jobb of JOBBER) {
        sjekk(`${jobb.id}: ${jobb.scheduleVar} leses med navnet skrevet ut`,
            jobberKilde.includes(`process.env.${jobb.scheduleVar}`), true);
    }
}

// ---------- 4. én jobb, to innganger ----------
{
    const fn = utenKommentarer(les('api', 'src', 'functions', 'postnumre.js'));
    const jobb = utenKommentarer(les('api', 'src', 'lib', 'postnummer-jobb.js'));

    // To kall: HTTP-handleren og timeren. Destruktureringen teller ikke —
    // den har ingen parentes.
    sjekk('begge innganger kaller jobben',
        (fn.match(/kjorBringOppdatering\(/g) || []).length, 2);

    // Bokføringen SKRIVES bare i jobben. Statusraden LESES fortsatt i
    // handleren — det er GET /api/postnumre/status — så sjekken må være på
    // skrivingen, ikke på at rowkeyen nevnes.
    sjekk('handleren skriver ingen statusrad', /upsertEntity\(/.test(fn), false);
    sjekk('jobben gjør det', /upsertEntity\(/.test(jobb), true);
    sjekk('og handleren leser den fortsatt',
        /getEntity\('Meta', 'Postnumre-Bring'\)/.test(fn), true);
    sjekk('hendelsesloggingen bare i jobben', /postnumre\.bring-oppdatert/.test(fn), false);
    sjekk('og den skjer der', /postnumre\.bring-oppdatert/.test(jobb), true);

    // Handleren skal ikke kalle Bring direkte lenger.
    sjekk('handleren kaller ikke Bring selv', /oppdaterFraBring\(/.test(fn), false);
}

// ---------- 5. jobben kaster aldri ----------
//
// Timeren VENTER på den. Kaster den, blir det en uhåndtert feil i hosten i
// stedet for en statusrad som sier hva som gikk galt.
async function jobbsjekk() {
    const sti = require.resolve('../src/lib/postnummer-jobb.js');
    const skrevet = [];
    const kjor = async (bringSvar) => {
        skrevet.length = 0;
        const ekte = Module._load;
        Module._load = function (forespurt, ...r) {
            if (forespurt === './bring-postnummer') return { oppdaterFraBring: bringSvar };
            if (forespurt === './storage') {
                return { tabellKlient: () => ({
                    createTable: async () => {},
                    upsertEntity: async (e) => { skrevet.push(e); }
                }) };
            }
            if (forespurt === './hendelser-storage') return { logg: () => {} };
            return ekte.call(this, forespurt, ...r);
        };
        delete require.cache[sti];
        try {
            const { kjorBringOppdatering } = require(sti);
            return await kjorBringOppdatering({ kilde: 'test' });
        } finally {
            Module._load = ekte;
            delete require.cache[sti];
        }
    };

    const godt = await kjor(async () => ({ antallSkrevet: 5, antallSlettet: 0, varighetSekunder: 1 }));
    sjekk('vellykket kjøring gir ok', godt.status, 'ok');
    sjekk('og tallene følger med', godt.antallSkrevet, 5);
    sjekk('statusraden går fra kjører til ok',
        skrevet.map(e => e.Status), ['kjører', 'ok']);

    let kastet = null;
    let vondt = null;
    try {
        vondt = await kjor(async () => { throw new Error('Bring svarte ikke'); });
    } catch (e) { kastet = e.message; }
    sjekk('en feilet kjøring kaster ikke', kastet, null);
    sjekk('den returnerer status feil', vondt?.status, 'feil');
    sjekk('med årsaken i seg', /Bring svarte ikke/.test(vondt?.melding || ''), true);
    // Og årsaken står i statusraden, ikke bare i returverdien — det er den
    // admin-panelet leser.
    sjekk('statusraden ender på feil', skrevet.map(e => e.Status), ['kjører', 'feil']);
    sjekk('og bærer feilteksten',
        /Bring svarte ikke/.test(skrevet[skrevet.length - 1]?.SistFeil || ''), true);
}

jobbsjekk().then(() => {
    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
}).catch((e) => { console.log('TESTEN KRASJET:', e.stack); process.exit(1); });
