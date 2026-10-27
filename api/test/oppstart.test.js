/**
 * Starter appen i hvert miljø — og registrerer den riktig antall timere?
 *
 * Dette er røyktesten for den ene feilen som tar alt: **en timer registrert
 * på en vert som ikke støtter dem kan velte oppstarten for HELE appen.** Da
 * er ikke bare jobben borte, men alle 138 HTTP-rutene — innlogging, skjemaer,
 * innsending. `timer-trigger.test.js` laster én funksjonsfil om gangen; her
 * lastes `index.js`, som er det verten faktisk gjør.
 *
 * Testen svarer på spørsmålet som stilles før hver prod-deploy: «kan vi rulle
 * ut uten at noe brekker?» Den kan ikke svare for alt, men den svarer for
 * dette, og det var ubesvart til 17.10.2026.
 *
 * **Tredjepartspakkene stubbes.** Testene skal kunne kjøre uten
 * `node_modules`, og det er hele grunnen til at Azure-SDK-ene lastes lat.
 * Her lastes alle funksjonsfilene, og da må `pdf-lib` og de andre vikes for
 * en stubb. Det betyr at testen måler VÅR kode — modullast, vakter og
 * registreringer — ikke at en pakke finnes. Det siste fanges av at deployen
 * kjører `npm ci`.
 *
 * Kjøres med:  node api/test/oppstart.test.js
 */
const path = require('path');
const Module = require('module');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const INDEKS = path.join(__dirname, '..', 'src', 'index.js');
const builtins = new Set(Module.builtinModules);

/**
 * Last hele appen slik verten gjør, med MILJO satt.
 *
 * Alle modulene tømmes fra cachen først: vaktene leses ved LAST, og en
 * modul som allerede ligger i cachen fra forrige miljø ville ikke blitt
 * kjørt på nytt — og testen ville målt det første miljøet fire ganger.
 */
function startMed(miljo) {
    const ruter = [];
    const timere = [];
    const ekte = Module._load;
    Module._load = function (q, ...r) {
        if (q === '@azure/functions') {
            return { app: { http: (n) => ruter.push(n), timer: (n) => timere.push(n) } };
        }
        const erLokal = q.startsWith('.') || q.startsWith('/');
        if (!erLokal && !builtins.has(q) && !q.startsWith('node:')) {
            return new Proxy(function () {}, {
                get: () => function () { return {}; },
                apply: () => ({}),
                construct: () => ({})
            });
        }
        return ekte.call(this, q, ...r);
    };
    const foer = process.env.MILJO;
    if (miljo === undefined) delete process.env.MILJO; else process.env.MILJO = miljo;
    for (const n of Object.keys(require.cache)) {
        if (n.includes(`${path.sep}api${path.sep}src${path.sep}`)) delete require.cache[n];
    }
    let feilmelding = null;
    try {
        require(INDEKS);
    } catch (e) {
        feilmelding = e.message;
    } finally {
        Module._load = ekte;
        if (foer === undefined) delete process.env.MILJO; else process.env.MILJO = foer;
        for (const n of Object.keys(require.cache)) {
            if (n.includes(`${path.sep}api${path.sep}src${path.sep}`)) delete require.cache[n];
        }
    }
    return { ruter, timere, feilmelding };
}

// ---------- 1. appen starter i hvert miljø ----------
const dev = startMed('dev');
sjekk('dev: appen starter', dev.feilmelding, null);
sjekk('dev: rutene registreres', dev.ruter.length > 100, true);

// `production` er pilotens MILJO-verdi den dag i dag, `prod` er prodens,
// og `lokal` brukes ved kjøring på egen maskin. Et ukjent navn er også med:
// et miljø vi ikke kjenner skal starte, ikke feile.
// PROD ER UTE AV LISTA siden 27.10.2026: den registrerer ni timere nå, og
// dekkes av dev-tilfellet over. De andre skal fortsatt ikke registrere noen —
// pilot kjører på SWA Managed Functions, der en timer kan ta ned appen.
for (const miljo of ['pilot', 'production', 'lokal', 'staging', undefined]) {
    const m = startMed(miljo);
    sjekk(`${miljo}: appen starter`, m.feilmelding, null);
    sjekk(`${miljo}: like mange ruter som dev`, m.ruter.length, dev.ruter.length);
    // DEN AVGJØRENDE: ingen timer registreres utenfor dev. En timer på en
    // vert uten støtte kan ta ned hele appen — og da er rutene over borte.
    sjekk(`${miljo}: ingen timere registreres`, m.timere, []);
}

// ---------- 2. dev registrerer én timer per jobb ----------
{
    const { JOBBER } = require('../src/lib/jobber');
    sjekk('dev: én timer per jobb i registeret', dev.timere.length, JOBBER.length);
    sjekk('dev: alle timernavn er unike', new Set(dev.timere).size, dev.timere.length);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
