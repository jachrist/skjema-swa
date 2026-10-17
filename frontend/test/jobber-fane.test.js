/**
 * Jobber-fanen i admin.
 *
 * Fanen finnes fordi «når kjører jobben» sto tre steder som kunne svare ulikt:
 * i `app.timer(...)`, i cron-workflowen, og i en håndskrevet setning i
 * admin.html («Full import fra Bring skjer 2 ganger i året … via GitHub
 * Actions»). Den setningen ble feil i dev samme dag timeren kom, og ingenting
 * sa fra. Nå kommer svaret fra /api/jobber.
 *
 * Tre ting prøves, og alle tre er tilfeller der noe SER riktig ut:
 *
 *   **Triggeren navngis.** «Timer i appen» og «GitHub Actions» er to ulike
 *   eiere av planen, og den som leser skal vite hvilken uten å gjette.
 *
 *   **De tre stille feilene får en merknad:** en avvist overstyring, en
 *   overstyring satt i et miljø uten timere, og en statusrad som ikke kunne
 *   leses. Den siste er den dyreste — «aldri kjørt» og «storage svarte ikke»
 *   ser ellers helt like ut.
 *
 *   **Ingenting havner uescapet i HTML-en.** Verdiene kommer fra API-et, og
 *   feilteksten i en statusrad kommer opprinnelig fra en exception.
 *
 * Funksjonene klippes ut av admin.html og kjøres direkte — samme form som
 * `varselbanner.test.js`.
 *
 * Kjøres med:  node frontend/test/jobber-fane.test.js
 */
const fs = require('fs');
const path = require('path');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const kilde = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');

/** Klipp ut én funksjon på toppnivå i script-blokka (åtte mellomrom inn). */
function klipp(navn, innledning = 'function') {
    const start = kilde.indexOf(`${innledning} ${navn}(`);
    if (start === -1) throw new Error(`Fant ikke ${navn} i admin.html`);
    const slutt = kilde.indexOf('\n        }', start) + '\n        }'.length;
    return kilde.slice(start, slutt);
}

// escHtml og escapeJsIAttributt importeres som ES-moduler i admin.html, så de
// må stubbes her. De er prøvd for seg i escaping.test.js; det som prøves her
// er om fanen BRUKER dem.
const escapeJs = require('../js/escape.js');

/**
 * Konstanten på modulnivå må BLI MED. `JOBB_KOLONNER` deles av overskriften
 * og radene nettopp for at de ikke skal drive fra hverandre, og en test som
 * ikke ser den kjører kode som ikke finnes i nettleseren. Den leses ut av
 * fila, ikke skrevet om igjen her.
 */
const kolonnelinje = /const JOBB_KOLONNER = '[^']+';/.exec(kilde);
if (!kolonnelinje) throw new Error('Fant ikke JOBB_KOLONNER i admin.html');

const omgivelser = `
    ${kolonnelinje[0]}
    const escHtml = (s) => require(${JSON.stringify(path.join(__dirname, '..', 'js', 'escape.js'))}).escapeHtml(s);
    const escapeJsIAttributt = (s) => require(${JSON.stringify(path.join(__dirname, '..', 'js', 'escape.js'))}).escapeJsIAttributt(s);
    const formatDato = (iso) => iso ? 'DATO(' + iso + ')' : '';
`;

const bygg = (navn, ...hjelpere) => new Function('require', `
    ${omgivelser}
    ${hjelpere.map(h => klipp(h)).join('\n')}
    ${klipp(navn)}
    return ${navn};
`)(require);

const jobbTriggerTekst = bygg('jobbTriggerTekst');
const jobbMerknader = bygg('jobbMerknader');
const jobbStatusFarge = bygg('jobbStatusFarge');

// ---------- 1. triggeren navngis ----------
{
    sjekk('timer', jobbTriggerTekst({ trigger: 'timer' }), 'Timer i appen');
    sjekk('github med workflow',
        jobbTriggerTekst({ trigger: 'github-actions', workflow: 'refresh-postnumre.yml' }),
        'GitHub Actions · refresh-postnumre.yml');
    sjekk('github uten workflow',
        jobbTriggerTekst({ trigger: 'github-actions', workflow: null }), 'GitHub Actions');
    // De to skal ikke gi samme tekst: det er to ulike eiere av planen, og to
    // ulike steder å gå for å endre den.
    sjekk('timer og github ser ulike ut',
        jobbTriggerTekst({ trigger: 'timer' }) !== jobbTriggerTekst({ trigger: 'github-actions' }), true);
    sjekk('ingen jobb gir tom tekst', jobbTriggerTekst(null), '');
}

// ---------- 2. de tre stille feilene får en merknad ----------
{
    const tom = jobbMerknader({ scheduleVar: 'POSTNUMRE_SCHEDULE', avvist: null, grunn: null, overstyringIgnorert: null, statusFeil: null });
    sjekk('alt i orden gir ingen merknad', tom, []);

    const avvist = jobbMerknader({ scheduleVar: 'POSTNUMRE_SCHEDULE', avvist: '30 4 15 1,7 *', grunn: 'Seks felt kreves.' });
    sjekk('avvist gir én merknad', avvist.length, 1);
    sjekk('og den er en feil', (avvist[0] || {}).nivaa, 'feil');
    const avvistTekst = String((avvist[0] || {}).tekst || '');
    sjekk('nevner app-settingen', avvistTekst.includes('POSTNUMRE_SCHEDULE'), true);
    sjekk('nevner verdien', avvistTekst.includes('30 4 15 1,7 *'), true);
    sjekk('og bærer grunnen fra API-et', avvistTekst.includes('Seks felt kreves.'), true);

    const ignorert = jobbMerknader({ scheduleVar: 'POSTNUMRE_SCHEDULE', overstyringIgnorert: '0 */5 * * * *' });
    sjekk('ignorert gir én merknad', ignorert.length, 1);
    const ignorertTekst = String((ignorert[0] || {}).tekst || '');
    sjekk('og den er en advarsel, ikke en feil', (ignorert[0] || {}).nivaa, 'advarsel');
    sjekk('og sier at den ikke har virkning', /ingen\s+virkning/.test(ignorertTekst), true);
    // De to skal ikke se like ut: «avvist» er en skrivefeil i verdien,
    // «ignorert» er riktig verdi i feil miljø.
    sjekk('avvist og ignorert har ulik tekst', avvistTekst !== ignorertTekst, true);

    const statusFeil = jobbMerknader({ scheduleVar: 'X', statusFeil: 'Forbidden' });
    sjekk('statusfeil gir én merknad', statusFeil.length, 1);
    const statusTekst = String((statusFeil[0] || {}).tekst || '');
    sjekk('og sier at vi IKKE vet om jobben har kjørt',
        /vet\s+altså\s+ikke/.test(statusTekst), true);
    sjekk('og at det ikke er det samme som aldri kjørt',
        statusTekst.includes('ikke det samme'), true);

    const alle = jobbMerknader({ scheduleVar: 'X', avvist: 'a', grunn: 'b', overstyringIgnorert: 'c', statusFeil: 'd' });
    sjekk('tre samtidig gir tre merknader', alle.length, 3);
}

// ---------- 2b. «registrert» skilles fra «timer i miljøet» ----------
//
// «Timer i appen» er en påstand om MILJØET. Den sier ingenting om at nettopp
// denne jobbens timer ble registrert, og 17.10.2026 var det akkurat det
// spørsmålet som ikke lot seg besvare da en jobb ikke fyrte.
{
    const jobbRegistrertTekst = bygg('jobbRegistrertTekst');
    sjekk('registrert timer navngis',
        jobbRegistrertTekst({ trigger: 'timer', registrert: { navn: 'oppslaglisterTimer' } }),
        'registrert: oppslaglisterTimer');
    sjekk('uregistrert timer sier fra',
        jobbRegistrertTekst({ trigger: 'timer', registrert: null }), 'IKKE registrert i appen');
    // I et miljø uten timere er spørsmålet ikke stilt, og da skal det ikke
    // besvares heller — en «IKKE registrert» der ville vært en falsk alarm.
    sjekk('github-actions får ingen registreringslinje',
        jobbRegistrertTekst({ trigger: 'github-actions', registrert: null }), null);
    sjekk('ingen jobb gir null', jobbRegistrertTekst(null), null);

    const jobbMerknader2 = bygg('jobbMerknader');
    const uregistrert = jobbMerknader2({ scheduleVar: 'X', trigger: 'timer', registrert: null });
    sjekk('uregistrert timer gir en merknad', uregistrert.length, 1);
    sjekk('og den er en feil', uregistrert[0]?.nivaa, 'feil');
    sjekk('og sier at den aldri fyrer',
        /fyrer den aldri/.test(String(uregistrert[0]?.tekst || '')), true);
    sjekk('en registrert timer gir ingen merknad',
        jobbMerknader2({ scheduleVar: 'X', trigger: 'timer', registrert: { navn: 't' } }).length, 0);
    // Og i et miljø uten timere er fraværet riktig, ikke en feil.
    sjekk('github-actions gir ingen merknad om registrering',
        jobbMerknader2({ scheduleVar: 'X', trigger: 'github-actions', registrert: null }).length, 0);
}

// ---------- 3. fargeskalaen ----------
{
    sjekk('ok', jobbStatusFarge('ok'), 'success');
    sjekk('feil', jobbStatusFarge('feil'), 'danger');
    sjekk('kjører', jobbStatusFarge('kjører'), 'warning');
    sjekk('aldri kjørt', jobbStatusFarge('aldri kjørt'), 'text-secondary');
    sjekk('ukjent verdi', jobbStatusFarge(undefined), 'text-secondary');
}

// ---------- 4. ingenting havner uescapet i HTML-en ----------
{
    const jobbRadHtml = bygg('jobbRadHtml', 'jobbTriggerTekst', 'jobbRegistrertTekst', 'jobbMerknader', 'jobbStatusFarge');
    const ondt = '<img src=x onerror=alert(1)>';
    const html = jobbRadHtml({
        id: ondt, navn: ondt, beskrivelse: ondt, rute: ondt,
        trigger: 'timer', registrert: { navn: 'enTimer' },
        schedule: ondt, scheduleKilde: ondt, scheduleVar: ondt,
        avvist: ondt, grunn: ondt, overstyringIgnorert: null, statusFeil: ondt,
        siste: { status: ondt, kilde: ondt, sistFeil: ondt, sistOppdatert: null, varighetSekunder: 3, antallRader: 7 }
    });
    sjekk('ingen rå tag i HTML-en', html.includes('<img'), false);
    sjekk('men verdien er med, escapet', html.includes('&lt;img'), true);
    // Jobb-id-en står i en JS-STRENG inne i et HTML-attributt, og må gjennom
    // escapeJsIAttributt — ikke bare escHtml.
    //
    // FØRSTE VERSJON AV DENNE SJEKKEN VAR BLIND. Den brukte samme nyttelast
    // som over og krevde at `escapeJsIAttributt(x)` sto i HTML-en. For en
    // nyttelast uten apostrof og bakoverstrek gir de to funksjonene NESTEN
    // samme svar, og en mutasjon som byttet escapeJsIAttributt for escHtml
    // var grønn.
    //
    // Nyttelasten under er den fra escape.js: bakoverstrek, bakoverstrek,
    // apostrof. Med bare HTML-escaping kommer apostrofen tilbake rå etter at
    // nettleseren HTML-dekoder attributtet, og de to bakoverstrekene blir
    // ÉN streng-bakoverstrek — altså avsluttes strengen, og resten leses som
    // kode.
    const ondtJs = "\\\\');alert(1);//";
    const medId = jobbRadHtml({ id: ondtJs, navn: 'A', rute: 'r', trigger: 'timer', schedule: 's', scheduleKilde: 'standard', siste: null });
    const attr = /onclick="([^"]*)"/.exec(medId);
    sjekk('fant onclick-attributtet', !!attr, true);

    // Gjør det nettleseren gjør: HTML-dekod attributtverdien først.
    const htmlDekod = (t) => String(t)
        .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

    /**
     * Hvor JS-strengen slutter, med bakoverstrek-escaping tolket som JS gjør.
     * Slutter den før siste tegn, står det kode etter argumentet.
     */
    const strengSlutt = (js) => {
        const start = js.indexOf("('") + 2;
        for (let i = start; i < js.length; i++) {
            if (js[i] === '\\') { i++; continue; }
            if (js[i] === "'") return i;
        }
        return -1;
    };

    const dekodet = htmlDekod(attr ? attr[1] : '');
    sjekk('kallet ender der argumentet slutter', strengSlutt(dekodet), dekodet.length - 2);
    sjekk('og det er et kall med ett argument', dekodet.endsWith("')"), true);

    // Tallene skal vises, ikke forsvinne.
    sjekk('varighet vises', html.includes('3s'), true);
    sjekk('antall rader vises', html.includes('7 rader'), true);

    // En jobb uten statusrad skal ikke vises som «0 rader» eller «0s»: det er
    // en påstand om en kjøring som ikke har skjedd.
    const uten = jobbRadHtml({
        id: 'a', navn: 'A', rute: 'r', trigger: 'timer', registrert: { navn: 't' },
        schedule: 's', scheduleKilde: 'standard', siste: null, statusFeil: null
    });
    sjekk('ingen varighet uten statusrad', /\b0s\b/.test(uten), false);
    sjekk('ingen rader uten statusrad', /0 rader/.test(uten), false);
    sjekk('status vises som aldri kjørt', uten.includes('aldri kjørt'), true);

    // Og når statusraden ikke kunne leses, skal status IKKE stå som «aldri
    // kjørt» — det er den forvekslingen fanen er til for å hindre.
    const uviss = jobbRadHtml({
        id: 'a', navn: 'A', rute: 'r', trigger: 'timer', registrert: { navn: 't' },
        schedule: 's', scheduleKilde: 'standard', siste: null, statusFeil: 'Forbidden'
    });
    sjekk('uviss status sier ukjent', uviss.includes('ukjent'), true);
    sjekk('og ikke aldri kjørt', uviss.includes('aldri kjørt'), false);
}

// ---------- 5. fanen er lesende ----------
{
    // Ingen vei herfra til å ENDRE en schedule. Kommer en input eller en
    // lagre-knapp inn her, er beslutningen i 8m reversert i stillhet.
    const start = kilde.indexOf('// ==================== JOBBER-FANE');
    const slutt = kilde.indexOf('// ==================== SYSTEM-FANE');
    sjekk('fant jobber-seksjonen', start > -1 && slutt > start, true);
    const seksjon = kilde.slice(start, slutt);
    sjekk('ingen skjemafelt for schedule', /<input|<select|contenteditable/.test(seksjon), false);
    sjekk('ingen lagring av schedule', /api\.(put|patch)\(/.test(seksjon), false);
    // Den ene POST-en som finnes, er «Kjør nå» mot jobbens egen rute.
    sjekk('én POST, mot jobbens rute', (seksjon.match(/api\.post\(/g) || []).length, 1);
    sjekk('og den går mot rute-feltet fra API-et', seksjon.includes('`/api/${j.rute}`'), true);

    // Og den gamle håndskrevne setningen om tidspunktet skal være borte: den
    // var en kopi som drev fra virkeligheten.
    sjekk('ingen håndskrevet schedule-setning igjen',
        /2 ganger i året \(15\. jan og 15\. jul\)/.test(kilde), false);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
