/**
 * $innsender_navn — navnet på innsenderen.
 *
 * Plassholderen har alltid blitt substituert riktig. Den ble bare byttet ut med
 * tom streng, fordi `Innsender_Navn` aldri ble SKREVET noe sted: alle leserne
 * fantes (plassholderen, SP-kolonnen, PDF-en, mottakernavnet i varslingen),
 * ingen skriver. Og fordi `$innsender` rett ved siden av virket, så det ut som
 * en feil i substitusjonen.
 *
 * Testen dekker de tre stedene feilen kunne oppstå igjen:
 *
 *   **Rekkefølgen i erstattPlassholdere.** `$innsender` er et prefiks av
 *   `$innsender_navn`. Byttes rekkefølgen, blir «$innsender_navn» til
 *   «kari@fhs.no_navn» — som ser ut som en datafeil, ikke en kodefeil.
 *
 *   **Navnet fra claims.** AAD-mappingen legger ofte e-postadressen i
 *   `.../claims/name`. Et «navn» som er en e-postadresse er ikke et navn, og
 *   ville blitt lagret som Innsender_Navn for all ettertid.
 *
 *   **Fallbacken.** Skjemaer lagret før 16.09.2026 har ingen Innsender_Navn, og
 *   eksterne innsendere får aldri et. Da skal adressen stå der — ikke et
 *   tomrom midt i en setning.
 *
 * Kjøres med:  node api/test/innsender-navn.test.js
 */
let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const { erstattPlassholdere, byggKontekst } = require('../src/lib/placeholder');
const { hentInnloggetNavn, hentInnloggetUpn } = require('../src/lib/auth');

async function kjor() {

/** Etterligner SWAs principal-header. */
function req(principal) {
    const headers = new Map();
    if (principal !== undefined) {
        headers.set('x-ms-client-principal',
            Buffer.from(JSON.stringify(principal), 'utf8').toString('base64'));
    }
    return { headers: { get: (k) => headers.get(k) ?? null } };
}

// ---------- navnet fra claims ----------
{
    sjekk('name-claim',
        hentInnloggetNavn(req({ userDetails: 'kari@fhs.no', claims: [{ typ: 'name', val: 'Kari Nordmann' }] })),
        'Kari Nordmann');

    sjekk('displayname-URI',
        hentInnloggetNavn(req({ claims: [{ typ: 'http://schemas.microsoft.com/identity/claims/displayname', val: 'Ola Hansen' }] })),
        'Ola Hansen');

    sjekk('given_name + family_name',
        hentInnloggetNavn(req({ claims: [{ typ: 'given_name', val: 'Kari' }, { typ: 'family_name', val: 'Nordmann' }] })),
        'Kari Nordmann');

    sjekk('bare fornavn',
        hentInnloggetNavn(req({ claims: [{ typ: 'given_name', val: 'Kari' }] })), 'Kari');

    // AAD legger preferred_username i denne. Adressen er ikke et navn.
    sjekk('e-post i name-claim godtas ikke',
        hentInnloggetNavn(req({ claims: [{ typ: 'name', val: 'kari@fhs.no' }] })), null);

    sjekk('e-post i .../claims/name godtas ikke',
        hentInnloggetNavn(req({ claims: [{ typ: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name', val: 'kari@fhs.no' }] })),
        null);

    // ... men står det et navn der, er det bedre enn ingenting.
    sjekk('navn i .../claims/name brukes',
        hentInnloggetNavn(req({ claims: [{ typ: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name', val: 'Kari Nordmann' }] })),
        'Kari Nordmann');

    // «Vi vet ikke» er ikke det samme som «hen heter kari@fhs.no».
    sjekk('ingen claims gir null',
        hentInnloggetNavn(req({ userDetails: 'kari@fhs.no' })), null);
    sjekk('ingen header gir null', hentInnloggetNavn(req()), null);
    sjekk('tom claim-verdi gir null',
        hentInnloggetNavn(req({ claims: [{ typ: 'name', val: '   ' }] })), null);

    // Claims-formen skal ikke velte UPN-oppslaget som allerede virker.
    sjekk('upn leses fortsatt',
        hentInnloggetUpn(req({ userDetails: 'Kari@FHS.no', claims: [] })), 'kari@fhs.no');
}

// ---------- substitusjon ----------
{
    const kontekst = byggKontekst({
        skjema: { Skjema_id: '42', Innsender_Epost: 'kari@fhs.no', Innsender_Navn: 'Kari Nordmann' },
        skjematype: { Skjema_navn: 'Reiseregning' }
    });

    sjekk('navnet substitueres',
        erstattPlassholdere('Hei, $innsender_navn!', kontekst), 'Hei, Kari Nordmann!');

    // Byttes rekkefølgen i erstattPlassholdere, blir dette «kari@fhs.no_navn».
    sjekk('$innsender spiser ikke $innsender_navn',
        erstattPlassholdere('$innsender_navn ($innsender)', kontekst),
        'Kari Nordmann (kari@fhs.no)');

    sjekk('begge veier i samme tekst',
        erstattPlassholdere('$innsender / $innsender_navn', kontekst),
        'kari@fhs.no / Kari Nordmann');
}

// ---------- fallback ----------
{
    // Skjema lagret før feltet ble skrevet.
    const gammelt = byggKontekst({ skjema: { Innsender_Epost: 'per@fhs.no' } });
    sjekk('uten navn brukes adressen', gammelt.innsenderNavn, 'per@fhs.no');
    sjekk('og den kommer med i teksten',
        erstattPlassholdere('Fra $innsender_navn', gammelt), 'Fra per@fhs.no');

    // Kompakt format bruker liten e.
    sjekk('kompakt feltnavn',
        byggKontekst({ skjema: { Innsender_epost: 'per@fhs.no' } }).innsenderNavn, 'per@fhs.no');

    // Ekstern innsender via SMS: «adressen» er et mobilnummer, og det er det
    // eneste vi vet om hen.
    sjekk('sms-innsender',
        byggKontekst({ skjema: { Innsender_Epost: 'mobil:99887766' } }).innsenderNavn, 'mobil:99887766');

    // Vet vi ingenting, skal det heller ikke stå noe.
    sjekk('helt ukjent innsender', byggKontekst({ skjema: {} }).innsenderNavn, '');

    // Navnet vinner når det finnes.
    sjekk('navnet går foran adressen',
        byggKontekst({ skjema: { Innsender_Navn: 'Kari Nordmann', Innsender_Epost: 'kari@fhs.no' } }).innsenderNavn,
        'Kari Nordmann');
}

// ---------- navnet fra rollekildens payload ----------
{
    // SWA sender claims til /api/roller-swa, men IKKE videre i
    // principal-headeren API-et får. Verifisert på dev 16.09.2026: whoami
    // svarte `"navn": null` med claims-lesingen på plass. Navnet fanges derfor
    // der claims faktisk finnes — og begge veiene bruker SAMME funksjon, slik
    // at en bruker ikke kan få ett navn ved innlogging og et annet ved
    // lagring. Testen holder på den regelen.
    const { navnFraClaims } = require('../src/lib/auth');

    sjekk('name-claim i payload',
        navnFraClaims([{ typ: 'name', val: 'Kari Nordmann' }]), 'Kari Nordmann');
    sjekk('given + family i payload',
        navnFraClaims([{ typ: 'given_name', val: 'Kari' }, { typ: 'family_name', val: 'Nordmann' }]),
        'Kari Nordmann');
    sjekk('e-post i payload godtas ikke',
        navnFraClaims([{ typ: 'name', val: 'kari@fhs.no' }]), null);
    sjekk('ingen claims i payload', navnFraClaims(undefined), null);
    sjekk('tom claims-liste', navnFraClaims([]), null);

    // Samme claims inn gir samme navn ut, uansett vei.
    const claims = [{ typ: 'given_name', val: 'Ola' }, { typ: 'family_name', val: 'Hansen' }];
    sjekk('header og payload gir samme navn',
        navnFraClaims(claims), hentInnloggetNavn(req({ claims })));
}

// ---------- lagring og oppslag ----------
{
    const storage = require('../src/lib/storage');
    const brukernavn = require('../src/lib/brukernavn-storage');
    const opprinnelig = storage.sikreTabell;

    // Minimal tabell-stubb. Ingen ekte lagringskonto — testene skal kunne
    // kjøre uten node_modules.
    function stubb({ feilerSkriv = false, feilerLes = false } = {}) {
        const rader = new Map();
        storage.sikreTabell = async () => ({
            upsertEntity: async (e) => {
                if (feilerSkriv) throw new Error('403 fra tabellen');
                rader.set(e.rowKey, e);
            },
            getEntity: async (pk, rk) => {
                if (feilerLes) throw new Error('nede');
                const e = rader.get(rk);
                if (!e) { const err = new Error('ikke funnet'); err.statusCode = 404; throw err; }
                return e;
            }
        });
        return rader;
    }

    try {
        const rader = stubb();

        sjekk('lagret', await brukernavn.settNavn('Kari@FHS.no', 'Kari Nordmann'), true);
        // UPN normaliseres — ellers blir samme person to rader.
        sjekk('nøkkelen er små bokstaver', [...rader.keys()], ['kari@fhs.no']);
        sjekk('slås opp uansett skrivemåte', await brukernavn.hentNavn('KARI@fhs.no'), 'Kari Nordmann');

        sjekk('ukjent bruker gir tom streng', await brukernavn.hentNavn('ola@fhs.no'), '');
        sjekk('tom upn', await brukernavn.hentNavn(''), '');
        sjekk('tomt navn lagres ikke', await brukernavn.settNavn('per@fhs.no', '   '), false);

        // losNavn: claims foran tabellen, og kilden skal kunne ses.
        sjekk('claims går foran',
            await brukernavn.losNavn(req({ claims: [{ typ: 'name', val: 'Fra claims' }] }), 'kari@fhs.no'),
            { navn: 'Fra claims', kilde: 'claims' });
        sjekk('uten claims brukes tabellen',
            await brukernavn.losNavn(req({ userDetails: 'kari@fhs.no' }), 'kari@fhs.no'),
            { navn: 'Kari Nordmann', kilde: 'lagret' });
        sjekk('ukjent overalt',
            await brukernavn.losNavn(req({ userDetails: 'ola@fhs.no' }), 'ola@fhs.no'),
            { navn: '', kilde: null });

        // En tabell som er nede skal gi «vi vet ikke», ikke en exception midt
        // i en innsending.
        stubb({ feilerSkriv: true, feilerLes: true });
        sjekk('feilende skriv kaster ikke', await brukernavn.settNavn('kari@fhs.no', 'Kari'), false);
        sjekk('feilende lesing kaster ikke', await brukernavn.hentNavn('kari@fhs.no'), '');
        sjekk('losNavn overlever en tabell som er nede',
            await brukernavn.losNavn(req({ userDetails: 'kari@fhs.no' }), 'kari@fhs.no'),
            { navn: '', kilde: null });
    } finally {
        storage.sikreTabell = opprinnelig;
    }
}

console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
}

kjor().catch(e => { console.error(e); process.exit(1); });
