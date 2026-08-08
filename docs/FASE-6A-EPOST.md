# Fase 6a — E-post-varsling

Automatisk e-post ved innsending, behandling og videresending. Bruker SMTP
via `nodemailer` — MS-uavhengig valg som passer inn i exit-strategien.

## Env-vars som må settes i SWA

I Azure Portal → SWA → Configuration:

```
SMTP_HOST         = smtp.office365.com          (eller egen SMTP-server)
SMTP_PORT         = 587                          (STARTTLS) — evt. 465 for SSL
SMTP_USER         = <full e-postadresse>
SMTP_PASS         = <app-passord>                (via @Microsoft.KeyVault(...) anbefalt)
SMTP_FROM         = <avsenderadresse>            (valgfritt, default = SMTP_USER)
SMTP_FROM_NAVN    = FHS Skjema                   (valgfritt, visningsnavn)
SMTP_SECURE       = false                        (true for port 465, false for 587)
SWA_URL           = https://ashy-meadow-...      (base-URL for $lenke)
VARSLING_DEAKTIVERT = true                        (valgfritt — kjør uten å sende)
```

`SWA_URL` er allerede satt i GitHub-vars for FS-cron. Hvis den ikke ligger som
env i selve SWA-en, sett den også der (uten trailing slash).

## Office 365-oppsett (anbefalt for pilot)

1. **App-passord**: Krever at brukerens konto har MFA aktivert. Generer app-passord
   under Microsoft Konto → Sikkerhet → App-passord.
2. **Alternativ — service-konto**: Opprett en dedikert brukerkonto (f.eks.
   `noreply@dinorg.no`), aktiver SMTP AUTH på den (Exchange-admin), lag app-passord.
3. **SMTP AUTH i tenant**: Kan være deaktivert som default i M365 — må aktiveres
   per postboks via `Set-CASMailbox -Identity <user> -SmtpClientAuthenticationDisabled $false`.

**Dokumentasjon**: <https://learn.microsoft.com/exchange/clients-and-mobile-in-exchange-online/authenticated-client-smtp-submission>

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
| `$rolle` | Rolle-streng (fra Roller-array) |
| `$tidspunkt` | Nåværende dato/tid (Europe/Oslo) |
| `$navn` | Mottaker-navn (per-mottaker) |
| `$frist` | Frist-dato (hvis satt) |
| `$dagerTilFrist` | Antall dager |
| `{N-NN}` | Svar på felt (seksjon-felt), f.eks. `{1-02}` |
| `{UUID}` | Svar på felt via stabil Id |

## Kall-flyt

**Ved innsending** (`POST /api/skjemaer` med Skjema_status=2):
- `sendInnsenderKvittering` — én e-post til innsender
- `sendVarslingAktiveSteg` — én e-post til hver behandler-liste per aktive steg

**Ved beslutning** (`POST /api/skjemaer/.../beslutning`):
- `sendBeslutningVarsling` — én e-post til innsender med utfall
- `sendVarslingAktiveSteg` for nye aktive steg (etter skip-kaskade)

**Ved videresending** (`POST /api/skjemaer/.../videresend`):
- `sendBehandlerVarsling` — kun til den nye mottakeren (ikke hele lista)

Alle kall er **fire-and-forget** — feil i SMTP feiler ikke selve handlingen.
Feil logges i Application Insights via `context.log`.

## Test

Sett `VARSLING_DEAKTIVERT=true` for å kjøre uten faktisk utsending — hver ville-vært-send
logges til Application Insights som `epost DRY-RUN: ...`.

Full test: send inn et skjema med behandlingssteg. Sjekk at:
1. Innsender får kvittering
2. Behandler(e) får varsling
3. Ved beslutning: innsender får utfall-melding, neste steg får varsling

## Neste

Fase 6b: HTML-editor for tilpasning av melding-maler.
