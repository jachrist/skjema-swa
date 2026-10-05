/**
 * Forklaringen på at innsenderen havnet på visningssiden.
 *
 * `evaluering.html` sender en innsender uten behandlingsoppgave videre til
 * `visning.html`. Omdirigeringen er riktig, men den var stum: adressen i
 * lenka fra e-posten byttet seg ut mens siden lastet, og det eneste brukeren
 * så var at lenken «gikk et annet sted». Det ble meldt som en feil i lenka og
 * kostet en feilsøkingsrunde på noe som virket som det skulle.
 *
 * Tre ting testes, og det siste er det som gjør at banneret ikke kan
 * forsvinne stille:
 *
 *   **Lenka bygges av modulen.** Parameternavnet står ett sted, og både den
 *   som skriver det og den som leser det bruker samme konstant. To
 *   strengliteraler ville gjort en skrivefeil til en omdirigering uten
 *   forklaring — altså akkurat tilstanden dette skulle rette.
 *
 *   **En ukjent grunn gir ingenting.** Siden skal ikke tegne en tom boks, og
 *   den som selv åpnet visningen skal ikke få en forklaring på hvorfor hen er
 *   der.
 *
 *   **Hver grunn en side faktisk sender, har en tekst.** Dette er sjekken som
 *   fanger en skrivefeil i `evaluering.html`: en grunn uten tekst gir
 *   `grunnTekst() === null`, og banneret uteblir uten et eneste varsel.
 *
 * Kjøres med:  node frontend/test/visningsgrunn.test.js
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { utenKommentarer } = require('../../scripts/test-kilde.js');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const frontend = path.join(__dirname, '..');
const les = (f) => utenKommentarer(fs.readFileSync(path.join(frontend, f), 'utf8'));

(async () => {
    // Den ekte modulen, ikke en klipt kopi.
    const m = await import(pathToFileURL(path.join(frontend, 'js', 'visningsgrunn.js')).href);

    // ---------- lenka ----------
    {
        const uten = m.visningslenke('T1', 'S1');
        sjekk('lenke uten grunn', uten, '/visning.html?skjematype_id=T1&skjema_id=S1');
        sjekk('uten grunn: ingen parameter', uten.includes(m.GRUNN_PARAM + '='), false);

        const med = m.visningslenke('T1', 'S1', 'ingen-behandling');
        sjekk('med grunn: parameteren er med',
            med.includes(`${m.GRUNN_PARAM}=ingen-behandling`), true);

        // Hash hører etter spørringen, ikke inni den.
        const hash = m.visningslenke('T1', 'S1', 'ingen-behandling', '#steg-2');
        sjekk('hash havner sist', hash.endsWith('#steg-2'), true);
        sjekk('hash er ikke en del av spørringen', /#steg-2[^#]*=/.test(hash), false);

        // Id-er er brukerdata og kan inneholde tegn som bryter en spørring.
        const rart = m.visningslenke('A&B', 'x y', 'ingen-behandling');
        sjekk('id-er er kodet', rart.includes('skjematype_id=A%26B'), true);
        sjekk('mellomrom er kodet', /skjema_id=x(\+|%20)y/.test(rart), true);
    }

    // ---------- ukjent grunn ----------
    {
        sjekk('kjent grunn har tittel og tekst',
            Object.keys(m.grunnTekst('ingen-behandling') || {}).sort(), ['tekst', 'tittel']);
        sjekk('tittelen er ikke tom', (m.grunnTekst('ingen-behandling').tittel || '').length > 0, true);
        sjekk('teksten er ikke tom', (m.grunnTekst('ingen-behandling').tekst || '').length > 0, true);

        sjekk('ukjent grunn', m.grunnTekst('tull'), null);
        sjekk('ingen grunn', m.grunnTekst(null), null);
        sjekk('udefinert grunn', m.grunnTekst(undefined), null);
        sjekk('tom streng', m.grunnTekst(''), null);
    }

    // ---------- sidene bruker modulen ----------
    {
        const ev = les('evaluering.html');
        sjekk('evaluering bygger lenka med modulen', /visningslenke\(/.test(ev), true);
        // Ingen håndskrevet lenke igjen — den ville ikke hatt grunnen med.
        sjekk('ingen håndskrevet visning-lenke', /'\/visning\.html\?|`\/visning\.html\?/.test(ev), false);

        const vis = les('visning.html');
        sjekk('visning leser parameteren fra modulen', /params\.get\(GRUNN_PARAM\)/.test(vis), true);
        sjekk('visning har ingen egen parameterstreng', /get\('grunn'\)|get\("grunn"\)/.test(vis), false);
        sjekk('visning kaller grunnTekst', /grunnTekst\(/.test(vis), true);
        // Teksten skal settes som tekst. Den er vår egen, men vanen er verdt å holde.
        sjekk('teksten settes som textContent', /tekst\.textContent = grunn\.tekst/.test(vis), true);
        sjekk('banneret har et sted å stå', /id="visningsgrunn"/.test(vis), true);

        // Hver grunn en side sender, må finnes i kartet.
        const sendte = [...ev.matchAll(/visningslenke\([^)]*?,[^,)]*?,\s*'([^']*)'/g)].map(t => t[1]);
        sjekk('evaluering sender minst én grunn', sendte.length > 0, true);
        sjekk('alle sendte grunner har tekst', sendte.filter(g => !m.grunnTekst(g)), []);
    }

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
})();
