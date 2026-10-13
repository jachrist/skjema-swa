# Masseutsending styrt av skjematype-definisjonen

I dag finnes én masseutsending: **emneevaluering**. Den emneansvarlige fyller
ut et avsender-skjema — velger emne fra FS, velger mottakere fra kadettene på
emnet, setter utsendings-, purre- og avslutningsdato — og et behandlingssteg
kaller en Power Automate-flyt som kaller `POST /api/utsending`.

Mønsteret er generelt. En ny masseutsending burde være en skjematype, ikke en
ny flyt.

## Hva som allerede er generelt

Tre av de fire stegene krever ingen ny mekanisme.

**Avgrensningen av mottakere** er FasteData-datakilder som alt finnes:

| Avgrensning | Datakilde |
|---|---|
| Emne | `Studenter{Emne}` |
| Klasse / kull / studieprogram | `Studenter{Klasse}`, `{Kull}`, `{Studieprogram}` |
| Teammedlemskap | `Personer{Team}` |
| Rolle | `Personer{Rolle}` |

**Valget av mottakere** er et vanlig flervalgsfelt med `FasteData`. DNF-formen
lar feltet peke på et annet felt — `Studenter{Emne={1-01}}` — så mottakerlista
repopuleres når emnet velges. Emneevalueringen bruker altså ingen
spesialmekanisme.

Det virker fordi `_hentStudenter` i `oppslag.js` returnerer `Verdi = s.EP`,
altså e-postadressen. Et mottakerfelt lagrer adresser direkte, og
kartleggingen trenger ingen oppslag.

**Datoene** er datofelter.

**API-et** er også generelt: `POST /api/utsending` tar `skjematypeId`,
`mottakere[]` med `prefilled` per mottaker, og de tre datoene. Ingenting i
kontrakten er emneevaluering-spesifikt.

## Det eneste som er spesialskrevet

Kartleggingen: hvilket felt holder mottakerne, hvilke holder datoene, hvilke
svar blir `prefilled`. Den ligger i flyten.

Den hører i koden, av fire grunner:

* Flytendringer koster en firestegs manuell ALM-runde mellom tenantene
  (`docs/FLYT-DEPLOY.md`), og kartlegging er det som endres oftest.
* Logikken kan ikke testes i en flyt.
* Én flyt for alle masseutsendinger, for alltid. En ny type blir en
  definisjon — ingen flytjobb, ingen deploy.
* Feilmeldingene blir brukbare. En flyt kan ikke si «felt 2-01 finnes ikke i
  avsender-skjemaet».

## `Utsending`-blokka

Legges i **avsender**-skjematypens definisjon.

```jsonc
"Utsending": {
  "Målskjematype_id": "71",          // skjematypen som sendes ut
  "Mottakerfelt": "2-01",            // flervalgsfelt med FasteData
  "Datoer": {
    "utsendingsdato":  "1-03",
    "purredato":       "1-04",       // valgfri — uten den purres det ikke
    "avslutningsdato": "1-05"
  },
  "Prefilled": {                     // nøkkel = felt i MÅLskjemaet
    "1-01": { "fraFelt": "1-01" },
    "1-02": { "tekst": "Evaluering av {1-02}" },
    "1-03": { "emnebeskrivelse": "{1-01}" }
  },
  "Purretekst": "Vi mangler fortsatt ditt svar.",
  "KanalHint": "epost"
}
```

**Avgrensningen står ikke her, med vilje.** `Mottakerfelt` peker på et vanlig
felt, og feltet har allerede `FasteData`. Datakildelista bor i `oppslag.js` og
i editoren; gjentas den her, har vi samme regel to steder — den feilklassen
som har kostet mest i dette repoet.

### Prefill-formene

| Form | Betydning |
|---|---|
| `{ "fraFelt": "1-01" }` | svaret i et felt på avsender-skjemaet |
| `{ "tekst": "… {1-02} …" }` | fast tekst, med feltreferanser |
| `{ "emnebeskrivelse": "{1-01}" }` | oppslag, løses når mottakeren åpner lenka |
| `"ren tekst"` | kortform for `{ tekst }` |

Oppslagsformen sendes videre som objekt. `POST /api/utsending` validerer den og
lagrer **referansen**, ikke teksten: det holder radene små (`Prefilled` har en
grense på 30 000 tegn), slipper å duplisere en lang læringsmålstekst for 200
mottakere, og gir alltid teksten som gjelder når skjemaet fylles ut.

Oppslagstypene er de samme som `utsending-prefill.js` kjenner, og en test
krever at de to listene er like.

## Endepunktet

```
POST /api/utsending/fra-skjema
{ "skjema_id": "412", "skjematype_id": "70" }
```

Flyten sender bare det. Serveren:

1. henter avsender-skjemaet og dets skjematype
2. kjører `byggUtsending(st.JSON.Utsending, skjema)` — ren funksjon
3. ved feil: **400 med alle feilene samlet**, ingenting skrevet
4. ellers: samme logikk som `POST /api/utsending` i dag

Behandlingssteget kaller altså én flyt som alltid gjør det samme. En ny
masseutsending rører hverken flyt eller kode.

## Status

**Bygget og testet:** `api/src/lib/utsending-oppsett.js` — kartleggingen som
ren funksjon, med `api/test/utsending-oppsett.test.js` (45 sjekker).

**Ikke bygget:** endepunktet. Det krever at batch-opprettingen trekkes ut av
`utsendingOpprett`-handleren i `functions/utsending.js`, der den ligger inline
i dag. Det er en egen avgjørelse — handleren er i drift, og en refaktorering
der bør gjøres med åpne øyne og ikke som bieffekt.

## To ting som må avklares før endepunktet bygges

**Skal `prefilled` kunne variere per mottaker?** Mekanismen i
`POST /api/utsending` støtter det; `byggUtsending` gir i dag samme verdier til
alle. Ingen kjent sak trenger per mottaker, og formen for «denne verdien kommer
fra mottakerraden» er en reell forgrening i designet. Tas når et tilfelle
dukker opp.

**Hvem skal få lov?** `POST /api/utsending` godtar admin eller flyt-nøkkel.
Går kartleggingen gjennom et behandlingssteg, er det stegets behandler som i
praksis utløser utsendingen. Den autorisasjonen bør være eksplisitt, ikke
arvet fra at flyten har nøkkelen.

## En felle som er verdt å kjenne

Mottakerfeltet **må** være et flervalgsfelt (`Flervalg-dropdown` eller
`Flervalg-knapper`). `alleSvarIFelt` i `placeholder.js` leser bare FØRSTE svar
på et felt som ikke er flervalg — en masseutsending ville gått til én av to
hundre, og både kallet og svaret ville sett helt normale ut.

`byggUtsending` avviser derfor et mottakerfelt med feil type, og sier hvilke
typer som duger. Fella ble funnet ved å KJØRE modulen mot et
emneevaluering-formet skjema, ikke ved å lese den.
