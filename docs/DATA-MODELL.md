# Datamodell

## Tabellstruktur (Table Storage)

Alle tabeller er PK+RK-basert. Ingen indekser utover partition scan.

### Skjemadefinisjoner
- PK = "Skjematype"
- RK = `<Skjematype_id>` (heltall som streng)
- Egenskaper: `JSON` (hele skjematype-definisjonen), `Fase`, `Skjema_navn`, `SistOppdatert`

### Skjema
- PK = `<Skjematype_id>`
- RK = `<Skjema_id>` (`SKJ-YYYY-NNN`)
- Egenskaper: `JSON` (skjemadata, kompakt eller fullt format), `Fase`, `Innsender_epost`, `SistOppdatert`

### Token
- PK = "Token"
- RK = `<GUID>`
- Egenskaper: `UPN`, `Tilgangstype`, `SkjemaId`, `SkjematypeId`, `Utloper`, `Brukt`, `Forhandsdata`

### Rollemedlemskap
- PK = `<Rolle>` (f.eks. "Emneansvarlig")
- RK = `<Omfang>|<upn>` (f.eks. "CBU2501|user@mil.no")
- Egenskaper: `FN`, `EN`, `EP`, `SistOppdatert`, `Kilde`

### Emner
- PK = `<Termin>` (f.eks. "26V")
- RK = `<EK>-<VK>` (f.eks. "CBU2501-1")
- Egenskaper: `EK`, `VK`, `EN`, `SK`, `SN`, `C`, `Larere` (JSON), `Hovedlarere` (JSON), `LU` (emnebeskrivelse fra FS, lagret som Markdown)

### EmneStudenter
- PK = `<Termin>|<EK>-<VK>`
- RK = `<upn>`
- Egenskaper: `FN`, `EN`, `EP`

### Utsendinger
- PK = `<BatchId>`, RK = `<mottaker>`
- Egenskaper: `SkjematypeId`, `Jti`, `Opprettet`, `KanalHint`, `Prefilled` (JSON),
  `SvarSkjemaId`, `SvarTid`, `SistPurret`, `SenderSkjemaId`, `OpprettetAv`

**Prefilled** styrer felter som er fylt ut på forhånd i utsendings-lenka:

```json
{
  "1-01": ["CBU1503"],
  "1-02": { "emnebeskrivelse": "26H|CBU1503-1" }
}
```

- **Tekstverdi** (`["..."]`) — låses i skjemaet, og tvinges inn igjen ved
  innsending så mottakeren ikke kan endre den.
- **Oppslags-referanse** (`{ "emnebeskrivelse": "<termin>|<EK>-<VK>" }`) — bare
  referansen lagres. Teksten slås opp fra Emner-tabellen når mottakeren åpner
  lenka (`GET /api/utsending/valider`), se `lib/utsending-prefill.js`. Terminen
  er valgfri; utelates den, brukes nyeste versjon av emnet.

  Referansene valideres når utsendingen opprettes — en ukjent emnekode gir 400
  med én gang, i stedet for et tomt felt hos alle mottakerne. Feiler oppslaget
  senere (emnet er borte fra FS), får feltet tom tekst og skjemaet vises
  likevel.

Treffer en prefilled-verdi et **informasjonsfelt**, overstyres feltets
`Tekst.Verdi` i stedet for å sette et svar, og feltets `Format` (Tekst/Markdown)
beholdes — se `frontend/index.html`. Emnebeskrivelsen lagres som Markdown og
rendres dermed med avsnitt og punktlister. Informasjonsfelt lagres ikke med
skjemaet, så teksten er kun til utfylleren; skal den analyseres senere, hentes
den fra Emner-tabellen eller FS.

`Prefilled` har en grense på 30 000 tegn (Table Storage tåler 32 KiB per
egenskap). Overskrides den, feiler utsendingen med melding om hvilken mottaker
og hvor stor verdien var — tidligere ble JSON-en kuttet, og da forsvant hele
prefillen stille.

### Loggtabeller
- **Hendelseslogg** (skjema-lifecycle-events): PK = `<yyyy-MM>`, RK = `<timestamp>-<id>`
- **Jobblogg** (masterdata-refresh): PK = `<jobbtype>`, RK = `<timestamp>`

## Skjema-format

To varianter:

**Fullt format** — brukes under aktiv utfylling og behandling:
```json
{
  "Skjema_id": "SKJ-2026-001",
  "Skjematype_id": "1",
  "Seksjoner": [{
    "Nummer": 1,
    "Overskrift": "...",
    "Felter": [{ "Id": "uuid", "Nummer": 1, "Type": "Tekst", "Svar": ["..."] }]
  }]
}
```

**Kompakt format** — brukes for arkiv/eksport (~0.5-1 KB vs 10-15 KB):
```json
{
  "Skjema_id": "SKJ-2026-001",
  "Skjematype_id": "1",
  "Svar": [
    { "sek": 1, "spm": "01", "sva": ["verdi"] }
  ]
}
```

Konvertering skjer via `api/src/lib/skjema-kompakt.js` (`komprimerSkjema`, `ekspanderSkjema`).

## Blob-containers

- `vedlegg-<skjematype_id>` — vedleggsfiler for skjema av denne typen
- `logoer` — logoer brukt i skjematype-definisjoner
- `krypterte-nokler` — backup av krypteringsnøkler

## Vilkårsmodell (DNF)

Betingelser for `Vises`, `ObligatoriskHvis`, behandlingssteg lagres som:
```json
{
  "EllerAv": [
    { "OgAv": [{ "Felt": "1-01", "Operator": "=", "Verdi": "Ja" }] }
  ]
}
```

Feltreferanse: UUID (foretrukket) eller `<seksjon>-<felt>` (legacy).
Se `api/src/lib/vilkar.js` for evaluering.

## Faste data-oppslag

Dropdown-verdier som hentes fra masterdata:
```json
{
  "Datakilde": "Personer",
  "EllerAv": [
    { "OgAv": [
      { "Kolonne": "EmneHovedlarere", "Operator": "=", "Verdi": "CBU2501" }
    ]}
  ]
}
```

Filterverdi kan være:
- Fast tekst (`"CBU2501"`)
- `$upn` (pålogget bruker)
- UUID/S-FF-referanse til annet felt i skjemaet

Se `api/src/lib/faste-data.js` + `api/src/lib/masterdata/oppslag.js`.

### Rolleoppslag og omfang

Datakilden `Roller` filtreres på `Rolle` (rollenavn), `Omfang`, eller begge —
omfang alene er ikke entydig, siden samme klasse kan ha flere roller. To
betingelser i samme OG-gruppe snittes på verdi.

Omfang matches mot **alias** (`api/src/lib/omfang.js`). Kildene `Klasser` og
`Kull` leverer FS' naturlige nøkkel som verdi — `"FHSBA|22H|A"`, altså
`{studieprogram}|{kullets start-termin}|{klassekode}` — mens rollelista
vedlikeholdes for hånd, der admin typisk skriver klassenavnet slik det står i
nedtrekket. Oppslaget prøver derfor, i denne rekkefølgen:

1. hele nøkkelen — unik og stabil (terminen er kullets start, ikke inneværende)
2. klasse-/kullnavnet fra FilterStudent-metadata (`"KS Kull Rønneberg 22-25"`)
3. klassekoden alene — **ikke unik**, se FILTERSTUDENT-SPEC.md §6 funn 1, og
   godtas bare som alias for den klassen oppslaget gjelder

Kallere som skal treffe én rolle (`Personer`-filteret `Rolle(Omfang)`, dynamisk
behandler) prøver formene i tur og tar første treff. Filtre matcher mot hele
settet.

## Behandlingssteg — dynamisk rolleomfang

Et steg peker på behandlere via `Personer`, `Roller` og `Team`. Rollestrenger er
`"Rolle"` eller `"Rolle(Omfang)"`.

Omfanget kan hentes fra innsenderens eget svar — «behandleren er klassesjefen
for klassen kadetten oppga»:

```json
{
  "Steg": 1,
  "Stegnavn": "Klassesjefens vurdering",
  "Roller": ["Klassesjef({2-01})"],
  "Reserverolle": "Sjef(Befalsskolen)"
}
```

Ved innsending (`POST /api/skjemaer`, status → 2) skjer følgende i
`api/src/lib/dynamisk-rolle.js`:

1. Feltreferansen (`{<seksjon>-<felt>}` eller `{<UUID>}`) slås opp i svarene.
2. Er verdien en sammensatt FS-nøkkel, prøves alias-formene over, og den som
   faktisk har innehavere velges. Finnes ingen, brukes klassenavnet — den mest
   lesbare formen — så hendelsesloggen viser admin hvilken rolle som mangler.
3. Malen lagres i `RollerMal`, resultatet skrives til `Roller`:
   `"Klassesjef(MILM23-1)"`.
4. Har ingen av stegets roller innehavere, legges `Reserverolle` til i tillegg,
   og hendelsen `behandling.uten-behandler` logges.

Ekspansjonen skjer **én gang**, ved innsending — ikke ved hvert oppslag. På
skjematyper med `Krypteres: "Svar"|"Alt"` ligger svaret som chiffertekst, og
tilgangssjekken kjører før dekryptering. Sendes skjemaet inn på nytt etter
ompuss, ekspanderes det på nytt fra `RollerMal`.

Det er rollestrengen — ikke personene — som fryses: legges klassesjefen inn i
rollelista i etterkant, får steget behandler uten at skjemaet må røres.

Er feltet ubesvart, beholdes malen uendret i `Roller` (steget får ingen
behandler, og `behandling.rolle.ekspandert` logger det som uløst).

## Visningstekst for valglister (`SvarTekst` / `svt`)

Valglister lagrer **verdien**, ikke teksten: en klasse blir FS-nøkkelen
`"FHSBA|22H|A"`, en person blir UPN, en rolle blir `"Klassesjef(...)"`. Ved
innsending lagres derfor også teksten som sto i nedtrekket:

```json
{ "Nummer": 1, "Type": "Flervalg-dropdown",
  "Svar": ["FHSBA|22H|A"],
  "SvarTekst": ["KS Kull Rønneberg 22-25"] }
```

Kompakt format bruker `svt` ved siden av `sva`. Feltet skrives bare når teksten
skiller seg fra verdien (`svarTekstFor()` i `frontend/js/felt-render.js`), så
fritekstfelt får det aldri.

`SvarTekst` er svarinnhold og krypteres på lik linje med `Svar` — den kan
inneholde navn.

Teksten lagres fordi valglista er ferskvare: FS-data oppdateres, roller endres,
og filtrerte lister (`Studenter{Klasse}`) kan ikke gjenskapes uten svarene de
var filtrert på. Arkivet skal vise det innsenderen faktisk valgte.

Visning bruker teksten når den finnes, ellers slås verdien opp i feltets
`Valg`-liste, ellers vises råverdien. Det gjelder behandlingssiden, visning,
register, PDF og datauttrekk. Rapportmotoren filtrerer fortsatt på **verdien** —
filtre skal matche det som er lagret, ikke visningsteksten.
