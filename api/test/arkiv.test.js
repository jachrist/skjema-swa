/**
 * Arkivering (TODO 66).
 *
 * Formålet er å frigjøre lagring — altså å SLETTE. Arkivet er ikke et tillegg
 * til slettingen, det er det som gjør den forsvarlig. Table Storage har
 * hverken soft delete eller point-in-time restore: det som slettes her,
 * finnes etterpå bare i fila brukeren lastet ned.
 *
 * Fem regler, og fire av dem handler om ikke å slette noe vi ikke har:
 *
 *   **Bare avsluttede saker.** Et skjema under behandling har en behandler
 *   som venter på det.
 *
 *   **Bare eldre enn grensen.** Uten en dato betyr «arkiver» i praksis
 *   «slett alt som er ferdig», inkludert saken som ble avsluttet i går.
 *
 *   **Uten dato: nei.** Vi vet da ikke hvor gammelt skjemaet er, og «vet
 *   ikke» skal ikke bety «slett».
 *
 *   **Vedlegg som ikke er i arkivet, skal ikke slettes.** Et arkiv uten dem
 *   gir ingen rett til å fjerne dem — og vedleggene er trolig det som faktisk
 *   tar plass.
 *
 *   **Sjekksummen binder slettingen til fila.** Uten den kunne noen slette på
 *   grunnlag av en eksport som aldri kom fram.
 *
 * Kjøres med:  node api/test/arkiv.test.js
 */
let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const { kanArkiveres, sjekksum, byggArkiv, verifiser, filnavnFor } = require('../src/lib/arkiv');

const GRENSE = '2026-01-01';
const gammel = (status = 5) => ({ Skjema_id: '1', Skjema_status: status, Sist_endret: '2025-06-01T10:00:00Z' });

// ---------- hva som kan arkiveres ----------
{
    sjekk('avsluttet og gammelt', kanArkiveres(gammel(), GRENSE), true);

    // Et skjema under behandling har noen som venter på det.
    for (const status of [1, 2, 3]) {
        sjekk(`status ${status} arkiveres ikke`, kanArkiveres(gammel(status), GRENSE), false);
    }

    sjekk('nyere enn grensen',
        kanArkiveres({ Skjema_status: 5, Sist_endret: '2026-06-01T10:00:00Z' }, GRENSE), false);
    // Nøyaktig på grensen er ikke FØR grensen.
    sjekk('på grensen', kanArkiveres({ Skjema_status: 5, Sist_endret: GRENSE }, GRENSE), false);

    // «Vet ikke» skal ikke bety «slett».
    sjekk('uten dato på skjemaet', kanArkiveres({ Skjema_status: 5 }, GRENSE), false);
    sjekk('uten grense', kanArkiveres(gammel(), ''), false);
    sjekk('uten skjema', kanArkiveres(null, GRENSE), false);

    // Kompakt format bruker Oppdatert.
    sjekk('kompakt feltnavn',
        kanArkiveres({ Skjema_status: 5, Oppdatert: '2025-06-01' }, GRENSE), true);
}

// ---------- sjekksum ----------
{
    sjekk('rekkefølge spiller ingen rolle', sjekksum(['b', 'a']), sjekksum(['a', 'b']));
    sjekk('duplikater teller én gang', sjekksum(['a', 'a', 'b']), sjekksum(['a', 'b']));
    sjekk('ulike sett gir ulik sum', sjekksum(['a']) === sjekksum(['a', 'b']), false);
    sjekk('tom liste gir en sum', sjekksum([]).length > 0, true);
    // Antallet er med i summen, så «samme id-er, annet antall» finnes ikke.
    sjekk('summen er kort nok til en tabellrad', sjekksum(['a', 'b']).length, 32);
}

// ---------- arkivet ----------
{
    // NB: dette er formen `skjema-storage.hentSkjematype` faktisk returnerer —
    // `{ id, navn, JSON }`, ikke `{ Skjematype_id }`. Første versjon av denne
    // testen fant på sin egen form, og da gikk testen grønt mens produksjons-
    // koden bygget arkiv med tom skjematype-ID.
    const skjematype = { id: '7', navn: 'Reiseregning', JSON: { Skjema_navn: 'Reiseregning' } };
    const skjemaer = [gammel(), { ...gammel(), Skjema_id: '2' }];
    const a = byggArkiv({
        skjematypeId: '7', skjematype, skjemaer,
        samtaler: { '1': [{ Id: 'x', Tekst: 'hei' }] },
        vedlegg: { '1': [{ filnavn: 'a.pdf', innhold: 'AAA=' }] },
        medVedlegg: true,
        foerDato: GRENSE, arkivertAv: 'sjef@fhs.no',
        dato: new Date('2026-09-20T12:00:00Z')
    });

    sjekk('antall', a.Manifest.Antall, 2);
    sjekk('samtaleinnlegg telles', a.Manifest.AntallSamtaleinnlegg, 1);
    sjekk('vedlegg telles', a.Manifest.AntallVedlegg, 1);
    sjekk('medVedlegg', a.Manifest.MedVedlegg, true);
    sjekk('hvem', a.Manifest.ArkivertAv, 'sjef@fhs.no');
    sjekk('kriteriet er med', a.Manifest.FoerDato, GRENSE);
    sjekk('sjekksum stemmer med skjemaene', a.Manifest.Sjekksum, sjekksum(['1', '2']));

    // Skjematype-ID-en er nøkkelen arkivet slås opp på senere (PK i Arkiv-
    // tabellen). Er den tom, lagres raden under en annen nøkkel enn den
    // slettingen leter på, og svaret blir «Fant ikke arkivet».
    sjekk('skjematype-id i manifestet', a.Manifest.Skjematype_id, '7');
    sjekk('skjematype-id i arkiv-id', a.Manifest.ArkivId.endsWith('_7'), true);
    sjekk('navnet er med', a.Manifest.Skjema_navn, 'Reiseregning');

    // Definisjonen må med — uten den kan arkivet ikke tolkes om to år.
    sjekk('skjematypedefinisjonen er med', a.Skjematype.Skjema_navn, 'Reiseregning');
    // Og merknaden står i FILA, ikke bare i grensesnittet: den som finner
    // arkivet senere har ikke sett skjermbildet.
    sjekk('merknad om klartekst', /klartekst/.test(a.Manifest.Merknad), true);
    sjekk('merknad om at skjemaene er slettet', /slettet/.test(a.Manifest.Merknad), true);
}

// ---------- MedVedlegg er valget, ikke utfallet ----------
{
    const skjematype = { id: '7', navn: 'Reiseregning', JSON: { Skjema_navn: 'Reiseregning' } };
    const skjemaer = [gammel()];
    const felles = { skjematypeId: '7', skjematype, skjemaer, foerDato: GRENSE, arkivertAv: 'a@b.no' };

    // Skjemaer UTEN vedlegg, men vedlegg var med i jobben. Arkivet er
    // komplett, og slettingen skal ikke stoppes av en advarsel om filer som
    // ikke finnes.
    const ingenFiler = byggArkiv({ ...felles, medVedlegg: true, vedlegg: {} });
    sjekk('ingen vedlegg å ta, men de var med i jobben', ingenFiler.Manifest.MedVedlegg, true);
    sjekk('og telles til null', ingenFiler.Manifest.AntallVedlegg, 0);

    // Vedlegg valgt bort: da skal slettingen la dem ligge.
    const valgtBort = byggArkiv({ ...felles, medVedlegg: false, vedlegg: {} });
    sjekk('vedlegg valgt bort', valgtBort.Manifest.MedVedlegg, false);

    // Og motsatt: valget skal ikke kunne overstyres av at det tilfeldigvis
    // finnes vedlegg i kartet.
    const bortMenFinnes = byggArkiv({
        ...felles, medVedlegg: false, vedlegg: { '1': [{ filnavn: 'a.pdf', innhold: 'AAA=' }] }
    });
    sjekk('valget veier tyngst', bortMenFinnes.Manifest.MedVedlegg, false);
}

// ---------- skjematype-ID kan ikke mangle ----------
{
    const skjemaer = [gammel()];
    let kastet = '';
    try {
        byggArkiv({ skjematype: { navn: 'Uten id', JSON: {} }, skjemaer, foerDato: GRENSE, arkivertAv: 'a@b.no' });
    } catch (e) { kastet = e.message; }
    sjekk('tom skjematype-id kaster', /Skjematype_id/.test(kastet), true);

    // Den kan hentes fra objektets egen form hvis kalleren ikke sender den.
    const fraObjekt = byggArkiv({
        skjematype: { id: '9', JSON: { Skjema_navn: 'X' } }, skjemaer, foerDato: GRENSE, arkivertAv: 'a@b.no'
    });
    sjekk('id leses fra skjematype-objektet', fraObjekt.Manifest.Skjematype_id, '9');
}

// ---------- filnavnet ----------
{
    const m = {
        Skjematype_id: '120', Skjema_navn: 'PLANNER',
        Arkivert: '2026-09-20T16:21:06.524Z', FoerDato: '2026-09-21'
    };
    const navn = filnavnFor(m);
    sjekk('skjematypen er med i navnet', navn.includes('PLANNER'), true);
    sjekk('id-en er med', navn.includes('120'), true);
    sjekk('datoen er med', navn.includes('2026-09-20'), true);
    // Klokkeslettet er det som skiller to kjøringer samme dag fra hverandre.
    sjekk('klokkeslettet er med', navn.includes('162106'), true);
    sjekk('endelse', navn.endsWith('.json'), true);

    const senere = filnavnFor({ ...m, Arkivert: '2026-09-20T18:05:00.000Z' });
    sjekk('to kjøringer samme dag får ulike navn', navn === senere, false);

    // Navn er fritekst fra skjemaeier og havner i et filnavn.
    const stygt = filnavnFor({ ...m, Skjema_navn: 'A/B: «test» \\ 100%' });
    sjekk('ingen skilletegn i filnavnet', /[\\/:*?"<>|]/.test(stygt), false);
    sjekk('æøå beholdes', filnavnFor({ ...m, Skjema_navn: 'Søknad' }).includes('Søknad'), true);

    // Mangler navnet, skal ikke fila hete «arkiv__…».
    const utenNavn = filnavnFor({ ...m, Skjema_navn: '' });
    sjekk('ingen tomme ledd', utenNavn.includes('__'), false);
}

// ---------- verifisering før sletting ----------
{
    const manifest = { Sjekksum: sjekksum(['1', '2']), SkjemaIder: ['1', '2'] };

    sjekk('riktig sjekksum', verifiser(manifest, manifest.Sjekksum, ['1', '2']).ok, true);
    sjekk('feil sjekksum', verifiser(manifest, 'feil', ['1', '2']).ok, false);
    sjekk('manglende sjekksum', verifiser(manifest, '', ['1', '2']).ok, false);
    sjekk('uten manifest', verifiser(null, 'noe', []).ok, false);

    // Et skjema som er kommet til ETTER eksporten skal ikke slettes med.
    const nytt = verifiser(manifest, manifest.Sjekksum, ['1', '2', '3']);
    sjekk('nytt skjema stopper slettingen', nytt.ok, false);
    sjekk('og sier hvilket', nytt.uventet, ['3']);

    // Færre enn arkivet er greit — noen kan ha slettet ett manuelt i mellomtiden.
    sjekk('færre er greit', verifiser(manifest, manifest.Sjekksum, ['1']).ok, true);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
