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
 * Kjøres med:  node api/test/skjema-import.test.js
 */
const fs = require('fs');
const path = require('path');
const imp = require('../src/lib/skjema-import');

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

// ---------- argumenter (kommandolinja) ----------
{
    const cli = require('../../scripts/importer-skjemaer.js');
    const imp = cli; // bare lesArgumenter hentes herfra
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

// ---------- behandlingen de importerte radene får ----------
{
    const MED_STEG = {
        ...DEF,
        Behandling: [{
            Steg: 1, Stegnavn: 'Vurdering', Personer: ['dsl@mil.no'],
            Beslutningsvalg: [
                { Nummer: 1, Tekst: 'Godkjent' },
                { Nummer: 2, Tekst: 'Avslått' },
                { Nummer: 3, Tekst: 'Ompuss', Handling: 'ompuss' }
            ]
        }]
    };
    const steg = MED_STEG.Behandling[0];

    // Teksten er det man ser i editoren og i registerfilteret — den er det man
    // oppgir. Tallet godtas også, for to valg kan hete det samme.
    sjekk('valg på tekst', imp.finnValg(steg, 'Godkjent').Nummer, 1);
    sjekk('valg på nummer', imp.finnValg(steg, '2').Tekst, 'Avslått');
    sjekk('kasus spiller ingen rolle', imp.finnValg(steg, 'godkjent').Nummer, 1);
    sjekk('ukjent valg', imp.finnValg(steg, 'Innvilget'), null);
    sjekk('tomt valg', imp.finnValg(steg, ''), null);

    const b = imp.byggFerdigBehandling(MED_STEG, 'Godkjent', 'dsl@mil.no', '2026-10-06T10:00:00.000Z', 'Vurdert i regneark');
    sjekk('ett steg', b.length, 1);
    sjekk('beslutningen er nummeret', b[0].Beslutning, 1);
    sjekk('behandler er satt', b[0].BehandletAv, 'dsl@mil.no');
    sjekk('dato er satt', b[0].BehandletDato, '2026-10-06T10:00:00.000Z');
    sjekk('kommentaren følger med', b[0].Kommentar, 'Vurdert i regneark');
    // Definisjonen skal ikke endres av å bygge behandlingen.
    sjekk('definisjonen er urørt', MED_STEG.Behandling[0].Beslutning, undefined);

    // Det som betyr noe er at de EKTE leserne forstår formen. En egen form
    // ville lagret seg fint og vært usynlig i registerfilteret.
    const { sisteBeslutning } = require('../src/lib/datauttrekk');
    // `?.` med vilje: svarer leseren null fordi formen er feil, skal testen
    // melde det som en feil — ikke krasje og ta med seg sjekkene under.
    sjekk('sisteBeslutning leser utfallet', sisteBeslutning({ Behandling: b })?.tekst, 'Godkjent');
    sjekk('og stegnavnet', sisteBeslutning({ Behandling: b })?.steg, 'Vurdering');
    // Status 5 og «alle steg ferdig» må være enige, ellers står et avsluttet
    // skjema med et steg som venter.
    const { alleStegFerdig } = require('../src/lib/behandling');
    sjekk('alle steg er ferdige', alleStegFerdig({ Behandling: b }), true);

    // Et navn som ikke finnes skal stoppe importen, ikke skrive 270 rader med
    // et beslutningstall ingen kjenner igjen.
    let kastet = null;
    try { imp.byggFerdigBehandling(MED_STEG, 'Innvilget', 'x', 'y', ''); } catch (e) { kastet = e.message; }
    sjekk('ukjent beslutning stopper', !!kastet, true);
    sjekk('og sier hvilke som finnes', /Godkjent \(1\), Avslått \(2\), Ompuss \(3\)/.test(kastet || ''), true);

    // Flere steg: alle får samme utfall. Regnearket sier ingenting om at det
    // ene skulle vært godkjent og det neste avslått.
    const toSteg = { Behandling: [steg, { ...steg, Steg: 2, Stegnavn: 'Kontroll' }] };
    const b2 = imp.byggFerdigBehandling(toSteg, 'Avslått', 'a@b.no', 'd', '');
    sjekk('begge steg avgjort', b2.map(x => x.Beslutning), [2, 2]);
    sjekk('og skjemaet er ferdig', alleStegFerdig({ Behandling: b2 }), true);
}

// ---------- importen stopper når utfallet ikke er oppgitt ----------
{
    // Uten dette ville 270 rader landet som «Ikke behandlet» i registerets
    // utfallsfilter — og det oppdages først når noen filtrerer og ikke finner
    // dem. Et valg man ikke tar bevisst, skal ikke tas stille.
    const kilde = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'skjema-import.js'), 'utf8');
    const DEF = { Behandling: [{ Steg: 1, Stegnavn: 'Vurdering',
        Beslutningsvalg: [{ Nummer: 1, Tekst: 'Godkjent' }, { Nummer: 2, Tekst: 'Avslått' }] }] };

    let m = null;
    try { imp.krevBeslutning(DEF, { status: 5 }); } catch (e) { m = e.message; }
    sjekk('vakten slår til', !!m, true);
    sjekk('og nevner valgene', /Godkjent, Avslått/.test(m || ''), true);

    // Kallerens egne ord for utveiene — kommandolinja snakker om flagg,
    // grensesnittet om knapper. Regelen er den samme.
    let h = null;
    try { imp.krevBeslutning(DEF, { status: 5, hjelp: '  --beslutning "Godkjent"' }); } catch (e) { h = e.message; }
    sjekk('hjelpeteksten følger med', /--beslutning "Godkjent"/.test(h || ''), true);

    // De tre utveiene slipper gjennom.
    const gaarGjennom = (o) => { try { imp.krevBeslutning(DEF, o); return true; } catch { return false; } };
    sjekk('med beslutning', gaarGjennom({ status: 5, beslutning: 'Godkjent' }), true);
    sjekk('uten behandling, bevisst', gaarGjennom({ status: 5, utenBehandling: true }), true);
    sjekk('til behandling', gaarGjennom({ status: 2 }), true);
    sjekk('uten behandlingssteg', gaarGjennom.call(null, { status: 5 }) || imp.krevBeslutning({}, { status: 5 }) === undefined, true);

    // Et navn som ikke finnes stoppes HER, ikke etter at 270 rader er lest.
    sjekk('ukjent beslutning stoppes av vakten', gaarGjennom({ status: 5, beslutning: 'Innvilget' }), false);
}

// ---------- diagnostikken når en kolonne ikke treffer ----------
{
    // Meldt fra første kjøring: «Hoppet over 1 kolonne(r): Datapunkt (navn)»
    // etterfulgt av «Fant ikke nøkkelfeltet». Begge var sanne, og ingen av dem
    // sa hva feltet i skjematypen HETER — den som leser må tilbake til
    // editoren for å gjette. Svaret finnes i katalogen og er gratis å skrive.
    const kilde = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'skjema-import.js'), 'utf8');

    sjekk('ledige felt regnes ut',
        /const ledige = katalog\.filter\(f => !brukte\.has\(f\.nokkel\)\);/.test(kilde), true);
    sjekk('nøkkelfeil lister koblede kolonner',
        /Det må være en kolonne som er koblet\./.test(kilde), true);

    // Begge overflatene skriver dem ut — kommandolinja og registeret.
    const cli = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'importer-skjemaer.js'), 'utf8');
    sjekk('kommandolinja viser ledige felt', /Felt uten kolonne \(\$\{plan\.ledige\.length\}\)/.test(cli), true);
    sjekk('med et ferdig --kolonner-eksempel', /Koble dem med --kolonner/.test(cli), true);
    const reg = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'register.html'), 'utf8');
    sjekk('registeret viser ledige felt', /Felt uten kolonne:/.test(reg), true);
}

// ---------- flere verdier i én celle, og skrivefeil ----------
{
    // Oppdaget i det ekte arket: vurderingskolonnene har «TJENSTLIG/AVSKJERMET»,
    // og noen celler er skrevet feil. Begge deler må håndteres uten å rette
    // 270 celler i Excel.
    const lagFelt = (over) => imp.feltKatalog({ Seksjoner: [{ Seksjon_nummer: 2, Felter: [{
        Nummer: '01', Type: 'Flervalg-knapper', Tekst: 'Datapunkt',
        Valg: [{ Tekst: 'TJENSTLIG' }, { Tekst: 'AVSKJERMET' }, { Tekst: 'KAN OFFENTLIGGJØRES' }],
        ...over
    }] }] })[0];

    // Hvor mange verdier feltet tar — samme regel som felt-render.js.
    sjekk('uten Max_valg tar feltet én', lagFelt({}).maksValg, 1);
    sjekk('Max_valg leses', lagFelt({ Max_valg: 3 }).maksValg, 3);
    sjekk('MerkAlle opphever taket', lagFelt({ MerkAlle: true }).maksValg, Infinity);

    const flere = lagFelt({ Max_valg: 3 });
    sjekk('én verdi er fortsatt én', imp.tolkVerdi('TJENSTLIG', flere), { verdi: 'TJENSTLIG' });
    sjekk('to verdier deles', imp.tolkVerdi('TJENSTLIG/AVSKJERMET', flere), { verdi: ['TJENSTLIG', 'AVSKJERMET'] });
    sjekk('luft rundt skilletegnet', imp.tolkVerdi(' TJENSTLIG / AVSKJERMET ', flere), { verdi: ['TJENSTLIG', 'AVSKJERMET'] });
    sjekk('samme verdi to ganger blir én', imp.tolkVerdi('TJENSTLIG/TJENSTLIG', flere), { verdi: ['TJENSTLIG'] });
    sjekk('annet skilletegn', imp.tolkVerdi('TJENSTLIG;AVSKJERMET', flere, { skilletegn: ';' }),
        { verdi: ['TJENSTLIG', 'AVSKJERMET'] });

    // Hele cella prøves FØRST. Et valg som selv inneholder en skråstrek skal
    // ikke deles i to deler som ingen av dem finnes.
    const medSkrå = lagFelt({ Max_valg: 3, Valg: [{ Tekst: 'TJENSTLIG/AVSKJERMET' }, { Tekst: 'TJENSTLIG' }] });
    sjekk('hele cella vinner over delingen',
        imp.tolkVerdi('TJENSTLIG/AVSKJERMET', medSkrå), { verdi: 'TJENSTLIG/AVSKJERMET' });

    // Ukjent del: feilen må peke på DELEN, ikke på hele cella — det er den
    // som skal rettes.
    const u = imp.tolkVerdi('TJENESTLIG/AVSKJERMET', flere);
    sjekk('ukjent del stopper', !!u.feil, true);
    sjekk('og peker på delen', u.ukjent, 'TJENESTLIG');

    // Rettefila, med og uten kasus.
    sjekk('retting treffer eksakt',
        imp.tolkVerdi('TJENESTLIG/AVSKJERMET', flere, { aliaser: { TJENESTLIG: 'TJENSTLIG' } }),
        { verdi: ['TJENSTLIG', 'AVSKJERMET'] });
    sjekk('retting treffer normalisert',
        imp.tolkVerdi('Tjenestlig', flere, { aliaser: { tjenestlig: 'TJENSTLIG' } }), { verdi: 'TJENSTLIG' });

    // Et felt som bare tar én verdi skal ikke få to. Det er en
    // modelleringsavgjørelse, ikke noe skriptet gjetter på.
    const en = lagFelt({});
    const f = imp.tolkVerdi('TJENSTLIG/AVSKJERMET', en);
    sjekk('enkeltvalgfelt avviser to verdier', !!f.feil, true);
    sjekk('og sier begge utveiene',
        /Øk Max_valg på feltet, eller legg inn "TJENSTLIG\/AVSKJERMET" som et eget valg/.test(f.feil), true);

    // Fritekst røres ikke av delingen — en sti eller en dato med skråstrek er
    // ikke to verdier.
    const fritekst = imp.feltKatalog({ Seksjoner: [{ Seksjon_nummer: 1, Felter: [
        { Nummer: '01', Type: 'Tekst', Tekst: 'Vurdering' }] }] })[0];
    sjekk('fritekst deles ikke', imp.tolkVerdi('EK_PERSON/EK_ANSATT', fritekst), { verdi: 'EK_PERSON/EK_ANSATT' });
}

// ---------- feilrapporten er en arbeidsliste ----------
{
    // 270 rader med fire skrivefeil gir 300 enkeltfeil. Den lista er ikke til
    // å jobbe med; gruppert på verdi er den fire ting å rette.
    const kilde = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'skjema-import.js'), 'utf8');
    // Kjør den ekte grupperingen i stedet for å lese etter den.
    const feilListe = [
        { radNr: 3, kolonne: 'Datapunkt', ukjent: 'TJENESTLIG', melding: 'a' },
        { radNr: 9, kolonne: 'Datapunkt', ukjent: 'TJENESTLIG', melding: 'a' },
        { radNr: 4, kolonne: 'Datapunkt', ukjent: 'AVSKJERMA', melding: 'b' },
        { radNr: 5, kolonne: 'Kategori', ukjent: 'TJENESTLIG', melding: 'c' }
    ];
    const g = imp.grupperFeil(feilListe);
    sjekk('tre grupper, ikke fire feil', g.length, 3);
    sjekk('de vanligste først', g[0].antall, 2);
    sjekk('gruppert på kolonne OG verdi',
        g.map(x => `${x.kolonne}/${x.ukjent}`), ['Datapunkt/TJENESTLIG', 'Datapunkt/AVSKJERMA', 'Kategori/TJENESTLIG']);
    sjekk('radnumrene følger med', g[0].rader, [3, 9]);
    // Noen radnumre å slå opp i arket, men ikke alle 270.
    const mange = imp.grupperFeil(Array.from({ length: 30 }, (_, i) => ({ radNr: i + 2, kolonne: 'K', ukjent: 'X', melding: 'm' })));
    sjekk('maks fem radnumre', mange[0].rader.length, 5);
    sjekk('men antallet er riktig', mange[0].antall, 30);

    // Et ferdig utkast til rettefila sparer en avskrift — begge overflater.
    const cli2 = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'importer-skjemaer.js'), 'utf8');
    sjekk('kommandolinja foreslår rettefila', /Er det skrivefeil i arket, rett dem med --verdier/.test(cli2), true);
    const reg2 = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'register.html'), 'utf8');
    sjekk('registeret foreslår den også', /Er det skrivefeil i arket, rett dem under «Avansert»/.test(reg2), true);
}

// ---------- koblingslista viser hva skriptet faktisk leser ----------
{
    // «Får feil på antall verdier selv om de er satt til 5» — og utskriften
    // viste bare felttypen, så det fantes ingen måte å se om skriptet leste 5
    // eller 1. Står taket i lista, er spørsmålet besvart uten en runde med
    // gjetting.
    const f = (over) => imp.feltKatalog({ Seksjoner: [{ Seksjon_nummer: 2, Felter: [
        { Nummer: '01', Type: 'Flervalg-knapper', Tekst: 'Datapunkt',
          Valg: [{ Tekst: 'TJENSTLIG' }, { Tekst: 'AVSKJERMET' }], ...over }] }] })[0];

    sjekk('taket vises', imp.beskrivFelt(f({ Max_valg: 5 })), 'Flervalg-knapper, maks 5, 2 valg');
    sjekk('uten tak vises 1', imp.beskrivFelt(f({})), 'Flervalg-knapper, maks 1, 2 valg');
    sjekk('MerkAlle sier «alle», ikke Infinity',
        imp.beskrivFelt(f({ MerkAlle: true })), 'Flervalg-dropdown, maks: alle, 2 valg'.replace('dropdown', 'knapper'));

    // Fritekst har hverken tak eller valgliste — da skal det ikke stå noe om
    // dem heller.
    const fri = imp.feltKatalog({ Seksjoner: [{ Seksjon_nummer: 1, Felter: [
        { Nummer: '01', Type: 'Tekst', Tekst: 'Vurdering' }] }] })[0];
    sjekk('fritekst viser bare typen', imp.beskrivFelt(fri), 'Tekst');

    // Begge overflatene viser beskrivelsen — kommandolinja i teksten,
    // registeret i koblingslista fra serveren.
    const cli3 = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'importer-skjemaer.js'), 'utf8');
    sjekk('kommandolinja bruker den', /\$\{beskrivFelt\(k\.felt\)\}/.test(cli3), true);
    const ep = fs.readFileSync(path.join(__dirname, '..', 'src', 'functions', 'skjema-import.js'), 'utf8');
    sjekk('endepunktet sender den', /beskrivelse: imp\.beskrivFelt\(k\.felt\)/.test(ep), true);
}

// ---------- hele planen, som begge overflatene kaller den ----------
{
    // `lagPlan` er delt mellom kommandolinja og endepunktet. Delte
    // småfunksjoner hadde ikke vært nok: REKKEFØLGEN — finn overskriften,
    // koble, tolk, grupper, hopp over det som finnes — er selve regelen, og
    // to kopier av den ville før eller siden gitt to svar på samme fil.
    const DEF = { Skjema_navn: 'Verdivurdering', Seksjoner: [{ Seksjon_nummer: 1, Felter: [
        { Nummer: '01', Type: 'Tekst', Tekst: 'Datapunkt navn' },
        { Nummer: '02', Type: 'Flervalg-knapper', Tekst: 'Datapunkt', Max_valg: 5,
          Valg: [{ Tekst: 'TJENSTLIG' }, { Tekst: 'AVSKJERMET' }] }
    ] }] };
    const MATRISE = [
        ['VERKTØY FOR KARTLEGGING AV INFORMASJONSVERDI', '', ''],
        ['Datapunkt (navn)', 'Datapunkt', 'Ubrukt kolonne'],
        ['epost_privat', 'TJENSTLIG/AVSKJERMET', 'x'],
        ['sap_brukernavn', 'TJENESTLIG', 'y'],
        ['', '', '']
    ];
    const kolonner = { 'Datapunkt (navn)': '1-01' };
    // Kaster planen fordi en regel er brutt, skal testen MELDE det — ikke dø
    // og ta med seg sjekkene under.
    const TOM = { linje: -1, kobling: [], ukoblede: [], ledige: [], nokkelFelt: null,
        rader: [], feil: [], hoppet: [], grupper: [] };
    const planTrygt = (navn, o) => {
        try { return imp.lagPlan(o); }
        catch (e) { sjekk(`${navn}: planen lot seg lage`, e.message, null); return TOM; }
    };

    const plan = planTrygt('grunntilfellet',
        { matrise: MATRISE, def: DEF, opsjoner: { kolonner, nokkelfelt: 'Datapunkt (navn)' } });

    // Overskriftsraden finnes under tittelraden — og en kolonne som bare
    // kobles manuelt teller med. Uten den regelen kunne et ark med to slike
    // ikke finne raden i det hele tatt, og feilmeldingen pekte da på
    // feltnavnene, som var helt riktige.
    sjekk('overskriftsraden', plan.linje, 1);
    sjekk('koblet begge', plan.kobling.map(k => k.felt.nokkel), ['1-01', '1-02']);
    sjekk('ukoblet kolonne meldes', plan.ukoblede, ['Ubrukt kolonne']);
    sjekk('ingen ledige felt igjen', plan.ledige, []);
    sjekk('nøkkelfeltet er koblet', plan.nokkelFelt?.nokkel, '1-01');

    // Tomme rader hoppes over uten å telle som feil.
    sjekk('én rad klar, én med feil', [plan.rader.length, plan.feil.length], [1, 1]);
    sjekk('flere verdier i samme celle', plan.rader[0]?.svar['1-02'], ['TJENSTLIG', 'AVSKJERMET']);
    sjekk('feilen er gruppert', plan.grupper.map(g => g.ukjent), ['TJENESTLIG']);

    // Med rettefila går begge gjennom.
    const rettet = planTrygt('med retting', { matrise: MATRISE, def: DEF,
        opsjoner: { kolonner, verdier: { TJENESTLIG: 'TJENSTLIG' }, nokkelfelt: 'Datapunkt (navn)' } });
    sjekk('retting fjerner feilen', [rettet.rader.length, rettet.feil.length], [2, 0]);

    // Idempotens: en rad som finnes fra før hoppes over.
    const fraFor = [{ Seksjoner: imp.byggSeksjoner(DEF, new Map([['1-01', ['epost_privat']]])) }];
    const andre = planTrygt('andre kjøring', { matrise: MATRISE, def: DEF, eksisterende: fraFor,
        opsjoner: { kolonner, verdier: { TJENESTLIG: 'TJENSTLIG' }, nokkelfelt: 'Datapunkt (navn)' } });
    sjekk('kjent rad hoppes over', andre.hoppet.map(h => h.verdi), ['epost_privat']);
    sjekk('resten importeres', andre.rader.length, 1);

    // Nøkkelfeltet må være en KOBLET kolonne — ellers er det tomt på hver rad,
    // og idempotensen virker ikke uansett.
    let m = null;
    try { imp.lagPlan({ matrise: MATRISE, def: DEF, opsjoner: { kolonner, nokkelfelt: 'Finnes ikke' } }); }
    catch (e) { m = e.message; }
    sjekk('ukjent nøkkelfelt stoppes', !!m, true);
    sjekk('og de koblede listes', /"Datapunkt \(navn\)", "Datapunkt"/.test(m || ''), true);

    // Uten koblingsfila treffer bare én kolonne et feltnavn — og da er det
    // ikke nok til å kjenne igjen overskriftsraden.
    let u = null;
    try { imp.lagPlan({ matrise: MATRISE, def: DEF, opsjoner: {} }); } catch (e) { u = e.message; }
    sjekk('for få kjente navn gir forklaring', /Fant ingen overskriftsrad/.test(u || ''), true);
    sjekk('og peker på koblingsfila', /koble dem med en koblingsfil/i.test(u || ''), true);
}

// ---------- endepunktet og panelet kaller den samme planen ----------
{
    const les = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8');
    const ep = les('api', 'src', 'functions', 'skjema-import.js');
    const cli = les('scripts', 'importer-skjemaer.js');
    const reg = les('frontend', 'register.html');

    // Begge overflatene kaller lagPlan. Det er hele poenget med modulen: en
    // import fra nettleseren og en fra terminalen skal gi samme resultat.
    sjekk('endepunktet kaller lagPlan', /imp\.lagPlan\(\{/.test(ep), true);
    sjekk('kommandolinja kaller lagPlan', /lagPlan\(\{ matrise:/.test(cli), true);
    // Og ingen av dem har sin egen kopi av lesingen.
    for (const [navn, kode] of [['endepunktet', ep], ['kommandolinja', cli]]) {
        sjekk(`${navn} har ingen egen radløkke`, /for \(let i = linje \+ 1;/.test(kode), false);
        sjekk(`${navn} har ingen egen kobling`, /function koble\(/.test(kode), false);
    }

    // Tørrkjøring er standard. En import som skriver med mindre du ber om det
    // er feil vei rundt — og her er det 270 rader som står på spill.
    sjekk('bekreft kreves for å skrive', /const bekreft = String\(formData\.get\('bekreft'\) \|\| ''\) === 'true';/.test(ep), true);
    // `indexOf` gir -1 når linja mangler, og -1 er mindre enn alt — en
    // sammenligning alene ville bestått på en fjernet retur. Finn den først.
    const iRetur = ep.indexOf('if (!bekreft) return { jsonBody: forhåndsvisning };');
    const iSkriv = ep.indexOf('await forekomstStorage.lagreSkjema');
    sjekk('tørrkjøringen returnerer', iRetur > -1, true);
    sjekk('og gjør det før skrivingen', iRetur > -1 && iSkriv > -1 && iRetur < iSkriv, true);
    // Feil stopper utførelsen også når noen bekrefter likevel.
    sjekk('feil stopper utførelsen', /if \(plan\.feil\.length > 0\) \{\s*\n\s*return \{ status: 400/.test(ep), true);

    // Eier, ikke bare admin: den som forvalter et register er eier av
    // skjematypen og skal kunne fylle det uten å gå via noen andre.
    sjekk('eier eller admin', /harEierTilgang\(skjematypeId, upn\)/.test(ep), true);
    sjekk('admin alene er ikke nok', /if \(!erAdmin\(upn\)\) return \{ status: 403/.test(ep), false);

    // Importen går forbi lagreSkjema-endepunktet nettopp for å unngå 270
    // varslinger. Det skal stå i koden, ikke bare i hodet på den som skrev den.
    sjekk('ingen varsling fra importen', /sendBehandlerVarsling|sendBeslutningVarsling/.test(ep), false);
    sjekk('radene merkes som importert', /Importert: \{ Fra: fil\.name, Rad: r\.radNr/.test(ep), true);
    sjekk('og havner i hendelsesloggen', /Type: 'skjema\.import'/.test(ep), true);

    // Panelet
    sjekk('registeret har importknappen', /onclick="visImport\(\)"/.test(reg), true);
    sjekk('og sender til endepunktet', /\/import`, \{ method: 'POST', body: fd \}/.test(reg), true);
    sjekk('tørrkjøring først', /importSkjema\(false\)/.test(reg), true);
    sjekk('så bekreftelse', /importSkjema\(true\)/.test(reg), true);
    // Utfallsvalget fylles fra skjematypen, ikke fra en fast liste.
    sjekk('utfallene kommer fra skjematypen',
        /\(steg\?\.Beslutningsvalg \|\| \[\]\)\.map\(v => v\.Tekst\)/.test(reg), true);
    // Lista hentes på nytt etter import — ellers ser det ut som ingenting skjedde.
    sjekk('lista oppdateres etterpå', /api\.get\(`\/api\/skjema-liste/.test(reg.split('importUtfor').pop()), true);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
