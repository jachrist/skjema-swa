/**
 * Ingen rute skal være anonym i gatewayen, ubevoktet i handleren OG uerklært.
 *
 * Tilgangsstyringen bor i to lag, og må bo i to:
 *
 *   `staticwebapp.config.<miljø>.json` avgjør hvem SWA slipper fram til
 *   funksjonen. Står det `anonymous`, kommer hvem som helst dit.
 *
 *   Handleren avgjør resten — `erAdmin`, `hentInnloggetUpn`, en OTP-sjekk,
 *   en delt nøkkel i en header.
 *
 * Den ene kombinasjonen som ikke skal finnes, er at BEGGE slipper gjennom.
 * Den er også den som ikke sier fra: endepunktet svarer pent, med data, til
 * en som ikke er pålogget. Ingen test feiler, ingen logg skiller det fra
 * normal bruk, og det oppdages først av noen utenfor.
 *
 * Det er ikke mulig å se ved å lese ett sted. Rutereglene står i én fil,
 * vaktene i 40 andre, og `/api/*` på slutten av regellista gjør at en
 * glemt rute ser bevoktet ut. Derfor kobler `scripts/api-oversikt.js` de to
 * lagene, og derfor krever denne testen at koblingen gir tomt svar.
 *
 * Testen sjekker også at unntakslista ikke forfaller. En liste over «åpne med
 * vilje» som inneholder ruter som ikke finnes lenger, er en liste ingen tør
 * stole på — og da er den verdiløs i begge retninger.
 *
 * Kjøres med:  node api/test/api-oversikt.test.js
 */
const fs = require('fs');
const path = require('path');
const oversikt = require('../../scripts/api-oversikt.js');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const rot = path.join(__dirname, '..', '..');
const MILJØER = ['pilot', 'prod'];

// ---------- parseren må faktisk finne noe ----------
//
// Dette er testens eget nullpunkt. Hvis `app.http`-mønsteret slutter å
// treffe — en formatering, en ny registreringsform — finner skriptet null
// endepunkter, og «ingen åpne ruter» blir sant fordi ingenting ble lest.
// En grønn test som ikke har sett koden er verre enn ingen test.
{
    const rader = oversikt.bygg('prod');
    sjekk('parseren finner endepunktene', rader.length > 100, true);

    const filer = fs.readdirSync(path.join(rot, 'api', 'src', 'functions'))
        .filter(n => n.endsWith('.js'));
    // Hver fil med en `app.http(` må være representert. En fil som ikke blir
    // lest, blir heller ikke sjekket — og det er nettopp den som er farlig.
    // Per FIL er ikke nok. `samtale.js` har tre registreringer, og da den ene
    // med `route: `${RUTE}/demping`` falt ut, var fila fortsatt «lest» —
    // oversikten manglet ett endepunkt uten at noe sa fra. Derfor telles
    // registreringene, ikke filene.
    const telt = {};
    for (const n of filer) {
        const t = fs.readFileSync(path.join(rot, 'api', 'src', 'functions', n), 'utf8');
        const antall = (t.match(/app\.http\(/g) || []).length;
        if (antall) telt[n] = antall;
    }
    const lest = {};
    for (const r of rader) lest[r.fil] = (lest[r.fil] || 0) + 1;
    const avvik = Object.keys(telt)
        .filter(n => telt[n] !== lest[n])
        .map(n => `${n}: ${lest[n] || 0} lest av ${telt[n]}`);
    sjekk('hver app.http-registrering er lest', avvik, []);

    sjekk('alle ruter starter med /api/', rader.filter(r => !r.rute.startsWith('/api/')).map(r => r.rute), []);
    sjekk('alle ruter har minst én metode', rader.filter(r => r.metoder.length === 0).map(r => r.rute), []);
}

// ---------- hovedregelen, i begge miljøer ----------
for (const miljo of MILJØER) {
    const rader = oversikt.bygg(miljo);
    const åpne = rader.filter(r => r.åpenForVerden)
        .map(r => `${r.metoder.join(',')} ${r.rute} (${r.fil})`);
    // Er denne ikke tom, er listen selve feilmeldingen: hver linje er et
    // endepunkt hvem som helst på internett kan kalle.
    sjekk(`${miljo}: ingen anonyme, ubevoktede og uerklærte ruter`, åpne, []);
}

// ---------- gatewayen er aldri eneste sperre ----------
//
// Strengere enn regelen over, og sann for alle 133 endepunktene i dag: hvert
// endepunkt har minst én vakt i handleren, eller står på unntakslista.
//
// Regelen over ser bare på de anonyme, og det er for sent. Et endepunkt som
// er `authenticated` i gatewayen og sjekker ingenting selv, er trygt helt til
// noen legger inn en anonym regel over `/api/*` — og den som gjør det, ser en
// handler som ikke sier fra. Da har man flyttet hele tilgangsstyringen til en
// JSON-fil, og den filen blir forkastet i sin helhet hvis én rute er ugyldig
// (se swa-config.test.js; det har skjedd).
{
    const rader = oversikt.bygg('prod');
    const uten = rader.filter(r => r.vakter.length === 0 && !(r.rute in oversikt.ÅPNE_MED_VILJE))
        .map(r => `${r.metoder.join(',')} ${r.rute} (${r.fil})`);
    sjekk('hvert endepunkt har en vakt i handleren', uten, []);
}

// ---------- miljøene må være enige om rutene ----------
//
// Reglene finnes i to filer, og `--miljo=prod` over er bare én av dem.
// Er de uenige om hvem som slipper inn, beviser en grønn test for prod
// ingenting om pilot — og pilot er der ekte data ligger i dag.
{
    const nøkkel = regler => (regler || [])
        .filter(r => r.route && String(r.route).startsWith('/api'))
        .map(r => `${r.route} :: ${JSON.stringify(r.allowedRoles || null)}`);
    const [pilot, prod] = MILJØER.map(m => nøkkel(oversikt.lesRegler(m)));
    // Rapporter BARE det som skiller. En full liste av 28 regler på begge
    // sider gjør utslaget uleselig, og en feilmelding ingen leser er en
    // feilmelding som blir stående.
    sjekk('ingen api-ruteregel bare i pilot', pilot.filter(r => !prod.includes(r)), []);
    sjekk('ingen api-ruteregel bare i prod', prod.filter(r => !pilot.includes(r)), []);
    // Rekkefølgen teller for seg: SWA bruker FØRSTE treff, så to filer med de
    // samme reglene i ulik rekkefølge svarer ulikt. En anonym regel flyttet
    // ned under `/api/*` slutter å gjelde, uten at noen regel er endret.
    // Bare FØRSTE avvik rapporteres: flyttes én regel, er alle indekser etter
    // den forskjøvet, og en liste over 28 «avvik» sier ingenting om hva som
    // faktisk ble flyttet.
    const i = pilot.findIndex((r, k) => r !== prod[k]);
    sjekk('og i samme rekkefølge', i === -1 ? null : { nr: i, pilot: pilot[i], prod: prod[i] }, null);
}

// ---------- unntakslista skal ikke forfalle ----------
{
    const rader = oversikt.bygg('prod');
    const ruter = new Set(rader.map(r => r.rute));
    const erklært = Object.keys(oversikt.ÅPNE_MED_VILJE);

    sjekk('unntakslista er ikke tom', erklært.length > 0, true);
    // En rute som ikke finnes lenger. Da er oppføringen død, og lista kan
    // ikke lenger leses som «dette er alt som er åpent».
    sjekk('alle erklærte ruter finnes', erklært.filter(r => !ruter.has(r)), []);

    // En erklært rute som IKKE er anonym i gatewayen. Oppføringen gjør
    // ingenting i dag, men står som en ferdig utfylt tillatelse hvis noen
    // senere gjør ruta anonym — en whitelist med forhåndsgodkjente ruter
    // ingen har vurdert på nytt.
    const ikkeAnonyme = erklært.filter(r =>
        !rader.some(x => x.rute === r && x.swaRoller.includes('anonymous')));
    sjekk('alle erklærte ruter er anonyme i gatewayen', ikkeAnonyme, []);

    // Begrunnelsen skal kunne leses av en som evaluerer sikkerheten. «ok» og
    // «med vilje» er ikke begrunnelser.
    const tynne = erklært.filter(r => (oversikt.ÅPNE_MED_VILJE[r] || '').length < 40);
    sjekk('hver begrunnelse sier noe', tynne, []);
}

// ---------- vaktmønstrene må treffe noe ----------
//
// Et mønster som ikke treffer noe er en vakt som er usynlig for oversikten.
// Blir `erAdmin` døpt om, ser admin-endepunktene ubevoktede ut — og de som er
// pålogget-beskyttede i gatewayen fanges IKKE av hovedregelen over, fordi den
// bare ser på de anonyme. Da er hullet i oversikten, ikke i koden, og en
// oversikt med hull er det denne runden handler om å slutte med.
{
    const rader = oversikt.bygg('prod');
    const brukt = new Set(rader.flatMap(r => r.vakter));
    const døde = oversikt.VAKTER.map(([kort]) => kort).filter(k => !brukt.has(k));
    sjekk('hvert vaktmønster treffer minst ett endepunkt', døde, []);
}

// ---------- ingen ruteregel uten endepunkt ----------
//
// En eksakt regel som ikke treffer et endepunkt er enten død config eller en
// skrivefeil. Skrivefeilen er den farlige: ruta den SKULLE truffet faller da
// ned på `/api/*` nederst, og det er en helt annen tilgang enn den som står
// skrevet. Regelen ser riktig ut i fila.
{
    const rader = oversikt.bygg('prod');
    const ruter = new Set(rader.map(r => r.rute));
    for (const miljo of MILJØER) {
        const uten = oversikt.lesRegler(miljo)
            .map(r => String(r.route || ''))
            .filter(r => r.startsWith('/api/') && !r.endsWith('/*') && !ruter.has(r));
        sjekk(`${miljo}: hver eksakte api-regel treffer et endepunkt`, uten, []);
    }
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
