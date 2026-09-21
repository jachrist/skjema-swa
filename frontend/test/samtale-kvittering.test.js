/**
 * Samtalen på kvitteringen.
 *
 * Kvitteringen hadde en knapp med teksten «Still et spørsmål om saken», som
 * pekte videre til visningssiden. To ting var galt med den:
 *
 *   Teksten lovet noe skjematypen ikke alltid tillot. Står samtalen på
 *   «Behandlere», kan innsenderen svare — men ikke stille det første
 *   spørsmålet. Knappen sa likevel det samme.
 *
 *   Varselet innsenderen får når en behandler starter en samtale, lenker til
 *   kvitteringen. En side som bare sier «du har en melding et annet sted» er
 *   en omvei.
 *
 * Nå ligger selve widgeten der, og den avgjør synligheten ved å spørre
 * serveren. Det er testens hovedpoeng: siden skal IKKE ha sin egen kopi av
 * regelen. To kopier av en tilgangsregel blir før eller siden uenige, og da er
 * det grensesnittet som lyver.
 *
 * I tillegg sjekkes ankeret `#samtale`. Varsellenkene ender på det, og fantes
 * det bare på visning.html — slik det gjorde — lander mottakeren på toppen av
 * siden og må lete etter det hen ble varslet om.
 *
 * Kjøres med:  node frontend/test/samtale-kvittering.test.js
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

const rot = path.join(__dirname, '..');
const les = (f) => fs.readFileSync(path.join(rot, f), 'utf8');

const kvittering = les('kvittering.html');
const kode = utenKommentarer(kvittering);

// ---------- knappen er borte, widgeten er der ----------
{
    sjekk('ingen «Still et spørsmål»-knapp', /Still et spørsmål/.test(kode), false);
    sjekk('ingen start-samtale-lenke', /id="start-samtale"/.test(kvittering), false);

    sjekk('widgeten importeres', /import\(['"]\.\/js\/samtale\.js['"]\)/.test(kode), true);
    sjekk('og bygges', /byggSamtale\(/.test(kode), true);
    sjekk('og startes', /\.start\(\)/.test(kode), true);

    // Widgeten poller. Uten stopp lever timeren videre når fanen forlates.
    sjekk('pollingen stoppes ved pagehide',
        /pagehide[\s\S]{0,120}\.stopp\(\)/.test(kode), true);
}

// ---------- siden har ingen egen kopi av regelen ----------
{
    // Innstillingen ('Av' / 'Behandlere' / 'Alle') bor i samtale-tilgang.js.
    // Dukker den opp her, er det en andre kopi.
    sjekk('ingen innstillingsnavn på siden', /'Behandlere'|"Behandlere"/.test(kode), false);
    sjekk('ingen Samtale-innstilling leses', /\.Samtale\b/.test(kode), false);

    // Den forrige versjonen spurte serveren om `synlig`/`kanSkrive` og tegnet
    // knappen selv. Widgeten gjør det nå — siden skal ikke gjøre begge deler.
    sjekk('siden tolker ikke synlig selv', /svar\?\.synlig|\.kanSkrive/.test(kode), false);

    // Og rollen skal ikke regnes ut i nettleseren.
    sjekk('siden gjetter ikke rollen',
        /Innsender_Epost[\s\S]{0,80}userDetails/.test(kode), false);
}

// ---------- ankeret finnes der varslene peker ----------
{
    // varsling.js bygger lenker til disse to sidene, begge med #samtale.
    const varsling = fs.readFileSync(
        path.join(rot, '..', 'api', 'src', 'lib', 'varsling.js'), 'utf8');
    const sider = [...varsling.matchAll(/side: '([a-z-]+\.html)'/g)].map(m => m[1]);
    sjekk('varslingen bruker kvitteringen og behandlingssiden',
        [...new Set(sider)].sort(), ['evaluering.html', 'kvittering.html']);

    for (const fil of ['kvittering.html', 'evaluering.html', 'visning.html']) {
        const k = utenKommentarer(les(fil));
        const harAnker = /id="samtale"/.test(k) || /\.id = 'samtale'/.test(k);
        sjekk(`${fil} har ankeret #samtale`, harAnker, true);
    }
}

// ---------- oversiktslenken styres fortsatt av serveren ----------
{
    // Kvitteringen er den ene siden en vanlig innsender garantert ser, og
    // lenken til skjemaoversikten skal ikke vises for hen. Den sjekken lå i
    // koden som ble skrevet om, og skal ikke ha falt ut på veien.
    sjekk('styrOversiktslenker kalles', /styrOversiktslenker\(api\)/.test(kode), true);
    sjekk('lenken er merket', /data-oversiktslenke/.test(kvittering), true);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
