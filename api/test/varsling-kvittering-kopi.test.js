/**
 * Kvitteringen skal være ÉN e-post med kopimottakerne i kopi-feltet.
 *
 * Fram til 07.10.2026 fikk innsenderen og hver kopimottaker sin egen e-post:
 * payloaden hadde bare `mottakere`, og flyten løkket over den. Brukeren
 * opplevde det som tre kvitteringer på samme skjema, uten å kunne se av den
 * ene at de andre fikk den samme.
 *
 * Payloaden har nå `kopi` ved siden av `mottakere`. Formen er en OVERGANG, og
 * det er dét testene under passer på — begge halvdelene:
 *
 *   `kopi` skal ALLTID være med, også tom. En nøkkel som kan forsvinne kan
 *   ikke feilsøkes: «flyten fikk ingen kopimottakere» og «koden som setter
 *   dem er ikke deployet» ville sett helt likt ut i payloaden.
 *
 *   De samme adressene skal FORTSATT ligge i `mottakere`. Flyten rulles ut i
 *   en egen ALM-runde mellom tenantene (docs/FLYT-DEPLOY.md), og fjernes
 *   duplikatet før den er ute, er det en periode der kopimottakerne ikke får
 *   noe i det hele tatt. Testen er her for at en opprydding ikke skal kunne
 *   gjøre det uten å bli rød.
 *
 *   Ingen adresse i både TIL og KOPI. `mottakere[0]` er den som står i
 *   til-feltet, og `kopi` regnes ut fra lista vi faktisk sender — ikke fra
 *   kopioppsettet — nettopp for at innsenderen ikke skal kunne stå i begge.
 *
 * Kjører den EKTE sendInnsenderKvittering og fanger payloaden i `fetch`.
 * Feltnavnene er dermed lest ut av koden som lager dem, ikke funnet opp her.
 *
 * Kjøres med:  node api/test/varsling-kvittering-kopi.test.js
 */
let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const varsling = require('../src/lib/varsling');
const rollerStorage = require('../src/lib/roller-storage');

const SKJEMATYPE = {
    Skjematype_id: '130',
    Skjematype_navn: 'Verdivurdering',
    Innsenderkvittering: {
        Aktiv: true,
        Emne: 'Kvittering',
        Tekst: 'Takk.',
        Kopi: { Personer: ['leder@jccodevel.onmicrosoft.com'], Roller: ['Ansatt FOSK'] }
    }
};

/**
 * Kjører kvitteringen med stubbet rolleoppslag og fanget fetch.
 * Returnerer payloaden flyten ville fått.
 */
async function kjorKvittering({ innsender, kopiOppsett, innehavere = [] }) {
    const kv = { ...SKJEMATYPE.Innsenderkvittering };
    if (kopiOppsett !== undefined) kv.Kopi = kopiOppsett;
    const skjematype = { ...SKJEMATYPE, Innsenderkvittering: kv };
    const skjema = {
        Skjematype_id: '130', Skjema_id: '7',
        Innsender_Epost: innsender || '',
        Innsender_Navn: innsender ? 'Inn Sender' : '',
        Seksjoner: []
    };

    const forrigeHent = rollerStorage.hentInnehavere;
    const forrigeFetch = global.fetch;
    const forrigeUrl = process.env.VARSLING_FLOW_URL;
    const forrigeAv = process.env.VARSLING_DEAKTIVERT;
    let fanget = null;
    rollerStorage.hentInnehavere = async () => innehavere;
    process.env.VARSLING_FLOW_URL = 'https://eksempel.invalid/flyt';
    delete process.env.VARSLING_DEAKTIVERT;
    global.fetch = async (_url, opts) => {
        fanget = JSON.parse(opts.body);
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    };
    try {
        await varsling.sendInnsenderKvittering(skjema, skjematype);
    } catch (e) {
        // Kastes det her, er `fanget` null og sjekkene under sier «flyten ble
        // ikke kalt» uten å si hvorfor. Skriv ut grunnen.
        console.log(`      (kvitteringen kastet: ${e.message})`);
    } finally {
        rollerStorage.hentInnehavere = forrigeHent;
        global.fetch = forrigeFetch;
        if (forrigeUrl === undefined) delete process.env.VARSLING_FLOW_URL;
        else process.env.VARSLING_FLOW_URL = forrigeUrl;
        if (forrigeAv !== undefined) process.env.VARSLING_DEAKTIVERT = forrigeAv;
    }
    return fanget;
}

// Rolleinnehavere lagres med EN/FN, ikke Navn — det er `samleBehandlerMottakere`
// som setter navnet sammen. Formen er lest ut derfra; et oppdiktet `Navn` her
// ga tom streng og fikk testen til å se ut som en feil i koden.
/**
 * Blir flyten aldri kalt, skal det bli ÉN rød linje — ikke en TypeError som
 * tar resten av fila med seg. Et kast her har tidligere skjult de andre
 * sjekkene helt, og da ser et hull ut som om testen ikke finnes.
 */
function krevPayload(navn, p) {
    if (p) { ok++; return p; }
    feil++;
    console.log(`FEIL  ${navn}: flyten ble ikke kalt — ingen payload å sjekke`);
    return { mottakere: [], kopi: [], varslinger: [] };
}

const eposter = (liste) => (liste || []).map(m => m.epost);

async function kjor() {
    // ---------- innsender + to kopimottakere ----------
    {
        const p = krevPayload('innsender + to kopi', await kjorKvittering({
            innsender: 'innsender@jccodevel.onmicrosoft.com',
            innehavere: [{ EP: 'fosk@jccodevel.onmicrosoft.com', EN: 'Osk', FN: 'Frida' }]
        }));
        sjekk('til-feltet er innsenderen', (p.mottakere[0] || {}).epost,
            'innsender@jccodevel.onmicrosoft.com');
        sjekk('kopi er de to andre', eposter(p.kopi).sort(),
            ['fosk@jccodevel.onmicrosoft.com', 'leder@jccodevel.onmicrosoft.com']);

        // Overgangsformen: de samme adressene ligger fortsatt i mottakere, så
        // en uendret flyt oppfører seg akkurat som før.
        sjekk('kopimottakerne er fortsatt i mottakere', eposter(p.mottakere).sort(),
            ['fosk@jccodevel.onmicrosoft.com', 'innsender@jccodevel.onmicrosoft.com',
             'leder@jccodevel.onmicrosoft.com']);

        // Ingen skal stå både i til og i kopi.
        sjekk('innsenderen står ikke i kopi',
            eposter(p.kopi).includes('innsender@jccodevel.onmicrosoft.com'), false);

        // Navnet skal med — flyten viser «Navn <adresse>» når det finnes.
        sjekk('navn følger kopimottakeren',
            (p.kopi.find(m => m.epost === 'fosk@jccodevel.onmicrosoft.com') || {}).navn, 'Osk, Frida');
        sjekk('og er tom streng, ikke undefined, når det mangler',
            (p.kopi.find(m => m.epost === 'leder@jccodevel.onmicrosoft.com') || {}).navn, '');
    }

    // ---------- ingen kopimottakere ----------
    {
        const p = krevPayload('uten kopimottakere', await kjorKvittering({
            innsender: 'innsender@jccodevel.onmicrosoft.com',
            kopiOppsett: null
        }));
        // Nøkkelen SKAL finnes. Forsvinner den, kan «ingen kopimottakere» ikke
        // skilles fra «koden er ikke ute».
        sjekk('kopi finnes også når den er tom', 'kopi' in p, true);
        sjekk('og er en tom liste', p.kopi, []);
        sjekk('mottakeren er innsenderen alene', eposter(p.mottakere),
            ['innsender@jccodevel.onmicrosoft.com']);
    }

    // ---------- ingen innsender-adresse ----------
    {
        // Skjemaer uten innsender-adresse finnes (importerte rader). Da skal
        // kvitteringen til den FØRSTE kopimottakeren, og resten i kopi — ikke
        // en e-post uten til-felt.
        const p = krevPayload('uten innsender-adresse', await kjorKvittering({
            innsender: '',
            innehavere: [{ EP: 'fosk@jccodevel.onmicrosoft.com', EN: 'Osk', FN: 'Frida' }]
        }));
        sjekk('til-feltet er første kopimottaker', (p.mottakere[0] || {}).epost,
            'leder@jccodevel.onmicrosoft.com');
        sjekk('og står ikke også i kopi',
            eposter(p.kopi).includes('leder@jccodevel.onmicrosoft.com'), false);
        sjekk('kopi er resten', eposter(p.kopi), ['fosk@jccodevel.onmicrosoft.com']);
    }

    // ---------- innsenderen er også kopimottaker ----------
    {
        // Rollen kan inneholde innsenderen selv. Da skal han få én e-post, i
        // til-feltet, og ikke stå i kopi på sin egen kvittering.
        const p = krevPayload('innsender også i rollen', await kjorKvittering({
            innsender: 'innsender@jccodevel.onmicrosoft.com',
            kopiOppsett: { Personer: [], Roller: ['Ansatt FOSK'] },
            innehavere: [
                { EP: 'innsender@jccodevel.onmicrosoft.com', EN: 'Sender', FN: 'Inn' },
                { EP: 'fosk@jccodevel.onmicrosoft.com', EN: 'Osk', FN: 'Frida' }
            ]
        }));
        sjekk('innsenderen bare én gang i mottakere',
            eposter(p.mottakere).filter(e => e === 'innsender@jccodevel.onmicrosoft.com').length, 1);
        sjekk('og ikke i kopi', eposter(p.kopi), ['fosk@jccodevel.onmicrosoft.com']);
    }

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
}

kjor().catch(e => { console.error(e); process.exit(1); });
