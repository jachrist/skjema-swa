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

const { kanArkiveres, sjekksum, byggArkiv, verifiser } = require('../src/lib/arkiv');

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
    const skjematype = { Skjematype_id: '7', JSON: { Skjema_navn: 'Reiseregning' } };
    const skjemaer = [gammel(), { ...gammel(), Skjema_id: '2' }];
    const a = byggArkiv({
        skjematype, skjemaer,
        samtaler: { '1': [{ Id: 'x', Tekst: 'hei' }] },
        vedlegg: { '1': [{ filnavn: 'a.pdf', innhold: 'AAA=' }] },
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

    // Definisjonen må med — uten den kan arkivet ikke tolkes om to år.
    sjekk('skjematypedefinisjonen er med', a.Skjematype.Skjema_navn, 'Reiseregning');
    // Og merknaden står i FILA, ikke bare i grensesnittet: den som finner
    // arkivet senere har ikke sett skjermbildet.
    sjekk('merknad om klartekst', /klartekst/.test(a.Manifest.Merknad), true);
    sjekk('merknad om at skjemaene er slettet', /slettet/.test(a.Manifest.Merknad), true);

    // Uten vedlegg: da skal ikke slettingen røre dem.
    const uten = byggArkiv({ skjematype, skjemaer, foerDato: GRENSE, arkivertAv: 'a@b.no' });
    sjekk('uten vedlegg', uten.Manifest.MedVedlegg, false);
    sjekk('og telles til null', uten.Manifest.AntallVedlegg, 0);
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
