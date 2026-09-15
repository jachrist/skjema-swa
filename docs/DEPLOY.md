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
- Oppdater `staticwebapp.config.<miljø>.json` (pilot eller prod — rot-fila er
  generert og ikke i repoet): legg tilbake `auth`-blokken med:
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
2. **Managed Identity + rolletildelinger** — samme som pilot,
   pluss **`Key Vault Certificate User`** og **`Key Vault Secrets User`**
   for sertifikat-basert AAD-auth (se «Sertifikat-oppsett for prod» under).
3. **Entra app-registrering** for prod — kan levere sertifikat-basert
   client credential (ingen ClientSecret nødvendig). Se
   «Sertifikat-oppsett for prod» under.
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

Ved hvert bygg kopieres også `staticwebapp.config.<miljø>.json` →
`frontend/staticwebapp.config.json`, som er den SWA faktisk leser, og til en
kopi i roten til lokal referanse. Begge kopiene er gitignorert; kildene er
miljøvariantene. Pilot bruker ClientSecret, prod bruker sertifikat-referanse.

## Pålogging på pilot fra utviklingstenanten

Pilot/dev logget opprinnelig inn mot pilot-tenanten
(`e4fcc393-7190-4d3d-a38d-fa6429f870f3`). Testbrukerne der er syntetiske og
**uten lisenser**, så de har hverken postboks, Teams-medlemskap eller noe
annet som krever lisens — epostutsending, teamoppslag og varsling kunne
derfor ikke testes ende-til-ende.

Pilot bruker derfor nå utviklingstenanten `jccodevel.onmicrosoft.com`
(`02ff6bc3-07c5-4ed5-835e-5c68c26ab8eb`) som identitetsleverandør. SWA-en
ligger fortsatt i pilot-tenanten — en Static Web App trenger ikke å være i
samme tenant som app-registreringen den logger inn mot. **Prod er urørt**;
den leser `staticwebapp.config.prod.json` med sin egen issuer.

### Engangsoppsett

1. **App-registrering i utviklingstenanten** (krever bare Entra ID, ingen
   Azure-subscription):
   - Navn: `swa-fhsskjema-pilot-auth`
   - Supported account types: **single tenant**
   - Redirect URI (Web): `https://<swa-navn>.<random>.azurestaticapps.net/.auth/login/aad/callback`
   - **Authentication** → slå på `ID tokens` under Implicit grant
   - **Certificates & secrets** → New client secret (verdien vises kun én gang)
2. **Sett nøklene i pilot-SWA-ens Configuration** (i pilot-tenanten):
   - `AAD_CLIENT_ID` = Application (client) ID fra den nye registreringen
   - `AAD_CLIENT_SECRET` = hemmeligheten fra steg 1
   - Restart SWA-en etterpå.
3. `openIdIssuer` i `staticwebapp.config.pilot.json` peker allerede på
   utviklingstenanten. Den trer i kraft ved neste deploy til pilot.

> Issuer-en skal **aldri** settes til `/common/` eller `/organizations/` —
> da er innlogging åpen for alle tenanter. `api/test/swa-config.test.js`
> feiler hvis det skjer.

### UPN-omlegging

Alle innlogginger får nye UPN-er (`@jccodevel.onmicrosoft.com`), og UPN er
nøkkelen overalt i løsningen. Rekkefølgen er viktig — **`ADMIN_UPNS` først**,
ellers står du uten admin-tilgang på pilot:

1. `ADMIN_UPNS` i pilot-SWA Configuration — legg inn de nye admin-UPN-ene
   *ved siden av* de gamle i overgangsperioden, og fjern de gamle først når
   innlogging med ny tenant er verifisert.
2. `Rollemedlemskap`-tabellen — roller per UPN.
3. Publikum og Eiere på skjematypene (settes i editoren).
4. `Teammedlemskap`-cachen — flyten som fyller den må hente fra
   utviklingstenanten for dev (se `docs/FLYTER.md`).
5. `GRAPH_TENANT_ID` / `GRAPH_CLIENT_ID` / `GRAPH_CLIENT_SECRET` hvis
   Graph-oppslag (SharePoint-backup) skal kjøre mot samme tenant.

Gamle FHS-testbrukere kan ikke logge inn på pilot etter omleggingen med
mindre de inviteres som gjester i `jccodevel` — og gjester tar ikke med seg
lisensene sine, så de får fortsatt ikke postboks eller teammedlemskap.

### Første innlogging etter en endring i Configuration

`admin`-rollen settes **én gang, ved innlogging**: SWA kaller `/api/roller-swa`
med kort tidsfrist og legger svaret inn i sesjonen. Rekker ikke kallet fram,
logges brukeren inn uten ekstra roller — uten feilmelding noe sted.

Å endre en app setting restarter Functions-appen. Den første innloggingen etter
en restart treffer derfor en kald app, og kaldstarten er ofte tregere enn
fristen. Utslaget er at `/admin.html` er stengt selv om `ADMIN_UPNS` er helt
riktig; `/api/whoami` svarer samtidig `erAdmin: true`, fordi den leser samme
env-var uten å gå via rollekallet.

Så etter hver endring i Configuration:

1. Kall `/api/ping` til den svarer med én gang — da er appen varm.
2. `/.auth/logout` (ikke bare lukk fanen — auth-cookien bærer de gamle rollene).
3. Logg inn på nytt.

Diagnosen, hvis rollen fortsatt mangler — `erAdmin: true` fra `/api/whoami`
mot `userRoles` i `/.auth/me` skiller verdien fra rollekallet, og i
Application Insights viser

```kusto
requests
| where url contains "roller-swa"
| project timestamp, resultCode, duration, success
| order by timestamp desc
```

om kallet i det hele tatt kom fram. Ingen rader betyr at `rolesSource` ikke er
i kraft; høy `duration` eller feilkode betyr kaldstart.

Merk at et eksternt kall mot `/api/roller-swa` svarer **404**. Plattformen
skjermer ruter som er satt opp som `rolesSource`, så 404 der betyr at ruten
er gjenkjent — ikke at funksjonen mangler.

### Lisensgrense

Utviklingstenanten har **23 ledige lisenser**. Antall testbrukere må derfor
holdes under det taket — de syntetiske brukerne fra pilot-tenanten skal
*ikke* kopieres over én-til-én. Velg et minimumsutvalg som dekker rollene
som faktisk testes:

- 1–2 administratorer (`ADMIN_UPNS`)
- 1 skjemaeier per skjematype som testes
- 2–3 behandlere, fordelt på de teamene som brukes i teammedlemskap-testen
- 2–3 ordinære innsendere
- 1 bruker uten roller (negativ test på tilgang)

Eksterne innsendere trenger ingen lisens — de går via engangskode/OTP og
skal testes med en adresse utenfor tenanten.

`scripts/opprett-testbrukere.ps1` oppretter nøyaktig dette utvalget. Det
verifiserer først at du er logget inn i riktig tenant (domenet må være
verifisert der), teller ledige seter før det oppretter noe, og er idempotent
— en bruker som finnes fra før hoppes over. Engangspassordene skrives ut én
gang og lagres ikke.

```powershell
az login --tenant 02ff6bc3-07c5-4ed5-835e-5c68c26ab8eb --allow-no-subscriptions
.\scripts\opprett-testbrukere.ps1 -Domene jccodevel.onmicrosoft.com -VisLisenser
.\scripts\opprett-testbrukere.ps1 -Domene jccodevel.onmicrosoft.com -TorrKjor
.\scripts\opprett-testbrukere.ps1 -Domene jccodevel.onmicrosoft.com
```

## Sertifikat-oppsett for prod

Prod-tenanten bruker **sertifikat-basert AAD-auth** i stedet for
ClientSecret. Dette matcher sikkerhetsprofilen til app-registreringen
`fhs-adminskjema-api` og krever ingen roterende passord.

Referanse:
[Custom certificate for Azure AD in SWA](https://learn.microsoft.com/en-us/azure/static-web-apps/authentication-custom?tabs=aad#custom-certificate)

### Forutsetning

- **ID-token må være slått på.** Entra ID → App registrations → appen →
  **Authentication** → *Implicit grant and hybrid flows* → huk av
  **«ID tokens (used for implicit and hybrid flows)»**.

  SWA bruker hybrid flow (`response_type=code+id_token`). Uten dette avviser
  Entra hver eneste innlogging med

  ```
  AADSTS700054: response_type 'id_token' is not enabled for the application
  ```

  Feilen kommer fra Entra, ikke fra SWA, så den ser ut som noe galt med
  redirect-URI-en. Det er den ikke. Slår gjennom umiddelbart, uten deploy.
- App-registrering i prod-tenanten med sertifikat-basert client credential
  (thumbprint registrert som Certificate på app-en i Entra ID)
- Sertifikat-filen (PFX med private key) tilgjengelig, eller admin
  laster opp direkte til vår prod-KV

### Steg-for-steg

1. **Last opp sertifikatet til prod-KV som Certificate** (ikke Secret).
   Bruker portal-UI eller CLI:
   ```
   az keyvault certificate import \
     --vault-name kv-fhsskjema-prod \
     --name fhs-adminskjema-cert \
     --file <sti>/certificate.pfx \
     --password <pfx-passord>
   ```
2. **Aktiver system-assigned Managed Identity på SWA** (kan gjøres via
   portal → Identity → System assigned → On).
3. **Tildel MI følgende KV-roller:**
   - `Key Vault Certificate User` — for å lese sertifikatet
   - `Key Vault Secrets User` — for å lese secret-representasjonen KV
     lager automatisk for hvert sertifikat
4. **Sett env-var `AAD_CLIENT_ID`** i SWA Configuration = Client ID fra
   app-registreringen.
5. **Fyll ut `staticwebapp.config.prod.json`** i repo — bytt ut
   placeholderene:
   - `<PROD_TENANT_ID>` → prod-tenant sin ID (fra app-registrering-info)
   - `<PROD_KV_NAME>` → f.eks. `kv-fhsskjema-prod`
   - `<CERT_NAME>` → f.eks. `fhs-adminskjema-cert`
6. **Commit og push** — pilot-deploy trigges automatisk (ingen effekt
   siden pilot-config er separat).
7. **Trigger prod-deploy** manuelt fra Actions-fanen.

### Verifikasjon

- Åpne prod-SWA-URL i inkognito
- Skal redirecte til Entra-login på prod-tenant
- Etter innlogging: `.auth/me` skal returnere `identityProvider: "aad"`
  med `userDetails` = UPN

### Feilsøking

Hvis auth feiler:
- Sjekk at MI har begge KV-roller (Certificate User + Secrets User)
- Sjekk at sertifikatet i KV har private key (må importeres som PFX,
  ikke bare public-cert)
- Sjekk at thumbprint i app-registreringen matcher sertifikatet i KV
- Sjekk at Application ID URI matcher redirect URI konfigurert på
  app-registreringen: `https://<swa-url>/.auth/login/aad/callback`


## Prøv innloggingen før produksjon

Auth-oppsettet i prod har aldri vært i drift: `staticwebapp.config.json` ble
aldri lest før 02.09.2026 (se `scripts/build-config.js`). Første prod-deploy
etter det tar i bruk sertifikat-basert innlogging, egen rollekilde og 29
ruteregler samtidig. Går noe galt der, kommer **ingen** inn i grensesnittet.

Derfor: kjør den samme koden i et navngitt preview-miljø først.

```
Actions → Deploy prod → Run workflow
  bekreft:  DEPLOY-PROD
  preview:  test          ← tomt felt = produksjon
```

Miljøet opprettes av kjøringen; ingenting settes opp på forhånd. Det ligger på
**samme SWA-ressurs** som produksjon og arver app settings derfra — også
Key Vault-referansen til sertifikatet. Innloggingen som testes der er altså den
samme som produksjon vil bruke, ikke en tilnærming.

URL-en blir `<vertsnavn>-test.<region>.azurestaticapps.net`.

**To ting må være på plass i app-registreringen først:**

1. **ID-token slått på** — Authentication → *Implicit grant and hybrid flows*.
   Mangler den, får du `AADSTS700054` uansett hvor redirect-URI-en peker. Se
   «Sertifikat-oppsett for prod» nedenfor.
2. **Preview-vertsnavnet som redirect-URI**, ved siden av produksjonens.

```
https://<vertsnavn>-test.<region>.azurestaticapps.net/.auth/login/aad/callback
```

Uten den avviser Entra innloggingen i preview-miljøet — og bare der. Det er en
forventet feil, ikke et tegn på at oppsettet er galt.

### Hva som skal sjekkes

| | Forventet |
|---|---|
| Innlogging | Kontovelger fra prod-tenanten, ikke `/common/` |
| `/admin.html` som admin | Kommer inn |
| `/admin.html` som ikke-admin | «Ingen tilgang»-siden, ikke Microsofts 403 |
| Forsiden | Skjemavelgeren, ikke «Mangler skjematype_id» |
| `/api/system/info` | `MILJO` = prod, `AAD_CLIENT_SECRET` merket som utenfor miljøet |

Virker alt, kjør samme workflow på nytt med tomt `preview`-felt.

### Hvis produksjon likevel låser seg

De fleste feilene ligger utenfor deployen — feil `AAD_CLIENT_ID`, manglende
Key Vault-rolle på SWA-ens managed identity, uregistrert redirect-URI,
sertifikat ikke lastet opp i Entra. Alt dette rettes i portalen uten ny
deploy, og slår gjennom i løpet av et par minutter.

Trengs likevel en tilbakerulling: SWA har ingen angreknapp, så det gjøres ved å
deploye forrige commit. Lag taggen **før** deployen, ikke etter:

```bash
# SHA-en fra Actions → Deploy prod → siste vellykkede kjøring
git tag prod-siste-gode <sha> && git push origin prod-siste-gode
```

Kjør så workflowen med taggen valgt som branch i stedet for `main`.

Merk at cron-jobbene, ekstern innsending via OTP og PA-flytene inn mot appen
går på anonyme ruter. De fortsetter å virke selv om ingen kommer inn i
grensesnittet — backup stopper altså ikke.
