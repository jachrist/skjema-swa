/**
 * Bakgrunnsjobber: at de FAKTISK kjører, og at svaret sier hvilken vei vi tok.
 *
 * 27.10.2026 sto alle ni jobbene i prod v3 på «aldri kjørt». Fire av rutene
 * startet jobben uten `await`, svarte 202 «startet» — og Function App-verten
 * fullførte invokasjonen ved retur og drepte jobben før den rakk sin FØRSTE
 * statusskriving. Den skrivingen står før alt arbeid, nettopp for at «startet,
 * men feilet» skal kunne skilles fra «startet aldri», så «aldri kjørt» var
 * sant. Svaret 202 «startet» var ikke.
 *
 * Fem ruter gjorde det samme på fem steder. De samme tre linjene — kall uten
 * await, svar 202 — er nå ÉN hjelper over ÉN liste i `lib/plattform.js`.
 *
 * Og i tillegg: de tre varslingsstedene i `skjemaer.js` hadde nøyaktig samme
 * form. Der er utslaget verre, for en e-post som ikke ble sendt etterlater
 * ingen rad noen kan lese «aldri kjørt» av.
 *
 * Testen binder fire ledd:
 *   1. Regelen: ventes det, HAR jobben kjørt ferdig før vi returnerer?
 *   2. Svaret: tre utfall, tre statuskoder, og `ferdig` lyver ikke.
 *   3. Rutene: ingen av dem gjør det selv lenger.
 *   4. Panelet: det sier hvilken ventetid som gjelder.
 *
 * Kjøres med:  node api/test/bakgrunnsjobb.test.js
 */
const fs = require('fs');
const path = require('path');
const { utenKommentarer } = require('../../scripts/test-kilde.js');
const { startBakgrunnsjobb, jobbSvar } = require('../src/lib/bakgrunn');
const { maaVentePaaBakgrunnsarbeid, FULLFOERER_VED_RETUR, gjelderHer } = require('../src/lib/plattform');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const rot = path.join(__dirname, '..', '..');
const les = (...p) => utenKommentarer(fs.readFileSync(path.join(rot, ...p), 'utf8'));

const forrigeMiljo = process.env.MILJO;
const iMiljo = (navn, fn) => { process.env.MILJO = navn; try { return fn(); } finally { process.env.MILJO = forrigeMiljo; } };

(async () => {

// ---------- 1. hvilke miljøer venter ----------
//
// Pilot MÅ ikke vente: SWA-proxyen der gir opp etter ~45 s, og jobbene tar
// 30-90 s til 2-4 min. Ventet vi, ville cron-jobbene i GitHub Actions meldt
// rødt for jobber som gikk fint.
sjekk('dev venter', iMiljo('dev', maaVentePaaBakgrunnsarbeid), true);
sjekk('prod venter', iMiljo('prod', maaVentePaaBakgrunnsarbeid), true);
sjekk('pilot venter IKKE', iMiljo('pilot', maaVentePaaBakgrunnsarbeid), false);
// `MILJO=production` er pilot — env.pilot.json setter det den dag i dag. Leses
// det som et ukjent navn, får pilot prodens oppførsel og cron-en der dør.
sjekk('production (= pilot) venter IKKE', iMiljo('production', maaVentePaaBakgrunnsarbeid), false);
sjekk('ukjent miljø venter IKKE', iMiljo('tull', maaVentePaaBakgrunnsarbeid), false);

// Aliaset må normaliseres FØR oppslaget. Ingen av listene inneholder et
// alias-mål i dag, så feilen er usynlig til den dagen pilot legges inn.
sjekk('gjelderHer normaliserer aliaset',
    iMiljo('production', () => gjelderHer(new Set(['pilot']))), true);
// Et alias INNE i lista er en stille no-op — det slås aldri opp.
sjekk('ingen alias-nøkkel i FULLFOERER_VED_RETUR',
    [...FULLFOERER_VED_RETUR].filter(n => n === 'production'), []);

// ---------- 2. venter den faktisk? ----------
//
// Kjernen. «Jobben er ferdig når vi returnerer» er hele påstanden, og den
// prøves ved at jobben setter et flagg ETTER en tur gjennom hendelsesløkka.
{
    const lagJobb = () => {
        const spor = { ferdig: false };
        return [spor, async () => { await new Promise(r => setImmediate(r)); spor.ferdig = true; }];
    };

    const [sporProd, jobbProd] = lagJobb();
    process.env.MILJO = 'prod';
    const utProd = await startBakgrunnsjobb(jobbProd, { navn: 'prøve' });
    sjekk('prod: ventet', utProd.ventet, true);
    sjekk('prod: jobben var FERDIG da vi returnerte', sporProd.ferdig, true);
    sjekk('prod: feil er null, ikke borte', utProd.feil, null);

    const [sporPilot, jobbPilot] = lagJobb();
    process.env.MILJO = 'pilot';
    const utPilot = await startBakgrunnsjobb(jobbPilot, { navn: 'prøve' });
    sjekk('pilot: ventet ikke', utPilot.ventet, false);
    sjekk('pilot: jobben var ikke ferdig ennå', sporPilot.ferdig, false);
    // …men den ble startet, og den blir ferdig. Fire-and-forget skal fortsatt
    // starte jobben, ikke droppe den.
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    sjekk('pilot: jobben ble likevel kjørt', sporPilot.ferdig, true);
    process.env.MILJO = forrigeMiljo;
}

// ---------- 3. feil kommer fram der vi venter ----------
{
    const logget = [];
    const log = (m) => logget.push(String(m));

    process.env.MILJO = 'prod';
    const ut = await startBakgrunnsjobb(async () => { throw new Error('storage svarte ikke'); },
        { log, navn: 'prøve' });
    sjekk('prod: feilen returneres', ut.feil, 'storage svarte ikke');
    sjekk('prod: og logges', logget.some(m => m.includes('storage svarte ikke')), true);

    // En synkron throw i oppstarten — en manglende app-setting, en require som
    // feiler — skal ikke bli en 500 der ruta skulle svart 202.
    const sync = await startBakgrunnsjobb(() => { throw new Error('mangler nøkkel'); },
        { log, navn: 'prøve' });
    sjekk('synkron throw fanges', sync.feil, 'mangler nøkkel');
    sjekk('og regnes som kjent utfall', sync.ventet, true);

    // OGSÅ I PILOT. Det er her det betyr noe: en jobb som kastet FØR den kom i
    // gang har vi et svar på, uansett hva plattformen gjør med bakgrunnsarbeid
    // — og da skal ruta si «feil», ikke 202 «startet» på noe som aldri startet.
    // Blir den synkrone throw-en gjort om til en vanlig rejection, forsvinner
    // nettopp denne forskjellen, og den er usynlig i prod.
    process.env.MILJO = 'pilot';
    const syncPilot = await startBakgrunnsjobb(() => { throw new Error('mangler nøkkel'); },
        { log, navn: 'prøve' });
    sjekk('pilot: synkron throw gir kjent utfall', syncPilot.ventet, true);
    sjekk('pilot: og årsaken er med', syncPilot.feil, 'mangler nøkkel');
    sjekk('pilot: så ruta svarer feil, ikke startet',
        jobbSvar(syncPilot, { startet: 'x', asynkronMelding: 'a', ferdigMelding: 'f' }).status, 500);
    process.env.MILJO = 'prod';

    // Pilot venter ikke, så feilen kan ikke returneres — men den MÅ logges.
    // En uhåndtert rejection tar ned hele prosessen i Node 15+.
    process.env.MILJO = 'pilot';
    const logget2 = [];
    const utP = await startBakgrunnsjobb(async () => { throw new Error('smtp nede'); },
        { log: (m) => logget2.push(String(m)), navn: 'prøve' });
    sjekk('pilot: feilen kan ikke returneres', utP.feil, null);
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    sjekk('pilot: men den logges', logget2.some(m => m.includes('smtp nede')), true);

    // Uten log skal den ikke kaste. Rutene sender alltid en, men en ny
    // kaller som glemmer det skal ikke velte innsendingen.
    const utenLog = await startBakgrunnsjobb(async () => { throw new Error('x'); }, {});
    sjekk('uten log: kaster ikke', utenLog.ventet, false);
    process.env.MILJO = forrigeMiljo;
}

// ---------- 4. svaret ----------
//
// `status: 'ok'` på en jobb som ikke kjørte er feilklassen hele modulen finnes
// for. Sier svaret «ferdig», HAR jobben kjørt ferdig.
{
    const opt = { startet: '2026-10-27T10:00:00Z', asynkronMelding: 'kjører', ferdigMelding: 'kjørte' };

    const a = jobbSvar({ ventet: false, feil: null }, opt);
    sjekk('ikke ventet → 202', a.status, 202);
    sjekk('ikke ventet → startet', a.jsonBody.status, 'startet');

    const b = jobbSvar({ ventet: true, feil: null }, opt);
    sjekk('ventet, gikk bra → 200', b.status, 200);
    sjekk('ventet, gikk bra → ferdig', b.jsonBody.status, 'ferdig');
    sjekk('og meldingen er ferdig-meldinga', b.jsonBody.melding, 'kjørte');

    const c = jobbSvar({ ventet: true, feil: 'storage svarte ikke' }, opt);
    sjekk('ventet, feilet → 500', c.status, 500);
    sjekk('ventet, feilet → feil', c.jsonBody.status, 'feil');
    sjekk('og årsaken er med', c.jsonBody.melding.includes('storage svarte ikke'), true);

    sjekk('startet er alltid med', b.jsonBody.startet, '2026-10-27T10:00:00Z');
    const d = jobbSvar({ ventet: true, feil: null }, { ...opt, ekstra: { filnavn: 'x.zip' } });
    sjekk('ekstra felt følger med', d.jsonBody.filnavn, 'x.zip');
}

// ---------- 5. ingen rute gjør det selv lenger ----------
//
// Her er regelen «ett sted» prøvbar. Dukker 202-en opp igjen i en handler, er
// valget tatt to steder — og det ene stedet vet ikke om plattformen.
{
    const funksjoner = fs.readdirSync(path.join(rot, 'api', 'src', 'functions'))
        .filter(f => f.endsWith('.js'));

    const med202 = funksjoner.filter(f => /status:\s*202/.test(les('api', 'src', 'functions', f)));
    sjekk('ingen handler setter 202 selv', med202, []);

    // Et bart kall til en jobb- eller varslingsfunksjon, som SETNING, er
    // nøyaktig feilen. Alle lovlige bruk står bak `await`, `return`, en
    // tilordning eller en `() =>`.
    const MAA_VENTES_PAA = [
        'kjorBringOppdatering', 'kjorRefreshFs', 'kjorBackupJobb', 'kjorEksternBackup',
        'kjorVerifisering', 'loggVarslingsutfall', 'sendBehandlerVarsling'
    ];
    const bare = [];
    for (const f of funksjoner) {
        const linjer = les('api', 'src', 'functions', f).split('\n');
        linjer.forEach((linje, i) => {
            const t = linje.trim();
            for (const navn of MAA_VENTES_PAA) {
                if (t.startsWith(`${navn}(`) || t.startsWith(`varsling.${navn}(`)) {
                    bare.push(`${f}:${i + 1} ${navn}`);
                }
            }
        });
    }
    sjekk('ingen bare bakgrunnskall i handlerne', bare, []);

    // Og positivt: hvert sted går gjennom hjelperen. Uten dette ville testen
    // over vært grønn også om kallet ble slettet.
    const forventet = {
        'postnumre.js': ['kjorBringOppdatering'],
        'refresh-fs.js': ['kjorRefreshFs'],
        'backup.js': ['kjorBackupJobb', 'kjorEksternBackup', 'kjorVerifisering'],
        'skjemaer.js': ['loggVarslingsutfall', 'loggVarslingsutfall', 'sendBehandlerVarsling']
    };
    for (const [fil, navn] of Object.entries(forventet)) {
        const kilde = les('api', 'src', 'functions', fil);
        sjekk(`${fil} importerer hjelperen`,
            /require\('\.\.\/lib\/bakgrunn'\)/.test(kilde), true);
        const antall = (kilde.match(/startBakgrunnsjobb\(/g) || []).length;
        sjekk(`${fil}: ${navn.length} steder gjennom hjelperen`, antall, navn.length);
        for (const n of new Set(navn)) {
            sjekk(`${fil}: ${n} er pakket inn`,
                new RegExp(`startBakgrunnsjobb\\(\\s*\\(\\) => (?:\\w+\\.)?${n}\\(`).test(kilde), true);
        }
    }
}

// ---------- 6. panelet sier hvilken ventetid som gjelder ----------
//
// Venter ruta, kommer svaret først når jobben er ferdig — og gatewayen kan ha
// gitt opp lenge før. Et tidsavbrudd lest som «jobben feilet» sender
// feilsøkingen i gal retning, og det er den feilen hele økta handlet om.
{
    const jobberRute = les('api', 'src', 'functions', 'jobber.js');
    sjekk('/api/jobber svarer med venterPaaJobb',
        /venterPaaJobb:\s*maaVentePaaBakgrunnsarbeid\(\)/.test(jobberRute), true);

    const admin = les('frontend', 'admin.html');
    const i = admin.indexOf('window.jobberKjorNa');
    sjekk('fant jobberKjorNa', i > -1, true);
    const kjorNa = admin.slice(i, admin.indexOf('\n        };', i));

    sjekk('panelet leser venterPaaJobb fra API-et',
        /jobberState\.venterPaaJobb/.test(kjorNa), true);
    // Ikke utledet av miljønavnet — det er den andre kopien av regelen.
    sjekk('og utleder det IKKE av miljøet', /miljø|MILJO/.test(kjorNa), false);
    sjekk('panelet skiller ferdig fra startet',
        /res\.status === 'ferdig'/.test(kjorNa), true);
    sjekk('og sier at tidsavbrudd ikke stopper jobben',
        /tidsavbrudd/i.test(kjorNa), true);

    const last = admin.slice(admin.indexOf('window.jobberLast'), admin.indexOf('window.jobberKjorNa'));
    // `undefined` fra et gammelt API skal lese som «venter ikke», ikke bli en
    // tredje tilstand i meldingene.
    sjekk('jobberLast setter feltet til en boolean',
        /venterPaaJobb = d\.venterPaaJobb === true/.test(last), true);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);

})();
