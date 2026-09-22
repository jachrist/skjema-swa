/**
 * Diagnose av en skjematype.
 *
 * En skjematype kan lagres, se riktig ut, og likevel være ødelagt på en måte
 * som først viser seg ved første innsending — hos noen andre, i en flyt,
 * uten at skjemaeier får vite det. Kjøringen blir rød i Power Automate, og
 * det er alt som skjer.
 *
 * Reglene her finner de feilene som kan avgjøres uten nettverk. Testen er
 * bygget rundt to ting som er lette å gjøre galt:
 *
 *   **En plassholder er ikke en feil.** `Bucket: "{2-3}"` er helt lovlig —
 *   verdien kommer fra skjemaet ved innsending. Meldes den som feil, jager
 *   skjemaeier noe som er riktig, og slutter å tro på diagnosen.
 *
 *   **Et oppslag som feilet er ikke en tom rolle.** Svarer
 *   rollelageret ikke, skal diagnosen tie — ikke melde at rollen er tom.
 *   Forskjellen er mellom «du har skrevet feil» og «vi vet ikke».
 *
 * Alvorsgradene skal også bety noe: `feil` er «dette virker ikke», `advarsel`
 * er «dette virker, men gjør ikke det du tror», `info` er «kan ikke sjekkes».
 * Glir de over i hverandre, blir lista uleselig.
 *
 * Kjøres med:  node api/test/skjematype-diagnose.test.js
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

const d = require('../src/lib/skjematype-diagnose');

/** Rollelager som alltid svarer med et gitt antall. */
const roller = (n) => async () => n;

/** Koder i funnene, til sammenligning. */
const koder = (res) => res.funn.map(f => f.kode).sort();
const harKode = (res, k) => res.funn.some(f => f.kode === k);

const SEKSJONER = [{
    Seksjon_nummer: 1,
    Felter: [{ Nummer: 1, Id: 'felt-a' }, { Nummer: 2, Id: 'felt-b' }]
}];

async function kjor() {

    // ---------- en ren skjematype gir ingen funn ----------
    {
        const res = await d.diagnoser({
            Seksjoner: SEKSJONER,
            Behandling: [{
                Steg: 1, Stegnavn: 'Godkjenning', Personer: ['sjef@fhs.no'], Varsling: ['epost']
            }]
        }, { antallInnehavere: roller(3) });
        sjekk('ingen funn', res.funn, []);
        sjekk('sammendraget er tomt', res.sammendrag, { feil: 0, advarsel: 0, info: 0 });
    }

    // ---------- plassholdere er ikke feil ----------
    {
        // Det viktigste enkeltpunktet: en lovlig plassholder skal gi `info`,
        // ikke `feil`. Ellers mister skjemaeier tilliten til hele lista.
        const res = await d.diagnoser({
            Seksjoner: SEKSJONER,
            Behandling: [{
                Steg: 1, Personer: ['a@b.no'], Varsling: ['planner'],
                PlannerOppgave: { TeamOgPlan: 'FFT {1-1}', Bucket: 'Nye' }
            }]
        }, { antallInnehavere: roller(3) });
        // «FFT {1-1}» har plassholder, men mangler kolon — da er det den mer
        // presise koden som gjelder. Poenget er det samme: info, ikke feil.
        sjekk('plassholder gir info', res.sammendrag.info > 0, true);
        sjekk('og ingen feil', res.sammendrag.feil, 0);

        // $-plassholdere også.
        const res2 = await d.diagnoser({
            Seksjoner: SEKSJONER,
            Behandling: [{
                Steg: 1, Personer: ['a@b.no'], Varsling: ['teamskanal'],
                TeamsKanalInnlegg: { Team: 'FFT', Kanal: '$stegnavn' }
            }]
        }, { antallInnehavere: roller(3) });
        sjekk('$-plassholder gir info', harKode(res2, 'teamskanal.plassholder'), true);
        sjekk('og ingen feil', res2.sammendrag.feil, 0);
    }

    // ---------- feilet oppslag er ikke en tom rolle ----------
    {
        // `null` betyr «vi fikk ikke svar». Da skal det IKKE meldes at rollen
        // er tom — det ville vært en feilmelding om noe som kanskje er helt
        // i orden.
        const def = {
            Seksjoner: SEKSJONER,
            Behandling: [{ Steg: 1, Roller: ['Sjef'], Varsling: ['epost'] }]
        };
        const tom = await d.diagnoser(def, { antallInnehavere: roller(0) });
        sjekk('tom rolle meldes', harKode(tom, 'rolle.tom'), true);

        const ukjent = await d.diagnoser(def, { antallInnehavere: async () => null });
        sjekk('feilet oppslag meldes ikke', harKode(ukjent, 'rolle.tom'), false);
    }

    // ---------- dynamiske roller: feltreferansen sjekkes ----------
    {
        const god = await d.diagnoser({
            Seksjoner: SEKSJONER,
            Behandling: [{ Steg: 1, Roller: ['Klassesjef({1-2})'], Varsling: ['epost'] }]
        }, { antallInnehavere: roller(0) });
        sjekk('gyldig feltref gir info', harKode(god, 'rolle.dynamisk'), true);
        // Rollen kan ikke slås opp, så den skal ikke meldes som tom.
        sjekk('dynamisk rolle meldes ikke som tom', harKode(god, 'rolle.tom'), false);

        const daarlig = await d.diagnoser({
            Seksjoner: SEKSJONER,
            Behandling: [{ Steg: 1, Roller: ['Klassesjef({9-9})'], Varsling: ['epost'] }]
        }, { antallInnehavere: roller(0) });
        sjekk('ugyldig feltref gir feil', harKode(daarlig, 'rolle.feltref-mangler'), true);

        // Felt-Id fungerer også som referanse.
        const viaId = await d.diagnoser({
            Seksjoner: SEKSJONER,
            Behandling: [{ Steg: 1, Roller: ['Klassesjef({felt-b})'], Varsling: ['epost'] }]
        }, { antallInnehavere: roller(0) });
        sjekk('felt-Id godtas som referanse', harKode(viaId, 'rolle.feltref-mangler'), false);
    }

    // ---------- Planner ----------
    {
        const utenPlan = await d.diagnoser({
            Behandling: [{ Steg: 1, Personer: ['a@b.no'], Varsling: ['planner'], PlannerOppgave: { Bucket: 'Nye' } }]
        }, { antallInnehavere: roller(3) });
        sjekk('bucket uten plan', harKode(utenPlan, 'planner.bucket-uten-plan'), true);
        sjekk('og manglende plan', harKode(utenPlan, 'planner.mangler-plan'), true);
        sjekk('begge er feil', utenPlan.sammendrag.feil, 2);

        // Oppsett som aldri brukes: virker, men gjør ikke det eieren tror.
        const ikkeAktiv = await d.diagnoser({
            Behandling: [{
                Steg: 1, Personer: ['a@b.no'], Varsling: ['epost'],
                PlannerOppgave: { TeamOgPlan: 'FFT | Saker', Bucket: 'Nye' }
            }]
        }, { antallInnehavere: roller(3) });
        sjekk('ubrukt planner-oppsett gir advarsel', harKode(ikkeAktiv, 'planner.ikke-aktiv'), true);
        sjekk('og ikke feil', ikkeAktiv.sammendrag.feil, 0);
    }

    // ---------- «Team og plan» er ETT felt med TO verdier ----------
    {
        // Funnet i testkjøring 22.09.2026: feltets plassholder er
        // «Automatisering:Oppgaver», og skriver man bare teamnavnet er
        // verdien ikke tom — alt så riktig ut, og diagnosen sa ingenting.
        // Flyten fikk et teamnavn der den venter et par.
        const medPlan = async (v) => d.diagnoser({
            Behandling: [{ Steg: 1, Personer: ['a@b.no'], Varsling: ['planner'], PlannerOppgave: { TeamOgPlan: v } }]
        }, { antallInnehavere: roller(3) });

        const bareTeam = await medPlan('Automatisering');
        sjekk('team uten plan gir feil', harKode(bareTeam, 'planner.plan-uten-plan'), true);
        // Meldingen skal vise hvordan det skal se ut, ikke bare si at det er galt.
        sjekk('meldingen foreslår formen',
            bareTeam.funn[0].melding.includes('Automatisering:Oppgaver'), true);

        // Bare plan-feltet vurderes her; en tom bucket gir sin egen advarsel,
        // og den hører til i blokka under.
        const planFunn = (r) => r.funn.filter(f => f.kode.startsWith('planner.plan')).map(f => f.kode);
        sjekk('riktig form gir ingenting om planen',
            planFunn(await medPlan('Automatisering:Oppgaver')), []);

        // En plassholder kan løse seg til «Team:Plan». Da vet vi ikke nok til
        // å melde feil — men vi skal si at det ikke kan sjekkes.
        const ukjent = await medPlan('{1-1}');
        sjekk('plassholder uten kolon gir info', harKode(ukjent, 'planner.plan-form-ukjent'), true);
        sjekk('og ikke feil', ukjent.sammendrag.feil, 0);
        // Og bare ÉN linje om plan-feltet — to er støy.
        sjekk('ikke to meldinger om samme felt', planFunn(ukjent).length, 1);

        // Kolon i den faste delen: formen er i orden, men verdien kan fortsatt
        // ikke sjekkes.
        const halvt = await medPlan('FFT:{1-1}');
        sjekk('kolon utenfor plassholderen er nok', harKode(halvt, 'planner.plan-uten-plan'), false);
        sjekk('men verdien kan ikke sjekkes', harKode(halvt, 'planner.plassholder'), true);
    }

    // ---------- Teams-kanal ----------
    {
        const res = await d.diagnoser({
            Behandling: [{ Steg: 1, Personer: ['a@b.no'], Varsling: ['teamskanal'], TeamsKanalInnlegg: { Team: 'FFT' } }]
        }, { antallInnehavere: roller(3) });
        sjekk('manglende kanal', harKode(res, 'teamskanal.mangler-kanal'), true);
        sjekk('team er satt, så ingen feil der', harKode(res, 'teamskanal.mangler-team'), false);
    }

    // ---------- feltnavnene må være de varslingen faktisk leser ----------
    {
        // Diagnosen leste `steg.Teamskanal`. Editoren skriver
        // `steg.TeamsKanalInnlegg`, og varsling.js leser det samme. Navnet
        // fantes ikke noe sted, så sjekken meldte begge feltene som tomme
        // uansett hva som sto i dem — og testene gikk grønt, fordi TESTDATAENE
        // brukte det oppdiktede navnet.
        //
        // Derfor leses navnene ut av varsling.js her, og sammenlignes med det
        // diagnosen bruker. Glir de fra hverandre igjen, feiler dette.
        const varslingKode = utenKommentarer(fs.readFileSync(
            path.join(__dirname, '..', 'src', 'lib', 'varsling.js'), 'utf8'));
        const diagnoseKode = utenKommentarer(fs.readFileSync(
            path.join(__dirname, '..', 'src', 'lib', 'skjematype-diagnose.js'), 'utf8'));

        for (const [hva, regex] of [
            ['Teams-kanal', /somTeamskanal\(steg\?\.(\w+)\)/],
            ['Planner', /somPlannerOppgave\(steg\?\.(\w+)\)/]
        ]) {
            const m = regex.exec(varslingKode);
            sjekk(`${hva}: fant feltnavnet i varsling.js`, !!m, true);
            if (!m) continue;
            sjekk(`${hva}: diagnosen leser «${m[1]}»`,
                new RegExp(`steg\\?\\.${m[1]}\\b`).test(diagnoseKode), true);
        }

        // Og en oppførselstest, ikke bare en tekstsammenligning: et utfylt
        // felt skal ikke meldes som tomt.
        const fylt = await d.diagnoser({
            Behandling: [{
                Steg: 1, Personer: ['a@b.no'], Varsling: ['teamskanal'],
                TeamsKanalInnlegg: { Team: 'FHS test', Kanal: 'Generelt' }
            }]
        }, { antallInnehavere: roller(3) });
        sjekk('utfylt teams-kanal gir ingen funn', fylt.funn, []);

        const bareTeam = await d.diagnoser({
            Behandling: [{
                Steg: 1, Personer: ['a@b.no'], Varsling: ['teamskanal'],
                TeamsKanalInnlegg: { Team: 'FHS test' }
            }]
        }, { antallInnehavere: roller(3) });
        sjekk('team er utfylt, så bare kanalen meldes',
            bareTeam.funn.map(f => f.kode), ['teamskanal.mangler-kanal']);
    }

    // ---------- tomt felt er ikke en feil ----------
    {
        // Editorens egen hjelpetekst: «Står team eller kanal tomt, bruker
        // flyten sitt eget standardvalg», og «Tomme felter overlates til
        // flyten, som før». Det VIRKER altså — det havner bare et annet sted.
        // En rød linje på noe som fungerer er den formen for feilmelding som
        // gjør at folk slutter å lese lista.
        const tomKanal = await d.diagnoser({
            Behandling: [{ Steg: 1, Personer: ['a@b.no'], Varsling: ['teamskanal'], TeamsKanalInnlegg: {} }]
        }, { antallInnehavere: roller(3) });
        sjekk('tom teams-kanal gir advarsel, ikke feil', tomKanal.sammendrag.feil, 0);
        sjekk('men den sies fra om', tomKanal.sammendrag.advarsel, 2);
        sjekk('og meldingen sier hva som skjer',
            tomKanal.funn[0].melding.includes('standard'), true);

        // Planner er ANNERLEDES enn Teams-kanal, og det er domenekunnskap
        // som ikke står i editorens hjelpetekst: det finnes ingen standardplan
        // å falle tilbake på (bekreftet av oppdragsgiver 22.09.2026). Uten
        // plan blir det ingen oppgave, og da er rødt riktig.
        const tomPlan = await d.diagnoser({
            Behandling: [{ Steg: 1, Personer: ['a@b.no'], Varsling: ['planner'], PlannerOppgave: {} }]
        }, { antallInnehavere: roller(3) });
        sjekk('tom plan er en FEIL', harKode(tomPlan, 'planner.mangler-plan'), true);
        sjekk('og meldes som feil',
            tomPlan.funn.find(f => f.kode === 'planner.mangler-plan').alvor, 'feil');
        sjekk('meldingen sier at det ikke finnes noen standardplan',
            tomPlan.funn[0].melding.includes('ingen standardplan'), true);
        // Uten plan skal bucket-advarselen IKKE komme i tillegg — linja over
        // sier allerede det som må sies, og to linjer om samme felt er støy.
        sjekk('ingen bucket-advarsel uten plan', harKode(tomPlan, 'planner.mangler-bucket'), false);

        // Bucket HAR derimot et standardvalg: oppgaven havner i planens
        // felles bucket. Den er vanskeligere å finne igjen, men den finnes.
        const utenBucket = await d.diagnoser({
            Behandling: [{
                Steg: 1, Personer: ['a@b.no'], Varsling: ['planner'],
                PlannerOppgave: { TeamOgPlan: 'Automatisering:Oppgaver' }
            }]
        }, { antallInnehavere: roller(3) });
        sjekk('manglende bucket gir advarsel', harKode(utenBucket, 'planner.mangler-bucket'), true);
        sjekk('og ingen feil', utenBucket.sammendrag.feil, 0);
        sjekk('meldingen sier hvor den havner',
            utenBucket.funn[0].melding.includes('felles bucket'), true);

        const komplett = await d.diagnoser({
            Behandling: [{
                Steg: 1, Personer: ['a@b.no'], Varsling: ['planner'],
                PlannerOppgave: { TeamOgPlan: 'Automatisering:Oppgaver', Bucket: 'Til godkjenning' }
            }]
        }, { antallInnehavere: roller(3) });
        sjekk('komplett planner gir ingenting', komplett.funn, []);

        // Bucket uten plan er fortsatt en FEIL: en bucket i en plan man ikke
        // har navngitt, finnes ikke i flytens standardplan.
        const bucket = await d.diagnoser({
            Behandling: [{ Steg: 1, Personer: ['a@b.no'], Varsling: ['planner'], PlannerOppgave: { Bucket: 'Nye' } }]
        }, { antallInnehavere: roller(3) });
        sjekk('bucket uten plan er fortsatt feil', harKode(bucket, 'planner.bucket-uten-plan'), true);
        sjekk('og meldes som feil',
            bucket.funn.find(f => f.kode === 'planner.bucket-uten-plan').alvor, 'feil');
    }

    // ---------- SharePoint: de tre delene må stå sammen ----------
    {
        const felterMed = [{ Seksjon_nummer: 1, Felter: [{ Nummer: 1, SPListefelt: 'Tittel' }] }];

        const kunAdresse = await d.diagnoser({ SPListeadresse: 'https://x', Seksjoner: felterMed });
        sjekk('adresse uten listenavn', harKode(kunAdresse, 'sp.mangler-listenavn'), true);
        sjekk('og felt uten liste', harKode(kunAdresse, 'sp.felt-uten-liste'), true);

        const kunNavn = await d.diagnoser({ SPListenavn: 'Saker', Seksjoner: felterMed });
        sjekk('listenavn uten adresse', harKode(kunNavn, 'sp.mangler-adresse'), true);

        const utenFelter = await d.diagnoser({
            SPListeadresse: 'https://x', SPListenavn: 'Saker', Seksjoner: SEKSJONER
        });
        sjekk('liste uten kolonner gir advarsel', harKode(utenFelter, 'sp.liste-uten-felt'), true);
        sjekk('og ikke feil', utenFelter.sammendrag.feil, 0);

        const komplett = await d.diagnoser({
            SPListeadresse: 'https://x', SPListenavn: 'Saker', Seksjoner: felterMed
        });
        sjekk('komplett oppsett gir ingenting', komplett.funn, []);
    }

    // ---------- et steg uten behandlere ----------
    {
        const res = await d.diagnoser({ Behandling: [{ Steg: 1, Stegnavn: 'Tomt' }] });
        sjekk('ingen behandlere', harKode(res, 'steg.ingen-behandlere'), true);
        sjekk('stedet navngir steget', res.funn[0].sted.includes('Tomt'), true);
    }

    // ---------- rekkefølge og form ----------
    {
        const res = await d.diagnoser({
            Seksjoner: SEKSJONER,
            SPListeadresse: 'https://x', SPListenavn: 'Saker',
            Behandling: [{
                Steg: 1, Roller: ['Tom', 'Klassesjef({1-1})'], Varsling: ['epost'],
                PlannerOppgave: { TeamOgPlan: 'P' }
            }]
        }, { antallInnehavere: roller(0) });

        // Feil først. En liste som starter med en advarsel leses ovenfra, og
        // da er det advarselen som får oppmerksomheten.
        const rang = { feil: 0, advarsel: 1, info: 2 };
        const sortert = res.funn.map(f => rang[f.alvor]);
        sjekk('feil står øverst', sortert.slice().sort((a, b) => a - b), sortert);

        // Hvert funn må kunne vises: alle fire feltene, alltid.
        sjekk('alle funn har alle feltene',
            res.funn.every(f => f.alvor && f.kode && f.sted && f.melding), true);
        sjekk('sammendraget stemmer med funnene',
            res.sammendrag.feil + res.sammendrag.advarsel + res.sammendrag.info, res.funn.length);
    }

    // ---------- aktiveKanaler er den samme regelen som i varsling.js ----------
    {
        // Regelen er gjentatt for å slippe å dra inn hele varslingsapparatet.
        // Gjentakelsen er greit; at de to sier ulike ting er det ikke.
        const varsling = require('../src/lib/varsling');
        for (const steg of [
            {}, { Varsling: [] }, { Varsling: ['epost'] }, { Varsling: ['planner', 'teamskanal'] },
            { Varsling: ['tull'] }, { Varsling: ['epost', 'tull', 'planner'] }, { Varsling: null }
        ]) {
            sjekk(`samme kanaler for ${JSON.stringify(steg)}`,
                d.aktiveKanaler(steg), varsling.aktiveKanaler(steg));
        }
    }

    // ---------- endepunktet er koblet på ----------
    {
        const kode = utenKommentarer(fs.readFileSync(
            path.join(__dirname, '..', 'src', 'functions', 'skjematyper.js'), 'utf8'));
        sjekk('ruta finnes', /route: 'skjematyper\/\{id\}\/diagnose'/.test(kode), true);

        // Sjekkene under må gjelde DENNE handleren, ikke fila som helhet.
        // `harEierPåType` kalles fra flere endepunkter, så et søk i hele fila
        // ville bestått selv om tilgangssjekken her var byttet ut med `true`.
        const iRute = kode.indexOf("route: 'skjematyper/{id}/diagnose'");
        const handler = iRute > -1 ? kode.slice(iRute, iRute + 1400) : '';
        sjekk('den kaller regelsettet', /diagnose\.diagnoser\(/.test(handler), true);
        // Eier eller admin — en diagnose forteller hvilke roller som er tomme.
        sjekk('den krever eier eller admin', /harEierPåType\(skjematypeId, upn\)/.test(handler), true);
        sjekk('og slipper ikke gjennom uten sjekk', /const tillatt = true/.test(handler), false);

        const editor = utenKommentarer(fs.readFileSync(
            path.join(__dirname, '..', '..', 'frontend', 'editor.html'), 'utf8'));
        sjekk('editoren kaller den', /\/diagnose`\)/.test(editor), true);
        // ETTER lagring. Diagnosen skal aldri kunne hindre noen i å lagre.
        const iPost = editor.indexOf("api.post('/api/skjematyper'");
        const iDiag = editor.indexOf('kjorDiagnose({ stille: true })');
        sjekk('den kjøres etter lagringen', iPost > -1 && iDiag > iPost, true);
        sjekk('og lagringen venter ikke på den',
            /\n\s*kjorDiagnose\(\{ stille: true \}\);/.test(editor), true);
        sjekk('knappen finnes', /sjekkOppsettet\(\)/.test(editor), true);
    }

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
}

kjor();
