/**
 * To GUI-punkter fra brukertesting.
 *
 * **Søkefeltet huskes.** Under utvikling av en skjematype går man fram og
 * tilbake mellom oversikten, utfylling og editoren. Hver retur tømte
 * søkefeltet, og man måtte skrive seg fram til samme kort på nytt.
 *
 * Valget av lager er en del av oppførselen, ikke en detalj: `sessionStorage`,
 * ikke `localStorage` som fasefiltrene og eierbryteren. De to er innstillinger
 * man har valgt; et søk er arbeidsstate. Å åpne oversikten i morgen og få ei
 * liste filtrert av noe man skrev i går, ser ut som om skjematyper har
 * forsvunnet — en verre feil enn å måtte skrive søket på nytt.
 *
 * **Advarslene har ett uttrykk.** «Nullpunkt mangler» og «Feltreferanser uten
 * felt» hadde sin egen røde boks ved siden av diagnoseboksens oransje linjer.
 * To uttrykk for samme sak, og den røde så ut som en feil som stoppet noe —
 * begge gjør ingenting av den typen, skjemaet er lagret. De bruker nå
 * diagnoseboksens klasser, så det finnes ÉN definisjon av hvordan en advarsel
 * ser ut.
 *
 * Søkelagringen kjøres for EKTE: funksjonene klippes ut av HTML-fila og
 * kjøres mot et stubbet `sessionStorage`. En test som bare leste at ordet
 * «sessionStorage» står i fila, ville bestått på en lagring som aldri leses
 * tilbake.
 *
 * Kjøres med:  node frontend/test/oversikt-sok-og-varsel.test.js
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
const oversikt = les('velgskjematype.html');
const editor = les('editor.html');

/**
 * Klipper ut en funksjon fra en HTML-fil.
 *
 * Tar både `function navn(` og `window.navn = (` — filas to former. Et
 * bomskudd gir ÉN rød linje og tom streng, ikke et kast: en manglende
 * funksjon skal ikke ta resten av fila med seg, for da ser et hull ut som om
 * testene ikke finnes.
 */
function hentFunksjon(kilde, navn) {
    const former = [`function ${navn}(`, `window.${navn} = (`, `const ${navn} = (`];
    const i = former.map(f => kilde.indexOf(f)).find(x => x > -1);
    if (i === undefined) {
        feil++;
        console.log(`FEIL  fant ikke funksjonen ${navn}`);
        return '';
    }
    // Arrow-funksjonene avsluttes med «};», de vanlige med «}».
    const slutt = Math.min(
        ...[kilde.indexOf('\n        }', i), kilde.indexOf('\n        };', i)]
            .filter(x => x > -1).concat(kilde.length));
    return kilde.slice(i, slutt + 11);
}

// ---------- søket huskes, for ekte ----------
{
    const nokkel = oversikt.match(/const SOK_SS_NOKKEL = '([^']+)';/);
    sjekk('nøkkelen finnes', Boolean(nokkel), true);

    function lagMiljo(kasterVed = null) {
        const lager = new Map();
        return {
            lager,
            sessionStorage: {
                getItem: (k) => {
                    if (kasterVed === 'get') throw new Error('privat modus');
                    return lager.has(k) ? lager.get(k) : null;
                },
                setItem: (k, v) => { if (kasterVed === 'set') throw new Error('privat modus'); lager.set(k, String(v)); },
                removeItem: (k) => { if (kasterVed === 'set') throw new Error('privat modus'); lager.delete(k); }
            }
        };
    }

    function byggFunksjoner(miljo, feltVerdi) {
        const felt = { value: feltVerdi };
        const biter = [
            oversikt.match(/const SOK_SS_NOKKEL = '[^']+';/)[0],
            hentFunksjon(oversikt, 'lesLagretSok'),
            hentFunksjon(oversikt, 'lagreSok'),
            hentFunksjon(oversikt, 'gjenopprettSok')
        ];
        const fabrikk = new Function('sessionStorage', 'document',
            `${biter.join('\n')}\nreturn { lesLagretSok, lagreSok, gjenopprettSok };`);
        const api = fabrikk(miljo.sessionStorage, { getElementById: () => felt });
        return { ...api, felt };
    }

    {
        const m = lagMiljo();
        const f = byggFunksjoner(m, '');
        f.lagreSok('ikt');
        sjekk('teksten lagres', m.lager.get(nokkel[1]), 'ikt');
        sjekk('og leses tilbake', f.lesLagretSok(), 'ikt');
        f.gjenopprettSok();
        sjekk('og legges i feltet', f.felt.value, 'ikt');
    }
    {
        // Rått, ikke normalisert: feltet skal se ut nøyaktig som man forlot det.
        const m = lagMiljo();
        const f = byggFunksjoner(m, '');
        f.lagreSok('  IKT tjeneste ');
        f.gjenopprettSok();
        sjekk('store bokstaver og mellomrom beholdes', f.felt.value, '  IKT tjeneste ');
    }
    {
        // Tømmer man feltet, skal det BLI tomt neste gang — ikke komme
        // tilbake til forrige søk.
        const m = lagMiljo();
        const f = byggFunksjoner(m, '');
        f.lagreSok('ikt');
        f.lagreSok('');
        sjekk('tømt søk fjernes fra lageret', m.lager.has(nokkel[1]), false);
        sjekk('og gjenopprettes ikke', f.lesLagretSok(), '');
    }
    {
        // Et felt brukeren alt har skrevet i skal ikke overskrives — det
        // skjer hvis listen lastes på nytt mens man taster.
        const m = lagMiljo();
        const f = byggFunksjoner(m, 'noe nytt');
        f.lagreSok('gammelt');
        f.gjenopprettSok();
        sjekk('feltet overskrives ikke når det alt har tekst', f.felt.value, 'noe nytt');
    }
    {
        // Privat modus: søket skal virke, det huskes bare ikke. En kastet
        // exception her ville tatt hele oversikten.
        const m = lagMiljo('set');
        const f = byggFunksjoner(m, '');
        f.lagreSok('ikt');
        sjekk('skriving som kaster tas i mot', true, true);
        const m2 = lagMiljo('get');
        const f2 = byggFunksjoner(m2, '');
        sjekk('lesing som kaster gir tom streng', f2.lesLagretSok(), '');
        f2.gjenopprettSok();
        sjekk('og feltet står tomt', f2.felt.value, '');
    }
}

// ---------- selve kappestriden, kjørt ----------
{
    // Rekkefølgen som ødela det: brukeren hadde søkt, navigerer tilbake, og
    // et bakgrunnskall rekker å filtrere FØR feltet er gjenopprettet.
    //
    // Her kjøres den EKTE filtrer-kroppen mot et stubbet DOM. En test som
    // bare leste at «lagreSok» ikke står i filtrer, ville bestått på en
    // filtrer som kalte noe annet som lagret.
    const lager = new Map();
    const felt = { value: '' };
    const sessionStorageStubb = {
        getItem: (k) => (lager.has(k) ? lager.get(k) : null),
        setItem: (k, v) => lager.set(k, String(v)),
        removeItem: (k) => lager.delete(k)
    };
    const kode2 = utenKommentarer(oversikt);
    const biter = [
        oversikt.match(/const SOK_SS_NOKKEL = '[^']+';/)[0],
        hentFunksjon(oversikt, 'lesLagretSok'),
        hentFunksjon(oversikt, 'lagreSok'),
        hentFunksjon(oversikt, 'gjenopprettSok'),
        hentFunksjon(kode2, 'filtrer'),
        hentFunksjon(kode2, 'sokEndret')
    ];
    const fabrikk = new Function('sessionStorage', 'document', 'window', 'alle',
        'lesValgteFaser', 'kunEierValgt', 'skalVises', 'render',
        // `sokEndret` kaller `filtrer()` som en global. I nettleseren ER den
        // det (`window.filtrer = …`); i sandkassen må bindingen lages. `var`
        // hoistes, så navnet finnes allerede når funksjonene defineres.
        `${biter.join('\n')}\n`
        + 'var filtrer = window.filtrer;\n'
        + 'return { gjenopprettSok, sokEndret: window.sokEndret, filtrer: window.filtrer };');
    const api = fabrikk(
        sessionStorageStubb,
        { getElementById: () => felt },
        {},                      // window — filtrer/sokEndret settes på denne
        [],                      // alle
        () => ['Produksjon'],    // lesValgteFaser
        () => false,             // kunEierValgt
        () => true,              // skalVises
        () => {}                 // render
    );

    // 1. Brukeren søker.
    felt.value = 'ikt';
    api.sokEndret();
    sjekk('brukerens søk er lagret', lager.get('velgskjema-sok'), 'ikt');

    // 2. Navigerer bort og tilbake: nytt, tomt felt.
    felt.value = '';

    // 3. Bakgrunnskallet kommer tilbake FØR gjenopprettingen og filtrerer.
    //    Det er dette som tømte lageret før rettelsen.
    api.filtrer();
    sjekk('en programmatisk filtrering rører ikke lageret',
        lager.get('velgskjema-sok'), 'ikt');

    // 4. Gjenopprettingen finner det den skal.
    api.gjenopprettSok();
    sjekk('og søket står i feltet etterpå', felt.value, 'ikt');
}

// ---------- søket er knyttet til økta, ikke til maskinen ----------
{
    const kode = utenKommentarer(oversikt);
    // Bare de tre søkefunksjonene, ikke alt som står mellom dem i fila:
    // eierbryteren ligger rett under og bruker localStorage helt legitimt.
    const sokDel = ['lesLagretSok', 'lagreSok', 'gjenopprettSok']
        .map(n => hentFunksjon(kode, n)).join('\n');
    sjekk('søket ligger i sessionStorage', /sessionStorage/.test(sokDel), true);
    // Dette er poenget med valget: localStorage ville overlevd til neste dag.
    sjekk('og ikke i localStorage', /localStorage/.test(sokDel), false);
    // Fasene og eierbryteren er innstillinger og skal fortsatt ligge fast.
    sjekk('fasefiltrene ligger fortsatt i localStorage',
        /localStorage\.setItem\(FASER_LS_NOKKEL/.test(kode), true);
    sjekk('og eierbryteren også',
        /localStorage\.setItem\(KUN_EIER_LS_NOKKEL/.test(kode), true);

    // Gjenopprettingen skal skje ÉTT sted, og det er øverst i `init()` —
    // ikke i `lastListe()`, som ligger bak et api-kall. To steder ville
    // dessuten gitt to svar på «er feltet fylt ut ennå».
    sjekk('lastListe gjenoppretter ikke',
        /gjenopprettSok\(\)/.test(hentFunksjon(kode, 'lastListe') || ''), false);
    sjekk('det er bare én gjenoppretting i fila',
        (kode.match(/gjenopprettSok\(\);/g) || []).length, 1);
    // ---- kappestriden som gjorde at søket likevel forsvant ----
    //
    // Lagringen hang på `filtrer()`, som kalles programmatisk fra seks
    // steder. `init()` starter nullpunkt-kallet FØR `await lastListe()`:
    //
    //     api.get('/api/gevinst/nullpunkt-status').then(() => filtrer());
    //     await lastListe();          // ← gjenopprettSok() ligger her inne
    //
    // Rakk det svaret først, kjørte `filtrer()` mens feltet ennå var tomt, og
    // lagret tom streng OVER det lagrede søket. Gjenopprettingen fant da
    // ingenting. Feilen var tidsavhengig, så den så ut som om lagringen aldri
    // virket.
    //
    // Rettelsen er ikke en ny rekkefølge — den ville bare flyttet vinduet.
    // Bare BRUKERENS endring skal skrive til lageret.
    sjekk('filtrer skriver ikke til lageret',
        /lagreSok\(/.test(hentFunksjon(kode, 'filtrer') || ''), false);
    sjekk('det gjør inndata-håndtereren',
        /lagreSok\(/.test(hentFunksjon(kode, 'sokEndret') || ''), true);
    sjekk('og feltet er koblet til den',
        /oninput="sokEndret\(\)"/.test(oversikt), true);
    sjekk('ikke lenger rett til filtrer',
        /oninput="filtrer\(\)"/.test(oversikt), false);

    // Gjenopprettingen må skje før noe asynkront i det hele tatt kan filtrere.
    // Den trenger ingen data — bare feltet — så den hører øverst i init().
    const init = hentFunksjon(kode, 'init') || kode.slice(kode.indexOf('async function init'));
    sjekk('gjenopprettes før første api-kall i init',
        init.indexOf('gjenopprettSok()') < init.indexOf('api.get'), true);
    sjekk('og begge ble funnet i init',
        [init.indexOf('gjenopprettSok()'), init.indexOf('api.get')].every(i => i > -1), true);
}

// ---------- advarslene har ett uttrykk ----------
{
    const kode = utenKommentarer(editor);

    // Den egne røde boksen skal være BORTE — ikke bare omfarget. To
    // definisjoner av «slik ser en advarsel ut» er det som ga to uttrykk.
    sjekk('den egne advarselstilen er fjernet', /\.nullpunkt-advarsel\s*\{/.test(kode), false);
    sjekk('og strong-regelen med den', /\.nullpunkt-advarsel strong/.test(kode), false);

    // Begge bannerne bruker diagnoseboksen.
    for (const [navn, id] of [['nullpunkt', 'nullpunkt-advarsel'], ['feltreferanser', 'feltref-advarsel']]) {
        const i = kode.indexOf(`el.id = '${id}';`);
        sjekk(`${navn}-banneret finnes`, i > -1, true);
        const blokk = kode.slice(i, i + 900);
        sjekk(`${navn} bruker diagnoseboksen`, /el\.className = 'diagnose';/.test(blokk), true);
        sjekk(`${navn} har diagnose-tittel`, /class="diagnose-tittel"/.test(blokk), true);
        // Oransje, ikke rød: ingen av dem stopper noe — skjemaet er lagret.
        sjekk(`${navn} er en advarsel`, /class="diagnose-linje advarsel"/.test(blokk), true);
        sjekk(`${navn} er ikke en feil`, /class="diagnose-linje feil"/.test(blokk), false);
        // Lukkeknappen må overleve omskrivingen — banneret skal kunne lukkes.
        sjekk(`${navn} kan lukkes`, /title="Lukk"/.test(blokk), true);
    }

    // Klassene de nå bruker MÅ ha en regel. En klasse uten regel er
    // ingenting, med en kommentar som påstår det motsatte.
    for (const regel of ['.diagnose {', '.diagnose-topp {', '.diagnose-tittel {',
                         '.diagnose-funn {', '.diagnose-linje {']) {
        sjekk(`regelen ${regel} finnes`, kode.includes(regel), true);
    }
    sjekk('og advarsel-varianten er oransje',
        /\.diagnose-linje\.advarsel \{ border-left-color: var\(--warning\); \}/.test(kode), true);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
