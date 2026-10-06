/**
 * Importskriptet: regneark → skjemaer.
 *
 * Laget for verdivurderingsregisteret, men skriptet kjenner ikke det
 * registeret — det leser skjematypedefinisjonen og lar DEN bestemme hvilke
 * kolonner som finnes og hvilke verdier som er gyldige.
 *
 * Det testes fire ting, og den første er grunnen til at skriptet validerer i
 * det hele tatt:
 *
 *   **En verdi som ikke finnes i valglista stopper importen.** Svar lagres
 *   som verdier, ikke som referanser. Skriver vi «TJENSTLIG» der valglista
 *   sier «Tjenstlig», ser raden riktig ut i visningen — men åpner noen den
 *   for redigering, filtrerer widgeten bort verdien som ukjent og lagringen
 *   skriver den bort. Stille. 270 rader importert med feil kasus er 270
 *   tikkende rader.
 *
 *   **Overskriftsraden finnes under en tittelrad.** Arket har «VERKTØY FOR
 *   KARTLEGGING …» på rad 1 og overskriftene på rad 2. Leser skriptet rad 1
 *   som overskrifter, kobles ingenting — og «fant ingen kolonner» er en
 *   forvirrende feilmelding for et ark som ser helt riktig ut.
 *
 *   **Formen som skrives er den ekte.** `Seksjoner[].Felter[]` må ha de samme
 *   nøklene som `samleSeksjonerFraDom` i frontend produserer. Testen leser
 *   den funksjonen og sammenligner — et skjema med en oppfunnet form ville
 *   lagret seg fint og vært tomt i hver eneste visning.
 *
 *   **Kjøringen er idempotent.** `nokkelverdi` må lese tilbake nøyaktig det
 *   `byggSeksjoner` skrev, ellers hopper ikke en ny kjøring over radene som
 *   finnes — den lager dubletter av alle 270.
 *
 * Kjøres med:  node api/test/importer-skjemaer.test.js
 */
const fs = require('fs');
const path = require('path');
const imp = require('../../scripts/importer-skjemaer.js');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

// Skjematypen slik den ville sett ut for verdivurderingen.
const DEF = {
    Skjema_navn: 'Verdivurdering av informasjon',
    Seksjoner: [{
        Seksjon_nummer: 1,
        Felter: [
            { Nummer: '01', Type: 'Informasjon', Tekst: { Verdi: 'Fyll ut alle felt' } },
            { Nummer: '02', Type: 'Tekst', Tekst: 'Datapunkt (navn)' },
            { Nummer: '03', Type: 'Flervalg-dropdown', Tekst: 'Informasjonskategori',
              Valg: [{ Tekst: 'Personinformasjon (mil)' }, { Tekst: 'Driftsdata' }] },
            { Nummer: '04', Type: 'Flervalg-knapper', Tekst: 'Personopplysning',
              Valg: [{ Tekst: 'Ja' }, { Tekst: 'Nei' }] },
            { Nummer: '05', Type: 'Flervalg-dropdown', Tekst: 'Datapunkt',
              Valg: [{ Tekst: 'Kan offentliggjøres', Verdi: 'OFFENTLIG' }, { Tekst: 'Tjenstlig', Verdi: 'TJENSTLIG' }] }
        ]
    }]
};
const KATALOG = imp.feltKatalog(DEF);
const felt = (etikett) => KATALOG.find(f => f.etikett === etikett);

// ---------- katalogen ----------
{
    sjekk('informasjonsfelt er ikke med', KATALOG.map(f => f.nokkel), ['1-02', '1-03', '1-04', '1-05']);
    sjekk('valglista leses', felt('Personopplysning').valg.map(v => v.verdi), ['Ja', 'Nei']);
    // Begge formene beholdes: regnearket inneholder TEKSTEN et menneske så på
    // skjermen, mens skjemaet lagrer VERDIEN.
    sjekk('verdiene', felt('Datapunkt').valg.map(v => v.verdi), ['OFFENTLIG', 'TJENSTLIG']);
    sjekk('tekstene', felt('Datapunkt').valg.map(v => v.tekst), ['Kan offentliggjøres', 'Tjenstlig']);
    // Uten egen Verdi er de to like.
    sjekk('uten Verdi er tekst og verdi like',
        felt('Personopplysning').valg.map(v => v.tekst), ['Ja', 'Nei']);
    sjekk('fritekstfelt har ingen valgliste', felt('Datapunkt (navn)').valg, null);
}

// ---------- overskriftsraden under tittelraden ----------
{
    const etiketter = new Set(KATALOG.map(f => imp.normaliser(f.etikett)));
    const matrise = [
        ['VERKTØY FOR KARTLEGGING AV INFORMASJONSVERDI (VERDIVURDERING)', '', '', '', ''],
        ['Vurdert av', 'Informasjonskategori', 'Datapunkt (navn)', 'Personopplysning', 'Datapunkt'],
        ['FHS', 'Personinformasjon (mil)', 'tjenestested', 'Nei', 'Tjenstlig']
    ];
    sjekk('tittelraden hoppes over', imp.finnOverskrift(matrise, etiketter), 1);
    // En tittelrad har én utfylt celle — det er nettopp det som skiller dem.
    sjekk('en rad med ett treff er ikke overskrifter',
        imp.finnOverskrift([['Datapunkt (navn)', '', '']], etiketter), -1);
    sjekk('ingen overskriftsrad gir -1', imp.finnOverskrift([['a', 'b'], ['c', 'd']], etiketter), -1);
}

// ---------- kobling ----------
{
    const overskrifter = ['Vurdert av', 'informasjonskategori', 'Datapunkt (navn):', 'Personopplysning', 'Datapunkt'];
    const { kobling, ukoblede } = imp.koble(overskrifter, KATALOG, {});
    sjekk('fire koblet', kobling.map(k => k.felt.nokkel), ['1-03', '1-02', '1-04', '1-05']);
    // Store bokstaver og etterstilt kolon skal ikke bryte koblingen.
    sjekk('ulik skrivemåte treffer', kobling.find(k => k.overskrift === 'informasjonskategori').felt.nokkel, '1-03');
    // En kolonne uten felt er hverdagen i et regneark, ikke en feil.
    sjekk('ukoblede meldes', ukoblede, ['Vurdert av']);

    // Koblingsfila peker på feltnøkkelen, ikke etiketten — en omdøpt etikett
    // skal ikke rive koblingen.
    const med = imp.koble(['Vurdert av'], KATALOG, { 'Vurdert av': '1-02' });
    sjekk('overstyring vinner', med.kobling[0].felt.nokkel, '1-02');
    sjekk('og da er ingenting ukoblet', med.ukoblede, []);
}

// ---------- verdier mot valglista ----------
{
    sjekk('gyldig verdi', imp.tolkVerdi('Nei', felt('Personopplysning')), { verdi: 'Nei' });
    // Dette er feilen testen finnes for: regnearket skriver «TJENSTLIG», og
    // definisjonen sier «TJENSTLIG» som Verdi — men teksten i arket er
    // «Tjenstlig» i andre rader. Begge må lande på den kanoniske verdien.
    sjekk('kasus normaliseres til den kanoniske', imp.tolkVerdi('tjenstlig', felt('Datapunkt')), { verdi: 'TJENSTLIG' });
    sjekk('eksakt treff beholdes', imp.tolkVerdi('TJENSTLIG', felt('Datapunkt')), { verdi: 'TJENSTLIG' });

    // Dette er det regnearket FAKTISK inneholder: visningsteksten. Uten denne
    // grenen stoppet importen på hver eneste rad med et valgfelt som har egen
    // Verdi — oppdaget ved å kjøre skriptet mot et ark laget etter
    // skjermbildet, ikke ved å lese koden.
    sjekk('visningsteksten godtas og lagres som verdien',
        imp.tolkVerdi('Kan offentliggjøres', felt('Datapunkt')), { verdi: 'OFFENTLIG' });
    sjekk('også med annet kasus',
        imp.tolkVerdi('kan offentliggjøres', felt('Datapunkt')), { verdi: 'OFFENTLIG' });

    const f = imp.tolkVerdi('Hemmelig', felt('Datapunkt'));
    sjekk('ukjent verdi gir feil', !!f.feil, true);
    // Feilmeldingen må vise begge formene — den som leser den har arket foran
    // seg, ikke definisjonen.
    sjekk('og feilen nevner tekst og verdi',
        /Kan offentliggjøres \(OFFENTLIG\), Tjenstlig \(TJENSTLIG\)/.test(f.feil), true);
    sjekk('og ingen verdi slipper gjennom', f.verdi, undefined);
    // Er tekst og verdi like, skal den ikke skrives dobbelt.
    sjekk('ingen dobbel form når de er like',
        /Ja, Nei/.test(imp.tolkVerdi('Kanskje', felt('Personopplysning')).feil), true);

    sjekk('fritekst slipper gjennom', imp.tolkVerdi('epost_privat', felt('Datapunkt (navn)')), { verdi: 'epost_privat' });
    sjekk('tomt gir null', imp.tolkVerdi('   ', felt('Datapunkt (navn)')), { verdi: null });
    sjekk('mellomrom trimmes', imp.tolkVerdi('  Ja  ', felt('Personopplysning')), { verdi: 'Ja' });
}

// ---------- formen som skrives ----------
{
    const svar = new Map([['1-02', ['tjenestested']], ['1-05', ['TJENSTLIG']]]);
    const seksjoner = imp.byggSeksjoner(DEF, svar);

    sjekk('én seksjon', seksjoner.length, 1);
    sjekk('seksjonen har begge nummerformene',
        Object.keys(seksjoner[0]).sort(), ['Felter', 'Nummer', 'Seksjon_nummer']);
    sjekk('alle felt er med, også ubesvarte', seksjoner[0].Felter.length, 5);
    sjekk('informasjonsfeltet får tomt svar', seksjoner[0].Felter[0].Svar, []);
    sjekk('svaret havner riktig', seksjoner[0].Felter[1].Svar, ['tjenestested']);
    sjekk('ubesvart felt er tomt', seksjoner[0].Felter[2].Svar, []);

    // Den ekte formen: samme nøkler som samleSeksjonerFraDom i frontend
    // produserer. Et skjema med en oppfunnet form lagrer seg fint og er tomt
    // i hver eneste visning.
    const fr = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'felt-render.js'), 'utf8');
    const start = fr.indexOf('export function samleSeksjonerFraDom');
    sjekk('fant samleSeksjonerFraDom', start > -1, true);
    const kropp = fr.slice(start, fr.indexOf('\n}', start));
    const feltNokler = [...kropp.matchAll(/return \{ ([^}]+) \}/g)].pop()?.[1] || '';
    sjekk('feltnøklene er de samme',
        Object.keys(seksjoner[0].Felter[0]).sort(),
        feltNokler.split(',').map(d => d.trim().split(':')[0].trim()).sort());
}

// ---------- idempotens ----------
{
    const svar = new Map([['1-02', ['epost_privat']]]);
    const skjema = { Seksjoner: imp.byggSeksjoner(DEF, svar) };
    // Rundtur: det `nokkelverdi` leser må være nøyaktig det `byggSeksjoner`
    // skrev. Bommer den, hopper ikke en ny kjøring over noe — den lager
    // dubletter av alle radene.
    sjekk('nøkkelverdien leses tilbake', imp.nokkelverdi(skjema, '1-02'), 'epost_privat');
    sjekk('feil nøkkel gir tomt', imp.nokkelverdi(skjema, '1-99'), '');
    sjekk('uten skjema gir tomt', imp.nokkelverdi(null, '1-02'), '');
}

// ---------- argumenter ----------
{
    const a = imp.lesArgumenter(['--fil', 'x.xlsx', '--skjematype', '130', '--innsender', 'a@b.no']);
    sjekk('argumenter leses', [a.fil, a.skjematype, a.innsender], ['x.xlsx', '130', 'a@b.no']);
    // Tørrkjøring er standard. En import som skriver med mindre du ber om
    // det, er feil vei rundt.
    sjekk('utfor er av som standard', a.utfor, false);
    sjekk('--utfor slår den på', imp.lesArgumenter(['--utfor']).utfor, true);
    // Status 5 = Avsluttet: radene er alt vurdert utenfor systemet.
    sjekk('standardstatus er 5', a.status, 5);
    sjekk('--status overstyrer', imp.lesArgumenter(['--status', '2']).status, 2);
    sjekk('status er et tall', typeof imp.lesArgumenter(['--status', '2']).status, 'number');
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
