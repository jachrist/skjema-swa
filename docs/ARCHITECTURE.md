# Arkitektur

## Overordnet

```
[Nettleser]
    │
    │ HTTPS
    ▼
[Static Web App]  ←— CDN for statiske filer
    │
    ├─ /                 → frontend/*  (statisk)
    ├─ /.auth/*          → SWA innebygd Entra ID
    └─ /api/*            → Managed Functions (api/)
                              │
                              │ Managed Identity (DefaultAzureCredential)
                              ▼
                    ┌─────────────────────────┐
                    │  Table Storage          │
                    │  Blob Storage           │
                    │  Key Vault              │
                    └─────────────────────────┘
                              │
                              │ HTTP (utgående)
                              ▼
                    ┌─────────────────────────┐
                    │  FS API                 │
                    │  Power Automate-flyter  │
                    │    (e-post, varsling,   │
                    │     SP-liste)           │
                    └─────────────────────────┘
```

## Frontend

- Ren HTML/CSS/JS med ES-moduler. Ingen rammeverk, intet byggsteg utover config.js-generering.
- `frontend/js/config.js` genereres av `scripts/build-config.js` fra `config/env.<miljø>.json` under deploy.
- Auth via SWA's `/.auth/*`-endepunkter. `hentInnloggetBruker()` returnerer `clientPrincipal` fra `.auth/me`.
- Alle API-kall går gjennom `api-client.js` som sentral fetch-wrapper.
- HTML-filer har inline styling (`<style>`) og logikk (`<script type="module">`). Delt JS ligger i `frontend/js/`.

## API-lag

- Azure Functions v4 (programmatic model), Node 22. Kun HTTP-triggere.
- Hver funksjon er en modul i `api/src/functions/` som kaller `app.http()` ved require.
- `api/src/index.js` samler require-kallene.
- Delt logikk i `api/src/lib/` — storage, blob, keyvault, auth, tilgang, vilkår, etc.
- Auth: SWA leverer verifisert `x-ms-client-principal`-header. `hentInnloggetUpn()` parser og returnerer UPN.
- Ingen connection strings — kun `STORAGE_ACCOUNT_NAME` + `KEYVAULT_NAME` i env, resten via Managed Identity.

## Konfigurasjon

- `config/env.development.json` og `config/env.production.json` er sannhetskilden.
- Hver oppføring er enten:
  - `{ "value": "...", "public": true|false }` — direkte verdi
  - `{ "keyvault": "secret-navn" }` — referanse til Key Vault
- Ikke-hemmelige `public: true`-verdier eksponeres til frontend via `config.js`.
- Ikke-hemmelige `public: false`-verdier settes som App Settings på SWA under deploy.
- `keyvault`-referanser leses ved behov via `hentHemmelighet('secret-navn')` (5-min cache).

## CI/CD

- **CI (`ci.yml`)**: kjører på PR mot `main`. `npm ci` + `npm test` + `build-config.js`.
- **Deploy (`deploy.yml`)**: kjører på push til `main`. Environment `production` → required reviewer.
- **Refresh-FS (`refresh-fs.yml`)**: schedule cron daglig 04:00 UTC → HTTP-kall mot `/api/refresh-fs`.

## Miljøer

- **development**: SWA-slot for utvikling og test. Ikke bak review, deployes automatisk fra feature-branches (planlagt utvidelse).
- **production**: Push til `main` → deploy krever manual approval av en reviewer i `production`-environment.

## Sikkerhetsprinsipper

- Managed Identity everywhere. Ingen langlevede tokens.
- Key Vault som eneste hemmelighetslager. Env-JSON committes, secrets ikke.
- Branch protection på `main`: PR påkrevd, 1+ review, signerte commits, "include administrators".
- CODEOWNERS på `.github/`, `config/`, `staticwebapp.config.json`.
- GitHub push protection + secret scanning slått på.
- Deploy-identitet minst-privilegert: kun deploy til én SWA.
