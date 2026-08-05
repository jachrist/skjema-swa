# Sikkerhet

## Repo-nivå

- **Branch protection** på `main`:
  - Krev PR med minst 1 review (2 for større endringer)
  - Krev signerte commits
  - Blokker force-push og sletting
  - "Include administrators"
  - Påkrevde CI-checks: `test`
- **CODEOWNERS** på `.github/`, `config/`, `staticwebapp.config.json`, `api/local.settings.example.json`.
- **Secret scanning** + **push protection**: aktiver i GitHub repo-innstillinger.
- **Dependabot**: ukentlige oppdateringer for `npm` og `github-actions`.

## Deploy-identitet

**Nåværende (pilot):** SWA deployment token i GitHub secret `AZURE_STATIC_WEB_APPS_API_TOKEN`.

**Mål (før produksjon):** OIDC federated credential.
- Opprett Entra-app-registrering for GitHub Actions
- Legg til federated credential med subject `repo:jachrist/skjema-swa:environment:production`
- Gi den `Contributor` kun på selve SWA-ressursen (ikke ressursgruppa)
- Bytt `Azure/static-web-apps-deploy@v1` med `azure/login@v2` + `az staticwebapp` CLI-kall
- Slett deployment token

## Managed Identity

- SWA har system-assigned managed identity slått på
- MI har følgende rolletildelinger:
  - `Storage Table Data Contributor` på storage-kontoen
  - `Storage Blob Data Contributor` på storage-kontoen
  - `Key Vault Secrets User` på Key Vault
- Ingen andre tildelinger (least privilege)

## Key Vault

- Alle hemmeligheter i `kv-fhsskjema-pilot` (dev) / `kv-fhsskjema-pilot-prod` (prod)
- Se `config/keyvault-secrets.md` for oversikt og rotasjonspolicy
- Cache på 5 minutter i appen — rotasjoner får effekt automatisk innen den tiden

## Auth-modell

- SWA gjør Entra ID-innlogging via `/.auth/login/aad`
- Alle `/api/*`-ruter krever autentisering (bortsett fra `/api/ping` og `/api/refresh-fs`)
- Fininnstilt admin-sjekk i handler via `erAdmin(upn)` mot `ADMIN_UPNS`-env-var
- Admin-sider (`admin.html`, `nokkeladmin.html`, `rolleadmin.html`, `migrer.html`) krever `admin`-rolle på ruten

## Roller i SWA

SWA-roller settes via "Manage user roles" i portalen eller via API. Standard-roller er
`anonymous` og `authenticated`. Egendefinerte roller (som `admin`) må tildeles per bruker.

Alternativ: sett rollen basert på Entra-gruppe med `rolesSource` i `staticwebapp.config.json`.
Krever SWA Standard-plan.

## Trussel-modell

Se `docs/ARCHITECTURE.md` for komponenter. Hovedangrepsflater:

- **Deploy-pipeline**: kompromittert GitHub-konto → uautorisert deploy. Mitigert av branch protection, review-krav, OIDC (planlagt).
- **Storage**: MI med bred tilgang. Mitigert av least-privilege roller på storage-konto-nivå (ikke subscription-nivå).
- **Key Vault**: MI med Secrets User. Kan lese alle secrets. Aksepteres siden MI kun eksisterer i SWA-runtime.
- **Ondsinnet skjemadefinisjon**: en admin kan i teorien lagre HTML som injiseres i utfyller. Mitigert av CSP-headers og escape ved rendering.
