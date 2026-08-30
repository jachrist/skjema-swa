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

**Merk:** MI-en brukes i praksis bare av SWA-hosten, til å løse
`@Microsoft.KeyVault(...)`-referanser ved oppstart. SWA Managed Functions
eksponerer ikke identity-endepunktet til koden, så `DefaultAzureCredential`
kan ikke hente token derfra — derfor går all lagring via connection string
fra Key Vault, og `api/src/lib/keyvault.js` er ubrukt. Storage-rolletildelingene
over er dermed uten praktisk effekt i dag; de står igjen fra da MI-veien ble forsøkt.

## Key Vault

- Alle hemmeligheter i `kv-fhsskjema-pilot` (dev) / `kv-fhsskjema-pilot-prod` (prod)
- Se `config/keyvault-secrets.md` for oversikt og rotasjonspolicy
- Verdiene når appen som env-vars via `@Microsoft.KeyVault(...)`-referanser,
  løst av SWA-hosten ved oppstart. En rotert hemmelighet får derfor effekt først
  når appen restartes — ikke automatisk.

## Nøkkelkalender

Hemmeligheter som utløper er den vanligste kilden til plutselig driftsstans, og
den vanskeligste å oppdage på forhånd. Admin-panelet har derfor fanen
**🗓 Nøkkelkalender** (`/admin.html#nokkelkalender`), som fører opp hver
hemmelighet med:

- **utløpsdato** og hvor mange dager det er igjen,
- **hvor den ligger** (Key Vault, SWA Configuration, GitHub Secrets),
- **konsekvens ved utløp** — hva som slutter å virke, og for hvem,
- **rotasjonsprosedyre** — steg for steg, skrevet for en som ikke bygde løsningen.

`.github/workflows/sjekk-nokler.yml` kaller `POST /api/nokkelkalender/sjekk`
daglig kl. 07:00 UTC. Endepunktet varsler `ADMIN_UPNS` på e-post når en
hemmelighet passerer et nytt trinn — først på radens egen varslingsfrist,
deretter 14, 7, 3 og 1 dag før, og så daglig etter utløp. Ett samlet brev per
kjøring, ikke ett per hemmelighet.

Praktiske detaljer:

- **Utløpsdatoer fylles inn manuelt.** Appen kan ikke spørre Key Vault (se
  Managed Identity over). Unntaket er SAS-strenger: de bærer utløpet i seg selv
  (`se=`), og leses direkte fra env-varen — merk raden med feltet **EnvVar**.
- **Hvert miljø eier sine egne rader**, så pilot og prod varsler ikke dobbelt.
  Trykk «Legg inn standardinventaret» én gang per miljø for å få inn de kjente
  hemmelighetene fra koden; datoene må fylles inn etterpå.
- **`HASH_SALT` er merket «skal ikke roteres».** Saltet gir deterministisk
  pseudonymisering av innsendere (`api/src/lib/kryptering.js`). Et bytte gir nye
  pseudonymer for framtidige innsendinger mens de historiske beholder de gamle,
  og koblingen kan ikke gjenskapes — e-postadressen den ble beregnet fra er slettet.
- «Test varsling» i panelet tørrkjører sjekken og viser hva som ville blitt sendt,
  uten å sende noe.

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
