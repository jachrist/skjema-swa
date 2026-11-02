/**
 * Omdøping av roller — reglene i lib/rolle-omdoping.js.
 *
 * Det farlige er det samme som ved sletting: å treffe for bredt. En
 * omdøping som tar med naboomfang, fritekst i en e-postmal eller en rolle med
 * likt prefiks, endrer noe ingen ba om — og den viser seg først når noen
 * mister tilgang. Derfor tester vi mest på hva som IKKE skal endres.
 *
 * Skjematypen under har de ekte formene: `Publikum`/`Eiere` som
 * `{ Personer, Roller, Team }`, `Behandling[]` med `Roller` og
 * `PlannerOppgave.AnsvarligRolle`, mottakeroppsettene, og et felt med
 * `FasteData`.
 *
 * Kjøres med:  node api/test/rolle-omdoping.test.js
 */
const fs = require('fs');
const path = require('path');
const o = require('../src/lib/rolle-omdoping');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const NAVN = { type: 'navn', fra: 'Emneansvarleg', til: 'Emneansvarlig' };
const OMFANG = { type: 'omfang', rolle: 'Emneansvarlig', fra: 'ING2308', til: 'ING2309' };

// ---------- 1. én rollestreng ----------
{
    const r = (s, op) => o.omskrivRolleStreng(s, op);
    sjekk('navn: uten omfang', r('Emneansvarleg', NAVN), 'Emneansvarlig');
    sjekk('navn: med omfang', r('Emneansvarleg(ING2308)', NAVN), 'Emneansvarlig(ING2308)');
    sjekk('navn: dynamisk omfang følger med', r('Emneansvarleg({2-01})', NAVN), 'Emneansvarlig({2-01})');
    sjekk('navn: annen rolle røres ikke', r('Sjef(ING2308)', NAVN), 'Sjef(ING2308)');
    sjekk('navn: likt prefiks røres ikke', r('EmneansvarlegVara(X)', NAVN), 'EmneansvarlegVara(X)');

    sjekk('omfang: eksakt treff', r('Emneansvarlig(ING2308)', OMFANG), 'Emneansvarlig(ING2309)');
    sjekk('omfang: annet omfang røres ikke', r('Emneansvarlig(ING2310)', OMFANG), 'Emneansvarlig(ING2310)');
    sjekk('omfang: «alle omfang» røres ikke', r('Emneansvarlig', OMFANG), 'Emneansvarlig');
    sjekk('omfang: dynamisk røres ikke', r('Emneansvarlig({2-01})', OMFANG), 'Emneansvarlig({2-01})');
    sjekk('omfang: samme omfang, annen rolle røres ikke', r('Sjef(ING2308)', OMFANG), 'Sjef(ING2308)');
    // FS-nøkler inneholder selv |. Et omfang som begynner likt er et annet omfang.
    const FS = { type: 'omfang', rolle: 'Klassesjef', fra: 'FHSBA', til: 'FHSBB' };
    sjekk('omfang: lengre FS-nøkkel med likt prefiks røres ikke',
        r('Klassesjef(FHSBA|22H|A)', FS), 'Klassesjef(FHSBA|22H|A)');

    sjekk('navn-felt: navneoperasjon', o.omskrivRolleNavn('Emneansvarleg', NAVN), 'Emneansvarlig');
    sjekk('navn-felt: omfangsoperasjon rører ikke navn', o.omskrivRolleNavn('Emneansvarlig', OMFANG), 'Emneansvarlig');
    // Et rollenavn kan være likt et omfang: rollen «Cyber» og omfanget «Cyber»
    // (Sjef(Cyber)). Å gi omfanget nytt navn skal ikke gi ROLLEN nytt navn.
    const CYBER = { type: 'omfang', rolle: 'Sjef', fra: 'Cyber', til: 'Cyberforsvar' };
    sjekk('navn-felt: rollenavn likt gammelt omfang står', o.omskrivRolleNavn('Cyber', CYBER), 'Cyber');
    sjekk('navn-felt: også i treet',
        o.omskrivTre({ EierRolle: 'Cyber', Roller: ['Sjef(Cyber)'] }, CYBER).tre,
        { EierRolle: 'Cyber', Roller: ['Sjef(Cyberforsvar)'] });
}

// ---------- 2. hele skjematypen ----------
const SKJEMATYPE = {
    Skjematype_id: '12',
    Skjema_navn: 'Søknad om utsatt eksamen',
    Skjema_forklaring: { Verdi: 'Sendes til Emneansvarleg(ING2308) for vurdering.', Format: 'Ren tekst' },
    Publikum: { Personer: [], Roller: ['Student(ING2308)'], Team: [] },
    Eiere: { Personer: ['eier@mil.no'], Roller: ['Emneansvarleg(ING2308)', 'Sjef'], Team: [] },
    Behandling: [
        {
            Steg: 1, Stegnavn: 'Emneansvarleg vurderer',
            Personer: [], Roller: ['Emneansvarleg(ING2308)', 'Emneansvarleg({2-01})'], Team: [],
            PlannerOppgave: { AnsvarligRolle: 'Emneansvarleg(ING2308)' },
            Epost: { Emne: 'Til Emneansvarleg', Tekst: '<p>Hei Emneansvarleg</p>' }
        },
        { Steg: 2, Roller: ['Sjef'] }
    ],
    Ferdigvarsling: { Mottakere: { Personer: [], Roller: ['Emneansvarleg'] } },
    Innsenderkvittering: { Kopi: { Personer: [], Roller: ['Emneansvarleg(ING2308)'] } },
    Seksjoner: [{
        Seksjon_nummer: 1,
        Felter: [{
            Nummer: 1, Type: 'Flervalg-dropdown', Tekst: 'Velg Emneansvarleg',
            FasteData: {
                Datakilde: 'Personer',
                EllerAv: [{ OgAv: [{ Kolonne: 'Rolle', Operator: '=', Verdi: 'Emneansvarleg(ING2308)' }] }]
            }
        }]
    }]
};

{
    const foer = JSON.stringify(SKJEMATYPE);
    const { tre, endringer } = o.omskrivTre(SKJEMATYPE, NAVN);
    sjekk('originalen røres ikke', JSON.stringify(SKJEMATYPE), foer);

    sjekk('eiere', tre.Eiere.Roller, ['Emneansvarlig(ING2308)', 'Sjef']);
    sjekk('behandlingssteg', tre.Behandling[0].Roller, ['Emneansvarlig(ING2308)', 'Emneansvarlig({2-01})']);
    sjekk('Planner-ansvarlig', tre.Behandling[0].PlannerOppgave.AnsvarligRolle, 'Emneansvarlig(ING2308)');
    sjekk('ferdigvarsling', tre.Ferdigvarsling.Mottakere.Roller, ['Emneansvarlig']);
    sjekk('kvitteringskopi', tre.Innsenderkvittering.Kopi.Roller, ['Emneansvarlig(ING2308)']);
    sjekk('FasteData-filter', tre.Seksjoner[0].Felter[0].FasteData.EllerAv[0].OgAv[0].Verdi, 'Emneansvarlig(ING2308)');

    // Fritekst skal stå: en e-postmal som nevner rollen, er tekst, ikke oppsett.
    sjekk('fritekst i forklaring står', tre.Skjema_forklaring.Verdi, SKJEMATYPE.Skjema_forklaring.Verdi);
    sjekk('stegnavn står', tre.Behandling[0].Stegnavn, 'Emneansvarleg vurderer');
    sjekk('e-postmal står', tre.Behandling[0].Epost, SKJEMATYPE.Behandling[0].Epost);
    sjekk('felttekst står', tre.Seksjoner[0].Felter[0].Tekst, 'Velg Emneansvarleg');
    sjekk('andre roller står', tre.Publikum.Roller, ['Student(ING2308)']);

    sjekk('antall endringer', endringer.length, 7);
    sjekk('endringene har sti, fra og til',
        endringer.find(e => e.sti === 'Behandling[0].PlannerOppgave.AnsvarligRolle'),
        { sti: 'Behandling[0].PlannerOppgave.AnsvarligRolle', fra: 'Emneansvarleg(ING2308)', til: 'Emneansvarlig(ING2308)' });

    const ingen = o.omskrivTre(SKJEMATYPE, { type: 'navn', fra: 'Finnesikke', til: 'X' });
    sjekk('ingen treff gir ingen endringer', ingen.endringer, []);
    sjekk('og et likt tre', JSON.stringify(ingen.tre), foer);
}

// ---------- 3. innsendt sak: Roller og RollerMal ----------
{
    // Ved innsending ekspanderes malen og lagres konkret; malen tas vare på
    // i RollerMal (lib/dynamisk-rolle.js). Begge skal følge med.
    const sak = {
        Skjema_id: '12-7', Skjematype_id: '12',
        Behandling: [{ Steg: 1, Roller: ['Emneansvarlig(ING2308)'], RollerMal: ['Emneansvarlig({2-01})'] }],
        Svar: [{ r: '2-01', sva: ['ING2308'] }]
    };
    const { tre, endringer } = o.omskrivTre(sak, OMFANG);
    sjekk('saken følger med til nytt omfang', tre.Behandling[0].Roller, ['Emneansvarlig(ING2309)']);
    sjekk('dynamisk mal står', tre.Behandling[0].RollerMal, ['Emneansvarlig({2-01})']);
    sjekk('svarene røres ikke', tre.Svar, sak.Svar);
    sjekk('én endring', endringer.length, 1);
}

// ---------- 4. rapport: tilgang og fraRolle ----------
{
    const rapport = {
        Publikum: { Roller: ['Emneansvarleg'] },
        Innebygde_filtre: [{ type: 'svar', seksjon: 2, felt: 1, fraRolle: 'Emneansvarleg' }]
    };
    const { tre } = o.omskrivTre(rapport, NAVN);
    sjekk('rapporttilgang', tre.Publikum.Roller, ['Emneansvarlig']);
    sjekk('rapportfilter fraRolle', tre.Innebygde_filtre[0].fraRolle, 'Emneansvarlig');
    // fraRolle er et navn uten omfang. Et nytt omfang endrer det ikke.
    const r2 = o.omskrivTre({ Innebygde_filtre: [{ fraRolle: 'Emneansvarlig' }] }, OMFANG);
    sjekk('fraRolle står ved omfangsendring', r2.endringer, []);
}

// ---------- 5. medlemskap ----------
{
    const rader = [
        { Rolle: 'Emneansvarlig', Omfang: 'ING2308', UPN: 'a@mil.no', FN: 'A', EN: 'A', Kilde: 'manuell' },
        { Rolle: 'Emneansvarlig', Omfang: 'ING2308', UPN: 'b@mil.no', FN: 'B', EN: 'B', Kilde: 'import' },
        { Rolle: 'Emneansvarlig', Omfang: 'ING2309', UPN: 'b@mil.no', FN: 'B', EN: 'B', Kilde: 'manuell' },
        { Rolle: 'Emneansvarlig', Omfang: 'ING2310', UPN: 'c@mil.no', FN: 'C', EN: 'C', Kilde: 'manuell' }
    ];
    const p = o.planMedlemskap(rader, OMFANG);
    sjekk('begge i omfanget slettes', p.slett.map(r => r.UPN).sort(), ['a@mil.no', 'b@mil.no']);
    sjekk('a flyttes', p.skriv.map(r => [r.Omfang, r.UPN]), [['ING2309', 'a@mil.no']]);
    sjekk('b sto allerede i målet, og får ikke en rad til', p.alleredeIMaal, 1);
    sjekk('kilden følger med', p.skriv[0].Kilde, 'manuell');
    sjekk('naboomfanget røres ikke', [...p.slett, ...p.skriv].some(r => r.UPN === 'c@mil.no'), false);

    const n = o.planMedlemskap(rader, { type: 'navn', fra: 'Emneansvarlig', til: 'Emneansvarlig2' });
    sjekk('navn: alle omfang flyttes', n.skriv.length, 4);
    sjekk('navn: omfanget beholdes', n.skriv.map(r => r.Omfang).sort(), ['ING2308', 'ING2308', 'ING2309', 'ING2310']);
}

// ---------- 6. rollegrupper ----------
{
    const grupper = [
        { Rolle: 'Emneansvarleg', Omfang: 'ING2308', Team: 'ING2308-team', EierRolle: '' },
        { Rolle: 'Medlem', Omfang: 'FFT', Team: 'FFT', EierRolle: 'Emneansvarleg' }
    ];
    const p = o.planGrupper(grupper, NAVN);
    sjekk('gruppen flyttes til nytt navn', p.flytt[0].til && [p.flytt[0].til.Rolle, p.flytt[0].til.Omfang], ['Emneansvarlig', 'ING2308']);
    sjekk('og eierrollen på andre grupper skrives om', p.oppdater.map(g => [g.Rolle, g.EierRolle]), [['Medlem', 'Emneansvarlig']]);

    // Finnes målgruppen fra før, beholdes den, og en forskjell meldes.
    const medMaal = [
        { Rolle: 'Emneansvarlig', Omfang: 'ING2308', Team: 'Gammelt', EierRolle: '' },
        { Rolle: 'Emneansvarlig', Omfang: 'ING2309', Team: 'Nytt', EierRolle: '' }
    ];
    const k = o.planGrupper(medMaal, OMFANG);
    sjekk('målgruppen overskrives ikke', k.flytt[0].til, null);
    sjekk('ulikt team meldes som konflikt', k.konflikter.map(x => [x.fra.Team, x.til.Team]), [['Gammelt', 'Nytt']]);
}

// ---------- 7. validering ----------
{
    sjekk('gyldig navneoperasjon', o.valider(NAVN), null);
    sjekk('gyldig omfangsoperasjon', o.valider(OMFANG), null);
    sjekk('FS-nøkkel er et gyldig omfang', o.valider({ ...OMFANG, til: 'FHSBA|22H|A' }), null);
    sjekk('ukjent type', /Ukjent/.test(o.valider({ type: 'begge', fra: 'a', til: 'b' })), true);
    sjekk('tomt nytt navn', !!o.valider({ ...NAVN, til: ' ' }), true);
    sjekk('likt navn', !!o.valider({ ...NAVN, til: NAVN.fra }), true);
    sjekk('parentes i navn', !!o.valider({ ...NAVN, til: 'A(B)' }), true);
    sjekk('klammer i omfang', !!o.valider({ ...OMFANG, til: '{2-01}' }), true);
    sjekk('skråstrek', !!o.valider({ ...NAVN, til: 'A/B' }), true);
    sjekk('| i rollenavn', !!o.valider({ ...NAVN, til: 'A|B' }), true);
    sjekk('omfang uten rolle', !!o.valider({ type: 'omfang', fra: 'x', til: 'y' }), true);
    for (const r of o.RESERVERTE) {
        sjekk(`${r} kan ikke gis nytt navn`, !!o.valider({ type: 'navn', fra: r, til: 'Annet' }), true);
        sjekk(`ingen rolle kan få navnet ${r}`, !!o.valider({ type: 'navn', fra: 'Annet', til: r }), true);
        sjekk(`men ${r} kan få nytt omfang`, o.valider({ type: 'omfang', rolle: r, fra: 'a', til: 'b' }), null);
    }
}

// ---------- 8. de reserverte navnene er de koden slår opp ----------
//
// Leser api/src: hvert rollenavn som sendes som strengkonstant til
// erMedlem/hentInnehavere/hentOmfangForBruker, må stå i RESERVERTE. Ellers
// kan admin gi rollen nytt navn, og koden slutter stille å finne den.
{
    const funnet = new Set();
    const gaa = (mappe) => {
        for (const f of fs.readdirSync(mappe, { withFileTypes: true })) {
            const sti = path.join(mappe, f.name);
            if (f.isDirectory()) { gaa(sti); continue; }
            if (!f.name.endsWith('.js')) continue;
            const kilde = fs.readFileSync(sti, 'latin1');
            for (const m of kilde.matchAll(/\b(?:erMedlem|hentInnehavere|hentOmfangForBruker)\(\s*'([^'(]+)/g)) {
                funnet.add(m[1]);
            }
        }
    };
    gaa(path.join(__dirname, '..', 'src'));
    sjekk('koden slår opp minst én rolle ved navn', funnet.size > 0, true);
    sjekk('hver av dem er reservert', [...funnet].filter(n => !o.RESERVERTE.includes(n)), []);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
