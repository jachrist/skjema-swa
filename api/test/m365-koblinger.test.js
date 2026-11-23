/**
 * M365-koblinger (lib/m365-koblinger.js) — hvilke team og SharePoint-områder
 * skjematypene skriver til, og når de sist ble brukt.
 *
 * Oversikten skal svare på ett spørsmål: kan tjenestebrukeren meldes ut av
 * dette teamet? Det kan den bare når INGEN skjematype som skriver dit er i
 * bruk. Testen passer derfor på:
 *
 *   - at skjematyper som skriver til samme team havner på SAMME rad, også med
 *     ulike store bokstaver
 *   - at raden har den NYESTE aktiviteten på tvers av dem
 *   - at en kanal som ikke er slått på, ikke gir en kobling (samme regel som
 *     «Sjekk oppsettet»)
 *   - at siste aktivitet er det samme tallet som skjematypeoversikten viser
 *
 * Kjøres med:  node api/test/m365-koblinger.test.js
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

const { byggKoblinger, malFor } = require('../src/lib/m365-koblinger');
const { byggOversikt } = require('../src/lib/skjematype-oversikt');

// ---------- 1. målene i én definisjon ----------
{
    const typer = (def) => malFor(def).map(m => [m.type, m.mal, m.detalj]);
    sjekk('SharePoint: adresse og liste', typer({ SPListeadresse: 'https://t.sharepoint.com/sites/A', SPListenavn: 'Saker' }),
        [['sharepoint', 'https://t.sharepoint.com/sites/A', 'Liste: Saker']]);
    sjekk('SharePoint: bare adresse gir ingen kobling', typer({ SPListeadresse: 'https://t.sharepoint.com/sites/A' }), []);

    sjekk('Planner: team før første kolon',
        typer({ Behandling: [{ Steg: 1, Varsling: ['planner'], PlannerOppgave: { TeamOgPlan: 'FFT:Saker: 2026' } }] }),
        [['planner', 'FFT', 'Plan: Saker: 2026']]);
    // Samme regel som diagnosen: et oppsett som ikke er slått på, skriver ikke.
    sjekk('Planner satt opp, men ikke slått på: ingen kobling',
        typer({ Behandling: [{ Steg: 1, Varsling: ['epost'], PlannerOppgave: { TeamOgPlan: 'FFT:Saker' } }] }), []);

    sjekk('Teams-kanal med team og kanal',
        typer({ Behandling: [{ Steg: 2, Varsling: ['teamskanal'], TeamsKanalInnlegg: { Team: 'Støtte', Kanal: 'Henvendelser' } }] }),
        [['teamskanal', 'Støtte', 'Kanal: Henvendelser']]);
    sjekk('Teams-kanal uten team: flytens standard, ikke borte',
        typer({ Behandling: [{ Steg: 1, Varsling: ['teamskanal'] }] }),
        [['teamskanal', '(flytens standardteam)', 'Kanal: (flytens standardkanal)']]);

    // Teams-melding og e-post skriver ikke til et team.
    sjekk('Teams-melding og e-post: ingen kobling',
        typer({ Behandling: [{ Steg: 1, Varsling: ['epost', 'teams'] }] }), []);

    const dyn = malFor({ Behandling: [{ Steg: 1, Varsling: ['teamskanal'], TeamsKanalInnlegg: { Team: '{1-02}' } }] });
    sjekk('team fra et svar: merket dynamisk', dyn[0].dynamisk, true);
    sjekk('steget står i «hvor»', malFor({ Behandling: [{ Steg: 3, Varsling: ['planner'], PlannerOppgave: { TeamOgPlan: 'X:Y' } }] })[0].hvor, 'Steg 3');
}

// ---------- 2. sammenstillingen ----------
{
    const st = (id, navn, def) => ({ id, JSON: { Skjema_navn: navn, Fase: 'Produksjon', ...def } });
    const kanal = (team) => ({ Behandling: [{ Steg: 1, Varsling: ['teamskanal'], TeamsKanalInnlegg: { Team: team, Kanal: 'K' } }] });
    const skjematyper = [
        // Den nyeste FØRST: står den sist, gir «siste» og «nyeste» samme svar,
        // og testen skiller ikke de to.
        st('2', 'Ny', kanal('STØTTE')),
        st('1', 'Gammel', kanal('Støtte')),
        st('3', 'Aldri brukt', { SPListeadresse: 'https://t.sharepoint.com/sites/B/', SPListenavn: 'L' }),
        st('4', 'Middels', { Behandling: [{ Steg: 1, Varsling: ['planner'], PlannerOppgave: { TeamOgPlan: 'Plan-team:P' } }] }),
        st('5', 'Uten kobling', {})
    ];
    // Den ekte oversikten, så siste aktivitet er SAMME tall som tabellen viser.
    const antall = new Map([
        ['1', { Antall: 3, SisteDato: '2026-01-10T10:00:00Z' }],
        ['2', { Antall: 7, SisteDato: '2026-11-20T10:00:00Z' }],
        ['4', { Antall: 1, SisteDato: '2026-06-01T10:00:00Z' }]
    ]);
    const k = byggKoblinger(skjematyper, byggOversikt(skjematyper, antall));

    const stotte = k.find(r => r.Type === 'teamskanal');
    sjekk('samme team, ulike store bokstaver: én rad', k.filter(r => r.Type === 'teamskanal').length, 1);
    sjekk('og begge skjematypene på den', stotte.Skjematyper.map(s => s.Skjema_navn).sort(), ['Gammel', 'Ny']);
    sjekk('raden har den nyeste aktiviteten', stotte.SisteAktivitet, '2026-11-20T10:00:00Z');
    sjekk('hver skjematype har sin egen dato og sitt antall',
        stotte.Skjematyper.map(s => [s.Skjema_navn, s.SisteDato, s.Utfylte]).sort(),
        [['Gammel', '2026-01-10T10:00:00Z', 3], ['Ny', '2026-11-20T10:00:00Z', 7]]);
    sjekk('skjematype uten kobling er ikke med', k.some(r => r.Skjematyper.some(s => s.Skjema_navn === 'Uten kobling')), false);
    sjekk('lengst ubrukt først, aldri brukt aller først', k.map(r => r.Type), ['sharepoint', 'planner', 'teamskanal']);
    sjekk('aldri brukt: tom aktivitet', k[0].SisteAktivitet, '');
}

// ---------- 3. kildene bruker det ----------
{
    const les = (...p) => utenKommentarer(fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8'));
    const endepunkt = les('api', 'src', 'functions', 'skjematype-oversikt.js');
    sjekk('endepunktet bygger koblingene av de samme radene', /koblinger:\s*byggKoblinger\(skjematyper,\s*rader\)/.test(endepunkt), true);
    const lib = les('api', 'src', 'lib', 'm365-koblinger.js');
    // Reglene er diagnosens, ikke en egen lesing.
    sjekk('kanalregelen fra diagnosen', /require\('\.\/skjematype-diagnose'\)/.test(lib), true);
    sjekk('ingen egen split på kolon', /split\(':'\)/.test(lib), false);
    const admin = les('frontend', 'admin.html');
    sjekk('admin viser koblingene', /byggKoblingTabell\(data\.koblinger/.test(admin), true);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
