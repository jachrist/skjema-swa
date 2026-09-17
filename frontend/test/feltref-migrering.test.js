/**
 * Tester for migrerFeltreferanser() — referansene festes til feltets Id.
 *
 * Bakgrunnen er en skjematype laget før feltene fikk stabil id. Svarene tålte
 * omnummerering allerede: de kobles på id i skjema-kompakt.js og flyttes med
 * ved lagring i svar-reparasjon.js. Referanseteksten i malene gjorde ikke det.
 * En {1-02} i en e-post er bare tekst, og pekte på posisjonen — så når et felt
 * ble satt inn lenger opp, pekte den plutselig på nabospørsmålet.
 *
 * Å redigere og lagre skjematypen hjalp ikke: lagringen reparerer svar, aldri
 * referanser. Derfor gjøres det ved innlasting i stedet, mens numrene fortsatt
 * er de referansene ble skrevet mot.
 *
 * Kjøres med:  node frontend/test/feltref-migrering.test.js
 */
const fs = require('fs');
const path = require('path');

// Ren ES-modul uten DOM-avhengigheter — `export` strippes og resten kjøres
// som den er, samme mønster som de andre frontend-testene bruker.
const kilde = fs.readFileSync(
    path.join(__dirname, '..', 'js', 'feltref-migrering.js'), 'utf8'
).replace(/export /g, '');
const { migrerFeltreferanser, migrerStreng, byggPosisjonskart } = (new Function(
    kilde + '\nreturn { migrerFeltreferanser, migrerStreng, byggPosisjonskart };'
))();

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const A = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const B = '11111111-2222-3333-4444-555555555555';

function seksjoner() {
    return [{
        Seksjon_nummer: 1,
        Felter: [
            { Id: A, Nummer: '01', Type: 'Tekst', Tekst: { Verdi: 'Reisemål' } },
            { Nummer: '02', Type: 'Informasjon', Tekst: { Verdi: 'Les dette {1-01}' } },
            { Id: B, Nummer: '03', Type: 'Dato' }
        ]
    }];
}

// ---------- posisjon byttes med id ----------
{
    const data = {
        Seksjoner: seksjoner(),
        Innsenderkvittering: { Emne: 'Takk for {1-01}', Tekst: 'Dato: {1-03}' }
    };
    const r = migrerFeltreferanser(data);
    sjekk('emne festet til id', data.Innsenderkvittering.Emne, `Takk for {${A}}`);
    sjekk('tekst festet til id', data.Innsenderkvittering.Tekst, `Dato: {${B}}`);
    sjekk('antall omskrevne strenger', r.endret, 2);
    sjekk('ingen uløste', r.uloste, []);
}

// ---------- alle kanalene, ikke bare e-post ----------
{
    // Gjennomgangen er generisk nettopp for dette: en fast liste over kanaler
    // ville måtte vedlikeholdes, og en glemt oppføring gir den stille feilen
    // migreringen skal fjerne.
    const data = {
        Seksjoner: seksjoner(),
        Behandling: [{
            Roller: ['Klassesjef({1-01})'],
            TeamsMelding: { Tittel: 'Reise {1-01}', Innhold: 'Dato {1-03}' },
            PlannerOppgave: { Tittel: 'Godkjenn {1-01}', Sjekkliste: 'Sjekk {1-03}' },
            TeamsKanalInnlegg: { Tittel: '{1-01}', Innhold: 'x' }
        }]
    };
    migrerFeltreferanser(data);
    const b = data.Behandling[0];
    sjekk('dynamisk rolle', b.Roller[0], `Klassesjef({${A}})`);
    sjekk('teams-melding', [b.TeamsMelding.Tittel, b.TeamsMelding.Innhold], [`Reise {${A}}`, `Dato {${B}}`]);
    sjekk('planner', [b.PlannerOppgave.Tittel, b.PlannerOppgave.Sjekkliste], [`Godkjenn {${A}}`, `Sjekk {${B}}`]);
    sjekk('teams-kanal', b.TeamsKanalInnlegg.Tittel, `{${A}}`);
}

// ---------- Seksjoner røres ikke ----------
{
    // Inne i Seksjoner står definisjonen av feltene selv. En {1-01} i teksten
    // på et Informasjon-felt er innhold forfatteren har skrevet, ikke en
    // referanse flyten slår opp.
    const data = { Seksjoner: seksjoner() };
    const r = migrerFeltreferanser(data);
    sjekk('felttekst uendret', data.Seksjoner[0].Felter[1].Tekst.Verdi, 'Les dette {1-01}');
    sjekk('ingenting endret', r.endret, 0);
}

// ---------- referanser uten felt meldes fra om ----------
{
    const data = {
        Seksjoner: seksjoner(),
        Innsenderkvittering: { Tekst: 'Borte: {2-09}' },
        Behandling: [{ TeamsMelding: { Innhold: `Slettet felt: {99999999-9999-9999-9999-999999999999}` } }]
    };
    const r = migrerFeltreferanser(data);
    sjekk('uløst posisjon beholdes som den er', data.Innsenderkvittering.Tekst, 'Borte: {2-09}');
    sjekk('uløst posisjon meldes med sti', r.uloste[0], { sti: 'Innsenderkvittering.Tekst', ref: '{2-09}' });
    // En id uten felt er like ødelagt som en posisjon uten felt — feltet er
    // slettet etter at referansen ble satt inn.
    sjekk('uløst id meldes', r.uloste[1].ref, '{99999999-9999-9999-9999-999999999999}');
    sjekk('sti til uløst id', r.uloste[1].sti, 'Behandling[0].TeamsMelding.Innhold');
}

// ---------- Informasjon-felt kan ikke være mål ----------
{
    // De har ingen svar. Posisjonen deres teller i nummereringen, men en
    // referanse dit ville alltid gitt tomt — den skal meldes, ikke festes.
    const data = { Seksjoner: seksjoner(), Innsenderkvittering: { Tekst: '{1-02}' } };
    const r = migrerFeltreferanser(data);
    sjekk('info-felt ikke i kartet', data.Innsenderkvittering.Tekst, '{1-02}');
    sjekk('info-felt meldes som uløst', r.uloste.map(u => u.ref), ['{1-02}']);
}

// ---------- id-referanser som alt er riktige ----------
{
    const data = { Seksjoner: seksjoner(), Innsenderkvittering: { Tekst: `Alt bra {${A}}` } };
    const r = migrerFeltreferanser(data);
    sjekk('id-referanse røres ikke', data.Innsenderkvittering.Tekst, `Alt bra {${A}}`);
    sjekk('teller ikke som endring', r.endret, 0);
    sjekk('ikke uløst', r.uloste, []);
}

// ---------- felt uten Id kan ikke festes ----------
{
    // Skal ikke skje etter sikreFeltIder(), men migreringen må tåle det:
    // referansen står igjen på posisjon, som er det den gjorde før.
    const utenId = [{ Seksjon_nummer: 1, Felter: [{ Nummer: '01', Type: 'Tekst' }] }];
    const data = { Seksjoner: utenId, Innsenderkvittering: { Tekst: '{1-01}' } };
    const r = migrerFeltreferanser(data);
    sjekk('beholder posisjon', data.Innsenderkvittering.Tekst, '{1-01}');
    sjekk('meldes som uløst', r.uloste.length, 1);
}

// ---------- seksjonsnummer på begge former ----------
{
    // Kompakte definisjoner bærer Nummer på seksjonen, fulle bærer
    // Seksjon_nummer. Begge må treffe, ellers ville halvparten av skjemaene
    // fått alle referansene sine meldt som uløste.
    const medNummer = [{ Nummer: 2, Felter: [{ Id: A, Nummer: '01', Type: 'Tekst' }] }];
    const { kart } = byggPosisjonskart(medNummer);
    sjekk('Nummer på seksjonen treffer', kart.get('2-01'), A);
}

// ---------- flere referanser i samme streng ----------
{
    const r = migrerStreng('{1-01} reiser {1-03}', byggPosisjonskart(seksjoner()));
    sjekk('begge byttet', r.tekst, `{${A}} reiser {${B}}`);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
