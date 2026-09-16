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

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
