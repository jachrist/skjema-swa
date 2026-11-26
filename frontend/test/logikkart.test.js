/**
 * Logikkartet (js/logikkart.js og logikkart.html).
 *
 * Testen bygger kartet av en ekte definisjon og sjekker plasseringen —
 * det er den som gjør kartet nyttig, og den som er lettest å bryte:
 *
 *   - et felt med vilkår om ÉTT felt i samme seksjon henger under det
 *   - et vilkår om et felt i en annen seksjon blir stående, med merkelapp,
 *     og feltet det avhenger av får en lenke dit
 *   - steg henger under steget de er avhengige av
 *   - vilkåret leses som tekst, med valgets tekst og stegets beslutning
 *   - begge referanseformene, og Id-formen fra papirskjema-importen
 *   - all tekst fra definisjonen escapes
 *
 * Kjøres med:  node frontend/test/logikkart.test.js
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const rot = path.join(__dirname, '..', '..');
const JA_NEI = [{ Valg_nr: 1, Tekst: 'Ja' }, { Valg_nr: 2, Tekst: 'Nei' }];
const vises = (Felt, Verdi, Operator = '=') => ({ EllerAv: [{ OgAv: [{ Felt, Operator, Verdi }] }] });

const DEF = {
    Skjema_navn: 'Behov for ny IKT', Fase: 'Produksjon',
    Seksjoner: [
        { Seksjon_nummer: 1, Seksjon_overskrift: 'Avtaler', Felter: [
            { Id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', Nummer: '01', Type: 'Flervalg-knapper', Max_valg: 1, Valg: JA_NEI,
                Tekst: { Verdi: 'Er det inngått databehandleravtale?' } },
            { Id: 'f-abc12345-xyz', Nummer: '02', Type: 'Tekst', Tekst: { Verdi: 'P360-referanse' },
                Vises: vises('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '1'),
                ObligatoriskHvis: vises('1-01', '1') },
            { Id: 'c3', Nummer: '03', Type: 'Opplasting', Tekst: { Verdi: 'Last opp utkastet' },
                Vises: vises('f-abc12345-xyz', null, 'ikke_tom') },
            { Id: 'c4', Nummer: '04', Type: 'Tekst', Tekst: { Verdi: 'Land 5 < 7 & "x"' } },
            { Id: 'c5', Nummer: '05', Type: 'Tekst', Tekst: { Verdi: 'Fritt felt' } }
        ] },
        { Seksjon_nummer: 2, Seksjon_overskrift: 'Overføring',
            Vises: { EllerAv: [{ OgAv: [{ Felt: '1-01', Operator: '=', Verdi: '1' }, { Felt: '1-02', Operator: 'ikke_tom' }] },
                { OgAv: [{ Felt: '1-04', Operator: 'inneholder', Verdi: 'EU' }] }] },
            Felter: [
                { Id: 'd1', Nummer: '01', Type: 'Flervalg-knapper', Max_valg: 1, Valg: JA_NEI, Tekst: { Verdi: 'Ut av EØS?' },
                    Vises: vises('1-01', '2') }
            ] }
    ],
    Behandling: [
        { Steg: 1, Stegnavn: 'Personvern', Roller: ['Personvernombud'],
            Beslutningsvalg: [{ Nummer: 1, Tekst: 'Godkjent' }, { Nummer: 2, Tekst: 'Avslått & "nei"' }, { Nummer: 3, Tekst: 'Retur', Handling: 'ompuss' }] },
        { Steg: 2, Stegnavn: 'Leder', AvhengigAv: 1, Personer: ['leder@x.no'], Vilkår: vises('behandling-1', '1') },
        { Steg: 3, Stegnavn: 'Arkiv', Beslutning_alle: true, Frist: { Dager: 14 } }
    ]
};

async function kjor() {
    const m = await import(pathToFileURL(path.join(rot, 'frontend', 'js', 'logikkart.js')).href);
    const kart = m.byggLogikkart(DEF);
    const alle = [];
    (function gaa(n, forelder) { alle.push({ n, forelder }); for (const b of n.barn) gaa(b, n); })(kart, null);
    const finn = (id) => alle.find(x => x.n.id === id);

    // ---------- plasseringen ----------
    sjekk('seksjonene og behandlingen ligger under rota', kart.barn.map(b => b.id), ['seksjon-1', 'seksjon-2', 'behandling']);
    sjekk('felt med vilkår om ett felt i samme seksjon henger under det (UUID)', finn('felt-1-02').forelder.id, 'felt-1-01');
    sjekk('… og kjeden fortsetter (import-Id)', finn('felt-1-03').forelder.id, 'felt-1-02');
    sjekk('grenen sier valgets tekst', finn('felt-1-02').n.gren, 'hvis «Ja»');
    sjekk('grenen sier operatoren når den ikke er =', finn('felt-1-03').n.gren, 'hvis er fylt ut');
    sjekk('felt uten vilkår ligger under seksjonen', finn('felt-1-05').forelder.id, 'seksjon-1');
    sjekk('vilkår om felt i en annen seksjon: står i sin seksjon', finn('felt-2-01').forelder.id, 'seksjon-2');
    sjekk('… med vilkåret som merkelapp', finn('felt-2-01').n.betingelse,
        'Vises hvis «Er det inngått databehandleravtale?» = «Nei»');
    sjekk('feltet det avhenger av, lenker dit', finn('felt-1-01').n.styrer.map(s => s.id), ['seksjon-2', 'felt-2-01']);
    sjekk('ingen lenke til det som alt henger rett under', finn('felt-1-01').n.styrer.some(s => s.id === 'felt-1-02'), false);
    sjekk('sammensatt vilkår: og, eller og parenteser', finn('seksjon-2').n.betingelse,
        'Vises hvis («Er det inngått databehandleravtale?» = «Ja» og «P360-referanse» er fylt ut) eller «Land 5 < 7 & "x"» inneholder «EU»');

    // ---------- behandlingen ----------
    sjekk('steg uten avhengighet under Behandling', finn('behandling').n.barn.map(b => b.id), ['steg-1', 'steg-3']);
    sjekk('avhengig steg henger under steget det venter på', finn('steg-2').forelder.id, 'steg-1');
    sjekk('vilkår på et stegs beslutning leses med valgets tekst', finn('steg-2').n.betingelse,
        'Kjøres hvis steg 1 «Personvern» = «Godkjent»');
    sjekk('beslutningsvalg farges etter type', finn('steg-1').n.merker.map(x => x.klasse),
        ['valg-positiv', 'valg-negativ', 'valg-ompuss']);
    sjekk('alle må avgjøre og frist vises', finn('steg-3').n.merker.map(x => x.tekst), ['Alle må avgjøre', 'Frist 14 dager']);
    sjekk('behandlerne vises', finn('steg-1').n.behandlere, ['Personvernombud']);

    // ---------- typer ----------
    sjekk('enkeltvalg og flervalg skilles på Max_valg',
        [m.typeMerke({ Type: 'Flervalg-knapper' }).tekst, m.typeMerke({ Type: 'Flervalg-dropdown', Max_valg: 3 }).tekst,
            m.typeMerke({ Type: 'Flervalg-knapper', MerkAlle: true }).tekst], ['Enkeltvalg', 'Flervalg', 'Flervalg']);

    // ---------- HTML ----------
    const html = m.tilHtml(kart);
    sjekk('tekst fra definisjonen escapes', [html.includes('5 < 7'), html.includes('5 &lt; 7 &amp; &quot;x&quot;')], [false, true]);
    sjekk('HTML i spørsmålsteksten tas bort', m.kortTekst('<img src=x onerror=alert(1)> Hei **du**'), 'Hei du');
    sjekk('merkelappene escapes', html.includes('Avslått &amp; &quot;nei&quot;'), true);
    sjekk('lenkene peker på nodenes id', /href="#seksjon-2"/.test(html) && /id="seksjon-2"/.test(html), true);
    const kompakt = m.tilHtml(kart, { bareLogikk: true });
    sjekk('bare logikken: felt uten vilkår er borte', kompakt.includes('id="felt-1-05"'), false);
    sjekk('bare logikken: felt som styrer, er med', kompakt.includes('id="felt-1-01"'), true);
    sjekk('full visning: alle felt er med', html.includes('id="felt-1-05"'), true);

    // ---------- siden og editoren ----------
    const editor = fs.readFileSync(path.join(rot, 'frontend', 'editor.html'), 'utf8');
    const side = fs.readFileSync(path.join(rot, 'frontend', 'logikkart.html'), 'utf8');
    const lagrer = /localStorage\.setItem\('([^']+)', JSON\.stringify\(data\)\);\s*localStorage\.setItem\('[^']+-tid'[\s\S]{0,80}?window\.open\('\/logikkart\.html'/.exec(editor);
    sjekk('editoren har knappen', /onclick="visLogikkart\(\)"/.test(editor), true);
    sjekk('siden leser nøkkelen editoren skriver', !!lagrer && side.includes(`localStorage.getItem('${lagrer[1]}')`), true);
    for (const f of ['staticwebapp.config.dev.json', 'staticwebapp.config.pilot.json', 'staticwebapp.config.prod.json']) {
        const ruter = JSON.parse(fs.readFileSync(path.join(rot, f), 'utf8')).routes || [];
        sjekk(`${f}: siden krever innlogging`, ruter.find(r => r.route === '/logikkart.html')?.allowedRoles, ['authenticated']);
    }
}

kjor().then(() => {
    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
}).catch(e => { console.log('FEIL  testen kastet:', e.message, e.stack); process.exit(1); });
