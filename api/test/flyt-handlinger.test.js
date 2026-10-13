/**
 * `handling`-verdiene i koden og i `docs/FLYTER.md` må være de samme.
 *
 * Varslingsflyten er en dispatcher: ÉN Power Automate-flyt som forgrener på
 * `handling`. Den som bygger switchen leser FLYTER.md — flyten ligger i en
 * annen tenant og kan ikke leses herfra.
 *
 * Dokumentet drev. 13.10.2026 manglet `sendSamtaleVarsling` i tabellen, og
 * overskriften sa «fire verdier» over en liste med seks. En flyt bygget etter
 * den tabellen ville ikke hatt noen gren for samtalevarsler, og utslaget er
 * taust på vår side: vi får 200 fra flyten og tror meldingen gikk.
 *
 * To krav, begge veier:
 *
 *   Hver `handling` i `api/src` skal stå i FLYTER.md. Ellers finnes det en
 *   kallform ingen som bygger flyten vet om.
 *
 *   Hver `handling` FLYTER.md navngir skal finnes i koden. Et spøkelse i
 *   dokumentet gir en gren som aldri treffer, og den som ser den tror den
 *   virker.
 *
 * Kjøres med:  node api/test/flyt-handlinger.test.js
 */
const fs = require('fs');
const path = require('path');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const rot = path.join(__dirname, '..', '..');

/** Hver `handling: '…'` i api/src — uansett hvilken flyt den går til. */
function iKoden() {
    const funnet = new Set();
    const gå = (katalog) => {
        for (const n of fs.readdirSync(katalog, { withFileTypes: true })) {
            const p = path.join(katalog, n.name);
            if (n.isDirectory()) { gå(p); continue; }
            if (!n.name.endsWith('.js')) continue;
            const t = fs.readFileSync(p, 'utf8');
            for (const m of t.matchAll(/handling: *'([a-zA-ZæøåÆØÅ]+)'/g)) funnet.add(m[1]);
            // `kallUtsendingsflyt('sendUtsendinger', …)` sender navnet som
            // argument, ikke som et `handling:`-felt. Uten denne var de to
            // utsendingsverdiene usynlige for testen.
            for (const m of t.matchAll(/kallUtsendingsflyt\('([a-zA-ZæøåÆØÅ]+)'/g)) funnet.add(m[1]);
        }
    };
    gå(path.join(rot, 'api', 'src'));
    return funnet;
}

/**
 * Verdiene FLYTER.md navngir i tabellene.
 *
 * Bare tabellrader som BEGYNNER med en backtick-verdi — ikke all
 * backtick-tekst i dokumentet. Ellers ville enhver omtale i brødteksten telt
 * som en oppføring, og testen hadde bestått på en tabell som manglet raden.
 */
function iDokumentet() {
    const t = fs.readFileSync(path.join(rot, 'docs', 'FLYTER.md'), 'utf8');
    // Bare seksjonene om `handling`. Dokumentet har flere tabeller med
    // backtick i første kolonne — miljøvariabler, loggfelter — og uten denne
    // avgrensningen talte testen `SkjemaMiljo` og `objektId` som
    // handling-verdier.
    const fra = t.indexOf('### Full form');
    const til = t.indexOf('### Kopimottakere');
    if (fra === -1 || til === -1) {
        feil++;
        console.log('FEIL  fant ikke handling-seksjonene i FLYTER.md');
        return new Set();
    }
    const ut = new Set();
    for (const m of t.slice(fra, til).matchAll(/^\| `([a-zA-ZæøåÆØÅ]+)` *\|/gm)) ut.add(m[1]);
    // Tabellhodet heter selv `handling`. Det er en kolonneoverskrift, ikke en
    // verdi.
    ut.delete('handling');
    return ut;
}

const kode = iKoden();
const doc = iDokumentet();

sjekk('koden har handling-verdier', kode.size >= 7, true);
sjekk('dokumentet navngir noen', doc.size >= 7, true);

sjekk('alle i koden står i FLYTER.md',
    [...kode].filter(h => !doc.has(h)).sort(), []);
sjekk('ingen spøkelser i FLYTER.md',
    [...doc].filter(h => !kode.has(h)).sort(), []);

// ---------- de to nyttelastformene ----------
{
    const t = fs.readFileSync(path.join(rot, 'docs', 'FLYTER.md'), 'utf8');
    // Skillet er selve kontrakten: den reduserte formen mangler
    // `epost_og_teams`, og en flyt som ikke forgrener sender en tom e-post.
    sjekk('full form er beskrevet', /### Full form/.test(t), true);
    sjekk('redusert form er beskrevet', /### Redusert form/.test(t), true);
    sjekk('og det står at flyten MÅ forgrene', /MÅ forgrene på `handling`/.test(t), true);

    // Verdiene må stå i RIKTIG seksjon. En tabell der alt er riktig listet,
    // men under feil overskrift, er verre enn ingen tabell.
    const full = t.slice(t.indexOf('### Full form'), t.indexOf('### Redusert form'));
    const redusert = t.slice(t.indexOf('### Redusert form'), t.indexOf('### Disse går IKKE hit'));
    for (const h of ['sendInnsenderKvittering', 'sendBehandlingsVarsling', 'sendBeslutningVarsling',
                     'sendFerdigVarsling', 'sendSamtaleVarsling']) {
        sjekk(`${h} står under full form`, full.includes(h), true);
    }
    for (const h of ['sendUtsendinger', 'purreUtsendinger']) {
        sjekk(`${h} står under redusert form`, redusert.includes(h), true);
    }
    // Og de som har egen adresse skal IKKE stå blant dispatcherens.
    for (const h of ['sendOtp', 'lagreBackup']) {
        sjekk(`${h} er ikke oppført som dispatcher-verdi`, full.includes(h) || redusert.includes(h), false);
    }
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
