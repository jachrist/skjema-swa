/**
 * Tilgjengelighetsperioden — regelen som bare sto i grensesnittet.
 *
 * En skjematype kan være åpen for utfylling i gitte perioder. Kortlista i
 * oversikten regnet det inn i `KanFylle`, så et stengt skjema kunne ikke
 * ÅPNES derfra. Men `lagreSkjema` spurte aldri, og utfyllingslenka går rett
 * dit: med lenka i hånda kunne et stengt skjema både fylles ut og sendes inn.
 * Meldt 20.10.2026 (punkt 87).
 *
 * Det er den tilbakevendende feilklassen her, i sin reneste form — en regel
 * som finnes ett sted, og det stedet er det eneste som ikke betyr noe.
 *
 * Testen har to halvdeler:
 *
 *   **Regelen**, kjørt ekte fra `lib/periode.js`. Datoene er grensetilfeller,
 *   for det er der en periode avgjøres: siste dag skal gjelde HELE dagen.
 *
 *   **Koblingen**, lest i kilden. `functions/skjemaer.js` og
 *   `functions/skjematyper.js` krever `@azure/functions` på toppnivå og kan
 *   ikke lastes her. Svakere enn å kjøre dem — men en mutasjon som fjerner
 *   sperren blir rød, og det var sperren som manglet.
 *
 * Kjøres med:  node api/test/periode-sperre.test.js
 */
const fs = require('fs');
const path = require('path');
const periode = require('../src/lib/periode');
const { hoppOverMappe } = require('../../scripts/test-kilde.js');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const rot = path.join(__dirname, '..');
const les = (...p) => fs.readFileSync(path.join(rot, 'src', ...p), 'utf8');

// ---------- 1. åpen eller stengt ----------
{
    const inni = new Date('2026-10-10T12:00:00');
    const p = [{ Fra: '2026-10-01', Til: '2026-10-15' }];

    sjekk('ingen perioder betyr alltid åpent', periode.erTilgjengeligNaa([], inni), true);
    sjekk('og det samme for noe som ikke er en liste',
        periode.erTilgjengeligNaa(null, inni), true);
    sjekk('inni perioden', periode.erTilgjengeligNaa(p, inni), true);

    // Grensene er det som avgjør, og «til og med» er et valg som må holde:
    // siste dag gjelder til 23:59:59.
    sjekk('første dag, tidlig', periode.erTilgjengeligNaa(p, new Date('2026-10-01T00:00:01')), true);
    sjekk('siste dag, sent', periode.erTilgjengeligNaa(p, new Date('2026-10-15T23:59:00')), true);
    sjekk('dagen etter', periode.erTilgjengeligNaa(p, new Date('2026-10-16T00:00:01')), false);
    sjekk('dagen før', periode.erTilgjengeligNaa(p, new Date('2026-09-30T23:00:00')), false);

    // Åpne ender: tom Fra eller Til betyr ingen grense i den retningen.
    sjekk('tom Fra gir ingen nedre grense',
        periode.erTilgjengeligNaa([{ Fra: '', Til: '2026-10-15' }], new Date('2020-01-01')), true);
    sjekk('tom Til gir ingen øvre grense',
        periode.erTilgjengeligNaa([{ Fra: '2026-10-01', Til: '' }], new Date('2099-01-01')), true);

    // Flere perioder OR-es. En treff er nok.
    const to = [{ Fra: '2026-01-01', Til: '2026-01-31' }, { Fra: '2026-10-01', Til: '2026-10-15' }];
    sjekk('flere perioder OR-es', periode.erTilgjengeligNaa(to, inni), true);
    sjekk('og utenfor begge er stengt',
        periode.erTilgjengeligNaa(to, new Date('2026-06-01')), false);

    // En ugyldig dato skal ikke kunne åpne eller stenge noe ved et uhell.
    sjekk('ugyldig dato hoppes over',
        periode.erTilgjengeligNaa([{ Fra: 'i morgen', Til: 'snart' }], inni), false);
}

// ---------- 2. feltnavnet ligger ett sted ----------
{
    sjekk('perioderFra leser feltet', periode.perioderFra({ Tilgjengelighetsperioder: [{ Fra: 'x' }] }).length, 1);
    sjekk('og gir alltid en liste', periode.perioderFra(null), []);
    sjekk('også når verdien er noe annet', periode.perioderFra({ Tilgjengelighetsperioder: 'nei' }), []);

    // Ingen andre i api/src skal plukke feltet av et objekt selv. Gjør de
    // det, finnes regelen i to eksemplarer igjen.
    const filer = (function samle(m) {
        return fs.readdirSync(m, { withFileTypes: true }).flatMap(e => {
            const pp = path.join(m, e.name);
            if (e.isDirectory()) return hoppOverMappe(e.name) ? [] : samle(pp);
            return e.name.endsWith('.js') ? [pp] : [];
        });
    })(path.join(rot, 'src'));
    const egne = filer.filter(f => !f.endsWith(path.join('lib', 'periode.js')))
        .filter(f => /\.Tilgjengelighetsperioder\b/.test(fs.readFileSync(f, 'utf8')))
        .map(f => path.relative(rot, f));
    sjekk('ingen andre leser feltet direkte', egne, []);
}

// ---------- 3. hvilke lagringer som skal prøves ----------
//
// Utfylling, ja. Behandling av et skjema som alt er sendt inn, nei — en
// beslutning registrert etter at perioden er ute, er ikke utfylling.
{
    const p = [{ Fra: '2026-10-01', Til: '2026-10-15' }];
    sjekk('nytt skjema prøves', periode.maaSjekkes({ perioder: p, gammelStatus: undefined }), true);
    sjekk('utkast prøves også', periode.maaSjekkes({ perioder: p, gammelStatus: 1 }), true);
    sjekk('innsendt skjema prøves ikke', periode.maaSjekkes({ perioder: p, gammelStatus: 2 }), false);
    sjekk('og ikke et som er kommet lenger', periode.maaSjekkes({ perioder: p, gammelStatus: 5 }), false);
    sjekk('uten perioder prøves ingenting', periode.maaSjekkes({ perioder: [], gammelStatus: 0 }), false);
}

// ---------- 4. meldingen skal si NÅR ----------
//
// «Skjemaet er stengt» sender folk til support for å spørre om når. Datoene
// finnes i perioden, og da skal de med.
{
    const naa = new Date('2026-10-20T12:00:00');

    const framover = periode.avvisningstekst([{ Fra: '2026-11-01', Til: '2026-11-15' }], naa);
    sjekk('kommende periode navngir begge datoene',
        framover.includes('01.11.2026') && framover.includes('15.11.2026'), true);
    sjekk('og sier at det åpner', /åpent for utfylling/.test(framover), true);

    const utenSlutt = periode.avvisningstekst([{ Fra: '2026-11-01', Til: '' }], naa);
    sjekk('uten sluttdato sies bare åpningen', /åpner for utfylling 01\.11\.2026/.test(utenSlutt), true);

    const bak = periode.avvisningstekst([{ Fra: '2026-10-01', Til: '2026-10-15' }], naa);
    sjekk('passert periode sier at fristen er ute', /ute/.test(bak), true);
    sjekk('og navngir siste dag', bak.includes('15.10.2026'), true);

    // Nærmeste grense skal velges, ikke den første i lista.
    const flere = periode.avvisningstekst(
        [{ Fra: '2027-01-01', Til: '2027-01-31' }, { Fra: '2026-11-01', Til: '2026-11-15' }], naa);
    sjekk('nærmeste kommende periode velges', flere.includes('01.11.2026'), true);

    const sisteAv_to = periode.avvisningstekst(
        [{ Fra: '2026-01-01', Til: '2026-01-31' }, { Fra: '2026-09-01', Til: '2026-09-30' }], naa);
    sjekk('seneste passerte periode velges', sisteAv_to.includes('30.09.2026'), true);

    // Datoer uten retning: ingen påstand om når.
    sjekk('uten datoer gis en nøktern melding',
        periode.avvisningstekst([{ Fra: 'tull', Til: '' }], naa),
        'Skjemaet er ikke åpent for utfylling nå.');

    sjekk('norskDato snur rekkefølgen', periode.norskDato('2026-03-07'), '07.03.2026');
    sjekk('og tåler søppel', periode.norskDato('nei'), '');
}

// ---------- 5. dommen er én form begge kallstedene bruker ----------
{
    const naa = new Date('2026-10-20T12:00:00');
    sjekk('åpen gir ok', periode.sjekkPeriode([], naa), { ok: true });
    const dom = periode.sjekkPeriode([{ Fra: '2026-10-01', Til: '2026-10-15' }], naa);
    sjekk('stengt gir ok=false', dom.ok, false);
    sjekk('og en melding', typeof dom.melding === 'string' && dom.melding.length > 10, true);
}

// ---------- 6. sperren står i lagreSkjema ----------
//
// Dette er hele poenget med punktet. Sperren i grensesnittet er høflighet;
// denne er porten.
{
    const kilde = les('functions', 'skjemaer.js');
    const fra = kilde.indexOf("app.http('lagreSkjema'");
    const til = kilde.indexOf("app.http('listSkjemaer'");
    sjekk('fant lagreSkjema', fra > 0 && til > fra, true);
    const lagring = kilde.slice(fra, til);

    sjekk('den leser periodene fra lib-en', /periode\.perioderFra\(/.test(lagring), true);
    sjekk('sperren står bak maaSjekkes', /if \(periode\.maaSjekkes\(\{/.test(lagring), true);

    // Og avvisningen må ligge INNE i den porten. Står den utenfor, avviser
    // den alt; står porten der uten avvisning, avviser den ingenting.
    const port = lagring.indexOf('periode.maaSjekkes({');
    const etterPort = port > -1 ? lagring.slice(port, port + 900) : '';
    sjekk('dommen hentes inne i porten', /periode\.sjekkPeriode\(/.test(etterPort), true);
    sjekk('og avvisningen også', /status: 409/.test(etterPort), true);
    sjekk('avvisningen er merket', /utenforPeriode: true/.test(etterPort), true);
    sjekk('og bærer meldingen fra lib-en', /melding: dom\.melding/.test(etterPort), true);

    // Statusen FØR lagringen er det som avgjør. Brukes den nye, ville en
    // behandler som setter status blitt vurdert på sitt eget resultat.
    sjekk('porten spør om forrige status',
        /gammelStatus: eksisterende\?\.Skjema_status/.test(etterPort), true);
}

// ---------- 7. og grensesnittet får vite det før utfylling ----------
//
// `kan-svare` er kallet index.html gjør før skjemaet tegnes. To rekkefølger
// kan gjøre svaret ubrukelig, og begge er lette å innføre ved et uhell.
{
    const kilde = les('functions', 'skjematyper.js');
    const fra = kilde.indexOf("app.http('kanSvarePaaSkjematype'");
    const til = kilde.indexOf("app.http('antallSkjemaerForType'");
    sjekk('fant kan-svare', fra > 0 && til > fra, true);
    const kanSvare = kilde.slice(fra, til);

    sjekk('periodesjekken finnes', /periode\.sjekkPeriode\(/.test(kanSvare), true);
    sjekk('og svaret er merket', /utenforPeriode: true/.test(kanSvare), true);
    sjekk('og sier kanSvare: false', /kanSvare: false/.test(kanSvare), true);

    // FØR den tidlige returen for «ingen svargrense» — ellers slipper et
    // stengt skjema uten grense rett igjennom, og det er den vanligste
    // kombinasjonen.
    const iPeriode = kanSvare.indexOf('periode.sjekkPeriode(');
    const tidligRetur = kanSvare.indexOf('if (grense === 0) return');
    sjekk('den står før den tidlige returen',
        iPeriode > -1 && tidligRetur > iPeriode, true);

    // Og før kravet om identitet. Perioden gjelder skjemaet, ikke personen,
    // og en ekstern innsender skal få meldingen og ikke en 401.
    const krevIdentitet = kanSvare.indexOf('Ikke innlogget');
    sjekk('og før kravet om innlogging',
        krevIdentitet > -1 && krevIdentitet > iPeriode, true);
}

// ---------- 8. siden har ingen egen kopi av regelen ----------
{
    const i = fs.readFileSync(path.join(rot, '..', 'frontend', 'index.html'), 'utf8');
    sjekk('index.html regner ikke på datoer selv',
        /Tilgjengelighetsperioder/.test(i), false);
    sjekk('men spør serveren', /kan-svare/.test(i), true);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
