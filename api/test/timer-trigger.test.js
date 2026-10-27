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
 *   avhengig av hvem som startet den. HVA jobben skriver, prøves i
 *   `jobb-bokforing.test.js`; her prøves at begge veiene kaller den.
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
    // Prod kom til 27.10.2026, da prod v3 ble en frittstående Function App.
    // HTTP-veien er fire-and-forget og virket bare på SWA Managed Functions;
    // på en Function App fullfører verten invokasjonen når handleren
    // returnerer, og alle ni jobbene sto på «aldri kjørt».
    sjekk('prod kjører timere', med('prod'), true);
    // PILOT SKAL IKKE. Den kjører fortsatt på SWA Managed Functions, der en
    // timer-registrering kan velte oppstarten for hele appen.
    sjekk('pilot gjør ikke', med('pilot'), false);
    // `production` er pilotens gamle navn, og må normaliseres FØR oppslaget.
    // DETTE ER IKKE LENGER EN TEORETISK SJEKK: lista inneholder nå `prod`, og
    // «production» ligner nok til at en manglende normalisering ville gitt
    // pilot timere — altså nettopp den registreringen som kan ta ned appen.
    sjekk('production er pilot, ikke prod', med('production'), false);
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
    // EN ALIAS I SELVE EVNELISTA ER EN STILLE NO-OP.
    //
    // `miljonavn()` normaliserer FØR oppslaget, så `KJORER_TIMERE` som
    // inneholder 'production' aldri kan treffe: navnet er allerede blitt
    // 'pilot'. Oppdaget ved mutasjonstesting 27.10.2026 — mutasjonen som la
    // 'production' inn i lista endret ingenting, og ingen test kunne se
    // forskjell på den og originalen.
    //
    // Det er ikke en teoretisk pirk: den som vil gi pilot timere i steg 6 og
    // skriver 'production' fordi det er det MILJO er satt til, får en liste
    // som ser riktig ut og ikke gjør noe.
    for (const [navn, sett] of [
        ['KJORER_TIMERE', plattform.KJORER_TIMERE],
        ['LØSER_KEYVAULT_REFERANSER', plattform.LØSER_KEYVAULT_REFERANSER]
    ]) {
        const aliaser = [...sett].filter(m => m in plattform.MILJO_ALIAS);
        sjekk(`${navn} inneholder ingen alias — de ville aldri truffet`, aliaser, []);
    }

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
/**
 * Hvilke funksjonsfiler registrerer en timer?
 *
 * LESES AV DISKEN, ikke skrevet ned her. En liste i testen ville vært en
 * fjerde kopi av «hvilke jobber finnes», og den som la til jobb nummer fire
 * ville fått grønt på en timer ingen prøvde.
 */
const timerFiler = fs.readdirSync(path.join(rot, 'api', 'src', 'functions'))
    .filter(n => n.endsWith('.js'))
    .filter(n => /app\.timer\(/.test(utenKommentarer(les('api', 'src', 'functions', n))));

const lastFil = (fil, miljo, overstyring) => {
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
    const sti = require.resolve(`../src/functions/${fil}`);
    delete require.cache[sti];
    // plattform.js og jobber.js leser env ved KALL, ikke ved last, så de
    // trenger ingen cache-tømming — men funksjonsfilene gjør vakten og
    // schedule-oppslaget ved LAST.
    try { require(sti); } finally {
        Module._load = ekte;
        if (foer === undefined) delete process.env.MILJO;
        else process.env.MILJO = foer;
        if (foerSchedule === undefined) delete process.env.POSTNUMRE_SCHEDULE;
        else process.env.POSTNUMRE_SCHEDULE = foerSchedule;
        delete require.cache[sti];
    }
    return { timere, ruter };
};

/** Postnumre-fila alene — brukt der sjekken handler om akkurat den. */
const lastMed = (miljo, overstyring) => lastFil('postnumre.js', miljo, overstyring);

/** Alle timer-filene, samlet. */
const lastAlle = (miljo) => {
    const timere = [];
    const ruter = [];
    for (const fil of timerFiler) {
        const m = lastFil(fil, miljo);
        timere.push(...m.timere);
        ruter.push(...m.ruter);
    }
    return { timere, ruter };
};

{
    const { JOBBER, jobbSchedule } = require('../src/lib/jobber');

    const dev = lastAlle('dev');
    sjekk('det finnes timer-filer i det hele tatt', timerFiler.length > 0, true);
    sjekk('dev registrerer én timer per jobb i registeret', dev.timere.length, JOBBER.length);
    sjekk('og alle har et navn', dev.timere.every(t => typeof t.navn === 'string' && t.navn), true);
    sjekk('navnene er unike', new Set(dev.timere.map(t => t.navn)).size, dev.timere.length);
    sjekk('dev registrerer rutene også', dev.ruter.length > 0, true);

    // HVER registrert schedule skal komme fra registeret, og HVER jobb i
    // registeret skal ha en timer. Uten begge retningene kan en jobb legges
    // inn i registeret uten at noen registrerer den — den vises da i
    // Jobber-fanen som «Timer i appen» og kjører aldri.
    const registrerte = dev.timere.map(t => t.opts?.schedule).sort();
    const forventede = JOBBER.map(j => jobbSchedule(j).schedule).sort();
    sjekk('de registrerte schedulene er registerets', registrerte, forventede);

    // `production` er pilotens gamle navn og skal IKKE få timere, selv om
    // lista nå inneholder `prod`. De to ligner nok til at en manglende
    // normalisering ville gitt pilot nettopp den registreringen som kan ta
    // ned appen — derfor står den fremst her.
    for (const miljo of ['production', 'staging']) {
        const m = lastAlle(miljo);
        sjekk(`${miljo} registrerer INGEN timer`, m.timere.length, 0);
        // Og rutene er uberørt — vakten skal ikke ha slått ut noe annet.
        sjekk(`${miljo} har like mange ruter som dev`, m.ruter.length, dev.ruter.length);
    }

    // Prod registrerer de samme timerne som dev — det er hele poenget med
    // endringen 27.10.2026.
    {
        const m = lastAlle('prod');
        sjekk('prod registrerer like mange timere som dev', m.timere.length, dev.timere.length);
        sjekk('og rutene er uberørt', m.ruter.length, dev.ruter.length);
        sjekk('og schedulene er de samme',
            m.timere.map(t => t.opts?.schedule).sort(), registrerte);
    }

    // ---- registreringen MELDES, og meldingen stemmer ----
    //
    // Jobber-fanen sier «Timer i appen» av at miljøet kjører timere. Uten en
    // melding fra selve registreringen kan den ikke skille «ingen timer er
    // registrert» fra «registrert, men fyrer ikke» — to tilstander med helt
    // ulik feilsøking. Her lastes filene for ekte, og det kreves at HVER jobb
    // i registeret har meldt seg.
    {
        const jobber = require('../src/lib/jobber');
        // MILJO må stå til dev mens oversikten LESES, ikke bare mens filene
        // lastes: i et miljø uten timere er `registrert` null per definisjon,
        // og den første versjonen av denne sjekken leste nettopp den grenen
        // og trodde registreringen manglet.
        const iDev = (fn) => {
            const foer = process.env.MILJO;
            process.env.MILJO = 'dev';
            try { return fn(); } finally {
                if (foer === undefined) delete process.env.MILJO;
                else process.env.MILJO = foer;
            }
        };
        jobber._glemTimere();
        lastAlle('dev');
        const oversikt = iDev(() => jobber.jobbOversikt());
        const uregistrerte = oversikt.filter(j => !j.registrert).map(j => j.id);
        sjekk('hver jobb melder fra om timeren sin', uregistrerte, []);
        sjekk('og navnet stemmer med det som ble registrert',
            oversikt.map(j => j.registrert?.navn).sort(),
            dev.timere.map(t => t.navn).sort());
        sjekk('og schedulen også',
            oversikt.map(j => j.registrert?.schedule).sort(), registrerte);

        // Og motsatt: uten en last er feltet null, ikke borte. «Ingen har
        // meldt fra» er et svar; et manglende felt er det ikke.
        jobber._glemTimere();
        const tomme = iDev(() => jobber.jobbOversikt());
        sjekk('uten registrering er feltet null', tomme.every(j => j.registrert === null), true);
        sjekk('men feltet finnes', tomme.every(j => 'registrert' in j), true);
        // Legg dem tilbake, så resten av fila ser samme tilstand som før.
        lastAlle('dev');
    }

    // Vakten må stå i HVER fil. En fil som registrerer timeren sin uten
    // `stotterTimere()` tar ned hele appen i pilot — og de andre filenes
    // vakter skjuler det ikke.
    for (const fil of timerFiler) {
        sjekk(`${fil}: registrerer i dev`, lastFil(fil, 'dev').timere.length > 0, true);
        sjekk(`${fil}: men ikke i pilot`, lastFil(fil, 'pilot').timere.length, 0);
        sjekk(`${fil}: vakten står rundt registreringen`,
            /if \(stotterTimere\(\)\) \{/.test(utenKommentarer(les('api', 'src', 'functions', fil))), true);
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
        const alle = [...wf.matchAll(/- cron: '([^']+)'/g)].map(m => m[1]);
        sjekk(`${jobb.id}: fant cron i ${jobb.workflow}`, alle.length > 0, true);

        // BACKUP HAR TO CRON-LINJER i samme workflow — full om søndagen,
        // delta ellers. Uten `workflowCron` ville begge jobbene blitt
        // sammenlignet mot den FØRSTE linja, og en drift i deltaet hadde gått
        // upåaktet hen: sjekken ville vært grønn mens deltaet kjørte til feil
        // tid i dev.
        if (alle.length > 1) {
            sjekk(`${jobb.id}: flertydig workflow krever workflowCron`, !!jobb.workflowCron, true);
        }
        const github = jobb.workflowCron || alle[0];
        sjekk(`${jobb.id}: workflowCron står faktisk i workflowen`, alle.includes(github), true);
        sjekk(`${jobb.id}: GitHub-cron har fem felt`, github.split(/\s+/).length, 5);
        sjekk(`${jobb.id}: timeren og workflowen beskriver samme tidspunkt`,
            jobb.standardSchedule, `0 ${github}`);
    }

    // OG MOTSATT: hver cron-linje i en workflow må være krevd av en jobb.
    // En kadens i GitHub Actions som ingen timer dekker, er en jobb som
    // slutter å kjøre i dev den dagen workflowen fjernes — og ingenting
    // sier fra.
    {
        const perWorkflow = new Map();
        for (const j of JOBBER) {
            if (!j.workflow) continue;
            if (!perWorkflow.has(j.workflow)) perWorkflow.set(j.workflow, new Set());
            perWorkflow.get(j.workflow).add(j.workflowCron || null);
        }
        for (const [wfNavn, krevde] of perWorkflow) {
            const alle = [...les('.github', 'workflows', wfNavn)
                .matchAll(/- cron: '([^']+)'/g)].map(m => m[1]);
            if (alle.length === 1) continue;   // entydig, workflowCron trengs ikke
            sjekk(`${wfNavn}: hver cron-linje er krevd av en jobb`,
                alle.filter(c => !krevde.has(c)).sort(), []);
        }
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
    sjekk('og ingenting er avvist', uten.avvist, null);

    const tom = medSchedule('   ', postnumre);
    sjekk('bare mellomrom er ingen overstyring', tom.kilde, 'standard');
    sjekk('og det er ikke en avvist verdi heller', tom.avvist, null);

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
//
// Tabellen er erklært, og det er en påstand testen kontrollerer: hver jobb i
// REGISTERET må stå her. En jobb som legges til uten en rad her ville sluppet
// unna hele seksjonen — og det er nettopp bokføringen som skiller «jobben
// kjørte» fra «noen trykket på en knapp».
const INNGANGER = [
    {
        ider: ['postnumre-bring'], fn: 'postnumre.js', jobbfil: 'postnummer-jobb.js',
        kall: 'kjorBringOppdatering', hendelse: 'postnumre.bring-oppdatert',
        radnokkel: "'Postnumre-Bring'"
    },
    {
        ider: ['refresh-fs'], fn: 'refresh-fs.js', jobbfil: 'refresh-fs-jobb.js',
        kall: 'kjorRefreshFs', hendelse: 'refresh-fs.oppdatert',
        // 'FS-Emner' står fortsatt i refresh-fs.js, i GET /status, som leser
        // FIRE kilderader med sine egne kolonner (klasse-diagnostikken). Det
        // er FS-fanens egen visning, ikke en kopi av jobbens bokføring — og
        // derfor er radnøkkelsjekken ikke med for denne.
        radnokkel: null
    },
    {
        ider: ['oppslaglister'], fn: 'oppslagsliste.js', jobbfil: 'oppslagsliste-jobb.js',
        kall: 'kjorOppslagslister', hendelse: 'oppslagsliste.oppdater',
        radnokkel: "'Jobb-Oppslaglister'"
    },
    {
        ider: ['team-synk'], fn: 'team-synk.js', jobbfil: 'team-synk-jobb.js',
        kall: 'kjorTeamSynk', hendelse: 'team.synk.ok',
        radnokkel: "'Jobb-Team-Synk'"
    },
    {
        ider: ['sjekk-nokler'], fn: 'nokkelkalender.js', jobbfil: 'nokkelkalender-jobb.js',
        kall: 'kjorNokkelsjekk', hendelse: 'nokkelkalender.varsel',
        radnokkel: "'Jobb-Nokkelsjekk'"
    },
    {
        ider: ['send-utsendinger'], fn: 'utsending.js', jobbfil: 'utsending-jobb.js',
        kall: 'kjorSendForfalte', hendelse: 'utsending.send-forfalte',
        radnokkel: "'Jobb-Utsending-Send'"
    },
    {
        ider: ['purre-utsendinger'], fn: 'utsending.js', jobbfil: 'utsending-jobb.js',
        kall: 'kjorPurring', hendelse: 'utsending.purre',
        radnokkel: "'Jobb-Utsending-Purre'"
    },
    {
        // BACKUP ER UNNTAKET, og det er erklært her med grunn: jobben ble
        // aldri flyttet til en lib, fordi begge inngangsportene allerede
        // delte `kjorBackupJobb` I SAMME FIL. Egenskapen vi er ute etter —
        // én jobb, én bokføring — holder altså allerede. En flytting for
        // formens skyld ville rørt 1135 linjer uten å gjøre noe sannere.
        //
        // To id-er, én rad: full og delta er to kadenser av den samme
        // jobben, og de kaller den samme funksjonen med ulik modus.
        ider: ['backup-full', 'backup-delta'],
        fn: 'backup.js', jobbfil: null,
        kall: 'kjorBackupJobb', hendelse: 'backup.kjort',
        radnokkel: null
    }
];

{
    const { JOBBER } = require('../src/lib/jobber');
    const alleIder = INNGANGER.flatMap(i => i.ider);
    sjekk('hver jobb i registeret står i tabellen',
        JOBBER.map(j => j.id).filter(id => !alleIder.includes(id)), []);
    sjekk('og ingen rad i tabellen er en rest',
        alleIder.filter(id => !JOBBER.some(j => j.id === id)), []);

    for (const i of INNGANGER) {
        const merke = i.ider.join('+');
        const f = utenKommentarer(les('api', 'src', 'functions', i.fn));

        if (!i.jobbfil) {
            // Jobben bor i funksjonsfila — se begrunnelsen i tabellen. Da er
            // det den SAMME egenskapen som prøves, bare innenfor én fil:
            // begge veier går gjennom den ene funksjonen, og bokføringen
            // skjer der, ikke per inngang.
            sjekk(`${merke}: jobben finnes som egen funksjon`,
                new RegExp(`async function ${i.kall}\\(`).test(f), true);
            // NAVNET telles, ikke kallet. Timeren går gjennom bokførings-
            // innpakningen, som tar jobben som parameter med en standardverdi
            // (`kjor = kjorBackupJobb`) — og en standardverdi har ingen
            // parentes. Første utgave av denne sjekken krevde tre KALL og ble
            // rød av nettopp den sømmen, med en melding som pekte feil vei.
            //
            // Tre forekomster: definisjonen, HTTP-veiens kall, og
            // standardverdien timer-veien går gjennom.
            sjekk(`${merke}: begge innganger går gjennom den`,
                (f.match(new RegExp(`\\b${i.kall}\\b`, 'g')) || []).length >= 3, true);
            // Og innpakningen må faktisk ha den som standard — ikke bare ta
            // en parameter som kalleren kan sende hva som helst inn i.
            sjekk(`${merke}: innpakningen har jobben som standard`,
                new RegExp(`=\\s*${i.kall}\\b`).test(f), true);
            // Hendelsen logges ÉN gang, inne i den delte funksjonen — ikke
            // en gang per inngangsport.
            sjekk(`${merke}: hendelsen logges ett sted`,
                (f.match(new RegExp(i.hendelse.replace('.', '\\.'), 'g')) || []).length, 1);
            continue;
        }

        const j = utenKommentarer(les('api', 'src', 'lib', i.jobbfil));

        // To kall: HTTP-handleren og timeren. Destruktureringen teller ikke —
        // den har ingen parentes.
        sjekk(`${merke}: begge innganger kaller jobben`,
            (f.match(new RegExp(`${i.kall}\\(`, 'g')) || []).length, 2);

        // Bokføringen SKRIVES bare i jobben.
        sjekk(`${merke}: handleren skriver ingen statusrad`, /upsertEntity\(/.test(f), false);
        sjekk(`${merke}: jobben gjør det`, /upsertEntity\(/.test(j), true);

        // Og hendelsen logges bare der. Lå den i handleren, ville en
        // timer-kjøring ikke dukket opp i Hendelser — og det er DEN raden
        // som beviser at timeren kjørte, ikke en logglinje som ruller forbi.
        sjekk(`${merke}: hendelsen logges i jobben`, f.includes(i.hendelse), false);
        sjekk(`${merke}: og den skjer der`, j.includes(i.hendelse), true);
        // Kilden må følge med inn, ellers står «startet av» tomt.
        sjekk(`${merke}: jobben bokfører hvem som startet den`, /Kilde: kilde/.test(j), true);

        if (i.radnokkel) {
            sjekk(`${merke}: radnøkkelen står ikke skrevet inn i handleren`,
                f.includes(i.radnokkel), false);
        }
    }
}

{
    const fn = utenKommentarer(les('api', 'src', 'functions', 'postnumre.js'));
    const jobb = utenKommentarer(les('api', 'src', 'lib', 'postnummer-jobb.js'));
    // Statusraden LESES fortsatt av handleren — det er GET
    // /api/postnumre/status — men gjennom den DELTE leseren, og raden pekes
    // ut av registeret. Står 'Meta' / 'Postnumre-Bring' skrevet inn i
    // handleren igjen, er feltnavnene og radnøkkelen tilbake i to
    // eksemplarer, og de to admin-fanene kan bli uenige om samme jobb.
    sjekk('handleren leser raden gjennom den delte leseren',
        /lesStatusrad\(/.test(fn), true);
    sjekk('og peker den ut via registeret',
        /jobbForId\('postnumre-bring'\)\.statusrad/.test(fn), true);
    sjekk('radnøkkelen står ikke skrevet inn i handleren',
        /'Postnumre-Bring'/.test(fn), false);
    sjekk('og leseren bor i registeret',
        /getEntity\(statusrad\.partisjon, statusrad\.rad\)/.test(
            utenKommentarer(les('api', 'src', 'lib', 'jobber.js'))), true);
    // Handleren skal ikke kalle Bring direkte lenger.
    sjekk('handleren kaller ikke Bring selv', /oppdaterFraBring\(/.test(fn), false);
}

// Bokføringen — statusraden, hendelsen og «kaster aldri» — lå her til
// 17.10.2026. Den bor nå i `api/test/jobb-bokforing.test.js`, for ALLE tre
// jobbene: denne fila handler om REGISTRERINGEN, den om hva jobben skriver.

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
