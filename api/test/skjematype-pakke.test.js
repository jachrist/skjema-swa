/**
 * Eksport og import av skjematyper.
 *
 * Verktøyet finnes for å fylle et nytt miljø (prod v3) med noen sentrale
 * skjematyper. Det som prøves her er det som gjør en slik import FARLIG hvis
 * den er taus:
 *
 *   **En pakke fra et annet verktøy må avvises**, ikke halvveis importeres.
 *
 *   **En skjematype som peker på en oppslagsliste som ikke finnes i
 *   målmiljøet, må SIES FRA OM før noe skrives.** Nedtrekket blir ellers tomt,
 *   og et tomt nedtrekk er umulig å skille fra «ingenting er godkjent ennå» —
 *   den forvekslingen har kostet tid i dette repoet før.
 *
 *   **Kryptering må flagges.** En ny nøkkel lages i målmiljøet, og svar fra
 *   kildemiljøet kan ikke leses her.
 *
 *   **Ingenting overskrives uten at det er bedt om det**, og en type som
 *   hoppes over må si hvorfor.
 *
 * Kjøres med:  node api/test/skjematype-pakke.test.js
 */
const pakke = require('../src/lib/skjematype-pakke');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

/** En definisjon i den EKTE formen — feltene leses ut av faste-data.js. */
const medListe = (navn, liste) => ({
    Skjematype_id: '7', Skjema_navn: navn, Fase: 'Produksjon',
    Seksjoner: [{ Felter: [{ FasteData: { Datakilde: 'Skjemasvar', Filterbegrep: 'Liste', Filterverdi: liste } }] }]
});

// ---------- 1. pakken bærer det den skal, og ikke mer ----------
{
    const def = { Skjematype_id: '3', Skjema_navn: 'Søknad' };
    const p = pakke.byggPakke([{ id: '3', navn: 'Søknad', JSON: def }], { fraMiljo: 'prod', av: 'a@b.no' });
    sjekk('formatet står i fila', p.format, 'skjema-swa/skjematyper');
    sjekk('versjonen også', p.versjon, pakke.PAKKE_VERSJON);
    sjekk('miljøet den kom fra', p.fraMiljo, 'prod');
    sjekk('hvem som laget den', p.av, 'a@b.no');
    sjekk('definisjonen er med', p.skjematyper[0].Skjematype_id, '3');

    // En type uten lesbar definisjon skal ikke telles med. En pakke som
    // påstår fire når tre er med, oppdages først i målmiljøet.
    const halv = pakke.byggPakke([{ id: '3', JSON: def }, { id: '4', JSON: null }]);
    sjekk('uleselig definisjon telles ikke', halv.antall, 1);
    sjekk('og er ikke med i lista', halv.skjematyper.length, 1);
}

// ---------- 2. en fremmed fil avvises ----------
{
    sjekk('tom fil', pakke.lesPakke(null).ok, false);
    sjekk('ugyldig JSON', pakke.lesPakke('{ ikke json').ok, false);
    sjekk('og sier hva som er galt', /gyldig JSON/.test(pakke.lesPakke('{ ikke json').feil[0]), true);

    // PAKKEN MÅ VÆRE GYLDIG BORTSETT FRA FORMATET. Første utgave sendte inn
    // en TOM liste, og da ble sjekken grønn av «pakken inneholder ingen
    // skjematyper» — altså av feil grunn. En mutasjon som fjernet
    // formatsjekken var usynlig for den.
    const fremmed = pakke.lesPakke({
        format: 'noe-annet', versjon: 1, skjematyper: [{ Skjematype_id: '1' }]
    });
    sjekk('feil format avvises', fremmed.ok, false);
    sjekk('og det er FORMATET som avviser den', fremmed.feil.length, 1);
    sjekk('og meldingen navngir begge formatene',
        /noe-annet[\s\S]*skjema-swa\/skjematyper/.test(fremmed.feil[0]), true);

    const framtid = pakke.lesPakke({
        format: pakke.PAKKE_FORMAT, versjon: 99, skjematyper: [{ Skjematype_id: '1' }]
    });
    sjekk('ukjent versjon avvises', framtid.ok, false);
    sjekk('og sier hvilken versjon koden leser', /versjon 1/.test(framtid.feil[0]), true);

    const tom = pakke.lesPakke({ format: pakke.PAKKE_FORMAT, versjon: 1, skjematyper: [] });
    sjekk('en pakke uten typer avvises', tom.ok, false);

    const utenId = pakke.lesPakke({
        format: pakke.PAKKE_FORMAT, versjon: 1,
        skjematyper: [{ Skjema_navn: 'Uten id' }, { Skjematype_id: '5', Skjema_navn: 'Med id' }]
    });
    sjekk('en oppføring uten id tas ikke med', utenId.skjematyper.length, 1);
    sjekk('og det står i feilene', /mangler Skjematype_id/.test(utenId.feil[0]), true);
    sjekk('pakken regnes ikke som feilfri', utenId.ok, false);

    const god = pakke.lesPakke(JSON.stringify(pakke.byggPakke([{ JSON: { Skjematype_id: '1' } }])));
    sjekk('en ekte pakke leses, også som streng', god.ok, true);
}

// ---------- 3. avhengigheter oppdages FØR noe skrives ----------
{
    sjekk('oppslagslista leses ut av feltet',
        pakke.oppslagslisterI(medListe('A', 'Godkjente')), ['Godkjente']);

    // DNF-formen er den moderne. Begge må leses — definisjonene i drift har
    // begge former, og en parser som bare kjente den ene ville meldt «ingen
    // avhengigheter» på halvparten av dem.
    const dnf = {
        Skjematype_id: '8',
        Seksjoner: [{ Felter: [{ FasteData: {
            Datakilde: 'Skjemasvar',
            EllerAv: [{ OgAv: [{ Kolonne: 'Liste', Operator: '=', Verdi: 'Vurderte' }] }]
        } }] }]
    };
    sjekk('og ut av DNF-formen', pakke.oppslagslisterI(dnf), ['Vurderte']);

    // Andre datakilder er ikke oppslagslister, og skal ikke meldes som det.
    const postnr = { Seksjoner: [{ Felter: [{ FasteData: { Datakilde: 'Postnumre' } }] }] };
    sjekk('postnummer-oppslag er ingen avhengighet', pakke.oppslagslisterI(postnr), []);
    sjekk('en definisjon uten seksjoner svarer tomt', pakke.oppslagslisterI({}), []);
}

// ---------- 4. planen sier hva som ville skjedd, og hvorfor ----------
{
    const def = medListe('Vurdering', 'Godkjente');

    const ny = pakke.vurderImport({ skjematyper: [def], finnesIder: [], finnesLister: ['Godkjente'] })[0];
    sjekk('ukjent type blir ny', ny.handling, 'ny');
    sjekk('og har ingen manglende lister', ny.manglendeLister, []);

    const manglerListe = pakke.vurderImport({ skjematyper: [def], finnesIder: [], finnesLister: [] })[0];
    sjekk('manglende oppslagsliste meldes', manglerListe.manglendeLister, ['Godkjente']);
    sjekk('og advarselen forklarer følgen',
        /[Nn]edtrekket blir tomt/.test(manglerListe.advarsler.join(' ')), true);
    // Navnet må sammenlignes uten hensyn til store bokstaver — ellers melder
    // importen en mangel som ikke finnes, og den som leser slutter å tro på
    // advarslene.
    const ulikCase = pakke.vurderImport({ skjematyper: [def], finnesIder: [], finnesLister: ['godkjente'] })[0];
    sjekk('store og små bokstaver teller ikke', ulikCase.manglendeLister, []);

    const finnes = pakke.vurderImport({ skjematyper: [def], finnesIder: ['7'], finnesLister: ['Godkjente'] })[0];
    sjekk('en type som finnes hoppes over', finnes.handling, 'hopper-over');
    sjekk('og grunnen står der', /[Ff]innes fra før/.test(finnes.grunn), true);

    const medOverskriv = pakke.vurderImport({
        skjematyper: [def], finnesIder: ['7'], finnesLister: ['Godkjente'], overskriv: true
    })[0];
    sjekk('med overskriving blir den erstattet', medOverskriv.handling, 'overskriv');
    sjekk('og det står hva som skjer', /erstattet/.test(medOverskriv.grunn), true);

    // Krypteringen må flagges uansett om lista finnes.
    const kryptert = pakke.vurderImport({
        skjematyper: [{ ...def, Krypteres: 'Alt' }], finnesIder: [], finnesLister: ['Godkjente']
    })[0];
    sjekk('kryptering flagges', /NY nøkkel/.test(kryptert.advarsler.join(' ')), true);
    const uten = pakke.vurderImport({
        skjematyper: [{ ...def, Krypteres: 'Nei' }], finnesIder: [], finnesLister: ['Godkjente']
    })[0];
    sjekk('ukryptert gir ingen slik advarsel',
        /NY nøkkel/.test(uten.advarsler.join(' ')), false);

    // Alle feltene er ALLTID satt. Et felt som forsvinner gjør «ingen
    // advarsler» umulig å skille fra «denne versjonen svarer ikke på det».
    for (const n of ['id', 'navn', 'fase', 'handling', 'grunn', 'manglendeLister', 'advarsler']) {
        sjekk(`${n} er alltid med`, n in ny, true);
    }
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
