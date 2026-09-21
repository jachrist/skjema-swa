/**
 * Team-synkronisering i adminsiden.
 *
 * Feltet som slår på synkroniseringen står ved siden av lista det virker på,
 * og det er ikke tilfeldig: den som fyller det ut, skal se hvem som blir
 * meldt inn — og lese hva som skjer med dem som ikke står der.
 *
 * Tre ting testes, og to av dem handler om å ikke gjøre skade lett:
 *
 *   **Konsekvensen står ved feltet.** Ikke bare i en dokumentasjonsfil. Ordet
 *   «destruktivt» skal være der det brukes.
 *
 *   **«Kjør likevel» tilbys bare når sikringen faktisk har stoppet noe.** En
 *   knapp som alltid står der, inviterer til å klikke seg forbi en sperre man
 *   ikke har lest.
 *
 *   **Overstyringen krever en bekreftelse.** Den melder folk ut av et team,
 *   og det skal ikke skje på ett uoppmerksomt klikk.
 *
 * Kjøres med:  node frontend/test/team-synk-ui.test.js
 */
const fs = require('fs');
const path = require('path');
const { utenKommentarer } = require('../../scripts/test-kilde.js');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const rå = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
const kode = utenKommentarer(rå);

// ---------- feltet finnes og henger sammen med API-et ----------
{
    sjekk('team-feltet finnes', /id="team-navn"/.test(kode), true);
    sjekk('det lagres mot API-et', /api\.put\(`\/api\/team-synk\//.test(kode), true);
    sjekk('omfanget sendes med', /omfang: g\.Omfang \|\| ''/.test(kode), true);
    sjekk('statusen hentes', /api\.get\('\/api\/team-synk'\)/.test(kode), true);

    // Feilet statuskall skal ikke velte rollesiden — team er en tilleggs-
    // funksjon, rolleadministrasjonen er hovedjobben.
    sjekk('statuskallet er ufarlig hvis det feiler',
        /api\.get\('\/api\/team-synk'\)\.catch\(/.test(kode), true);
}

// ---------- konsekvensen står ved feltet ----------
{
    sjekk('ordet «destruktivt» står i grensesnittet', /destruktivt/i.test(kode), true);
    sjekk('det står at folk meldes ut', /meldes ut/i.test(kode), true);
    sjekk('sperrene er forklart', /Tom liste sendes aldri/.test(kode), true);
    // GUID-rådet er ikke pynt: to team kan hete det samme, og da treffer
    // flyten et tilfeldig av dem.
    sjekk('GUID anbefales', /gruppe-ID/.test(kode), true);
}

// ---------- overstyringen er ikke lett tilgjengelig ----------
{
    // Knappen skal være betinget, ikke fast.
    sjekk('«kjør likevel» er betinget', /stoppet\s*\n?\s*\?\s*`<button[^`]*teamKjor\(true\)/.test(kode), true);
    sjekk('betingelsen er at noe ble stoppet',
        /const stoppet = status\.SisteStatus === 'stoppet'/.test(kode), true);

    // Og den skal spørre først.
    sjekk('overstyring krever bekreftelse', /tillatFall && !confirm\(/.test(kode), true);
    sjekk('bekreftelsen sier hva som skjer', /meldes alle som ikke står på lista ut/.test(kode), true);

    // «Kjør nå» uten overstyring skal IKKE spørre — den er ufarlig, sperrene
    // gjelder fortsatt.
    sjekk('vanlig kjøring spør ikke', /teamKjor\(false\)/.test(kode), true);
}

// ---------- den daglige kjøringen finnes ----------
{
    const flyt = fs.readFileSync(
        path.join(__dirname, '..', '..', '.github', 'workflows', 'team-synk.yml'), 'utf8');
    sjekk('workflowen kaller endepunktet', /\/api\/team-synk/.test(flyt), true);
    sjekk('den kjører daglig', /schedule:[\s\S]{0,80}cron:/.test(flyt), true);
    sjekk('den autentiserer med scheduler-nøkkel', /x-scheduler-key/.test(flyt), true);
    // Den skal ikke kunne overstyre sperren.
    sjekk('workflowen sender ikke tillatFall', /tillatFall/.test(flyt), false);
    // En stoppet gruppe skal være synlig uten at jobben blir rød.
    sjekk('stoppede grupper varsles', /::warning::/.test(flyt), true);

    // Endepunktet må være anonymt i SWA-ruta, ellers svarer plattformen 302
    // til innlogging før koden i det hele tatt kjører.
    for (const f of ['staticwebapp.config.pilot.json', 'staticwebapp.config.prod.json']) {
        const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8'));
        const rute = d.routes.find(r => r.route === '/api/team-synk');
        sjekk(`${f}: ruta finnes`, !!rute, true);
        sjekk(`${f}: den er anonym`, rute?.allowedRoles, ['anonymous']);
        // Og den må ligge FØR /api/*, ellers treffes den aldri.
        sjekk(`${f}: den ligger før /api/*`,
            d.routes.indexOf(rute) < d.routes.findIndex(r => r.route === '/api/*'), true);
    }
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
