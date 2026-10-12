/**
 * Datakildene i editoren og i dispatcheren må være de samme.
 *
 * Lista over datakilder finnes i TO eksemplarer, og må finnes i to: editoren
 * er frontend og kan ikke `require` backend. `DATAKILDER` i `editor.html`
 * bestemmer hva en skjemaskaper kan velge; `hentDropdownVerdier` i
 * `oppslag.js` bestemmer hva som faktisk slås opp.
 *
 * Er de uenige, er utslaget taust i begge retninger:
 *
 *   En kilde bare i editoren kan velges, og gir et tomt nedtrekk. Brukeren ser
 *   ingen feil — bare et felt uten alternativer, som ikke kan skilles fra «det
 *   finnes ingen verdier ennå».
 *
 *   En kilde bare i dispatcheren finnes ikke for noen. Arbeidet er gjort og
 *   ingen kan ta det i bruk.
 *
 * Det samme gjelder FILTRENE: dispatcheren leser `filterbegrep` ved navn, og
 * et filter editoren tilbyr men dispatcheren ikke kjenner, blir ignorert i
 * stillhet. Da får man hele lista der man ba om en del av den — for
 * `Skjemasvar` ville det betydd feil nedtrekksliste, ikke bare en upresis.
 *
 * Testen leser BEGGE filene og krever likt svar. Den er den slags test
 * CLAUDE.md ber om for en regel som må bo to steder.
 *
 * Kjøres med:  node api/test/datakilder-paritet.test.js
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

const rot = path.join(__dirname, '..', '..');
const oppslagKilde = utenKommentarer(fs.readFileSync(path.join(rot, 'api', 'src', 'lib', 'oppslag.js'), 'utf8'));
const editorKilde = fs.readFileSync(path.join(rot, 'frontend', 'editor.html'), 'utf8');

// ---------- editorens liste ----------
const dkStart = editorKilde.indexOf('const DATAKILDER = [');
if (dkStart === -1) throw new Error('Fant ikke DATAKILDER i editor.html');
// Blokka slutter på den avsluttende ];
const dkBlokk = editorKilde.slice(dkStart, editorKilde.indexOf('\n        ];', dkStart));
const editorKilder = [...dkBlokk.matchAll(/^\s{16}navn: '([^']+)'/gm)].map(m => m[1]);

// ---------- dispatcherens case-liste ----------
const bytt = oppslagKilde.slice(
    oppslagKilde.indexOf('switch (datakilde)'),
    oppslagKilde.indexOf('default:', oppslagKilde.indexOf('switch (datakilde)')));
const dispatcherKilder = [...bytt.matchAll(/case '([^']+)':/g)].map(m => m[1]);

// Kilder dispatcheren kjenner, men bevisst ikke har implementert. De skal
// ikke stå i editoren — en kilde man kan velge og som gir tomt, er verre enn
// en som ikke finnes.
const ikkeImpl = [...oppslagKilde.matchAll(/IKKE_IMPLEMENTERT = new Set\(\[([^\]]*)\]/g)]
    .flatMap(m => [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]));

{
    sjekk('editoren har kilder', editorKilder.length > 0, true);
    sjekk('dispatcheren har kilder', dispatcherKilder.length > 0, true);

    const bareEditor = editorKilder.filter(k => !dispatcherKilder.includes(k));
    const bareDispatcher = dispatcherKilder.filter(k => !editorKilder.includes(k));
    sjekk('ingen kilde bare i editoren', bareEditor, []);
    sjekk('ingen kilde bare i dispatcheren', bareDispatcher, []);
    sjekk('og ingen uimplementert kilde kan velges',
        editorKilder.filter(k => ikkeImpl.includes(k)), []);
}

// ---------- filtrene ----------
{
    // Hvert filter editoren tilbyr må nevnes i dispatcheren. Sjekken er grov
    // — den leter etter navnet i kildekoden — men den fanger det som faktisk
    // har gått galt: et filter som bare finnes i editoren.
    const mangler = [];
    for (const blokk of dkBlokk.split(/^\s{12}\{/m).slice(1)) {
        const navn = (blokk.match(/navn: '([^']+)'/) || [])[1];
        if (!navn) continue;
        const filtre = [...blokk.matchAll(/\{ navn: '([^']+)', beskrivelse:/g)].map(m => m[1]);
        for (const f of filtre) {
            // Filternavnet kan stå som streng ('Kommune') ELLER som ukvotert
            // objektnøkkel (`Emne: 'EK'` i STUDENT_FILTERKATEGORI). Bare den
            // første formen ga falske treff her første gang.
            const brukt = new RegExp(`['"\`]${f}['"\`]|\\b${f}\\s*:`).test(oppslagKilde);
            if (!brukt) mangler.push(`${navn}{${f}}`);
        }
    }
    sjekk('alle filtre er kjent av dispatcheren', mangler, []);
}

// ---------- Skjemasvar: den nye kilden ----------
{
    sjekk('Skjemasvar finnes i editoren', editorKilder.includes('Skjemasvar'), true);
    sjekk('og i dispatcheren', dispatcherKilder.includes('Skjemasvar'), true);

    // `Liste` er påkrevd. Uten den vet oppslaget ikke hvilken liste det er,
    // og et tomt nedtrekk kan ikke skilles fra «ingen vurderinger er
    // godkjent ennå». Begge sider må si det.
    const blokk = dkBlokk.slice(dkBlokk.indexOf("navn: 'Skjemasvar'"));
    sjekk('editoren sier at Liste er påkrevd', /PÅKREVD/.test(blokk), true);
    sjekk('og dispatcheren krever den',
        /filterbegrep !== 'Liste'/.test(oppslagKilde), true);

    // Tom liste har to helt ulike årsaker — «lista finnes ikke» og «jobben har
    // ikke kjørt» — og de skal kunne skilles i loggen. Det er hele poenget
    // med at kilden er en ferdigbygget tabell.
    sjekk('loggen skiller på årsak',
        /er definert men tom/.test(oppslagKilde) && /ingen oppslagsliste heter/.test(oppslagKilde), true);
}

// ---------- kilden leser tabellen, ikke forekomstene ----------
{
    // Hvis noen senere lar Skjemasvar lese skjemaforekomstene direkte, er vi
    // tilbake til en full skanning med dekryptering på den kritiske veien inn
    // i hvert skjema — og til at to påkrevde filtre kommer i to kall.
    sjekk('oppslag.js leser ikke forekomster',
        /skjema-forekomst-storage/.test(oppslagKilde), false);
    sjekk('men oppslagsliste-tabellen',
        /oppslagsliste-storage/.test(oppslagKilde), true);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
