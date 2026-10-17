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
    }
];

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
    const standard = { schedule: jobb.standardSchedule, kilde: 'standard' };
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
    return { schedule: raatt, kilde: jobb.scheduleVar };
}

module.exports = {
    JOBBER, jobbForId, jobbSchedule, gyldigNcrontab, overstyring, FELT_I_NCRONTAB
};
