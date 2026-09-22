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
                Teamskanal: { Team: 'FFT', Kanal: '$stegnavn' }
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

        sjekk('riktig form gir ingenting', (await medPlan('Automatisering:Oppgaver')).funn, []);

        // En plassholder kan løse seg til «Team:Plan». Da vet vi ikke nok til
        // å melde feil — men vi skal si at det ikke kan sjekkes.
        const ukjent = await medPlan('{1-1}');
        sjekk('plassholder uten kolon gir info', harKode(ukjent, 'planner.plan-form-ukjent'), true);
        sjekk('og ikke feil', ukjent.sammendrag.feil, 0);
        // Og bare ÉN linje om samme felt — to er støy.
        sjekk('ikke to meldinger om samme felt', ukjent.funn.length, 1);

        // Kolon i den faste delen: formen er i orden, men verdien kan fortsatt
        // ikke sjekkes.
        const halvt = await medPlan('FFT:{1-1}');
        sjekk('kolon utenfor plassholderen er nok', harKode(halvt, 'planner.plan-uten-plan'), false);
        sjekk('men verdien kan ikke sjekkes', harKode(halvt, 'planner.plassholder'), true);
    }

    // ---------- Teams-kanal ----------
    {
        const res = await d.diagnoser({
            Behandling: [{ Steg: 1, Personer: ['a@b.no'], Varsling: ['teamskanal'], Teamskanal: { Team: 'FFT' } }]
        }, { antallInnehavere: roller(3) });
        sjekk('manglende kanal', harKode(res, 'teamskanal.mangler-kanal'), true);
        sjekk('team er satt, så ingen feil der', harKode(res, 'teamskanal.mangler-team'), false);
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
