/**
 * Rapporttabellen: delepunkter i kolonnenavn, bredde på første kolonne, og
 * grupper som blir tomme når rader krysses bort.
 *
 * Tre ønsker etter testing av rapportene, og alle tre handler om det samme:
 * en tabell med mange kolonner som skal ut på et A4-ark.
 *
 *   **Delepunktene er forfatterens.** `overflow-wrap: anywhere` på
 *   overskriftene delte midt i ordet — «SÆRLIG KATEGORI PERSONOPP-LYSNING».
 *   Nå settes `_` der navnet KAN brytes, og understreken byttes til en myk
 *   bindestrek (U+00AD) som bare vises når bruddet brukes. Da må `anywhere`
 *   bort fra overskriftene: med den ville delepunktene vært virkningsløse,
 *   og regelen hadde sett ut til å virke uten å gjøre noe.
 *
 *   **Første kolonne er nøkkelen.** Den skal ha en minstebredde, og da må
 *   klassen settes BÅDE i `<th>` og i `<td>` — ellers får overskriften en
 *   annen bredde enn cellene under, og tabellen forskyves.
 *
 *   **En tom gruppe hører ikke på papiret.** Krysses alle radene i en gruppe
 *   bort, står overskriften igjen uten noe under seg. På SKJERMEN dempes den
 *   i stedet for å forsvinne — samme begrunnelse som for radene: en gruppe
 *   man ikke ser, kan man ikke hente tilbake.
 *
 * `kolonneNavnHtml` og `oppdaterTommeGrupper` klippes ut av rapport.html og
 * kjøres for ekte. Resten sjekkes som tekst, fordi det er CSS.
 *
 * Kjøres med:  node frontend/test/rapport-kolonner.test.js
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

const les = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const rapport = les('rapport.html');
const kode = utenKommentarer(rapport);

/** Klipper ut en funksjon fra rapport.html og gjør den kjørbar. */
function hentFunksjon(kilde, navn) {
    const i = kilde.indexOf(`function ${navn}(`);
    if (i === -1) throw new Error(`Fant ikke ${navn} i rapport.html`);
    const slutt = kilde.indexOf('\n        }', i);
    if (slutt === -1) throw new Error(`Fant ikke slutten på ${navn}`);
    return kilde.slice(i, slutt + 10);
}

// ---------- delepunkter i kolonnenavn ----------
{
    // Den EKTE funksjonen, med den EKTE escapeHtml — ikke en kopi skrevet her.
    const biter = [
        rapport.match(/const MYK_BINDESTREK = '[^']+';/)[0],
        hentFunksjon(rapport, 'kolonneNavnHtml'),
        hentFunksjon(rapport, 'escapeHtml')
    ];
    const kolonneNavnHtml = new Function(`${biter.join('\n')}\nreturn kolonneNavnHtml;`)();

    // Tegnet skal være den myke bindestreken, U+00AD — ikke en vanlig
    // bindestrek, som ville stått synlig i hvert kolonnenavn.
    sjekk('den myke bindestreken er U+00AD',
        kolonneNavnHtml('a_b').charCodeAt(1), 0xAD);
    sjekk('understrek blir myk bindestrek',
        kolonneNavnHtml('PERSON_OPPLYSNING'), 'PERSON\u00ADOPPLYSNING');
    sjekk('alle forekomster, ikke bare den første',
        kolonneNavnHtml('A_B_C'), 'A\u00ADB\u00ADC');
    // Understreken er en instruksjon, ikke et tegn — den skal ikke stå igjen.
    sjekk('ingen understrek igjen', kolonneNavnHtml('A_B').includes('_'), false);
    // Hard bindestrek skal stå. Den brytes av nettleseren, men vises alltid.
    sjekk('hard bindestrek står', kolonneNavnHtml('E-POST'), 'E-POST');
    sjekk('navn uten delepunkt er urørt',
        kolonneNavnHtml('Behandlingsresultat'), 'Behandlingsresultat');

    // Escaping skjer fortsatt, og FØR tegnet settes inn: et kolonnenavn kan
    // ikke bære markup.
    sjekk('escapes', kolonneNavnHtml('<b>&"x"</b>'), '&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;');
    sjekk('og en understrek i markupen endrer ikke det',
        kolonneNavnHtml('<a_b>'), '&lt;a\u00ADb&gt;');
    sjekk('tom og tomt er tom streng', [kolonneNavnHtml(''), kolonneNavnHtml(null)], ['', '']);
}

// ---------- overskriftene bruker delepunktene ----------
{
    // Uten dette kalles funksjonen ingen steder, og regelen finnes bare i
    // testen.
    sjekk('overskriftene går gjennom funksjonen',
        /<th\$\{[\s\S]{0,120}\}>\$\{kolonneNavnHtml\(k\.navn\)\}<\/th>/.test(kode), true);

    // `anywhere` på overskriftene ville overstyrt delepunktene. Cellene skal
    // fortsatt ha den — der er det verdier, ikke navn forfatteren har delt.
    // Regelen skal finnes ÉN gang. Står den to steder, svarer de to ulikt så
    // snart den ene endres, og hvilken som vinner avgjøres av rekkefølgen i
    // stilarket. Begge skjermreglene for overskriftene lå her til 07.10.2026.
    const theadRegler = kode.match(/\n        table\.rapport thead th \{[^}]*\}/g) || [];
    sjekk('én skjermregel for overskriftene', theadRegler.length, 1);
    const thead = theadRegler[0] || '';
    sjekk('overskriftene deler bare ved behov', /overflow-wrap: break-word/.test(thead), true);
    sjekk('og ikke hvor som helst', /anywhere/.test(thead), false);
    sjekk('manuell orddeling', /hyphens: manual/.test(thead), true);
    sjekk('og de brytes over flere linjer', /white-space: normal/.test(thead), true);
    sjekk('cellene brytes fortsatt fritt',
        /table\.rapport td \{ overflow-wrap: anywhere; \}/.test(kode), true);
}

// ---------- første kolonne ----------
{
    sjekk('minstebredde finnes',
        /table\.rapport th\.nokkelkol, table\.rapport td\.nokkelkol \{ min-width: [\d.]+em; \}/.test(kode), true);

    // BÅDE th og td. Bare én av dem gir ulik bredde på overskrift og celle.
    const thead = kode.split('<thead>')[1].split('</thead>')[0];
    const rad = kode.match(/<td class="velgkol">[\s\S]*?<\/tr>`;/)[0];
    sjekk('klassen settes på overskriften', /nokkelkol/.test(thead), true);
    sjekk('og på cellen', /nokkelkol/.test(rad), true);
    // Bare den første. `i === 0` er regelen begge steder.
    sjekk('bare på første kolonne, i overskriften', (thead.match(/i === 0 \? 'nokkelkol'/g) || []).length, 1);
    sjekk('og i cellen', (rad.match(/i === 0 \? 'nokkelkol'/g) || []).length, 1);

    // En klasse uten CSS-regel er ingenting. Sjekken over fanger den bare
    // hvis regelen og bruken sjekkes hver for seg — det gjør de.
    sjekk('klassen har en regel', kode.includes('td.nokkelkol {'), true);
}

// ---------- tomme grupper ----------
{
    // Den EKTE funksjonen mot et lite DOM-stubb.
    const lagBoks = (krysset) => ({ checked: krysset });
    const lagGruppe = (bokser) => {
        const klasser = new Set();
        return {
            klasser,
            classList: {
                toggle(c, på) { if (på === undefined) på = !klasser.has(c); på ? klasser.add(c) : klasser.delete(c); },
                contains(c) { return klasser.has(c); }
            },
            querySelectorAll(sel) {
                if (sel !== 'input[type="checkbox"]:checked') throw new Error(`uventet selektor: ${sel}`);
                return bokser.filter(b => b.checked);
            }
        };
    };
    const kjørMot = (grupper) => {
        const fn = new Function('document', `${hentFunksjon(rapport, 'oppdaterTommeGrupper')}\nreturn oppdaterTommeGrupper;`)({
            querySelectorAll(sel) {
                if (sel !== '#resultat .gruppe') throw new Error(`uventet selektor: ${sel}`);
                return grupper;
            }
        });
        fn();
    };

    const tom = lagGruppe([lagBoks(false), lagBoks(false)]);
    const delvis = lagGruppe([lagBoks(false), lagBoks(true)]);
    const full = lagGruppe([lagBoks(true)]);
    kjørMot([tom, delvis, full]);
    sjekk('gruppe uten valgte rader merkes', tom.classList.contains('gruppe-tom'), true);
    sjekk('én valgt rad er nok', delvis.classList.contains('gruppe-tom'), false);
    sjekk('full gruppe merkes ikke', full.classList.contains('gruppe-tom'), false);

    // Merket skal også tas BORT igjen — ellers er avkryssingen en enveisdør
    // på gruppenivå, akkurat det radene ble unngått.
    tom.querySelectorAll('input[type="checkbox"]:checked'); // ingen bivirkning
    const gjenåpnet = lagGruppe([lagBoks(false)]);
    kjørMot([gjenåpnet]);
    sjekk('merket settes', gjenåpnet.classList.contains('gruppe-tom'), true);
    gjenåpnet.querySelectorAll; // behold formen
    const bokser = [lagBoks(true)];
    const igjen = lagGruppe(bokser);
    igjen.classList.toggle('gruppe-tom', true);
    kjørMot([igjen]);
    sjekk('og fjernes når en rad krysses på igjen', igjen.classList.contains('gruppe-tom'), false);

    // Kalles fra BEGGE veiene en rad kan endres. Bare én av dem ville gjort
    // at «Skjul alle» lot gruppeoverskriftene stå.
    const radValgt = kode.split('window.radValgt')[1].split('};')[0];
    const settAlle = kode.split('window.settAlleRader')[1].split('};')[0];
    sjekk('radValgt oppdaterer gruppene', /oppdaterTommeGrupper\(\)/.test(radValgt), true);
    sjekk('settAlleRader gjør det også', /oppdaterTommeGrupper\(\)/.test(settAlle), true);

    // Dempet på skjermen, borte på papiret — og ikke omvendt.
    const skjerm = kode.split('@media print')[0];
    const utskrift = kode.split('@media print')[1];
    sjekk('dempes på skjermen', /\.gruppe\.gruppe-tom \{ opacity: [\d.]+; \}/.test(skjerm), true);
    sjekk('ikke skjult på skjermen', /\.gruppe\.gruppe-tom \{ display: none/.test(skjerm), false);
    sjekk('skjules i utskriften', /\.gruppe\.gruppe-tom \{ display: none !important; \}/.test(utskrift), true);
}

// ---------- «Rapporter» i skjemaoversikten ----------
{
    // Knappen og siden den peker på er to filer. Parameternavnet må være det
    // samme i alle tre: knappen, rapportoversikten som leser det, og
    // rapporteditoren den sender videre til.
    const velg = utenKommentarer(les('velgskjematype.html'));
    const oversikt = utenKommentarer(les('velgrapporttype.html'));
    const editor = utenKommentarer(les('rapporteditor.html'));

    // To knapper på samme side pekte på rapportoversikten, og de het BEGGE
    // «📊 Rapporter»: verktøylinja øverst (alle rapporter) og den nye på hvert
    // kort (bare denne skjematypen). Brukeren klikket den øverste og fikk alle
    // rapportene — og testen var grønn, fordi den bare spurte om teksten
    // fantes et sted i fila.
    //
    // Nå sjekkes LENKENE hver for seg, og at ingen to av dem heter det samme.
    const rapportLenker = [...velg.matchAll(/<a[^>]*href="\/velgrapporttype\.html([^"]*)"[^>]*>([^<]*)<\/a>/g)]
        .map(m => ({ spm: m[1], tekst: m[2].trim() }));
    sjekk('to veier til rapportene', rapportLenker.length, 2);
    sjekk('og de heter ikke det samme',
        new Set(rapportLenker.map(l => l.tekst)).size, rapportLenker.length);

    const medFilter = rapportLenker.filter(l => l.spm.includes('skjematype_id='));
    const utenFilter = rapportLenker.filter(l => !l.spm.includes('skjematype_id='));
    sjekk('én bærer skjematypen', medFilter.length, 1);
    sjekk('og én gjør det ikke', utenFilter.length, 1);
    sjekk('kortknappen heter Rapporter', medFilter[0]?.tekst, '📊 Rapporter');
    sjekk('og den generelle sier at den tar alle', utenFilter[0]?.tekst, '📊 Alle rapporter');
    sjekk('kortknappen tar skjematypen med seg',
        medFilter[0]?.spm, '?skjematype_id=${encodeURIComponent(t.Skjematype_id)}');
    // Den gamle veien skal være borte — to knapper til samme sted forvirrer.
    sjekk('ikke rett til editoren lenger',
        /📊 Ny rapport/.test(velg), false);

    sjekk('oversikten leser samme parameter',
        /URLSearchParams\(window\.location\.search\)\.get\('skjematype_id'\)/.test(oversikt), true);
    sjekk('og filtrerer på kildeskjematypen',
        /String\(t\.Kildeskjematype_id \|\| ''\) === String\(skjematypeFilter\)/.test(oversikt), true);
    sjekk('editoren leser samme parameter',
        /params\.get\('skjematype_id'\)/.test(editor), true);

    // Ingen rapporter ennå: videre til editoren, med kilden satt. Og BARE for
    // den som kan lage dem — ellers havner en leser i en editor han ikke får
    // lagre fra.
    sjekk('tom liste sender videre',
        /forSkjematype\(alle\)\.length === 0 && kanLage/.test(oversikt), true);
    sjekk('med kilden med seg',
        /location\.replace\(`\/rapporteditor\.html\?skjematype_id=\$\{encodeURIComponent\(skjematypeFilter\)\}`\)/.test(oversikt), true);
    // En «Ny rapport» skal finnes der også, og den må ta kilden med.
    sjekk('egen Ny rapport-knapp', /id="knapp-ny-for-skjematype"/.test(oversikt), true);
    sjekk('som også bærer kilden',
        /knapp\.href = `\/rapporteditor\.html\?skjematype_id=\$\{encodeURIComponent\(skjematypeFilter\)\}`/.test(oversikt), true);

    // Tittelen skal si hvilken skjematype man ser rapportene for, også om
    // navneoppslaget feiler — ellers ser det ut som filteret ikke virket.
    sjekk('tittelen settes', /async function settTittel\(\)/.test(oversikt), true);
    const tittel = oversikt.split('async function settTittel()')[1].split('\n        }')[0];
    sjekk('ID-en settes før oppslaget',
        tittel.indexOf('sett(`skjematype ${skjematypeFilter}`)') < tittel.indexOf("api.get('/api/skjematyper')"), true);
    sjekk('og begge indeksene ble funnet',
        [tittel.indexOf('sett(`skjematype ${skjematypeFilter}`)'), tittel.indexOf("api.get('/api/skjematyper')")]
            .every(i => i > -1), true);
    sjekk('navnet brukes når det finnes', /type\?\.Skjema_navn\) sett\(type\.Skjema_navn\)/.test(tittel), true);

    // Delepunktet må være kjent for den som skriver kolonnenavnet.
    const reditor = les('rapporteditor.html');
    sjekk('editoren forklarer understreken', /Sett\s*\n?\s*<code>_<\/code> der navnet kan brytes/.test(reditor), true);
    sjekk('og sier det der navnet faktisk skrives',
        /Bruk _ der navnet kan deles over to linjer/.test(reditor), true);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
