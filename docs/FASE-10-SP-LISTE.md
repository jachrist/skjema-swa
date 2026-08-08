# Fase 10 — SharePoint-liste-oppdatering

Ved innsending kalles en Power Automate-flyt som oppretter/oppdaterer en
rad i en spesifisert SharePoint-liste med valgte skjema-felter + metadata.

## Datamodell — skjematype (top-level)

```json
{
  "SPListeadresse": "https://tenant.sharepoint.com/sites/mittsite",
  "SPListenavn": "Reiseregninger",
  "SPMetadata": [
    { "Plassholder": "$skjema_id", "SPKolonne": "SkjemaId" },
    { "Plassholder": "$tidspunkt_innsendt", "SPKolonne": "Innsendt" }
  ],
  "SPLagreVedlegg": true
}
```

Og per felt:
```json
{ "Nummer": "01", "Type": "Tall", "SPListefelt": "Belop" }
```

Kun felter med `SPListefelt` sendes.

## Automatisk metadata

`Innsender_Navn` og `Innsender_Epost` skrives alltid til SP-kolonner med
akkurat de navnene (hardkodet — samme som legacy). Admin kan i tillegg
mappe `$innsender` / `$innsender_navn` til andre kolonner via SPMetadata.

## Støttede plassholdere

Kun submit-tid-verdier gir mening her (samme regel som legacy):

| Plassholder | Verdi |
|-------------|-------|
| `$skjema_id` | Skjema-ID |
| `$skjemanavn` | Skjematype-navn |
| `$innsender` | Innsender e-post |
| `$innsender_navn` | Innsender-navn |
| `$tidspunkt` / `$tidspunkt_innsendt` | ISO-tidsstempel |

Steg-spesifikke plassholdere (`$beslutning`, `$stegnavn`, ...) returnerer
null og filtreres bort.

## Payload til SP_LISTE_FLOW_URL

```json
{
  "listeadresse": "https://tenant.sharepoint.com/sites/mittsite",
  "listenavn": "Reiseregninger",
  "data": [
    { "felt": "Innsender_Navn", "format": "tekst", "verdi": "Nordmann, Ola" },
    { "felt": "Innsender_Epost", "format": "tekst", "verdi": "ola@fhs.no" },
    { "felt": "Belop", "format": "tall", "verdi": "1500" },
    { "felt": "SkjemaId", "format": "tekst", "verdi": "1" }
  ],
  "vedlegg": [
    { "name": "kvittering.pdf", "data": "<base64>" }
  ]
}
```

`format` er en av: `tekst`, `tall`, `dato`. `Valuta` konverteres til `tall`
(uten enhets-info).

Multi-svar (flervalg med flere valg) joines med `; ` (semikolon-space).

## Env-vars som må settes i SWA

```
SP_LISTE_FLOW_URL = https://prod-XX.westeurope.logic.azure.com/workflows/...
```

Hvis mangler: SP-integrasjon skippet stille (log).

## PA-flyt-oppsett (skisse)

1. **Trigger:** "When a HTTP request is received" med payload-schema over
2. **Parse** `data`-array
3. **Create item** i SharePoint på angitt listeadresse+listenavn, med
   `data[].felt` → verdi mapping
4. Hvis `vedlegg` er tilstede: **Add attachment** for hver fil (base64-decoded)

## Kall-flyt

- Trigges kun ved innsending (`Skjema_status=2` og `bleInnsendt=true`)
- Non-blocking: feil logges men avbryter ikke innsending
- Kjøres i samme fire-and-forget-batch som varsling og ekstern-flyt

## Editor-UI

- **SharePoint-panel** i editor (mellom Tilgang og Seksjoner):
  - Liste-adresse + liste-navn
  - Metadata-mapping-modal
  - "Legg ved filer"-checkbox
- **Per felt:** SP-kolonne-input vises kun når `SPListeadresse` er satt

## Testing

Sett `VARSLING_DEAKTIVERT=true` for å skru av kall. Loggen viser
`sp-liste DRY-RUN: ...`.

Om flyten feiler: sjekk `sp-liste FEIL: ...` i Application Insights (eller
SWA Log stream). Innsending går uansett gjennom.
