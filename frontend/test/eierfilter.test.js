/**
 * «Bare der jeg er eier» i skjemaoversikten.
 *
 * Ønsket fra oppdragsgiver: standardvisningen er alt man har tilgang til —
 * både det man er publikum på og det man eier — og bryteren smalner den inn
 * til det man eier.
 *
 * Det som gjør dette mer enn et filter på et felt, er at feltet ikke fantes.
 * `ErEier` på kortet er **true for admin på alt**, fordi den styrer hvilke
 * knapper kortet får. En bryter bygget på den ville vært uten virkning for
 * nettopp den som har flest kort å se gjennom — og det hadde sett ut som en
 * bryter som ikke virker, ikke som en tilgangsregel. API-et sender derfor
 * `ErOppfortSomEier` i tillegg, og den svarer på noe annet: står UPN-en i
 * `Eiere`?
 *
 * Fire ting testes:
 *
 *   **Bryteren filtrerer på det nye feltet.** Ikke på `ErEier`.
 *
 *   **Kriteriene er uavhengige.** Et søk som treffer skal ikke overstyre
 *   bryteren, og bryteren skal ikke overstyre fasefilteret.
 *
 *   **Av som standard.** Oppdragsgiver ba om at alt man har tilgang til vises
 *   til man selv velger noe annet.
 *
 *   **Serveren sender feltet, og regner det ut annerledes for admin.** Uten
 *   det er bryteren bare en bryter.
 *
 * Kjøres med:  node frontend/test/eierfilter.test.js
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

// ---------- den ekte funksjonen, klipt ut ----------
const kilde = fs.readFileSync(path.join(__dirname, '..', 'velgskjematype.html'), 'utf8');
const start = kilde.indexOf('function skalVises(');
if (start === -1) throw new Error('Fant ikke skalVises i velgskjematype.html');
const slutt = kilde.indexOf('\n        }', start) + '\n        }'.length;
const skalVises = new Function(`${kilde.slice(start, slutt)}\nreturn skalVises;`)();

const kort = (over) => ({
    Skjematype_id: '100', Skjema_navn: 'Reiseregning', Fase: 'Produksjon',
    ErEier: false, ErOppfortSomEier: false, ...over
});
const ALLE_FASER = { faser: ['Produksjon', 'Utvikling'], kunEier: false, ord: [] };
const BARE_EIER = { ...ALLE_FASER, kunEier: true };

// ---------- bryteren av: alt man har tilgang til ----------
{
    sjekk('publikum vises', skalVises(kort({}), ALLE_FASER), true);
    sjekk('eier vises', skalVises(kort({ ErOppfortSomEier: true }), ALLE_FASER), true);
}

// ---------- bryteren på: bare det man eier ----------
{
    sjekk('eier vises fortsatt',
        skalVises(kort({ ErOppfortSomEier: true }), BARE_EIER), true);
    sjekk('publikum faller bort', skalVises(kort({}), BARE_EIER), false);

    // Dette er hele poenget med det nye feltet: admin har ErEier på ALT.
    sjekk('ErEier alene holder ikke',
        skalVises(kort({ ErEier: true, ErOppfortSomEier: false }), BARE_EIER), false);
    sjekk('og et manglende felt teller som nei',
        skalVises({ Skjema_navn: 'X', Fase: 'Produksjon' }, BARE_EIER), false);
}

// ---------- kriteriene overstyrer ikke hverandre ----------
{
    // Et treff i søket skal ikke dra med seg et kort bryteren har sortert bort.
    sjekk('søk overstyrer ikke bryteren',
        skalVises(kort({}), { ...BARE_EIER, ord: ['reiseregning'] }), false);
    sjekk('bryteren overstyrer ikke fasen',
        skalVises(kort({ ErOppfortSomEier: true, Fase: 'Utvikling' }),
            { faser: ['Produksjon'], kunEier: true, ord: [] }), false);
    // Og søket virker fortsatt som før når bryteren er på.
    sjekk('søk + bryter: treff',
        skalVises(kort({ ErOppfortSomEier: true }), { ...BARE_EIER, ord: ['reise'] }), true);
    sjekk('søk + bryter: bom',
        skalVises(kort({ ErOppfortSomEier: true }), { ...BARE_EIER, ord: ['avvik'] }), false);
}

// ---------- siden ----------
{
    const kode = utenKommentarer(kilde);

    sjekk('bryteren finnes', /id="eier-toggle"/.test(kode), true);
    // Ikke `checked` i markupen: standard er at alt vises.
    const toggle = /<label class="fase-toggle" id="eier-toggle"[\s\S]*?<\/label>/.exec(kode)?.[0] || '';
    sjekk('bryteren er av som standard', /checked/.test(toggle), false);

    // Skjult for den som ikke eier noe — den ville bare kunnet tømme lista.
    sjekk('vises bare til den som eier noe',
        /eierNoe = alle\.some\(t => t\.ErOppfortSomEier === true\)/.test(kode), true);
    sjekk('og en lagret verdi kan ikke overleve det',
        /if \(!toggle \|\| toggle\.style\.display === 'none'\) return false;/.test(kode), true);

    // Valget huskes, som fasene.
    sjekk('valget lagres', /localStorage\.setItem\(KUN_EIER_LS_NOKKEL/.test(kode), true);
    sjekk('og leses tilbake', /localStorage\.getItem\(KUN_EIER_LS_NOKKEL\)/.test(kode), true);

    // Siden skal ikke filtrere på ErEier noe sted.
    sjekk('ingen filtrering på ErEier',
        /kunEier && t\.ErEier/.test(kode), false);
}

// ---------- serveren ----------
{
    const api = utenKommentarer(
        fs.readFileSync(path.join(__dirname, '..', '..', 'api', 'src', 'functions', 'skjematyper.js'), 'utf8'));

    sjekk('feltet sendes', /ErOppfortSomEier: erOppfortSomEier/.test(api), true);
    // Admin-grenen må slå opp eierskapet for seg. Gjør den ikke det, er
    // `oppfortSomEier` det samme settet som `eierIder` — altså alt.
    sjekk('admin slår opp eierskapet særskilt',
        /oppfortSomEier = new Set\(\s*\(await filtrerTyperPåTilgang\(alle, upn, 'Eiere', cache\)\)/.test(api), true);
    sjekk('og settet er ikke bare alle id-ene',
        /oppfortSomEier = new Set\(alle\.map/.test(api), false);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
