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

    // ---------- fase 2: hvilke referanser sendes ----------
    {
        const def = {
            SPListeadresse: 'https://x.sharepoint.com/sites/y', SPListenavn: 'Saker',
            Seksjoner: [{ Seksjon_nummer: 1, Felter: [
                { Nummer: 1, SPListefelt: 'Tittel' },
                { Nummer: 2, SPListefelt: '{1-1}' }     // plassholder
            ] }],
            Behandling: [
                { Steg: 1, Stegnavn: 'G', Varsling: ['planner', 'teamskanal'],
                  PlannerOppgave: { TeamOgPlan: 'Automatisering:Oppgaver', Bucket: 'Nye' },
                  TeamsKanalInnlegg: { Team: 'FHS test', Kanal: 'Generelt' } },
                { Steg: 2, Varsling: ['planner'], PlannerOppgave: { TeamOgPlan: 'FFT:{1-1}' } }
            ]
        };
        const refs = d.eksterneReferanser(def);
        const ider = refs.map(r => r.Id);

        sjekk('plan, bucket, team, kanal, liste og kolonne',
            ider, ['steg1.plan', 'steg1.bucket', 'steg1.team', 'steg1.kanal', 'sp.liste', 'sp.kolonne.1-1']);

        // Verdier med plassholder skal ALDRI sendes — de har ikke fått
        // innhold ennå, og et oppslag på «FFT:{1-1}» ville svart finnes-ikke
        // på noe som er helt riktig.
        sjekk('plassholder i plan sendes ikke', ider.includes('steg2.plan'), false);
        sjekk('plassholder i kolonne sendes ikke', ider.includes('sp.kolonne.1-2'), false);

        // Kontekst må følge med: en plan hører til et team, en kanal til et
        // team, en kolonne til en liste. Uten det kan flyten ikke slå opp.
        const plan = refs.find(r => r.Id === 'steg1.plan');
        sjekk('planen bærer teamet', [plan.Team, plan.Plan], ['Automatisering', 'Oppgaver']);
        sjekk('bucketen bærer planen', refs.find(r => r.Id === 'steg1.bucket').Plan, 'Oppgaver');
        sjekk('kanalen bærer teamet', refs.find(r => r.Id === 'steg1.kanal').Team, 'FHS test');
        sjekk('kolonnen bærer lista', refs.find(r => r.Id === 'sp.kolonne.1-1').Liste, 'Saker');
        sjekk('alle har et sted', refs.every(r => r.Sted), true);

        // «Team og plan» deles på FØRSTE kolon — et plannavn kan inneholde et.
        sjekk('deles på første kolon',
            d.delTeamOgPlan('FFT:Saker: 2026'), { team: 'FFT', plan: 'Saker: 2026' });

        // Ingen eksterne referanser = ingen grunn til å kalle flyten.
        sjekk('ren skjematype gir ingen referanser',
            d.eksterneReferanser({ Behandling: [{ Steg: 1, Varsling: ['epost'] }] }), []);
    }

    // ---------- fase 2: flytens svar flettes inn ----------
    {
        const refs = [
            { Id: 'a', Type: 'team', Team: 'FHS test', Sted: 'Steg 1 · Teams-kanal' },
            { Id: 'b', Type: 'plan', Team: 'A', Plan: 'B', Sted: 'Steg 1 · Planner' },
            { Id: 'c', Type: 'sp-liste', Liste: 'Saker', Sted: 'SharePoint-liste' },
            { Id: 'e', Type: 'bucket', Bucket: 'Nye', Plan: 'B', Sted: 'Steg 1 · Planner' }
        ];
        const funn = d.flettFlytsvar(refs, { Referanser: [
            { Id: 'a', Status: 'finnes' },
            { Id: 'b', Status: 'finnes-ikke', Melding: 'Fant ingen plan med det navnet.' },
            { Id: 'c', Status: 'ingen-tilgang' },
            { Id: 'e', Status: 'kan-ikke-sjekkes' }
        ] });
        const per = (kode) => funn.filter(f => f.kode === kode);

        sjekk('finnes gir ingenting', funn.some(f => f.melding.includes('FHS test')), false);
        sjekk('finnes-ikke er en feil', per('flyt.finnes-ikke')[0].alvor, 'feil');
        sjekk('og navngir referansen', per('flyt.finnes-ikke')[0].melding.includes('«B»'), true);
        sjekk('flytens egen melding tas med',
            per('flyt.finnes-ikke')[0].melding.includes('Fant ingen plan'), true);

        // ingen-tilgang er IKKE en feil. Flyten kjører som sin egen
        // tilkobling, og at den ikke ser noe betyr ikke at det ikke finnes.
        // Slås de sammen, jager skjemaeier et navn som er helt riktig.
        sjekk('ingen-tilgang er en advarsel', per('flyt.ingen-tilgang')[0].alvor, 'advarsel');
        sjekk('og sier at navnet kan være riktig',
            per('flyt.ingen-tilgang')[0].melding.includes('kan være riktig'), true);

        sjekk('kan-ikke-sjekkes er info', per('flyt.kan-ikke-sjekkes')[0].alvor, 'info');
    }

    // ---------- fase 2: én årsak gir én linje ----------
    {
        // Referansene henger sammen: en kolonne ligger i en liste, en kanal i
        // et team, en bucket i en plan. Et feilstavet listenavn på et skjema
        // med tjue mappede kolonner ville ellers gitt tjueén røde linjer for
        // én skrivefeil — nøyaktig det «fyller skjermen»-problemet.
        const refs = [
            { Id: 'sp.liste', Type: 'sp-liste', Liste: 'Saker', Sted: 'SP' },
            { Id: 'sp.kolonne.1-1', Type: 'sp-kolonne', Liste: 'Saker', Kolonne: 'A', Avhenger: 'sp.liste', Sted: 'SP·1-1' },
            { Id: 'sp.kolonne.1-2', Type: 'sp-kolonne', Liste: 'Saker', Kolonne: 'B', Avhenger: 'sp.liste', Sted: 'SP·1-2' },
            { Id: 'steg1.team', Type: 'team', Team: 'T', Sted: 'Steg1' },
            { Id: 'steg1.kanal', Type: 'kanal', Team: 'T', Kanal: 'K', Avhenger: 'steg1.team', Sted: 'Steg1' }
        ];

        const listaBorte = d.flettFlytsvar(refs, { Referanser: [
            { Id: 'sp.liste', Status: 'finnes-ikke' },
            { Id: 'sp.kolonne.1-1', Status: 'finnes-ikke' },
            { Id: 'sp.kolonne.1-2', Status: 'finnes-ikke' },
            { Id: 'steg1.team', Status: 'finnes' },
            { Id: 'steg1.kanal', Status: 'finnes' }
        ] });
        sjekk('én linje for lista, ikke tre', listaBorte.length, 1);
        sjekk('og den sier hvor mange som ikke ble sjekket',
            listaBorte[0].melding.includes('De 2 underliggende'), true);

        // Entall skal hete entall.
        const enKolonne = d.flettFlytsvar(refs.slice(0, 2), { Referanser: [
            { Id: 'sp.liste', Status: 'finnes-ikke' },
            { Id: 'sp.kolonne.1-1', Status: 'finnes-ikke' }
        ] });
        sjekk('entall', enKolonne[0].melding.includes('Den underliggende referansen'), true);

        // Finnes forelderen, skal barnet meldes helt vanlig.
        const teamFinnes = d.flettFlytsvar(refs, { Referanser: [
            { Id: 'sp.liste', Status: 'finnes' },
            { Id: 'sp.kolonne.1-1', Status: 'finnes' },
            { Id: 'sp.kolonne.1-2', Status: 'finnes-ikke' },
            { Id: 'steg1.team', Status: 'finnes' },
            { Id: 'steg1.kanal', Status: 'finnes-ikke' }
        ] });
        sjekk('barn under en forelder som finnes, meldes',
            teamFinnes.map(f => f.kode), ['flyt.finnes-ikke', 'flyt.finnes-ikke']);

        // Også ingen-tilgang undertrykker: ser ikke flyten lista, ser den
        // ikke kolonnene heller.
        const utenTilgang = d.flettFlytsvar(refs.slice(0, 3), { Referanser: [
            { Id: 'sp.liste', Status: 'ingen-tilgang' },
            { Id: 'sp.kolonne.1-1', Status: 'finnes-ikke' },
            { Id: 'sp.kolonne.1-2', Status: 'finnes-ikke' }
        ] });
        sjekk('ingen-tilgang undertrykker også', utenTilgang.length, 1);
        sjekk('og forblir en advarsel', utenTilgang[0].alvor, 'advarsel');

        // Men et UBESVART foreldre undertrykker IKKE — da vet vi ingenting
        // om årsaken, og barnas egne svar kan fortsatt være verdt å lese.
        const forelderTaus = d.flettFlytsvar(refs.slice(0, 3), { Referanser: [
            { Id: 'sp.kolonne.1-1', Status: 'finnes-ikke' },
            { Id: 'sp.kolonne.1-2', Status: 'finnes-ikke' }
        ] });
        sjekk('ubesvart forelder undertrykker ikke', forelderTaus.length, 3);
    }

    // ---------- fase 2: avhengigheten settes ved uttrekk ----------
    {
        const refs = d.eksterneReferanser({
            SPListeadresse: 'https://x', SPListenavn: 'Saker',
            Seksjoner: [{ Seksjon_nummer: 1, Felter: [{ Nummer: 1, SPListefelt: 'Tittel' }] }],
            Behandling: [{
                Steg: 1, Varsling: ['planner', 'teamskanal'],
                PlannerOppgave: { TeamOgPlan: 'A:B', Bucket: 'C' },
                TeamsKanalInnlegg: { Team: 'T', Kanal: 'K' }
            }]
        });
        const av = Object.fromEntries(refs.map(r => [r.Id, r.Avhenger || null]));
        sjekk('bucket avhenger av planen', av['steg1.bucket'], 'steg1.plan');
        sjekk('kanal avhenger av teamet', av['steg1.kanal'], 'steg1.team');
        sjekk('kolonne avhenger av lista', av['sp.kolonne.1-1'], 'sp.liste');
        // Og foreldrene selv avhenger ikke av noe.
        sjekk('planen er sin egen rot', av['steg1.plan'], null);
        sjekk('teamet er sin egen rot', av['steg1.team'], null);
        sjekk('lista er sin egen rot', av['sp.liste'], null);
        // Hver Avhenger må peke på en referanse som faktisk sendes.
        const ider = new Set(refs.map(r => r.Id));
        sjekk('alle avhengigheter peker på noe som sendes',
            refs.filter(r => r.Avhenger && !ider.has(r.Avhenger)), []);
    }

    // ---------- fase 2: et halvferdig endepunkt skal ikke fylle skjermen ----------
    {
        const refs = [
            { Id: 'a', Type: 'team', Team: 'X', Sted: 'S' },
            { Id: 'b', Type: 'team', Team: 'Y', Sted: 'S' },
            { Id: 'c', Type: 'team', Team: 'Z', Sted: 'S' }
        ];
        // Første versjon av flyten svarer 200 uten innhold. Da skal det bli
        // ÉN linje, ikke én per referanse.
        for (const svar of [{}, null, { Referanser: [] }, { noe: 'annet' }]) {
            const funn = d.flettFlytsvar(refs, svar);
            sjekk(`tomt svar (${JSON.stringify(svar)}) gir én linje`, funn.length, 1);
            sjekk('og den er info', funn[0].alvor, 'info');
            sjekk('og nevner antallet', funn[0].melding.includes('3'), true);
        }

        // Svarer flyten om NOEN av dem, skal de som mangler nevnes hver for
        // seg — da vet vi at endepunktet virker, og at akkurat disse falt ut.
        const delvis = d.flettFlytsvar(refs, { Referanser: [{ Id: 'a', Status: 'finnes' }] });
        sjekk('delvis svar nevner dem som mangler', delvis.length, 2);
        sjekk('som info', delvis.every(f => f.alvor === 'info'), true);

        // En ukjent status er ikke noe å bygge en feilmelding på.
        const rar = d.flettFlytsvar([refs[0]], { Referanser: [{ Id: 'a', Status: 'kanskje' }] });
        sjekk('ukjent status gir info', rar[0].alvor, 'info');
        sjekk('ingen tomme referanser gir ingen linjer', d.flettFlytsvar([], {}), []);
    }

    // ---------- endepunktet er koblet på ----------
    {
        const kode = utenKommentarer(fs.readFileSync(
            path.join(__dirname, '..', 'src', 'functions', 'skjematyper.js'), 'utf8'));
        sjekk('ruta finnes', /route: 'skjematyper\/\{id\}\/diagnose'/.test(kode), true);

        // Sjekkene under må gjelde DENNE handleren, ikke fila som helhet.
        // `harEierPåType` kalles fra flere endepunkter, så et søk i hele fila
        // ville bestått selv om tilgangssjekken her var byttet ut med `true`.
        // Avgrenses til NESTE app.http, ikke til et fast antall tegn. Et fast
        // tall gikk tom da handleren vokste, og sjekkene under begynte å lete
        // i tomme strenger — altså bestå på ingenting.
        const iRute = kode.indexOf("route: 'skjematyper/{id}/diagnose'");
        const iNeste = iRute > -1 ? kode.indexOf('app.http(', iRute) : -1;
        const handler = iRute > -1 ? kode.slice(iRute, iNeste > -1 ? iNeste : undefined) : '';
        sjekk('fant handleren, og den er ikke tom', handler.length > 200, true);
        sjekk('den kaller regelsettet', /diagnose\.diagnoser\(/.test(handler), true);
        // Eier eller admin — en diagnose forteller hvilke roller som er tomme.
        sjekk('den krever eier eller admin', /harEierPåType\(skjematypeId, upn\)/.test(handler), true);
        sjekk('og slipper ikke gjennom uten sjekk', /const tillatt = true/.test(handler), false);

        // Fase 2 må være koblet på — og i riktig rekkefølge.
        sjekk('endepunktet henter referansene', /eksterneReferanser\(def\)/.test(handler), true);
        sjekk('og kaller flyten', /kallDiagnoseFlyt\(/.test(handler), true);
        sjekk('med handlingen', /Handling: 'sjekkReferanser'/.test(handler), true);
        // Ingen referanser = ingen kall. Poenget med regelsettet er nettopp
        // at det avgjør om det er noe å spørre om.
        sjekk('bare når det er noe å spørre om',
            /referanser\.length > 0/.test(handler), true);
        // Et feilet eller avbrutt kall er ikke en feil ved SKJEMATYPEN.
        sjekk('tidsavbrudd meldes som info',
            /tidsavbrudd[\s\S]{0,300}alvor: 'info'/.test(handler), true);
        // Sammendraget må regnes om etter at flytens funn er lagt til.
        const iPush = handler.indexOf('flettFlytsvar(');
        const iSammendrag = handler.indexOf('res.sammendrag =');
        sjekk('sammendraget regnes om etterpå', iPush > -1 && iSammendrag > iPush, true);

        const flyt = utenKommentarer(fs.readFileSync(
            path.join(__dirname, '..', 'src', 'lib', 'flyt-kaller.js'), 'utf8'));
        sjekk('flyt-kalleren har tidsavbrudd', /AbortController/.test(flyt), true);
        sjekk('og en egen env-variabel', /DIAGNOSE_FLOW_URL/.test(flyt), true);
        // Uten URL skal det ikke skje noe — og uten referanser heller ikke.
        sjekk('hopper over uten URL',
            /DIAGNOSE_FLOW_URL[\s\S]{0,200}status: 'hoppet-over'/.test(flyt), true);

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
