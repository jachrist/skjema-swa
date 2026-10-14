/**
 * Generer oversikt over API-et: endepunkter, metoder og hva som slipper inn.
 *
 * Skrevet for sikkerhetsevalueringen. En håndskrevet liste over 111
 * endepunkter er utdatert før den er lest, og en evaluator som finner ett
 * endepunkt vi ikke har nevnt, leser alt annet med nye øyne.
 *
 * To lag må leses sammen, og det er hele poenget:
 *
 *   `staticwebapp.config.json` avgjør hvem SWA-gatewayen slipper gjennom.
 *   Står det `anonymous`, kommer hvem som helst fram til handleren.
 *
 *   Handleren avgjør resten. Et `anonymous`-endepunkt UTEN en vakt i
 *   handleren er åpent for verden.
 *
 * Skriptet kobler de to og flagger det siste tilfellet. Det er den ene
 * kombinasjonen som ikke skal finnes.
 *
 * Bruk:
 *   node scripts/api-oversikt.js            # tabell til skjermen
 *   node scripts/api-oversikt.js --markdown # til dokumentasjonen
 *   node scripts/api-oversikt.js --json
 *   node scripts/api-oversikt.js --miljo=pilot
 *   node scripts/api-oversikt.js --skriv     # oppdater docs/
 */
const fs = require('fs');
const path = require('path');
const { utenKommentarer } = require('./test-kilde.js');

const ROT = path.join(__dirname, '..');

/** Vaktene en handler kan bruke, i den rekkefølgen de skal rapporteres. */
const VAKTER = [
    ['admin', /\berAdmin\s*\(/, 'admin (ADMIN_UPNS)'],
    ['innlogget', /\bhentInnloggetUpn\s*\(/, 'innlogget (Entra via SWA)'],
    ['eier', /\bharEierTilgang\s*\(/, 'eier av skjematypen'],
    ['skjemaskaper', /\berSkjemaskaper\s*\(/, 'rollen Skjemaskaper'],
    ['flytnøkkel', /harFlytNokkel\s*\(|['"]x-flow-key['"]/, 'x-flow-key (FLOW_CALLBACK_KEY)'],
    ['scheduler', /['"]x-scheduler-key['"]/, 'x-scheduler-key (SCHEDULER_KEY)'],
    ['otp', /autentiserEkstern\s*\(|['"]x-otp-token['"]/, 'OTP-token (ekstern innsender)'],
    ['utsendingstoken', /utsendingToken\.valider\s*\(|['"]x-utsending-token['"]/, 'utsending-token (lenke i e-post)'],
    ['pb-token', /validerPbToken\s*\(/, 'Power BI-token (GUID bundet til UPN, skjematype og utløp)'],
    ['ratelimit', /rate-limitert/, 'rate-limitert']
];

/**
 * Endepunkter som er anonyme UTEN vakt, med vilje.
 *
 * Et endepunkt som er anonymt og ubevoktet er enten en bevisst beslutning
 * eller et hull. Uten denne lista kan de to ikke skilles, og en alarm som
 * alltid lyser er en alarm ingen handler på.
 *
 * Står et nytt endepunkt her, skal noen ha tatt stilling til hvorfor —
 * og begrunnelsen skal kunne leses av en som evaluerer sikkerheten.
 */
const ÅPNE_MED_VILJE = {
    '/api/ping': 'Helsesjekk. Svarer med commit-SHA, miljø, og om innloggingen nådde fram til funksjonen — ikke hvem som er innlogget: hverken UPN eller rollenavn er med. SHA-en er nødvendig for å kunne avgjøre om en rettelse er deployet.',
    '/api/logo/{filnavn}': 'Serverer bilde-bytes. Vises i skjema-headere, også for eksterne innsendere som ikke er pålogget.',
    '/api/systemlogo': 'Systemets logo og tittel. Vises før innlogging.',
    '/api/publikum-skjematype/{id}': 'Returnerer BARE skjematyper med EksternTilgang=true, og bare definisjonen — ingen svar. Er grunnlaget for at en ekstern kan åpne et skjema i det hele tatt.',
    '/api/otp/be-om-kode': 'Må være anonymt — det er her en ekstern ber om tilgang. Koden sendes bare til adressen som oppgis, og kallet er rate-limitet.',
    '/api/otp/verifiser-kode': 'Må være anonymt av samme grunn. Feil kode gir ingen opplysning om adressen finnes.'
};

/**
 * Ruta til en `app.http`-registrering.
 *
 * Tre former finnes i repoet: en streng, en konstant definert øverst i fila
 * (`route: RUTE`), og en malstreng bygget på den (`` `${RUTE}/demping` ``).
 * Bare den første ble lest til 13.10.2026, og de tre samtale-endepunktene
 * manglet i oversikten uten at noe sa fra.
 */
function finnRute(kropp, tekst) {
    const rå = (/route:\s*(.+?),\s*$/m.exec(kropp) || [])[1];
    if (!rå) return null;

    const literal = /^'([^']+)'$/.exec(rå.trim());
    if (literal) return literal[1];

    // Modulnivå-konstanter i samme fil, for oppslag under.
    const konstanter = {};
    for (const k of tekst.matchAll(/^const\s+([A-ZÆØÅ_][A-ZÆØÅ0-9_]*)\s*=\s*'([^']*)'/gm)) {
        konstanter[k[1]] = k[2];
    }

    const navn = /^([A-ZÆØÅ_][A-ZÆØÅ0-9_]*)$/.exec(rå.trim());
    if (navn) return konstanter[navn[1]] ?? null;

    const mal = /^`([^`]*)`$/.exec(rå.trim());
    if (mal) {
        let ut = mal[1], uløst = false;
        ut = ut.replace(/\$\{\s*([A-ZÆØÅ_][A-ZÆØÅ0-9_]*)\s*\}/g, (_, n) => {
            if (konstanter[n] === undefined) { uløst = true; return ''; }
            return konstanter[n];
        });
        return uløst ? null : ut;
    }
    return null;
}

/** Alle `app.http(...)`-registreringer i api/src/functions. */
function lesEndepunkter() {
    const ut = [];
    const katalog = path.join(ROT, 'api', 'src', 'functions');
    for (const navn of fs.readdirSync(katalog).filter(n => n.endsWith('.js')).sort()) {
        // Kommentarene må bort FØR vi leter etter vakter. Tre filer nevner
        // `x-scheduler-key` i en kommentar over handleren, og én nevner den
        // for å si at endepunktet BEVISST ikke godtar den. Leses rå tekst,
        // teller den kommentaren som en vakt — og et endepunkt uten vakt ser
        // bevoktet ut, som er feil retning for en slik feil.
        const tekst = utenKommentarer(fs.readFileSync(path.join(katalog, navn), 'utf8'));
        // Hver registrering, med kroppen fram til neste `app.http(` eller
        // filslutt. Vaktene leses ut av den kroppen — ikke av hele fila, for
        // da ville ett admin-endepunkt smittet alle de andre i samme fil.
        const treff = [...tekst.matchAll(/app\.http\(\s*'([^']+)'\s*,\s*\{/g)];
        for (const [i, m] of treff.entries()) {
            const start = m.index;
            const slutt = i + 1 < treff.length ? treff[i + 1].index : tekst.length;
            const kropp = tekst.slice(start, slutt);

            const rute = finnRute(kropp, tekst);
            // En registrering vi ikke klarer å lese ruta til, skal STOPPE
            // oversikten. Et `continue` her var grunnen til at de tre
            // samtale-endepunktene manglet i de første 130: de setter
            // `route: RUTE` fra en konstant, og falt ut i stillhet.
            // Et endepunkt som ikke er i oversikten, er heller ikke sjekket.
            if (!rute) throw new Error(
                `${navn}: klarte ikke lese route for app.http('${m[1]}') — ` +
                'legg til formen i finnRute() i stedet for å hoppe over den');
            const metoder = [...(/methods:\s*\[([^\]]*)\]/.exec(kropp)?.[1] || '')
                .matchAll(/'([A-Z]+)'/g)].map(x => x[1]);
            // Vaktene ligger ofte i en hjelpefunksjon definert lenger opp i
            // fila — `autorisert(request)` i refresh-fs.js, `krevAdmin()` i
            // oppslagsliste.js. Leses bare handlerkroppen, ser 15 endepunkter
            // ut til å være uten vakt, og 13 av dem er det ikke. En falsk
            // alarm i et overleveringsdokument er verre enn ingen oversikt.
            //
            // Ett nivå ned holder: hjelperne kaller ikke hverandre i dette
            // repoet. Dypere rekursjon ville dratt inn halve fila og gjort
            // det motsatte — alt ville sett bevoktet ut.
            const kalt = new Set([...kropp.matchAll(/\b([a-zA-ZæøåÆØÅ_][\w]*)\s*\(/g)].map(x => x[1]));
            let utvidet = kropp;
            for (const navn of kalt) {
                const def = new RegExp(`(?:async\\s+)?function\\s+${navn}\\s*\\(`).exec(tekst);
                if (!def) continue;
                const fra = def.index;
                const til = tekst.indexOf('\n}', fra);
                utvidet += '\n' + tekst.slice(fra, til === -1 ? tekst.length : til + 2);
            }
            const vakter = VAKTER.filter(([, re]) => re.test(utvidet)).map(([kort]) => kort);

            ut.push({ fil: navn, funksjon: m[1], rute: `/api/${rute}`, metoder, vakter });
        }
    }
    return ut;
}

/**
 * Hvilken SWA-regel som gjelder for en rute.
 *
 * Reglene leses i rekkefølge, og FØRSTE treff gjelder — samme semantikk som
 * SWA selv bruker. Leses de i feil rekkefølge, ser `/api/*` ut til å dekke
 * alt, og de 26 unntakene over den forsvinner.
 */
function swaRegelFor(rute, regler) {
    for (const r of regler) {
        if (!r.route) continue;
        const m = String(r.route);
        const treff = m.endsWith('/*')
            ? rute === m.slice(0, -2) || rute.startsWith(m.slice(0, -1))
            : rute === m;
        if (treff && r.allowedRoles) return { regel: m, roller: r.allowedRoles };
    }
    return null;
}

/**
 * Ruteregler for ett miljø.
 *
 * Leses fra `staticwebapp.config.<miljø>.json`, ikke fra den genererte
 * `staticwebapp.config.json` i roten: den er en kopi build-config.js skriver,
 * er ikke i repoet, og finnes ikke i en fersk klone. En oversikt bygget på en
 * fil som kanskje ligger der, og som i så fall kan være et gammelt
 * øyeblikksbilde, er den slags kilde dette repoet alt har brent seg på.
 */
function lesRegler(miljo) {
    const fil = path.join(ROT, `staticwebapp.config.${miljo}.json`);
    return JSON.parse(fs.readFileSync(fil, 'utf8')).routes || [];
}

function bygg(miljo = 'prod') {
    const endepunkter = lesEndepunkter();
    const regler = lesRegler(miljo);
    return endepunkter.map(e => {
        const swa = swaRegelFor(e.rute, regler);
        const roller = swa?.roller || ['(ingen regel — arver /api/*)'];
        const anonym = roller.includes('anonymous');
        return {
            ...e,
            swaRegel: swa?.regel || '',
            swaRoller: roller,
            // Den ene kombinasjonen som ikke skal finnes: gatewayen slipper
            // alle inn, handleren sjekker ingenting, OG ingen har tatt
            // stilling til at det er greit.
            åpenForVerden: anonym && e.vakter.length === 0 && !(e.rute in ÅPNE_MED_VILJE),
            åpenMedVilje: anonym && e.vakter.length === 0 && (e.rute in ÅPNE_MED_VILJE),
            begrunnelse: ÅPNE_MED_VILJE[e.rute] || ''
        };
    });
}

/**
 * Oversikten som markdown, til `docs/API-OVERSIKT.md`.
 *
 * Rendringen bor HER og ikke i testen. Skrev testen sin egen versjon av
 * tabellen, ville den sammenlignet to kilder som kan drifte fra hverandre —
 * og da er det igjen to sannheter, som er nøyaktig feilen dette repoet lager
 * oftest.
 */
function markdown(rader) {
    const l = [];
    const anon = rader.filter(r => r.swaRoller.includes('anonymous'));
    l.push('<!-- GENERERT av scripts/api-oversikt.js — ikke rediger for hånd. -->');
    l.push('<!-- Oppdater med: node scripts/api-oversikt.js --skriv -->');
    l.push('');
    l.push('# API-oversikt');
    l.push('');
    l.push('Alle HTTP-endepunkter i løsningen, med hvem som slipper inn.');
    l.push('');
    l.push('Tilgangen avgjøres i to lag, og tabellene under viser begge:');
    l.push('');
    l.push('* **SWA-gatewayen** (`staticwebapp.config.<miljø>.json`) avgjør hvem som');
    l.push('  kommer fram til funksjonen. `anonymous` betyr hvem som helst.');
    l.push('* **Handleren** avgjør resten. Hvert endepunkt har minst én vakt her; se');
    l.push('  `docs/SIKKERHET-OG-ARKITEKTUR.md` for hva hver vakt innebærer.');
    l.push('');
    l.push(`${rader.length} endepunkter, hvorav ${anon.length} er anonyme i gatewayen.`);
    l.push('');
    l.push('## Anonyme i gatewayen');
    l.push('');
    l.push('SWA slipper hvem som helst fram til handleren. Vakten der er eneste sperre.');
    l.push('');
    l.push('| Rute | Metoder | Vakt i handleren |');
    l.push('|---|---|---|');
    for (const r of [...anon].sort((a, b) => a.rute.localeCompare(b.rute))) {
        // Begrunnelsen skal vises også når ruta HAR en vakt. Det er den som
        // forklarer hvorfor den er anonym i det hele tatt, og det er nettopp
        // det spørsmålet en evaluator stiller.
        const v = r.vakter.length
            ? r.vakter.join(', ') + (r.begrunnelse ? ` — ${r.begrunnelse}` : '')
            : (r.åpenMedVilje ? `_åpent med vilje:_ ${r.begrunnelse}` : '**INGEN — uerklært**');
        l.push(`| \`${r.rute}\` | ${r.metoder.join(', ')} | ${v} |`);
    }
    l.push('');
    l.push('## Krever innlogging');
    l.push('');
    l.push('| Rute | Metoder | SWA | Vakt i handleren |');
    l.push('|---|---|---|---|');
    for (const r of rader.filter(x => !x.swaRoller.includes('anonymous'))
        .sort((a, b) => a.rute.localeCompare(b.rute))) {
        l.push(`| \`${r.rute}\` | ${r.metoder.join(', ')} | ${r.swaRoller.join(', ')} | ${r.vakter.join(', ') || '—'} |`);
    }
    l.push('');
    return l.join('\n');
}

/** Nøkkeltallene, til blokka i overleveringsdokumentet. */
function nokkeltall(rader) {
    const anon = rader.filter(r => r.swaRoller.includes('anonymous'));
    const åpne = rader.filter(r => r.åpenForVerden);
    const bevisst = rader.filter(r => r.åpenMedVilje);
    return [
        '| | |',
        '|---|---|',
        `| Endepunkter i alt | ${rader.length} |`,
        `| Anonyme i SWA-gatewayen | ${anon.length} |`,
        `| — av dem med vakt i handleren | ${anon.length - bevisst.length} |`,
        `| — av dem åpne med vilje, erklært og begrunnet | ${bevisst.length} |`,
        `| — av dem åpne UTEN forklaring | ${åpne.length} |`,
        `| Endepunkter uten noen vakt i handleren | ${rader.filter(r => r.vakter.length === 0).length} — alle erklærte |`
    ].join('\n');
}

const START = '<!-- GENERERT:api-nøkkeltall -->';
const SLUTT = '<!-- /GENERERT:api-nøkkeltall -->';

/** Blokka slik den skal stå i `docs/SIKKERHET-OG-ARKITEKTUR.md`. */
function nokkeltallBlokk(rader) {
    return `${START}\n${nokkeltall(rader)}\n${SLUTT}`;
}

/** Bytt ut blokka i et dokument. Returnerer null hvis markørene mangler. */
function medNyBlokk(dokument, rader) {
    const a = dokument.indexOf(START), b = dokument.indexOf(SLUTT);
    if (a === -1 || b === -1 || b < a) return null;
    return dokument.slice(0, a) + nokkeltallBlokk(rader) + dokument.slice(b + SLUTT.length);
}

const API_DOK = path.join(ROT, 'docs', 'API-OVERSIKT.md');
const SIKKERHET_DOK = path.join(ROT, 'docs', 'SIKKERHET-OG-ARKITEKTUR.md');

function skriv(rader) {
    fs.writeFileSync(API_DOK, markdown(rader) + '\n');
    const dok = fs.readFileSync(SIKKERHET_DOK, 'utf8');
    const ny = medNyBlokk(dok, rader);
    if (ny === null) throw new Error(`${SIKKERHET_DOK}: fant ikke markørene ${START} / ${SLUTT}`);
    fs.writeFileSync(SIKKERHET_DOK, ny);
    console.log(`Skrev docs/API-OVERSIKT.md og nøkkeltallblokka i docs/SIKKERHET-OG-ARKITEKTUR.md (${rader.length} endepunkter)`);
}

function cli(argv) {
    const miljo = (/^--miljo=(\w+)$/.exec(argv[0] || '') || [])[1];
    const arg = miljo ? (argv[1] || '') : (argv[0] || '');
    const rader = bygg(miljo || 'prod');

    if (arg === '--json') {
        console.log(JSON.stringify(rader, null, 2));
    } else if (arg === '--markdown') {
        console.log(markdown(rader));
    } else if (arg === '--skriv') {
        skriv(rader);
    } else {
        const anon = rader.filter(r => r.swaRoller.includes('anonymous'));
        const åpne = rader.filter(r => r.åpenForVerden);
        const bevisst = rader.filter(r => r.åpenMedVilje);
        console.log(`${rader.length} endepunkter`);
        console.log(`  anonyme i gatewayen      : ${anon.length}`);
        console.log(`  av dem: vakt i handleren : ${anon.length - åpne.length - bevisst.length}`);
        console.log(`  av dem: åpne med vilje   : ${bevisst.length}`);
        console.log(`  av dem: UTEN forklaring  : ${åpne.length}`);
        if (åpne.length > 0) {
            console.log('\nANONYME, UBEVOKTEDE OG UERKLÆRTE:');
            for (const r of åpne) console.log(`  ${r.metoder.join(',')} ${r.rute}  (${r.fil})`);
            process.exitCode = 1;
        }
    }
}

// Kalles bare når fila kjøres direkte. Testen `require`-er modulen, og en
// `process.exitCode = 1` satt under require ville gjort at testen feilet før
// den hadde sjekket noe — eller, verre, at en test som sjekket ingenting
// feilet og lot det se ut som om regelen var dekket.
if (require.main === module) cli(process.argv.slice(2));

module.exports = {
    bygg, lesEndepunkter, lesRegler, swaRegelFor, markdown, nokkeltallBlokk, medNyBlokk,
    API_DOK, SIKKERHET_DOK, VAKTER, ÅPNE_MED_VILJE
};
