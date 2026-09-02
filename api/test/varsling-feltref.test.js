/**
 * Tester at Teams-, Planner- og kanaloppsettene løser feltreferanser.
 *
 * Editoren tilbyr nå de samme feltreferansene i disse kanalene som i
 * e-postmalene. Backend støttet det allerede — alle tre går gjennom
 * `erstattPlassholdere` med samme kontekst — men den koblingen er lett å
 * miste ved en senere omskriving, og da ville referansene gått ut som rå
 * tekst i en Teams-melding uten at noe feilet.
 *
 * En `{1-02}` som står uendret i en oppgavetittel er verre enn en tom
 * tittel: den ser ut som en skrivefeil brukeren har gjort selv.
 *
 * Kjøres med:  node api/test/varsling-feltref.test.js
 */
const v = require('../src/lib/varsling');
const { byggKontekst } = require('../src/lib/placeholder');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const FELT_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

const skjema = {
    Skjema_id: '42',
    Skjema_navn: 'Reisesøknad',
    Innsender_Epost: 'kari@fhs.no',
    Seksjoner: [{
        Seksjon_nummer: 1,
        Felter: [
            { Id: FELT_ID, Nummer: '01', Type: 'Tekst', Svar: ['Oslo'] },
            { Nummer: '02', Type: 'Tekst', Svar: ['15. september'] }
        ]
    }]
};
const skjematype = { Skjema_navn: 'Reisesøknad' };
const kontekst = byggKontekst({ skjema, skjematype, lenke: 'https://eksempel.net/x' });

// ---------- Teams-melding ----------
{
    const steg = { TeamsMelding: { Tittel: 'Reise til {1-01}', Innhold: 'Dato: {1-02} — $skjemanavn' } };
    const ut = v.byggTeamsMelding(steg, kontekst, { emne: 'fallback', html: 'fallback' });
    sjekk('tittel med feltreferanse', ut.tittel, 'Reise til Oslo');
    sjekk('innhold med referanse og plassholder', ut.innhold, 'Dato: 15. september — Reisesøknad');
}

// ---------- Teams-kanal ----------
{
    const steg = { TeamsKanalInnlegg: { Team: 'FHS', Kanal: 'Generelt', Tittel: 'Ny reise: {1-01}', Innhold: '{1-02}' } };
    const ut = v.byggTeamskanal(steg, kontekst, { emne: 'fallback', html: 'fallback' });
    sjekk('kanaltittel', ut.tittel, 'Ny reise: Oslo');
    sjekk('kanalinnhold', ut.innhold, '15. september');
}

// ---------- Planner ----------
async function planner() {
    const steg = {
        PlannerOppgave: {
            Tittel: 'Godkjenn reise til {1-01}',
            Bucket: 'Til {1-01}',
            Sjekkliste: 'Sjekk dato {1-02}\nKontroller vedlegg',
            Notater: 'Reisemål: {1-01}'
        }
    };
    const ut = await v.byggPlanner(steg, kontekst, {
        emne: 'fallback', lenke: 'https://eksempel.net/x', skjema, behandlere: [], log: () => { },
        rolleOppslag: async () => []
    });
    sjekk('oppgavetittel', ut.tittel, 'Godkjenn reise til Oslo');
    sjekk('bucket', ut.bucket, 'Til Oslo');
    sjekk('sjekklistepunkt', ut.sjekkliste[0], 'Sjekk dato 15. september');
    sjekk('notat', ut.notat, 'Reisemål: Oslo');

    // ---------- referanse via felt-Id ----------
    {
        // Editoren foretrekker UUID når feltet har en — den overlever
        // omnummerering, i motsetning til «1-01».
        const medId = { TeamsMelding: { Tittel: `Sted: {${FELT_ID}}`, Innhold: 'x' } };
        const ut2 = v.byggTeamsMelding(medId, kontekst, { emne: '', html: '' });
        sjekk('referanse via felt-Id', ut2.tittel, 'Sted: Oslo');
    }

    // ---------- ubesvart felt gir tom streng ----------
    {
        const tomt = { TeamsMelding: { Tittel: 'Sted: {1-09}', Innhold: 'x' } };
        const ut3 = v.byggTeamsMelding(tomt, kontekst, { emne: '', html: '' });
        sjekk('ukjent felt blir tomt', ut3.tittel, 'Sted: ');
    }

    // ---------- uten eget oppsett brukes e-postmalen ----------
    {
        const ut4 = v.byggTeamsMelding({}, kontekst, { emne: 'E-postemne', html: '<p>E-post</p>' });
        sjekk('faller tilbake til e-postmalen', [ut4.tittel, ut4.innhold], ['E-postemne', '<p>E-post</p>']);
    }

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
}

planner().catch(e => { console.error('Testen krasjet:', e); process.exit(1); });
