/**
 * Team-synkronisering fra rollegrupper (TODO 71).
 *
 * Denne funksjonen MELDER FOLK UT AV ET TEAM. Det er ikke en varsling som kan
 * sendes på nytt eller en rapport som kan kjøres om igjen — tilgang blir
 * borte, og systemet husker ikke hvem som sto der før. Testen er derfor
 * skrevet rundt det som kan gå galt, ikke rundt det som skal virke.
 *
 * Lista kommer fra en manuell Excel-import. Går importen halvveis, er
 * resultatet en KORTERE liste, ikke en feilmelding. Det er den feilen sperrene
 * finnes for, og det er den formen for feil som ellers aldri oppdages før
 * noen ringer og sier at de ikke kommer inn.
 *
 * Fire ting:
 *
 *   **Tom liste sendes aldri.** Verken gjennom vurderingen eller gjennom
 *   flyt-kallet. To uavhengige sperrer, fordi konsekvensen er at ALLE meldes
 *   ut av teamet.
 *
 *   **Et stort fall stoppes.** Og bare en innlogget administrator kan
 *   overstyre det — den daglige kjøringen skal aldri kunne det, ellers er det
 *   ikke en sperre.
 *
 *   **Grunnlaget flyttes ikke av en stoppet kjøring.** Skrives det
 *   mistenkelige tallet til `SisteAntall`, sammenligner neste kjøring med det
 *   og slipper fallet gjennom. Sperren ville da slått ut nøyaktig én gang.
 *
 *   **Teamet identifiseres entydig når det kan.** Et visningsnavn er ikke
 *   unikt; en GUID er.
 *
 * Kjøres med:  node api/test/team-synk.test.js
 */
const fs = require('fs');
const path = require('path');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const t = require('../src/lib/team-synk');
const { utenKommentarer } = require('../../scripts/test-kilde.js');

// ---------- tom liste ----------
{
    // Den viktigste enkeltregelen i hele funksjonen.
    sjekk('tom gruppe stoppes', t.vurderSynk({ antallNaa: 0, forrigeAntall: 40 }).ok, false);
    sjekk('og grunnen er «tom»', t.vurderSynk({ antallNaa: 0, forrigeAntall: 40 }).grunn, 'tom');
    sjekk('tom stoppes også uten historikk', t.vurderSynk({ antallNaa: 0, forrigeAntall: 0 }).ok, false);

    // Overstyringen gjelder FALL, ikke tomhet. En tom liste er aldri riktig
    // å sende — skal teamet tømmes, gjøres det i Teams.
    sjekk('tillatFall åpner ikke for tom liste',
        t.vurderSynk({ antallNaa: 0, forrigeAntall: 40, tillatFall: true }).ok, false);

    sjekk('meldingen forklarer konsekvensen',
        /meldt ut|alle/i.test(t.vurderSynk({ antallNaa: 0, forrigeAntall: 9 }).melding), true);
}

// ---------- stort fall ----------
{
    // Grensen er «mer enn halvparten borte», altså at gruppen beholder MINDRE
    // enn halvparten. Kanten er skrevet ut her fordi den ellers måtte leses ut
    // av et `<` i koden, og fordi det er nøyaktig den som blir feil hvis
    // noen senere skriver om regelen.
    sjekk('19 av 40 stoppes', t.vurderSynk({ antallNaa: 19, forrigeAntall: 40 }).ok, false);
    sjekk('grunnen er «stort-fall»', t.vurderSynk({ antallNaa: 19, forrigeAntall: 40 }).grunn, 'stort-fall');
    sjekk('kraftig fall stoppes', t.vurderSynk({ antallNaa: 3, forrigeAntall: 200 }).ok, false);

    // Nøyaktig halvparten beholdt er IKKE mer enn halvparten borte, og går
    // gjennom. Det er grensen oppdragsgiver godkjente.
    sjekk('20 av 40 går gjennom', t.vurderSynk({ antallNaa: 20, forrigeAntall: 40 }).ok, true);

    // Sperren er mot ras, ikke mot vanlig gjennomtrekk.
    sjekk('normal avgang går gjennom', t.vurderSynk({ antallNaa: 38, forrigeAntall: 40 }).ok, true);
    sjekk('21 av 40 går gjennom', t.vurderSynk({ antallNaa: 21, forrigeAntall: 40 }).ok, true);

    // Vekst er aldri mistenkelig.
    sjekk('vekst går gjennom', t.vurderSynk({ antallNaa: 80, forrigeAntall: 40 }).ok, true);

    // Små grupper: 1 av 3 er ikke et varsko, det er en liten gruppe.
    sjekk('lite grunnlag gir ingen fallsperre',
        t.vurderSynk({ antallNaa: 1, forrigeAntall: 4 }).ok, true);
    sjekk('men fra 5 slår den inn',
        t.vurderSynk({ antallNaa: 1, forrigeAntall: 5 }).ok, false);
    // En gruppe som forsvinner helt fanges uansett av tom-sperren, også under
    // grunnlagsgrensen.
    sjekk('0 av 3 stoppes likevel', t.vurderSynk({ antallNaa: 0, forrigeAntall: 3 }).grunn, 'tom');

    // Første kjøring har ingenting å sammenligne med.
    sjekk('første kjøring slipper gjennom', t.vurderSynk({ antallNaa: 3, forrigeAntall: 0 }).ok, true);
    sjekk('og merkes som første', t.vurderSynk({ antallNaa: 3, forrigeAntall: 0 }).grunn, 'forste-kjoring');

    // Overstyring — og den skal være synlig i resultatet, ikke usynlig.
    const overstyrt = t.vurderSynk({ antallNaa: 3, forrigeAntall: 40, tillatFall: true });
    sjekk('overstyring slipper gjennom', overstyrt.ok, true);
    sjekk('og sier fra at den ble overstyrt', overstyrt.grunn, 'stort-fall-overstyrt');
}

// ---------- upnListe ----------
{
    const inn = [
        { UPN: 'B@mil.no' }, { UPN: 'a@MIL.no' }, { UPN: 'b@mil.no' },
        { UPN: '  c@mil.no  ' }, { UPN: '' }, { UPN: null }, {}
    ];
    sjekk('normalisert, unik og sortert', t.upnListe(inn), ['a@mil.no', 'b@mil.no', 'c@mil.no']);

    // Duplikater MÅ bort: to rader for samme person ville blåst opp antallet
    // og dermed svekket fallsperren neste gang.
    sjekk('duplikat teller én gang', t.upnListe([{ UPN: 'a@x.no' }, { UPN: 'A@X.no' }]).length, 1);

    sjekk('tom liste gir tom liste', t.upnListe([]), []);
    sjekk('null gir tom liste', t.upnListe(null), []);
    // EP brukes når UPN mangler — samme felt rolletabellen faller tilbake på.
    sjekk('EP brukes som reserve', t.upnListe([{ EP: 'd@mil.no' }]), ['d@mil.no']);
}

// ---------- identifisering av teamet ----------
{
    const guid = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
    sjekk('GUID blir TeamId', t.teamIdentitet(guid).TeamId, guid);
    sjekk('og ikke navn', t.teamIdentitet(guid).TeamNavn, '');
    sjekk('navn blir TeamNavn', t.teamIdentitet('Publikum FFT').TeamNavn, 'Publikum FFT');
    sjekk('og ikke id', t.teamIdentitet('Publikum FFT').TeamId, '');
    sjekk('store bokstaver i GUID godtas', t.teamIdentitet(guid.toUpperCase()).TeamId.length, 36);
    sjekk('nesten-GUID er et navn', t.teamIdentitet('3fa85f64-5717-4562-b3fc').TeamNavn.length > 0, true);
    sjekk('tomt gir begge tomme', t.teamIdentitet(''), { TeamId: '', TeamNavn: '' });

    sjekk('harTeam ser satt team', t.harTeam({ Team: 'X' }), true);
    sjekk('harTeam ser tomt', t.harTeam({ Team: '' }), false);
    sjekk('harTeam ser bare mellomrom', t.harTeam({ Team: '   ' }), false);
    sjekk('harTeam tåler manglende gruppe', t.harTeam(null), false);
}

// ---------- payloaden ----------
{
    const p = t.byggPayload({
        rolle: 'Publikum', omfang: 'FFT', team: 'Publikum FFT',
        upner: ['a@mil.no', 'b@mil.no'], miljo: 'pilot'
    });
    sjekk('handlingen er med', p.Handling, 'synkroniserTeamDestruktivt');
    sjekk('rollen er med', p.Rolle, 'Publikum');
    sjekk('omfanget er med', p.Omfang, 'FFT');
    sjekk('medlemmene er med', p.Medlemmer, ['a@mil.no', 'b@mil.no']);
    sjekk('antallet stemmer med lista', p.Antall, p.Medlemmer.length);
    sjekk('teamnavnet er med', p.TeamNavn, 'Publikum FFT');
    sjekk('miljøet er med', p.Miljo, 'pilot');

    // Lista skal være en kopi. Ville payloaden delt array med kalleren, kunne
    // en senere endring der ha nådd flyten.
    const kilde = ['a@mil.no'];
    const p2 = t.byggPayload({ rolle: 'R', team: 'T', upner: kilde });
    kilde.push('c@mil.no');
    sjekk('payloaden deler ikke array med kalleren', p2.Medlemmer.length, 1);
}

// ---------- sperrene er koblet der de gjelder ----------
{
    const les = (...d) => utenKommentarer(
        fs.readFileSync(path.join(__dirname, '..', 'src', ...d), 'utf8'));

    const endepunkt = les('functions', 'team-synk.js');
    const flyt = les('lib', 'flyt-kaller.js');

    // Vurderingen må skje FØR flyten kalles, ikke etterpå.
    sjekk('endepunktet vurderer før det kaller',
        endepunkt.indexOf('teamSynk.vurderSynk(') < endepunkt.indexOf('kallTeamSynkFlyt('), true);
    sjekk('og hopper over kallet når svaret er nei',
        /if \(!dom\.ok\)[\s\S]{0,600}return \{/.test(endepunkt), true);

    // Den daglige kjøringen skal ikke kunne overstyre fallsperren.
    sjekk('scheduler kan ikke overstyre',
        /tillatFall = body\?\.tillatFall === true && a\.upn !== 'scheduler'/.test(endepunkt), true);

    // Grunnlaget for neste sammenligning flyttes bare av en vellykket kjøring.
    const storage = les('lib', 'rollegruppe-storage.js');
    sjekk('SisteAntall skrives bare ved ok',
        /if \(status === 'ok' && antall !== null\) rad\.SisteAntall/.test(storage), true);

    // Og flyt-kalleren har sin egen sperre mot tom liste, uavhengig av
    // vurderingen. To sperrer, fordi det bare finnes én sjanse.
    sjekk('flyt-kalleren nekter tom liste',
        /Medlemmer\.length === 0[\s\S]{0,200}return \{ status: 'feil'/.test(flyt), true);
}

// ---------- testskriptet sender det samme som API-et ----------
{
    // scripts/test-team-flyt.ps1 brukes til å prøve flyten før den kobles på.
    // Er payloaden der ulik den ekte, tester man noe annet enn det som
    // kommer i produksjon — og oppdager forskjellen først når det gjelder.
    const ps1 = fs.readFileSync(
        path.join(__dirname, '..', '..', 'scripts', 'test-team-flyt.ps1'), 'utf8');

    const blokk = ps1.slice(ps1.indexOf('[ordered]@{'), ps1.indexOf('}', ps1.indexOf('[ordered]@{')));
    const feltIPs1 = [...blokk.matchAll(/^\s+(\w+)\s+=/gm)].map(m => m[1]);
    const feltIApi = Object.keys(t.byggPayload({
        rolle: 'R', omfang: 'O', team: 'T', upner: ['a@x.no'], miljo: 'pilot'
    }));
    sjekk('samme felter, i samme rekkefølge', feltIPs1, feltIApi);

    // Og samme verdi på handlingen — flyten kan komme til å switche på den.
    sjekk('samme handling', /'synkroniserTeamDestruktivt'/.test(ps1), true);

    // Skriptet må nekte tom liste, som API-et gjør. Det er et testverktøy mot
    // et ekte team, ikke en sandkasse.
    sjekk('skriptet nekter tom liste', /Tom medlemsliste/.test(ps1), true);
    sjekk('og krever bekreftelse', /Skriv SEND/.test(ps1), true);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
