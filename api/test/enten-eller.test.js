/**
 * To app settings som utelukker hverandre, og en kravliste som ikke visste det.
 *
 * 21.10.2026, midt i kapittel 4 av prod-kjøringen: sertifikatet var lagt inn
 * som `graph-client-cert-pem`, og `vis-appsettings.js prod --kommandoer` ga en
 * ferdig kommando som satte `GRAPH_CLIENT_SECRET` til v2 sin hemmelighet.
 * `--navn` listet den samme som PÅKREVD, så ferdig-kriteriet i 4.2 («tom
 * utskrift = ferdig») ville ikke blitt oppfylt før den var satt.
 *
 * Og `tokenKropp()` i `graph-opplast.js` lar hemmeligheten vinne når begge er
 * satt. Verktøyet dyttet altså operatøren mot det ene oppsettet der
 * sertifikatet aldri prøves — og det oppdages den dagen hemmeligheten
 * utløper, ikke før.
 *
 * Kokeboka SA det riktige i 0.5. Men 0.5 er 150 linjer fra kommandoene, og en
 * advarsel som ikke står der handlingen utføres, er en advarsel man leser
 * etterpå.
 *
 * Regelen testen holder: gruppa er deklarert ETT sted (`ENTEN_ELLER`),
 * standardvalget er det samme som koden faktisk foretrekker, og BEGGE kallene
 * i kokeboka bærer samme `--velg`.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const rot = path.join(__dirname, '..', '..');
const SKRIPT = path.join(rot, 'scripts', 'vis-appsettings.js');
const vis = require(SKRIPT);
const { ENTEN_ELLER, gruppenTil, valgteMedlemmer, utelatt } = vis;

function kjor(args) {
    return execFileSync('node', [SKRIPT, ...args], { encoding: 'utf8' });
}

// ---------- 1. gruppa er deklarert, og medlemmene finnes ----------
sjekk('det finnes minst én enten/eller-gruppe', ENTEN_ELLER.length > 0, true);
sjekk('hver gruppe har minst to medlemmer',
    ENTEN_ELLER.filter(gr => gr.length < 2).length, 0);

// Et navn som ikke står i inventaret, er en gruppe som beskriver noe annet
// enn virkeligheten. Alle tre miljøfilene leses — det er de tre aktive.
for (const miljo of ['dev', 'pilot', 'prod']) {
    const fil = JSON.parse(fs.readFileSync(
        path.join(rot, 'config', `env.${miljo}.json`), 'utf8'));
    const navn = new Set();
    (function samle(o) {
        if (o && typeof o === 'object') {
            for (const [k, v] of Object.entries(o)) {
                if (v && typeof v === 'object'
                    && ('keyvault' in v || 'value' in v || 'valgfri' in v
                        || 'settes_direkte' in v || 'kun_dokumentasjon' in v)) {
                    navn.add(k);
                } else samle(v);
            }
        }
    })(fil);
    const mangler = ENTEN_ELLER.flat().filter(n => !navn.has(n));
    sjekk(`env.${miljo}.json har alle medlemmene av gruppene`, mangler, []);
}

// ---------- 2. standardvalget er det koden faktisk foretrekker ----------
//
// Dette er den egentlige bindingen. `ENTEN_ELLER[0][0]` er standardvalget, og
// det skal være den legitimasjonen `tokenKropp()` velger når begge er satt.
// Snus rekkefølgen i koden en dag, skal denne si fra — ikke tilpasse seg.
{
    const kilde = fs.readFileSync(
        path.join(rot, 'api', 'src', 'lib', 'graph-opplast.js'), 'utf8');
    const fra = kilde.indexOf('function tokenKropp');
    sjekk('fant tokenKropp i koden', fra > 0, true);
    const kropp = kilde.slice(fra, kilde.indexOf('\n}', fra));

    // Hvilken av de to som vinner, leses ut av den tidlige returen.
    const tidlig = /if \(k\.clientSecret\)\s*return/.test(kropp);
    sjekk('hemmeligheten vinner i koden', tidlig, true);

    const gruppe = gruppenTil('GRAPH_CLIENT_SECRET');
    sjekk('hemmeligheten er med i en gruppe', !!gruppe, true);
    if (gruppe) {
        sjekk('og den som vinner i koden, er standardvalget',
            gruppe[0], tidlig ? 'GRAPH_CLIENT_SECRET' : 'GRAPH_CLIENT_CERT_PEM');
    }
}

// ---------- 2b. lagringsparet: strengen vinner, og den er standardvalget ----------
//
// Samme form som GRAPH-paret, og den sto i repoet lenge før den ble erklært:
// `lagringsvalg.js` tar tilkoblingsstrengen når den er satt, og leser da til
// og med KONTONAVNET ut av strengen. `STORAGE_ACCOUNT_NAME` blir ikke bare
// ignorert — den kan peke på en annen konto uten at noe sier fra.
{
    const kilde = fs.readFileSync(
        path.join(rot, 'api', 'src', 'lib', 'lagringsvalg.js'), 'utf8');

    // Navnene leses ut av modulen, ikke skrevet opp her.
    const streng = /const STRENG_VAR = '([^']+)'/.exec(kilde);
    const konto = /const KONTO_VAR = '([^']+)'/.exec(kilde);
    sjekk('fant begge variabelnavnene i lagringsvalg.js',
        !!streng && !!konto, true);

    if (streng && konto) {
        const gruppe = gruppenTil(streng[1]);
        sjekk('lagringsparet er erklært', !!gruppe, true);
        if (gruppe) {
            sjekk('og begge navnene er med',
                gruppe.slice().sort(), [streng[1], konto[1]].sort());

            // Hvem som vinner, AVGJØRES VED Å KJØRE funksjonen med begge
            // satt. Første utgave sammenlignet posisjonen til to tekstlige
            // `if`-linjer, og en mutasjon som la inn en ny gren foran dem
            // forble grønn — proxyen målte ikke oppførselen.
            const { lagringsvalg } = require(
                path.join(rot, 'api', 'src', 'lib', 'lagringsvalg.js'));
            sjekk('lagringsvalg er eksportert', typeof lagringsvalg, 'function');

            const begge = lagringsvalg({
                [streng[1]]: 'DefaultEndpointsProtocol=https;AccountName=stfrastrengen;'
                    + 'AccountKey=xx;EndpointSuffix=core.windows.net',
                [konto[1]]: 'stfrakontonavn'
            });
            sjekk('med BEGGE satt vinner tilkoblingsstrengen',
                begge.maate, 'tilkoblingsstreng');
            // Og kontoen leses ut av strengen, ikke av KONTO_VAR. Det er
            // grunnen til at paret er et enten/eller og ikke en preferanse:
            // de to kan peke på hver sin konto.
            sjekk('og kontonavnet kommer fra strengen',
                begge.konto, 'stfrastrengen');

            const vinner = begge.maate === 'tilkoblingsstreng' ? streng[1] : konto[1];
            sjekk('den som vinner, er standardvalget', gruppe[0], vinner);
        }
    }
}

// ---------- 3. valget flytter kravet, begge veier ----------
{
    sjekk('standard velger det første medlemmet',
        valgteMedlemmer([]), ENTEN_ELLER.map(gr => gr[0]));
    // Gruppevis, ikke med én gruppe antatt: det kom et par nummer to
    // 22.10.2026, og denne testen var skrevet som om det bare fantes ett.
    for (const gr of ENTEN_ELLER) {
        const andre = gr[1];
        const valgt = valgteMedlemmer([andre]);
        sjekk(`--velg ${andre} flytter sin egen gruppe`,
            valgt[ENTEN_ELLER.indexOf(gr)], andre);

        // Og BARE sin egen: et valg som flytter en annen gruppe er en
        // sammenblanding som ville vært usynlig med bare én gruppe.
        const uberoerte = ENTEN_ELLER
            .filter(g2 => g2 !== gr)
            .map(g2 => valgt[ENTEN_ELLER.indexOf(g2)]);
        sjekk(`og lar de andre gruppene stå på standard`,
            uberoerte, ENTEN_ELLER.filter(g2 => g2 !== gr).map(g2 => g2[0]));

        sjekk(`det fravalgte i ${gr[0]}-gruppa er det andre medlemmet`,
            [...utelatt([andre])].filter(n => gr.includes(n)), [gr[0]]);
    }

    // Et navn utenfor gruppene er en skrivefeil, og den skal stoppe. Går den
    // gjennom i stillhet, tror den som skrev den at valget ble tatt.
    let kastet = null;
    try { valgteMedlemmer(['GRAPH_CLIENT_PEM']); } catch (e) { kastet = e.message; }
    sjekk('en skrivefeil i --velg stopper', /ikke et navn i en enten\/eller-gruppe/.test(kastet || ''), true);
}

// ---------- 4. kravlista svarer på valget ----------
{
    const standard = kjor(['prod', '--navn']).trim().split('\n');
    sjekk('uten --velg kreves hemmeligheten',
        standard.includes('GRAPH_CLIENT_SECRET'), true);
    sjekk('og sertifikatet er ute', standard.includes('GRAPH_CLIENT_CERT_PEM'), false);

    const valgt = kjor(['prod', '--navn', '--velg', 'GRAPH_CLIENT_CERT_PEM'])
        .trim().split('\n');
    // `valgfri` i inventaret, men påkrevd når den er valgt: valget er nettopp
    // det som gjør den påkrevd.
    sjekk('med --velg kreves sertifikatet',
        valgt.includes('GRAPH_CLIENT_CERT_PEM'), true);
    sjekk('og hemmeligheten er ute', valgt.includes('GRAPH_CLIENT_SECRET'), false);

    // Resten av lista skal ikke røre seg. Et valg som endrer 30 andre krav er
    // ikke et valg, det er en annen liste.
    const uten = (a) => a.filter(n => !ENTEN_ELLER.flat().includes(n));
    sjekk('ingen andre krav endres', uten(valgt), uten(standard));
    sjekk('og lista er sortert', valgt.slice().sort(), valgt);
}

// ---------- 5. kommandoen setter aldri det fravalgte ----------
{
    const ut = kjor(['prod', '--kommandoer', '--vault', 'fhs-kv-01',
        '--velg', 'GRAPH_CLIENT_CERT_PEM']);

    // Linjene som FAKTISK settes, er de uten `#` foran. En kommentar som
    // nevner navnet er hele poenget og skal ikke telle som et treff.
    const aktive = ut.split('\n').filter(l => !/^\s*#/.test(l));
    sjekk('det fravalgte settes ikke',
        aktive.filter(l => /GRAPH_CLIENT_SECRET=/.test(l)), []);

    // Uten valget skal den gamle veien stå uendret — pilot og prod v2 går på
    // den, og en «forbedring» som tar den ned er en regresjon.
    const gammel = kjor(['prod', '--kommandoer', '--vault', 'fhs-kv-01'])
        .split('\n').filter(l => !/^\s*#/.test(l));
    sjekk('uten --velg settes hemmeligheten som før',
        gammel.filter(l => /GRAPH_CLIENT_SECRET=@Microsoft\.KeyVault/.test(l)).length, 1);

    // Begge medlemmene skal navngis, det fravalgte også: en utelatt setting
    // uten forklaring ser ut som et hull i kommandoen.
    for (const navn of ENTEN_ELLER.flat()) {
        sjekk(`${navn} er navngitt i utskriften`, ut.includes(navn), true);
    }
    sjekk('og det fravalgte står som tomt', /skal stå TOM/.test(ut), true);

    // Antallet i kommentaren må stemme med radene under. Filtreres en rad
    // bort uten at tallet følger, er utskriften selvmotsigende.
    const m = /# (\d+) Key Vault-referanser/.exec(ut);
    sjekk('antallet referanser er oppgitt', !!m, true);
    if (m) {
        // Slutten er linja som ER `)`. Radene inneholder `)` selv, inni
        // `SecretUri=.../)`, så det første `)` i teksten er ikke slutten —
        // første forsøk telte én rad av 21.
        const linjer = ut.split('\n');
        const fra = linjer.findIndex(l => l.trim() === '$kv = @(');
        const til = linjer.findIndex((l, i) => i > fra && l.trim() === ')');
        sjekk('fant blokka med referansene', fra >= 0 && til > fra, true);
        const rader = linjer.slice(fra + 1, til)
            .filter(l => /@Microsoft\.KeyVault/.test(l));
        sjekk('og det stemmer med radene', rader.length, Number(m[1]));
    }
}

// ---------- 6. kokeboka bærer samme valg på BEGGE kallene ----------
//
// Driftrisikoen her er at ett av dem oppdateres og det andre ikke: står
// `--velg` på generatoren men ikke på kravlista, melder sammenligningen
// hemmeligheten som manglende — og den som retter opp etter den, slår av
// sertifikatveien.
{
    const kokebok = fs.readFileSync(
        path.join(rot, 'docs', 'KOKEBOK-PROD-V3.md'), 'utf8');

    const kall = [...kokebok.matchAll(/node scripts\/vis-appsettings\.js[^\n]*/g)]
        .map(m => m[0])
        .filter(k => /--navn|--kommandoer/.test(k));
    sjekk('kokeboka har begge kallene', kall.length >= 2, true);

    const uten = kall.filter(k => !/--velg\s+\S+/.test(k));
    sjekk('alle kallene bærer --velg', uten, []);

    // Og samme medlem i alle. To kall med ulikt valg er to oppsett.
    //
    // Kallene uten `--velg` filtreres bort FØR uttrekket: mangler flagget,
    // er det meldt over, og en `null[1]` her ville kastet og tatt med seg
    // resten av fila. En rød sjekk sier hva som er galt; en kræsj sier at
    // testen er ødelagt.
    const valgt = [...new Set(kall
        .map(k => /--velg\s+(\S+)/.exec(k))
        .filter(Boolean)
        .map(m => m[1]))];
    sjekk('og det er samme valg i alle', valgt.length, 1);
    sjekk('og det er et gyldig gruppemedlem',
        valgt.length === 1 && !!gruppenTil(valgt[0]), true);

    // Begrunnelsen må stå der kommandoen står, ikke bare i 0.5.
    const fra = kokebok.indexOf('### 4.0');
    const kap4 = kokebok.slice(fra, kokebok.indexOf('### 4.1', fra));
    sjekk('4.0 forklarer hvorfor flagget er der',
        /tokenKropp/.test(kap4) && /GRAPH_CLIENT_CERT_PEM/.test(kap4), true);
    sjekk('og sier hva som skjer uten det',
        /aldri prøvd|vinner/.test(kap4), true);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
