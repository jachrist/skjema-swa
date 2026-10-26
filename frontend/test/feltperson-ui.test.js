/**
 * Feltreferanse som mottaker, i tilgang-editoren (ønske 73).
 *
 * «{2-01}» i personlista betyr «adressen innsenderen skrev i det feltet».
 * Regelen for hva som ER en slik referanse finnes nå to steder: i
 * api/src/lib/feltperson.js, som løser den opp, og i tilgang-editoren, som
 * viser den fram. To regler for samme spørsmål er mønsteret som har bitt oss
 * flere ganger i dette repoet — derfor kjøres BEGGE regexene mot de samme
 * tilfellene og må svare likt. Endrer noen den ene, blir dette rødt.
 *
 * Det samme gjelder listen over LOVLIGE FELTTYPER. Tilbyr velgeren et
 * Tekst-felt som ekspansjonen avviser, har skjemaeier gjort et valg som ikke
 * virker — uten å få vite det før noen ikke fikk e-post. Også den lista leses
 * fra begge steder og sammenlignes.
 *
 * Ellers tre ting:
 *
 *   **Velgeren vises bare der den betyr noe.** Publikum og Eiere får ingen
 *   feltreferanser inn, og skal ikke tilbys en mottaker som først finnes ved
 *   innsending.
 *
 *   **Hele oppføringen blir referansen.** Velgeren skal legge inn «{2-01}»,
 *   ikke flette den inn i noe. Begrunnelsen står i feltperson.js.
 *
 *   **Chipen viser feltet, ikke koden.** «{2-01}» sier ingenting til den som
 *   setter opp skjemaet, og forveksling mellom to felter er nettopp det
 *   visningen skal hindre.
 *
 * Kjøres med:  node frontend/test/feltperson-ui.test.js
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

const uiRå = fs.readFileSync(path.join(__dirname, '..', 'js', 'tilgang-editor.js'), 'utf8');
const ui = utenKommentarer(uiRå);
const api = utenKommentarer(
    fs.readFileSync(path.join(__dirname, '..', '..', 'api', 'src', 'lib', 'feltperson.js'), 'utf8'));

// ---------- samme regel to steder ----------
{
    const uiRe = /function erFeltperson\(p\) \{\s*return (\/.+?\/)\.test/.exec(ui);
    const apiRe = /const HEL_REFERANSE = (\/.+?\/);/.exec(api);
    sjekk('editoren har en regel', !!uiRe, true);
    sjekk('api-et har en regel', !!apiRe, true);

    if (uiRe && apiRe) {
        // eslint-disable-next-line no-eval
        const a = eval(uiRe[1]);
        // eslint-disable-next-line no-eval
        const b = eval(apiRe[1]);
        const tilfeller = [
            '{2-01}', '  {2-01} ', '{3f7a1c2e-0000-0000-0000-000000000000}',
            'ola@example.no', 'sjef-{2-01}@x.no', 'Klassesjef({2-01})',
            '{}', '{a}{b}', '', '{2-01} og {2-02}'
        ];
        const ulike = tilfeller.filter(t => a.test(t) !== b.test(t));
        sjekk('reglene svarer likt på alle tilfellene', ulike, []);

        // At de er like er ikke nok — de kan være like og begge gale.
        sjekk('ren referanse er en referanse', a.test('{2-01}'), true);
        sjekk('innfletting er det ikke', a.test('sjef-{2-01}@x.no'), false);
        sjekk('rollestreng er det ikke', a.test('Klassesjef({2-01})'), false);
    }
}

// ---------- samme typeliste to steder ----------
{
    const uiListe = /export const FELTPERSON_TYPER = (\[[^\]]*\]);/.exec(ui);
    const apiListe = /const GYLDIGE_FELTTYPER = (\[[^\]]*\]);/.exec(api);
    sjekk('editoren har en typeliste', !!uiListe, true);
    sjekk('api-et har en typeliste', !!apiListe, true);
    if (uiListe && apiListe) {
        // eslint-disable-next-line no-eval
        sjekk('listene er like', eval(uiListe[1]), eval(apiListe[1]));
        // eslint-disable-next-line no-eval
        sjekk('og inneholder E-post', eval(apiListe[1]), ['E-post']);
    }

    // Velgeren må faktisk BRUKE regelen, ikke bare ha den liggende.
    sjekk('dropdownen filtreres på regelen',
        /feltReferanser\.filter\(erPersonfelt\)/.test(ui), true);
    sjekk('knappen sperrer også',
        /if \(!erPersonfelt\(valgt\)\)/.test(ui), true);
    sjekk('uten brukbart felt er velgeren deaktivert',
        /velg\.disabled = aktuelle\.length === 0;/.test(ui), true);
}

// ---------- persondatakildene, og at tvillingene svarer likt ----------
//
// Fra 26.10.2026 er det TO veier til en kontrollert adresse: felttypen
// E-post, eller et flervalgsfelt som henter valgene fra en persondatakilde.
// Den andre veien kom fordi en kadett som velger klassesjefen sin fra en
// Studenter-nedtrekk ellers måtte skrive adressen på nytt i et E-post-felt —
// en adresse systemet allerede hadde.
//
// Regelen finnes nødvendigvis to steder (frontend kan ikke require backend).
// Her kjøres BEGGE implementasjonene mot de samme feltene og må svare likt.
// Det er sterkere enn å sammenligne listene: `datakildenTil` må også være
// enig om pipe-formen og om merket `FasteData_kilde`.
{
    const uiKilder = /export const FELTPERSON_DATAKILDER = (\[[^\]]*\]);/.exec(ui);
    const apiKilder = /const PERSON_DATAKILDER = (\[[^\]]*\]);/.exec(api);
    sjekk('editoren har en kildeliste', !!uiKilder, true);
    sjekk('api-et har en kildeliste', !!apiKilder, true);
    if (uiKilder && apiKilder) {
        // eslint-disable-next-line no-eval
        sjekk('kildelistene er like', eval(uiKilder[1]), eval(apiKilder[1]));
    }

    // Flervalgstypene eies av placeholder.js. Editorens kopi må stemme med
    // den, ellers tilbyr velgeren en type ekspansjonen leser annerledes.
    const ph = utenKommentarer(fs.readFileSync(
        path.join(__dirname, '..', '..', 'api', 'src', 'lib', 'placeholder.js'), 'utf8'));
    const uiFlerv = /export const FLERVALGSTYPER = (\[[^\]]*\]);/.exec(ui);
    const apiFlerv = /const FLERVALGSTYPER = new Set\((\[[^\]]*\])\);/.exec(ph);
    sjekk('begge kjenner flervalgstypene', !!uiFlerv && !!apiFlerv, true);
    if (uiFlerv && apiFlerv) {
        // eslint-disable-next-line no-eval
        sjekk('flervalgstypene er like', eval(uiFlerv[1]).sort(), eval(apiFlerv[1]).sort());
    }

    // Kjør begge implementasjonene. Hentet ut som kildetekst og evaluert —
    // en håndskrevet kopi i testen ville vært en TREDJE regel.
    const hent = (kilde, navn) => {
        const i = kilde.indexOf(`function ${navn}(`);
        if (i < 0) return null;
        let dybde = 0, start = kilde.indexOf('{', i);
        for (let j = start; j < kilde.length; j++) {
            if (kilde[j] === '{') dybde++;
            else if (kilde[j] === '}' && --dybde === 0) return kilde.slice(i, j + 1);
        }
        return null;
    };
    const lag = (kilde, flervalgUttrykk) => {
        const d = hent(kilde, 'datakildenTil'), e = hent(kilde, 'erPersonfelt');
        if (!d || !e) return null;
        // eslint-disable-next-line no-new-func
        return new Function(`
            const GYLDIGE_FELTTYPER = ['E-post'];
            const FELTPERSON_TYPER = ['E-post'];
            const PERSON_DATAKILDER = ['Personer', 'Studenter'];
            const FELTPERSON_DATAKILDER = PERSON_DATAKILDER;
            const FLERVALGSTYPER = ${flervalgUttrykk};
            ${d}
            ${e}
            return { datakildenTil, erPersonfelt };
        `)();
    };
    const uiImpl = lag(ui, "['Flervalg-dropdown', 'Flervalg-knapper']");
    const apiImpl = lag(api, "new Set(['Flervalg-dropdown', 'Flervalg-knapper'])");
    sjekk('fant begge implementasjonene', !!uiImpl && !!apiImpl, true);

    if (uiImpl && apiImpl) {
        const tilfeller = [
            // Vei 1: felttypen
            { Type: 'E-post' },
            { Type: 'Tekst' },
            // Vei 2: persondatakilde, i alle tre formene FasteData kan ha
            { Type: 'Flervalg-dropdown', FasteData: { Datakilde: 'Studenter' } },
            { Type: 'Flervalg-knapper', FasteData: { Datakilde: 'Personer' } },
            { Type: 'Flervalg-dropdown', FasteData: 'Studenter|Klasse|=|A' },
            { Type: 'Flervalg-dropdown', FasteData_kilde: 'Studenter' },
            { Type: 'Flervalg-dropdown', FasteData: '', FasteData_kilde: 'Personer' },
            // Feil datakilde — gir ikke en adresse
            { Type: 'Flervalg-dropdown', FasteData: { Datakilde: 'Klasser' } },
            { Type: 'Flervalg-dropdown', FasteData: { Datakilde: 'Roller' } },
            { Type: 'Flervalg-dropdown', FasteData: 'Postnumre|||' },
            // Riktig datakilde, men feil felttype
            { Type: 'Tekst', FasteData: { Datakilde: 'Studenter' } },
            // Valglister uten datakilde i det hele tatt
            { Type: 'Flervalg-dropdown' },
            { Type: 'Flervalg-dropdown', FasteData: null },
            // Rusk
            {}, { Type: '' }, { Type: 'Flervalg-dropdown', FasteData: [] }
        ];
        const ulike = tilfeller.filter(f =>
            uiImpl.erPersonfelt(f) !== apiImpl.erPersonfelt(f)
            || uiImpl.datakildenTil(f) !== apiImpl.datakildenTil(f));
        sjekk('tvillingene svarer likt på alle tilfellene', ulike, []);

        // Og at reglene faktisk SKILLER. Svarte begge «nei» overalt, ville
        // testen over vært grønn og utvidelsen gjort ingenting.
        sjekk('persondatakilde-feltet godtas',
            apiImpl.erPersonfelt({ Type: 'Flervalg-dropdown', FasteData: { Datakilde: 'Studenter' } }), true);
        sjekk('merket fra det innsendte skjemaet godtas',
            apiImpl.erPersonfelt({ Type: 'Flervalg-dropdown', FasteData_kilde: 'Studenter' }), true);
        sjekk('feil datakilde avvises',
            apiImpl.erPersonfelt({ Type: 'Flervalg-dropdown', FasteData: { Datakilde: 'Klasser' } }), false);
        sjekk('Tekst-felt avvises fortsatt',
            apiImpl.erPersonfelt({ Type: 'Tekst' }), false);
        sjekk('Tekst-felt med persondatakilde avvises også',
            apiImpl.erPersonfelt({ Type: 'Tekst', FasteData: { Datakilde: 'Studenter' } }), false);
    }
}

// ---------- velgeren finnes, og bare der den betyr noe ----------
{
    sjekk('velgeren bygges', /function byggFeltperson\(\)/.test(ui), true);
    sjekk('den vises bare med feltreferanser',
        /if \(feltReferanser\.length > 0\) sek\.appendChild\(byggFeltperson\(\)\);/.test(ui), true);
    sjekk('hele oppføringen blir referansen', /const streng = `\{\$\{ref\}\}`;/.test(ui), true);
    sjekk('duplikat legges ikke til', /if \(!state\.Personer\.includes\(streng\)\)/.test(ui), true);
    sjekk('tomt valg avvises', /Velg et felt f/.test(ui), true);

    // Publikum og Eiere sender ingen feltReferanser — kontrollen på at
    // editoren faktisk kalles uten dem, ligger i editor.html.
    const editor = utenKommentarer(fs.readFileSync(path.join(__dirname, '..', 'editor.html'), 'utf8'));
    sjekk('editor.html ble lest', editor.length > 50000, true);
    const pub = editor.slice(editor.indexOf('const pubEl'), editor.indexOf('const eiEl'));
    sjekk('Publikum får ingen feltreferanser', /feltReferanser/.test(pub), false);
    sjekk('mottakervelgerne får dem', /const felles = \{[^}]*feltReferanser: felter/.test(editor), true);

    // Uten `type` på oppføringene ville filteret over tømt dropdownen, og
    // velgeren sett ut som om skjemaet ikke har E-post-felter.
    //
    // Sjekken leser OPPFØRINGEN, ikke linjeskiftene: den festet tidligere
    // hele kallet på én linje, og ble rød da objektet ble brukket over
    // flere linjer uten at noe faktisk endret seg. En test som går i
    // stykker av ombrekking, måler formatering — ikke regelen.
    const push = /felter\.push\(\{([\s\S]{0,300}?)\}\);/.exec(editor);
    sjekk('fant oppføringen som bygges', !!push, true);
    sjekk('felttypen følger med referansen',
        !!push && /\btype:\s*felt\.Type\b/.test(push[1]), true);
    sjekk('og referansen er med', !!push && /\bref\b/.test(push[1]), true);
}

// ---------- chipen viser feltet, ikke koden ----------
{
    const kilde = /function personTilVisning\(p\) \{[\s\S]*?\n    \}/.exec(ui);
    sjekk('visningen finnes', !!kilde, true);
    if (kilde) {
        const feltReferanser = [{ ref: '2-01', tekst: 'S2-F1: Din e-post' }];
        const erFeltperson = (p) => /^\s*\{[^{}]+\}\s*$/.test(String(p || ''));
        // eslint-disable-next-line no-eval
        const vis = eval(`(${kilde[0].replace(/^function /, 'function ')})`);

        sjekk('kjent felt vises med tekst', vis('{2-01}'), 'E-post fra «S2-F1: Din e-post»');
        sjekk('koden står ikke i visningen', vis('{2-01}').includes('2-01'), false);
        sjekk('ukjent felt vises som svar', vis('{9-99}'), 'E-post fra svar {9-99}');
        sjekk('vanlig adresse vises uendret', vis('ola@x.no'), 'ola@x.no');
        void erFeltperson; void feltReferanser;
    }
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
