/**
 * Hvilke bakgrunnsjobber som finnes, og når de kjører.
 *
 * Én jobb er bokført på tre steder i dag: `app.timer(...)` i dev, en
 * cron-workflow i GitHub Actions for pilot og prod, og en statusrad i
 * `CacheMetadata` som admin-panelet leser. De tre MÅ si det samme om samme
 * jobb, og de gjorde det bare fordi noen husket å endre alle tre.
 *
 * Her står det én gang: navnet, ruta, statusraden, standard-schedulen og
 * navnet på app-settingen som kan overstyre den. `functions/postnumre.js`
 * registrerer timeren fra denne lista, `functions/jobber.js` viser den, og
 * `api/test/timer-trigger.test.js` leser `standardSchedule` mot cron-en i
 * workflowen og krever at de beskriver samme tidspunkt.
 *
 * Lista vokser i steg 5, når de sju andre cron-jobbene flyttes — se
 * `docs/BESLUTNING-EGEN-FUNCTION-APP.md`.
 */
const postnummerJobb = require('./postnummer-jobb');
const refreshFsJobb = require('./refresh-fs-jobb');
const oppslaglisteJobb = require('./oppslagsliste-jobb');
const nokkelsjekkJobb = require('./nokkelkalender-jobb');
const teamSynkJobb = require('./team-synk-jobb');

/**
 * NCRONTAB har SEKS felt — sekund først. GitHub-cron har fem.
 *
 * Skrives GitHub-uttrykket rett inn i en `standardSchedule`, leses
 * «30 4 15 1,7 *» som sekund-minutt-time-dag-måned og kjører 1,7 ganger i uka
 * i stedet for to ganger i året. Ingenting feiler — jobben kjører bare til
 * feil tid.
 */
const FELT_I_NCRONTAB = 6;

const JOBBER = [
    {
        id: 'postnumre-bring',
        navn: 'Postnummerregister (Bring)',
        beskrivelse: 'Henter Bring sitt postnummerregister og erstatter hele tabellen.',
        rute: 'postnumre/refresh-bring',
        // Statusraden bor i jobbmodulen, og leses HERFRA. To kopier av
        // «hvilken rad er dette» ville gitt et admin-panel som leser en annen
        // rad enn jobben skriver, og det ser ut som «jobben kjørte aldri».
        statusrad: { partisjon: postnummerJobb.PK, rad: postnummerJobb.RK },
        // 04:30 UTC den 15. januar og 15. juli. Bring oppdaterer registeret
        // ~1 gang i måneden; to ganger i året er nok.
        standardSchedule: '0 30 4 15 1,7 *',
        scheduleVar: 'POSTNUMRE_SCHEDULE',
        // Cron-workflowen som kjører den SAMME jobben mot pilot og prod, så
        // lenge plattformen der ikke har timere. Testen leser cron-en i denne
        // fila og krever at den stemmer med `standardSchedule`.
        workflow: 'refresh-postnumre.yml'
    },
    {
        id: 'refresh-fs',
        navn: 'FS-data (emner, studenter)',
        beskrivelse: 'Henter emner, studenter, filterstudenter og klasser fra FS.',
        rute: 'refresh-fs',
        // `FS-Emner` er både jobbens rad og én av kildene FS-fanen viser — se
        // begrunnelsen i refresh-fs-jobb.js.
        statusrad: { partisjon: refreshFsJobb.PK, rad: refreshFsJobb.RK },
        // 04:00 UTC daglig. Først av nattjobbene: team-synken 04:30 og
        // oppslagslistene 05:30 leser data den skriver.
        standardSchedule: '0 0 4 * * *',
        scheduleVar: 'REFRESH_FS_SCHEDULE',
        workflow: 'refresh-fs.yml'
    },
    {
        id: 'oppslaglister',
        navn: 'Oppslagslister',
        beskrivelse: 'Bygger nedtrekkslistene fra innsendte skjemaer.',
        rute: 'oppslaglister/oppdater',
        // JOBBENS rad, ikke de per-liste radene. De heter
        // `Oppslagsliste-<navn>` og vises i Oppslagslister-fanen.
        statusrad: { partisjon: oppslaglisteJobb.JOBB_PK, rad: oppslaglisteJobb.JOBB_RK },
        // 05:30 UTC daglig — etter FS-refreshen, som listene leser fra.
        standardSchedule: '0 30 5 * * *',
        scheduleVar: 'OPPSLAGLISTER_SCHEDULE',
        workflow: 'refresh-oppslagsliste.yml'
    },
    {
        id: 'team-synk',
        navn: 'Team-synkronisering',
        beskrivelse: 'Melder rolleinnehavere inn og ut av Teams-teamene.',
        rute: 'team-synk',
        statusrad: { partisjon: teamSynkJobb.PK, rad: teamSynkJobb.RK },
        // 04:30 UTC daglig — før arbeidsdagen, etter de nattlige importene.
        standardSchedule: '0 30 4 * * *',
        scheduleVar: 'TEAM_SYNK_SCHEDULE',
        workflow: 'team-synk.yml'
    },
    {
        id: 'sjekk-nokler',
        navn: 'Nøkkelkalender (utløpsvarsler)',
        beskrivelse: 'Varsler ADMIN_UPNS om hemmeligheter som nærmer seg utløp.',
        rute: 'nokkelkalender/sjekk',
        statusrad: { partisjon: nokkelsjekkJobb.PK, rad: nokkelsjekkJobb.RK },
        // 07:00 UTC daglig — sist av nattjobbene, så varselet ikke drukner
        // i det de andre skriver.
        standardSchedule: '0 0 7 * * *',
        scheduleVar: 'NOKKELSJEKK_SCHEDULE',
        workflow: 'sjekk-nokler.yml'
    }
];

/**
 * Timere som FAKTISK ble registrert i denne prosessen.
 *
 * Jobber-fanen sa «Timer i appen» fordi `stotterTimere()` svarer ja i dev.
 * Det er en påstand om MILJØET, ikke om prosessen: en jobb kan stå i
 * registeret uten at noen kaller `app.timer` for den, og da viser panelet en
 * timer som ikke finnes. 17.10.2026 var det nettopp det spørsmålet som ikke
 * lot seg besvare da oppslagslistejobben ikke fyrte — «er den registrert?» og
 * «er den registrert, men fyrer ikke?» krever helt ulik feilsøking, og
 * panelet skilte dem ikke.
 *
 * `meldTimer()` kalles av hver funksjonsfil rett etter `app.timer(...)`.
 *
 * **Den sier at KALLET ble gjort, ikke at verten godtok det.** Verten kan
 * fortsatt avvise en timer den ikke klarer å planlegge — mangler
 * `AzureWebJobsStorage`, eller identiteten rollene på den kontoen, har
 * timeren ingen plass å lagre hvor den er i planen. Men to av tre mulige
 * årsaker lar seg skille med dette, og i dag lot ingen av dem seg skille.
 */
const REGISTRERTE = new Map();

function meldTimer(jobbId, navn, schedule) {
    REGISTRERTE.set(jobbId, { navn, schedule, tidspunkt: new Date().toISOString() });
}

/** Bare for test: glem det som er meldt. */
function glemTimere() {
    REGISTRERTE.clear();
}

function jobbForId(id) {
    return JOBBER.find(j => j.id === id) || null;
}

/**
 * Ser uttrykket ut som en NCRONTAB?
 *
 * Dette er en VAKT, ikke en parser. Grunnen er at verdien kommer fra en
 * app-setting: en schedule som Azure ikke klarer å tolke, får
 * `app.timer(...)` til å feile VED REGISTRERING — og en timer-registrering
 * som feiler kan velte oppstarten for hele appen, slik at HTTP-rutene blir
 * borte også. Overstyringen skal kunne skrives feil uten å ta ned API-et.
 *
 * Feltinnholdet slippes gjennom med vilje (tall, `*`, `,`, `-`, `/` og navn
 * som `MON` og `JAN` er alle gyldige i NCRONTAB). Det den fanger, er den
 * feilen som faktisk skjer: fem felt limt inn fra en GitHub-workflow.
 */
function gyldigNcrontab(uttrykk) {
    const felt = String(uttrykk || '').trim().split(/\s+/);
    if (felt.length !== FELT_I_NCRONTAB) return false;
    return felt.every(f => /^[0-9A-Za-z*,/-]+$/.test(f));
}

/**
 * Overstyringen for en jobb, lest fra app settings.
 *
 * NAVNENE STÅR SKREVET UT. `process.env[jobb.scheduleVar]` ville vært kortere
 * og gjort `api/test/env-inventar.test.js` blind for app-settingen — da står
 * den utenfor inventaret, og en oversikt som ser komplett ut og ikke er det er
 * verre enn ingen. Samme grunn som i `lagringsvalg.js`.
 *
 * En jobb uten `case` her får ingen overstyring. Det er en stille feil i den
 * billige retningen — standarden gjelder — og `api/test/timer-trigger.test.js`
 * setter env-varen for hver jobb i lista og krever at den leses.
 */
function overstyring(jobb) {
    switch (jobb && jobb.scheduleVar) {
        case 'POSTNUMRE_SCHEDULE': return process.env.POSTNUMRE_SCHEDULE;
        case 'REFRESH_FS_SCHEDULE': return process.env.REFRESH_FS_SCHEDULE;
        case 'OPPSLAGLISTER_SCHEDULE': return process.env.OPPSLAGLISTER_SCHEDULE;
        case 'TEAM_SYNK_SCHEDULE': return process.env.TEAM_SYNK_SCHEDULE;
        case 'NOKKELSJEKK_SCHEDULE': return process.env.NOKKELSJEKK_SCHEDULE;
        default: return undefined;
    }
}

/**
 * Schedulen som gjelder for en jobb, og HVOR DEN KOMMER FRA.
 *
 * Returnerer alltid et objekt med `schedule` satt, og `kilde` som sier om det
 * er standarden eller app-settingen. Ble en overstyring avvist, står den i
 * `avvist` med `grunn` — en verdi som bare forsvinner er umulig å feilsøke:
 * «jeg satte den, og jobben kjører fortsatt på gammel tid» ser likt ut enten
 * verdien ble avvist, aldri lest, eller satt i feil miljø.
 *
 * Azure leser `schedule` ved REGISTRERING, altså ved modullast. En endret
 * app-setting slår derfor inn ved neste omstart av appen, ikke med en gang.
 */
function jobbSchedule(jobb) {
    const raatt = String(overstyring(jobb) ?? '').trim();
    // `avvist` og `grunn` er ALLTID satt, med null når ingenting ble avvist.
    // JSON.stringify dropper `undefined`, og da er «ingenting galt» umulig å
    // skille fra «feltet finnes ikke i denne versjonen av API-et» for den som
    // leser svaret i admin.
    const standard = { schedule: jobb.standardSchedule, kilde: 'standard', avvist: null, grunn: null };
    if (!raatt) return standard;
    if (!gyldigNcrontab(raatt)) {
        return {
            ...standard,
            avvist: raatt,
            grunn: `${jobb.scheduleVar} ser ikke ut som en NCRONTAB (${FELT_I_NCRONTAB} felt, `
                + 'sekund først). Standarden brukes. GitHub-cron har fem felt — mangler det '
                + 'et sekundfelt foran?'
        };
    }
    return { schedule: raatt, kilde: jobb.scheduleVar, avvist: null, grunn: null };
}

/**
 * Hva som TRIGGER jobbene her, og når — uten å røre lagringen.
 *
 * Svaret avhenger av miljøet, og det er hele grunnen til at det regnes ut ett
 * sted: i dev registrerer appen en timer, i pilot og prod kjører GitHub
 * Actions den samme jobben over HTTP. Står den regelen i admin-sida i tillegg,
 * får panelet og appen hver sin mening om hva som faktisk kjører.
 *
 * **I et miljø uten timere har overstyringen ingen virkning.** Da vises
 * standarden, og en verdi som likevel er satt står i `overstyringIgnorert` —
 * ellers er «jeg satte POSTNUMRE_SCHEDULE i pilot og ingenting skjedde» en
 * stille feil, og den er nettopp en man bruker en time på.
 */
function jobbOversikt() {
    const { stotterTimere } = require('./plattform');
    const timer = stotterTimere();
    return JOBBER.map((jobb) => {
        const felles = {
            id: jobb.id,
            navn: jobb.navn,
            beskrivelse: jobb.beskrivelse,
            rute: jobb.rute,
            statusrad: jobb.statusrad,
            standardSchedule: jobb.standardSchedule,
            scheduleVar: jobb.scheduleVar,
            workflow: jobb.workflow || null
        };
        if (timer) {
            const valgt = jobbSchedule(jobb);
            return {
                ...felles,
                trigger: 'timer',
                // Alltid satt: `null` betyr «ingen har meldt fra om en
                // registrering», og det er et svar, ikke et manglende felt.
                registrert: REGISTRERTE.get(jobb.id) || null,
                schedule: valgt.schedule,
                scheduleKilde: valgt.kilde,
                avvist: valgt.avvist,
                grunn: valgt.grunn,
                overstyringIgnorert: null
            };
        }
        return {
            ...felles,
            trigger: 'github-actions',
            // Ingen timer registreres her, så feltet er alltid null. Det
            // STÅR likevel, slik at frontend ikke må gjette om fraværet
            // betyr «ikke registrert» eller «gammelt API».
            registrert: null,
            schedule: jobb.standardSchedule,
            scheduleKilde: 'workflow',
            avvist: null,
            grunn: null,
            overstyringIgnorert: String(overstyring(jobb) || '').trim() || null
        };
    });
}

/**
 * Statusraden for en jobb, i den formen admin-panelet leser.
 *
 * ÉN leser, ikke to. `GET /api/postnumre/status` leste den samme raden med sin
 * egen feltmapping; to kopier av «hva heter feltene i denne raden» ville gitt
 * et admin-panel som viser «aldri kjørt» for en jobb som har kjørt, fordi den
 * ene kopien stavet et kolonnenavn annerledes.
 *
 * Alle feltene er alltid med, også når raden ikke finnes. Et felt som
 * forsvinner gjør «jobben har aldri kjørt» umulig å skille fra «denne
 * versjonen av API-et svarer ikke på det».
 */
const TOM_STATUS = {
    status: 'aldri kjørt', sistOppdatert: null, antallRader: null, antallSlettet: null,
    varighetSekunder: null, startet: null, ferdig: null, kilde: null, sistFeil: ''
};

async function lesStatusrad(statusrad) {
    const { tabellKlient } = require('./storage');
    const t = tabellKlient('CacheMetadata');
    try {
        const e = await t.getEntity(statusrad.partisjon, statusrad.rad);
        return {
            status: e.Status || 'ukjent',
            sistOppdatert: e.SistOppdatert || null,
            antallRader: e.AntallRader ?? null,
            antallSlettet: e.AntallSlettet ?? null,
            varighetSekunder: e.VarighetSekunder ?? null,
            startet: e.Startet || null,
            ferdig: e.Ferdig || null,
            kilde: e.Kilde || null,
            sistFeil: e.SistFeil || ''
        };
    } catch (err) {
        if (err.statusCode !== 404) throw err;
        return { ...TOM_STATUS };
    }
}

module.exports = {
    JOBBER, jobbForId, jobbSchedule, gyldigNcrontab, overstyring, FELT_I_NCRONTAB,
    jobbOversikt, lesStatusrad, TOM_STATUS, meldTimer, _glemTimere: glemTimere
};
