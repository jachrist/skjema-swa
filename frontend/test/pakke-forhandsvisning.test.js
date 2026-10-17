/**
 * Forhåndsvisningen før import av skjematype-definisjoner.
 *
 * Importen skriver i et miljø noen skal stole på etterpå. Det som prøves her
 * er at forhåndsvisningen ikke tier om det som gjør en import farlig:
 *
 *   **En type som finnes fra før må vises som «hoppes over»**, med grunnen —
 *   ikke stilltiende utelates.
 *
 *   **En manglende oppslagsliste må stå i raden.** Nedtrekket blir ellers
 *   tomt i målmiljøet, og et tomt nedtrekk er umulig å skille fra «ingenting
 *   er godkjent ennå».
 *
 *   **Ingenting havner uescapet i HTML-en.** Navn og feiltekster kommer fra
 *   en fil noen har lastet opp.
 *
 * Kjøres med:  node frontend/test/pakke-forhandsvisning.test.js
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

function klipp(navn) {
    const start = kilde.indexOf(`function ${navn}(`);
    if (start === -1) throw new Error(`Fant ikke ${navn} i admin.html`);
    const slutt = kilde.indexOf('\n        }', start) + '\n        }'.length;
    return kilde.slice(start, slutt);
}

const escapeSti = JSON.stringify(path.join(__dirname, '..', 'js', 'escape.js'));
const pakkePlanRad = new Function('require', `
    const escHtml = (s) => require(${escapeSti}).escapeHtml(s);
    ${klipp('pakkePlanRad')}
    return pakkePlanRad;
`)(require);

// ---------- 1. handlingen vises, med grunnen ----------
{
    const ny = pakkePlanRad({ id: '7', navn: 'Vurdering', fase: 'Produksjon', handling: 'ny', grunn: '', advarsler: [] });
    sjekk('ny type merkes som ny', /\bny\b/.test(ny), true);
    sjekk('og id-en vises', ny.includes('7'), true);
    sjekk('og navnet', ny.includes('Vurdering'), true);

    const hopp = pakkePlanRad({
        id: '7', navn: 'Vurdering', handling: 'hopper-over',
        grunn: 'Finnes fra før. Kryss av for overskriving hvis den skal erstattes', advarsler: []
    });
    sjekk('en type som hoppes over sier det', hopp.includes('hoppes over'), true);
    sjekk('og grunnen står i raden', hopp.includes('Finnes fra før'), true);

    const over = pakkePlanRad({ id: '7', navn: 'V', handling: 'overskriv', grunn: 'Finnes fra før og blir erstattet', advarsler: [] });
    sjekk('overskriving skrives med store bokstaver', over.includes('OVERSKRIVES'), true);
    // De tre handlingene skal ikke se like ut — det er hele poenget med
    // forhåndsvisningen.
    sjekk('de tre handlingene gir ulik tekst',
        new Set([ny, hopp, over].map(h => /">(ny|hoppes over|OVERSKRIVES)</.exec(h)?.[1])).size, 3);

    // En type uten navn skal ikke vises som en tom rad.
    sjekk('uten navn vises en plassholder',
        pakkePlanRad({ id: '9', navn: '', handling: 'ny', advarsler: [] }).includes('(uten navn)'), true);
}

// ---------- 2. advarslene står i raden ----------
{
    const med = pakkePlanRad({
        id: '7', navn: 'V', handling: 'ny', grunn: '',
        advarsler: ['Peker på oppslagsliste(r) som ikke finnes her: "Godkjente".',
            'Krypteres=Alt. Det lages en NY nøkkel i dette miljøet']
    });
    sjekk('begge advarslene vises', (med.match(/⚠/g) || []).length, 2);
    sjekk('oppslagslista navngis', med.includes('Godkjente'), true);
    sjekk('og krypteringen', med.includes('NY nøkkel'), true);

    const uten = pakkePlanRad({ id: '7', navn: 'V', handling: 'ny', grunn: '', advarsler: [] });
    sjekk('ingen advarsler gir ingen varseltegn', /⚠/.test(uten), false);
    // Og en rad uten `advarsler` i det hele tatt skal ikke velte visningen.
    sjekk('manglende advarsler-felt tåles', typeof pakkePlanRad({ id: '1', handling: 'ny' }), 'string');
}

// ---------- 3. ingenting havner uescapet ----------
{
    const ondt = '<img src=x onerror=alert(1)>';
    const html = pakkePlanRad({
        id: ondt, navn: ondt, fase: ondt, handling: 'ny', grunn: ondt, advarsler: [ondt]
    });
    sjekk('ingen rå tag i HTML-en', html.includes('<img'), false);
    sjekk('men verdiene er med, escapet', (html.match(/&lt;img/g) || []).length >= 4, true);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
