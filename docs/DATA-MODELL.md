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
- Egenskaper: `EK`, `VK`, `EN`, `SK`, `SN`, `C`, `Larere` (JSON), `Hovedlarere` (JSON), `LU`

### EmneStudenter
- PK = `<Termin>|<EK>-<VK>`
- RK = `<upn>`
- Egenskaper: `FN`, `EN`, `EP`

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

Omfang sammenlignes **normalisert**: siste ledd etter `|` på begge sider
(`api/src/lib/omfang.js`). Kildene `Klasser` og `Kull` leverer sammensatte
nøkler (`"FHSBA|22H|KS Kull Rønneberg 22-25"`), mens rollelista vedlikeholdes på
ren kode. Det samme gjelder omfanget i `Personer`-filteret `Rolle(Omfang)` og i
dynamiske rolleomfang på behandlingssteg.

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
2. Er verdien en sammensatt FasteData-nøkkel (`"BMIL|2025H|MILM23-1"`), brukes
   siste ledd — rollelista vedlikeholdes på ren klassekode.
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
