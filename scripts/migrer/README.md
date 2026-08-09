# Migreringsscript

Kopierer alle relevante Table Storage-tabeller og Blob-vedlegg fra én
Azure storage-konto til en annen. Kjøres lokalt av admin — ikke deployet.

## Bruksscenario

- Kopiere legacy prod-data til pilot-storage for realistiske tester
- Flytte pilot-data til dev-storage
- Ved endelig prod-switch: kopiere data fra pilot til ny prod-storage

## Forutsetninger

- Node.js 22+ installert
- Tilgang til begge storage-konti (connection strings)
- Full read-tilgang på kilde, write-tilgang på mål

## Installasjon

```bash
cd scripts/migrer
npm install
```

## Bruk

### 1. Hent connection strings

I Azure Portal for hver konto:
- Storage account → **Access keys** → kopier "Connection string" (key1 eller key2)

Format:
```
DefaultEndpointsProtocol=https;AccountName=<navn>;AccountKey=<hemmelig>;EndpointSuffix=core.windows.net
```

### 2. Kjør tørrkjøring først

Alltid `--dry-run` først for å se hva som ville blitt kopiert:

```bash
node migrer.js \
  --kilde-cs "DefaultEndpointsProtocol=...;AccountName=stfhslegacy;..." \
  --mal-cs "DefaultEndpointsProtocol=...;AccountName=stfhsswapilot;..." \
  --dry-run
```

Output viser antall entiteter per tabell + antall blobs uten å skrive noe.

### 3. Kjør full migrering

Fjern `--dry-run`:

```bash
node migrer.js \
  --kilde-cs "..." \
  --mal-cs "..."
```

Alternativt via env-vars (unngår å lekke keys i shell-historie):

```bash
export MIGRER_KILDE_CS="DefaultEndpointsProtocol=https;AccountName=legacy;..."
export MIGRER_MAL_CS="DefaultEndpointsProtocol=https;AccountName=pilot;..."
node migrer.js
```

### 4. Selektiv migrering

Kopier kun spesifikke tabeller:

```bash
node migrer.js --tabell Skjemadefinisjoner --tabell Kryptonokler
```

Kun blobs:

```bash
node migrer.js --kun-blobs
```

Kun tabeller (hopp over vedlegg-kopiering — nyttig for rask test):

```bash
node migrer.js --kun-tabeller
```

Se `node migrer.js --help` for full liste.

## Hva som kopieres

**Tabeller** (i denne rekkefølgen, avhengigheter først):

| Tabell | Formål | Kritisk? |
|--------|--------|----------|
| Skjemadefinisjoner | Skjematyper (mal) | Ja |
| Kryptonokler | Nøkler for krypterte skjemaer | **Ja — mister krypterte skjemaer uten** |
| Skjemaer | Alle innsendte skjema-forekomster | Ja |
| Rollemedlemskap | Rolle-tildelinger | Ja hvis rolle-tilgang brukes |
| Emner | FS-masterdata | Nei (kan re-genereres via refresh-fs) |
| EmneStudenter | FS-masterdata | Nei (samme) |
| Postnumre | Postnummer-oppslag | Nei (kan re-seedes) |
| Tilgangskontroll | Tokens + OTP-koder | Nei (ephemeral, vil uansett utløpe) |
| CacheMetadata | Sist-refresh-info | Nei (informativt) |

**Blob-containere:**

| Container | Innhold |
|-----------|---------|
| vedlegg | Alle opplastede filer på skjemaer |

## Idempotens

Scriptet bruker `upsert` for tabellrader og skip-hvis-lik-størrelse for blobs.
Kan kjøres flere ganger — nye entiteter i kilden legges til, eksisterende
overskrives.

**NB:** Sletting i kilden reflekteres IKKE i målet. Scriptet kopierer kun,
det synkroniserer ikke. Hvis mål har entiteter kilde ikke har, blir de stående.

## Sikkerhet

- **Connection strings inneholder access keys** — lekker de, får leseren full
  tilgang til storage-kontoen. Ikke committ dem, ikke lim inn i chat/e-post.
- Bruk env-vars fremfor CLI-args for å unngå shell-historikk-lekasje.
- Etter migrering: vurder å **rotere access keys** på legacy-kontoen hvis
  scriptet ble kjørt fra en delt maskin.
- Overføring skjer over HTTPS. Ingen data mellomlagres lokalt (utover
  in-memory-buffer for hver blob i overføringsøyeblikket).

## Kryptonokler-advarsel

Kryptonokler-tabellen inneholder AES-256-nøklene som beskytter innsendte
skjemasvar. Uten disse kan krypterte skjemaer aldri leses igjen.

- Ta alltid en manuell backup av Kryptonokler før migrering (kan gjøres
  via Azure Storage Explorer — eksporter til JSON)
- Ved endelig prod-switch: sjekk at Kryptonokler er komplett i det nye målet
  FØR legacy-kontoen slettes

## Restaure

Scriptet er symmetrisk — bytt `--kilde-cs` og `--mal-cs` for å reversere.
Restaure av backup-ZIP (fase backup) er en separat prosess — se
`scripts/restaure/` når den er implementert.

## Ytelse

- Tabellkopiering: ~500 entiteter/s (typisk)
- Blobs: begrenset av båndbredde + fil-størrelse. ~10-50 MB/s over
  internett, avhengig av region og filstørrelse
- Full pilot-storage (10-50 skjemaer + noen MB vedlegg): under 1 min
- Full prod-storage (tusener av skjemaer + GB vedlegg): kan ta timer

Kjør fra en maskin nær storage-regionen (helst Azure VM i samme region)
for optimal ytelse på store datasett.

## Ved feil

Scriptet fortsetter selv om enkelt-tabeller/blobs feiler. Ved slutten
vises et sammendrag med feilantall. Exit-kode:

- `0` — alt OK
- `2` — noen entiteter/blobs feilet (se logg)
- `3` — uventet feil under kjøring
- `1` — ugyldige argumenter
