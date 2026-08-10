# Deploy og engangsoppsett

## Første oppsett i Azure

### 1. Ressursgruppe

Bruk eksisterende `FHS-skjema` (Norway East eller West Europe).

### 2. Storage-konto

- Navn: `stfhsskjemapilot` (må være globalt unikt — bruk suffix hvis opptatt)
- SKU: Standard LRS
- Region: matcher ressursgruppa
- Kryptering: standard (Microsoft-managed keys)

### 3. Key Vault

- Navn: `kv-fhsskjema-pilot` (må også være globalt unikt)
- Region: matcher ressursgruppa
- Purge protection: **på** (kan ikke skrus av senere — vurder for pilot)
- RBAC-basert access (ikke access policies)

### 4. Application Insights

- Navn: `ai-fhsskjema-pilot`
- Ressurstype: Application Insights (klassisk eller workspace-basert)

### 5. Static Web App

- Navn: `swa-fhsskjema-pilot`
- **Plan: Standard (~$9/mnd)** — Free-plan støtter IKKE Managed Identity, custom Entra-registrering eller egendefinerte roller basert på Entra-grupper. Free duger kun til statisk hosting med SWA sin delte auth-provider.
- Region: **West Europe** (SWA støttes ikke i Norway East)
- Deployment source: GitHub → `jachrist/skjema-swa`
- Branch: `main`
- Build presets: Custom
  - App location: `frontend`
  - Api location: `api`
  - Output location: (tom)

**Standard-planens fordeler vi bruker:**
- System-assigned managed identity mot Storage og Key Vault (ingen connection strings i env)
- Custom AAD-registrering med `clientSecret` — låser innlogging til én tenant
- Egendefinerte roller (`admin`) kan tildeles via Entra-grupper (ikke bare per-bruker)
- Private endpoints (senere aktivering)

**Oppgrader fra Free til Standard:** SWA-ressurs → **Hosting plan** → velg Standard → Apply. Kan gjøres uten downtime.

Etter opprettelse (og oppgradering til Standard):
- Slå på **system-assigned managed identity** under Identity
- Under IAM på storage-kontoen: gi MI'en `Storage Table Data Contributor` + `Storage Blob Data Contributor`
- Under IAM på Key Vault: gi MI'en `Key Vault Secrets User`
- Under Environment variables: sett `STORAGE_ACCOUNT_NAME`, `KEYVAULT_NAME`, `ADMIN_UPNS`, `AAD_CLIENT_ID`, `AAD_CLIENT_SECRET`, `MILJO`
- Under Configuration: legg til enhver `public: false`-verdi fra `env.production.json` som ikke er Key Vault-referanse

### 6. Entra ID app-registrering (for auth)

- Navn: `swa-fhsskjema-pilot-auth`
- Supported account types: single tenant
- Redirect URI: `https://<swa-navn>.<random>.azurestaticapps.net/.auth/login/aad/callback`
- Etter opprettelse:
  - Kopier `Application (client) ID` → sett som `AAD_CLIENT_ID` i SWA Environment variables
  - Under **Certificates & secrets** → New client secret → kopier verdien → sett som `AAD_CLIENT_SECRET` i SWA Environment variables (kun synlig én gang!)
  - Under **Authentication**: slå på `ID tokens` under Implicit grant
- Oppdater `staticwebapp.config.json`: legg tilbake `auth`-blokken med:
  ```json
  "auth": {
      "identityProviders": {
          "azureActiveDirectory": {
              "registration": {
                  "openIdIssuer": "https://login.microsoftonline.com/<TENANT-ID>/v2.0",
                  "clientIdSettingName": "AAD_CLIENT_ID",
                  "clientSecretSettingName": "AAD_CLIENT_SECRET"
              }
          }
      }
  }
  ```
- Bytt `<TENANT-ID>` med faktisk tenant-ID (fra Entra ID overview i portalen)

### 7. GitHub-side

- Legg til environment `production` i repo settings → Environments
- Sett required reviewer på `production`-environment
- Legg til secret `AZURE_STATIC_WEB_APPS_API_TOKEN` (hentes fra SWA → Manage deployment token)
- Legg til environment variable `SWA_URL` = `https://<swa-navn>.<random>.azurestaticapps.net`
- Legg til secret `SCHEDULER_KEY` (samme verdi som i KV-secret `scheduler-key`)
- Aktiver Dependabot alerts + secret scanning + push protection under Security

## Endepunkt-URLer

- Frontend: `https://<swa-navn>.<random>.azurestaticapps.net/`
- API: `https://<swa-navn>.<random>.azurestaticapps.net/api/*`
- Auth: `https://<swa-navn>.<random>.azurestaticapps.net/.auth/*`

## Test at kjeden virker

Etter første deploy:

1. Åpne `/` — skal vise "Ikke innlogget"
2. Klikk "Logg inn" — Entra ID-flyt starter, redirect tilbake
3. Klikk "Test /api/ping" — skal returnere JSON med tid
4. Klikk "Test /api/hello-storage" — skal skrive én rad + én blob, deretter lese tilbake

Hvis /api/hello-storage feiler med "Forbidden" → MI mangler storage-rolletildeling.
Hvis den feiler med "STORAGE_ACCOUNT_NAME mangler" → env-var er ikke satt i SWA config.

## Rollout til brukere

- Under SWA → Role management: tildel `admin`-rolle til admin-brukere
- Andre brukere er automatisk `authenticated` etter innlogging

## Dual-tenant-oppsett (pilot + prod)

Under utviklings- og testperioden kjører **pilot-tenanten** som
test/utviklingsmiljø. Prod-tenanten opprettes separat og deployes
manuelt når bruker- og aksepansetest er godkjent på pilot.

### Workflows

- **`.github/workflows/deploy-pilot.yml`** — deployer automatisk til pilot
  ved push til `main`. Bygger med `env.pilot.json`.
- **`.github/workflows/deploy-prod.yml`** — trigges kun manuelt fra
  Actions-fanen (`workflow_dispatch`). Krever at operatøren skriver
  `DEPLOY-PROD` som bekreftelse. Bygger med `env.prod.json`.

Samme koden deployes til begge tenanter. Kun `config/env.<miljø>.json`
og GitHub secret for deployment-token skiller dem.

### Sette opp prod-tenant

1. **Repeter Azure-oppsett** (steg 1–5 over) med prod-navn:
   - Ressursgruppe: `FHS-skjema-prod`
   - Storage: `stfhsskjemaprod`
   - Key Vault: `kv-fhsskjema-prod`
   - Application Insights: `ai-fhsskjema-prod`
   - SWA (Standard-plan): `swa-fhsskjema-prod`
2. **Managed Identity + rolletildelinger** — samme som pilot.
3. **Entra app-registrering** for prod (kan være egen, eller gjenbruke
   pilot-appen hvis både pilot og prod aksepteres som redirect URIs).
4. **Sett env-vars i prod-SWA Configuration** — samme sett som pilot,
   men med prod-verdier:
   - `STORAGE_CONNECTION_STRING`
   - `AAD_CLIENT_ID` / `AAD_CLIENT_SECRET`
   - `ADMIN_UPNS`
   - `SWA_URL` (viktig for varsling-lenker!)
   - `FS_*`, `VARSLING_FLOW_URL`, `OTP_FLOW_URL`, `SP_LISTE_FLOW_URL`
   - `OTP_HMAC_KEY`, `FLOW_CALLBACK_KEY`, `SCHEDULER_KEY`, `HASH_SALT`
5. **Kopier deployment-token** fra prod-SWA Overview → Manage
   deployment token → legg som GitHub repo secret
   `AZURE_STATIC_WEB_APPS_API_TOKEN_PROD`.
6. **Fyll ut `config/env.prod.json`** med prod-verdier (STORAGE_ACCOUNT_NAME,
   KEYVAULT_NAME, ADMIN_UPNS).
7. **Opprett GitHub Environment "prod"** (repo Settings → Environments)
   med required reviewer for ekstra godkjenning før deploy kjører.
8. **Trigger prod-deploy** fra Actions-fanen → "Deploy prod" → Run workflow
   → skriv `DEPLOY-PROD` som bekreftelse.

### Cutover fra legacy

Når prod-tenanten er oppe og bruker-/aksepansetestet:

1. Kjør migreringsscript (`scripts/migrer/`) fra legacy-storage til
   prod-storage (Skjemadefinisjoner, Skjemaer, Kryptonokler, vedlegg-blobs).
2. Verifiser at PA-flyter (varsling, OTP, SP-liste) peker riktig for prod.
3. Kommuniser ny URL til brukere.
4. Behold legacy-appen i lese-modus en periode som fallback.
5. Etter stabiliseringsperiode: dekommisjoner legacy.

### Miljø-alias

`build-config.js` godtar disse miljø-navnene:

- `pilot` — leser `env.pilot.json` (samme som gammel `production`)
- `prod` — leser `env.prod.json` (ny)
- `production` — bakoverkompatibelt alias for `pilot`
- `development` / `lokal` — for lokal utvikling

