# Fase 6a — E-post-varsling via Power Automate

Automatisk e-post ved innsending, behandling og videresending. Bruker eksisterende
`VARSLING_FLOW_URL` Power Automate-flyt (samme som legacy).

**Hvorfor PA-flyt og ikke SMTP:** Varslingssystemet er MS-sentrisk uansett
(Teams-varsler, Planner-oppgaver kommer senere). PA-flyten sender via M365-brukerens
egne rettigheter — ingen SMTP AUTH-oppsett, ingen app-passord, ingen KV-hemmelighet.
Ved evt. exit fra Microsoft må hele varslingslaget uansett skiftes ut, så SMTP-porting
gir ingen langsiktig gevinst.

## Env-vars som må settes i SWA

I Azure Portal → SWA → Configuration:

```
VARSLING_FLOW_URL     = https://prod-XX.northeurope.logic.azure.com/workflows/.../triggers/manual/paths/invoke?...
SWA_URL               = https://ashy-meadow-0f2a44503.7.azurestaticapps.net
VARSLING_DEAKTIVERT   = true    (valgfritt — kjør uten faktisk utsending, alt logges)
```

`VARSLING_FLOW_URL` er samme URL som legacy — kan gjenbrukes direkte fra
prod-miljøet så lenge pilot-brukerne har rett til å kalle den. For pilot i egen
tenant må enten:
- Bruke legacy-flyten (deler samme URL/nøkkel), eller
- Kopiere flyten til pilot-tenant og bruke den nye URL-en

## Payload-kontrakt (mot VARSLING_FLOW_URL)

Fase 6a sender alltid `varslinger: ['epost']`. Fase 6c/d utvider med
`'teams'`, `'planner'`, `'teamskanal'` — flyten støtter det allerede.

```json
{
  "handling": "sendBehandlingsVarsling",
  "mottakere": [{ "epost": "ola@fhs.no", "navn": "Nordmann, Ola" }],
  "varslinger": ["epost"],
  "skjema_id": "1",
  "skjematype_id": "108",
  "skjema_navn": "Test fase 5c",
  "stegnavn": "Godkjenning",
  "lenker": [{ "epost": "ola@fhs.no", "url": "https://.../evaluering.html?..." }],
  "base_url": "https://ashy-meadow-....azurestaticapps.net",
  "epost_og_teams": {
    "emne": "Skjema til behandling: \"Test fase 5c\"",
    "html": "<p>Du har fått ...</p>"
  }
}
```

Plassholdere i emne+html er ferdig-substituert av backend før kallet — flyten
gjør ingen fletting.

## Datamodell — skjematype-utvidelse

**Top-level (innsender-kvittering):**
```json
{
  "Innsenderkvittering": {
    "Aktiv": true,
    "Emne": "Kvittering: \"$skjemanavn\" er sendt inn",
    "Tekst": "<p>Vi har mottatt skjemaet \"$skjemanavn\" ($skjema_id).</p>..."
  }
}
```

**Per behandlingssteg:**
```json
{
  "Behandling": [{
    "Steg": 1,
    "Varsling": ["epost"],
    "TilBehandler": {
      "Emne": "Skjema til behandling: \"$skjemanavn\"",
      "Tekst": "<p>...</p>"
    },
    "FraBehandler": [
      { "BeslutningNr": 1, "Emne": "...", "Tekst": "..." },
      { "BeslutningNr": 2, "Emne": "...", "Tekst": "..." }
    ]
  }]
}
```

**Default-oppførsel** hvis felter mangler:
- `Innsenderkvittering.Aktiv` ikke satt → standard-mal brukes (Aktiv=true)
- `Varsling` ikke satt → e-post på (backward-kompatibelt)
- `TilBehandler`/`FraBehandler` ikke satt → standard-maler brukes

## Placeholders

Alle støttede plassholdere:

| Plassholder | Verdi |
|-------------|-------|
| `$lenke` | Lenke til skjemaet (SWA_URL + evaluering.html) |
| `$innsender` | Innsender-e-post |
| `$innsender_navn` | Innsender-navn |
| `$skjemanavn` | Skjematype-navn |
| `$skjema_id` | Skjema-ID |
| `$beslutning` | Beslutning-tekst (kun i FraBehandler) |
| `$kommentar` | Behandler-kommentar |
| `$stegnavn` | Steg-navn |
| `$rolle` | Rolle-streng |
| `$tidspunkt` | Nåværende dato/tid (Europe/Oslo) |
| `$navn` | Mottaker-navn (per-mottaker) |
| `$frist` | Frist-dato (hvis satt) |
| `$dagerTilFrist` | Antall dager |
| `{N-NN}` | Svar på felt (seksjon-felt), f.eks. `{1-02}` |
| `{UUID}` | Svar på felt via stabil Id |

## Kall-flyt

**Ved innsending** (`POST /api/skjemaer` med Skjema_status=2):
- `sendInnsenderKvittering` — kall til innsender
- `sendVarslingAktiveSteg` — kall per aktive steg (én mottaker-batch per steg)

**Ved beslutning** (`POST /api/skjemaer/.../beslutning`):
- `sendBeslutningVarsling` — kall til innsender med utfall
- `sendVarslingAktiveSteg` for nye aktive steg (etter skip-kaskade)

**Ved videresending** (`POST /api/skjemaer/.../videresend`):
- `sendBehandlerVarsling` — kun til den nye mottakeren

Alle kall er **fire-and-forget** — feil i flyten feiler ikke selve handlingen.
Feil logges i Application Insights via `context.log`.

## Test

Sett `VARSLING_DEAKTIVERT=true` for å kjøre uten faktisk kall — hvert kall
logges som `flyt DRY-RUN: ...` i Application Insights.

Full test: send inn et skjema med behandlingssteg. Sjekk at:
1. Innsender får kvittering
2. Behandler(e) får varsling
3. Ved beslutning: innsender får utfall-melding, neste steg får varsling

## Neste

Fase 6b: HTML-editor for tilpasning av melding-maler.  
Fase 6c: Teams-varsler (utvid `varslinger: ['epost','teams']`).  
Fase 6d: Planner-oppgaver (utvid med Planner-payload).
