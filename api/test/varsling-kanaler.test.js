/**
 * Tester for kanaloppsettet per behandlingssteg (TODO 44).
 *
 * To ting må holde. For det første at eksisterende skjematyper oppfører seg
 * NØYAKTIG som før: uten oppsett skal alle kanaler arve e-postmalen, slik de
 * gjorde da de bare var av/på. For det andre at fristen aldri gjettes — en
 * Planner-oppgave med feil forfallsdato er verre enn en uten.
 *
 * Kjøres med:  node api/test/varsling-kanaler.test.js
 */
const v = require('../src/lib/varsling');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const KONTEKST = {
    skjemanavn: 'Reiseregning',
    skjemaId: 'REI-42',
    stegnavn: 'Godkjenning',
    innsender: 'kari@fhs.no',
    innsenderNavn: 'Kari',
    tidspunkt: '01.09.2026, 09:00',
    seksjoner: [],
    lenke: 'https://swa/evaluering.html?skjema_id=REI-42'
};
const BASIS = {
    emne: 'Skjema til behandling: "Reiseregning"',
    html: '<p>Du har fått et skjema.</p>',
    lenke: KONTEKST.lenke,
    skjema: { Seksjoner: [] },
    behandlere: [{ epost: 'ola@fhs.no', navn: 'Ola' }],
    log: () => {}
};

async function kjor() {
    // ---------- normalisering ----------
    {
        const p = v.somPlannerOppgave(null);
        sjekk('tomt Planner-oppsett får standardstatus', p.Status, 'Ikke startet');
        sjekk('og standardprioritet', p.Prioritet, 'Medium');
        sjekk('ugyldig status faller til standard',
            v.somPlannerOppgave({ Status: 'Tullestatus' }).Status, 'Ikke startet');
        sjekk('ugyldig prioritet faller til standard',
            v.somPlannerOppgave({ Prioritet: 'Kjempeviktig' }).Prioritet, 'Medium');
        sjekk('gyldig status beholdes',
            v.somPlannerOppgave({ Status: 'Pågår' }).Status, 'Pågår');
        sjekk('tomt teamskanal-oppsett gir tomme strenger',
            v.somTeamskanal(undefined), { Team: '', Kanal: '', Tittel: '', Innhold: '' });
    }

    // ---------- frist ----------
    {
        const na = new Date('2026-09-01T10:00:00.000Z');
        sjekk('{idag}', v.løsForfallsdato('{idag}', na), '2026-09-01');
        sjekk('{idag+7}', v.løsForfallsdato('{idag+7}', na), '2026-09-08');
        sjekk('{idag + 14} med mellomrom', v.løsForfallsdato('{idag + 14}', na), '2026-09-15');
        sjekk('{IDAG} uansett skrivemåte', v.løsForfallsdato('{IDAG}', na), '2026-09-01');
        sjekk('månedsskifte håndteres', v.løsForfallsdato('{idag+30}', na), '2026-10-01');
        sjekk('fast dato beholdes', v.løsForfallsdato('2026-12-24', na), '2026-12-24');
        sjekk('tom verdi gir tom', v.løsForfallsdato('', na), '');

        // Her ligger fella: V8 tolker begge disse velvillig og gir en dato
        // langt unna det noen mente. Da er ingen frist det riktige svaret.
        sjekk('«1. september» avvises', v.løsForfallsdato('1. september', na), '');
        sjekk('«om en uke» avvises', v.løsForfallsdato('om en uke', na), '');
        sjekk('31. februar avvises', v.løsForfallsdato('2026-02-31', na), '');
        sjekk('24.12.2026 avvises', v.løsForfallsdato('24.12.2026', na), '');
    }

    // ---------- sjekkliste ----------
    {
        sjekk('én linje per punkt',
            v.byggSjekkliste('Les skjemaet\nSjekk vedlegg\nBeslutt', KONTEKST),
            ['Les skjemaet', 'Sjekk vedlegg', 'Beslutt']);
        sjekk('bindestreker og tomme linjer ryddes',
            v.byggSjekkliste('- Ett\n\n  * To  \n', KONTEKST), ['Ett', 'To']);
        sjekk('plassholdere løses',
            v.byggSjekkliste('Godkjenn $skjemanavn', KONTEKST), ['Godkjenn Reiseregning']);
        sjekk('tom sjekkliste gir tom liste', v.byggSjekkliste('', KONTEKST), []);
        sjekk('maks 20 punkter',
            v.byggSjekkliste(Array.from({ length: 30 }, (_, i) => `P${i}`).join('\n'), KONTEKST).length, 20);
    }

    // ---------- Planner uten oppsett: som før ----------
    {
        const p = await v.byggPlanner({}, KONTEKST, BASIS);
        sjekk('tittel arver e-postemnet', p.tittel, BASIS.emne);
        sjekk('notatet blir lenka, som før', p.notat, `Åpne skjemaet: ${BASIS.lenke}`);
        sjekk('ingen frist når ingen er satt', p.forfallsdato, '');
        sjekk('ingen plan når ingen er satt', p.plan, '');
        sjekk('ansvarlig er stegets behandlere',
            p.ansvarlige, [{ epost: 'ola@fhs.no', navn: 'Ola' }]);
    }

    // ---------- Planner med oppsett ----------
    {
        const steg = {
            PlannerOppgave: {
                Tittel: 'Godkjenn $skjemanavn ($skjema_id)',
                TeamOgPlan: 'Automatisering:Oppgaver',
                Bucket: 'Til godkjenning',
                Status: 'Pågår',
                Prioritet: 'Viktig',
                Forfallsdato: '{idag+3}',
                Sjekkliste: 'Les\nBeslutt',
                Notater: 'Gjelder steg $stegnavn'
            }
        };
        const p = await v.byggPlanner(steg, KONTEKST, BASIS);
        sjekk('tittelen bruker oppsettet med plassholdere løst',
            p.tittel, 'Godkjenn Reiseregning (REI-42)');
        sjekk('planen følger med', p.plan, 'Automatisering:Oppgaver');
        sjekk('bucket følger med', p.bucket, 'Til godkjenning');
        sjekk('status og prioritet følger med', [p.status, p.prioritet], ['Pågår', 'Viktig']);
        sjekk('fristen er regnet ut', typeof p.forfallsdato === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.forfallsdato), true);
        sjekk('sjekklista er en liste', p.sjekkliste, ['Les', 'Beslutt']);
        sjekk('notatet overstyrer lenka', p.notat, 'Gjelder steg Godkjenning');
    }

    // ---------- ansvarlig rolle ----------
    {
        // Rollen løses her, ikke i flyten: PA skal ikke trenge å kunne
        // rollemodellen vår for å tilordne en oppgave.
        const steg = { PlannerOppgave: { AnsvarligRolle: 'Godkjenner(ØKONOMI)' } };

        let p = await v.byggPlanner(steg, KONTEKST, {
            ...BASIS, rolleOppslag: async () => [{ epost: 'sjef@fhs.no', navn: 'Sjefen' }]
        });
        sjekk('rollen løses til konkrete personer',
            p.ansvarlige, [{ epost: 'sjef@fhs.no', navn: 'Sjefen' }]);
        sjekk('og erstatter behandlerne', p.ansvarlige.length, 1);

        // En rolle uten innehavere skal ikke gi en eierløs oppgave.
        const advarsler = [];
        p = await v.byggPlanner(steg, KONTEKST, {
            ...BASIS, rolleOppslag: async () => [], log: (m) => advarsler.push(m)
        });
        sjekk('tom rolle faller tilbake til behandlerne',
            p.ansvarlige, [{ epost: 'ola@fhs.no', navn: 'Ola' }]);
        sjekk('og det logges', /ingen innehavere/.test(advarsler.join(' ')), true);

        // Rollestrengen skal gå videre uendret — dynamiske roller løses lenger inne.
        let sett = null;
        await v.byggPlanner(steg, KONTEKST, {
            ...BASIS, rolleOppslag: async (o) => { sett = o; return []; }
        });
        sjekk('rollen sendes som oppslag', sett, { Roller: ['Godkjenner(ØKONOMI)'] });
    }

    // ---------- Teams-kanal ----------
    {
        sjekk('uten oppsett arves e-postmalen',
            v.byggTeamskanal({}, KONTEKST, BASIS),
            { team: '', kanal: '', tittel: BASIS.emne, innhold: BASIS.html });

        const steg = { TeamsKanalInnlegg: { Team: 'FHS Behandling', Kanal: 'Generelt', Tittel: 'Nytt: $skjemanavn', Innhold: '<p>$stegnavn</p>' } };
        sjekk('med oppsett brukes det',
            v.byggTeamskanal(steg, KONTEKST, BASIS),
            { team: 'FHS Behandling', kanal: 'Generelt', tittel: 'Nytt: Reiseregning', innhold: '<p>Godkjenning</p>' });
    }

    // ---------- Teams-melding ----------
    {
        sjekk('uten oppsett arves e-postmalen',
            v.byggTeamsMelding({}, KONTEKST, BASIS),
            { tittel: BASIS.emne, innhold: BASIS.html });
        sjekk('delvis oppsett arver resten',
            v.byggTeamsMelding({ TeamsMelding: { Tittel: 'Kort: $skjemanavn' } }, KONTEKST, BASIS),
            { tittel: 'Kort: Reiseregning', innhold: BASIS.html });
    }

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
}

kjor().catch(e => { console.error('Testen krasjet:', e); process.exit(1); });
