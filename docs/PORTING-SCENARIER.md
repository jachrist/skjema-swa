# Porting-scenarier — Ubuntu og lukket MS-miljø

Notat om hva som må endres for å porte SWA-piloten til to alternative
plattformer. Piloten er allerede modulært designet for slik porting —
storage-, auth- og integrasjon-lagene er isolert i separate moduler.

## Del 1: Ren Ubuntu-plattform (full MS-avvenning)

Fjerner all Microsoft-avhengighet. Beholder kjernekoden — kun infrastruktur-
og integrasjons-lagene byttes ut.

### Katalogtjeneste

**Bytt Entra ID med:**
- **Keycloak** (åpen kildekode, mest brukt, moden) — primærkandidat
- **FreeIPA** — hvis også trenger LDAP/Kerberos for annen infra
- **Authelia** — lettere alternativ hvis kun web-innlogging

**Effekt på piloten:**
- `api/src/lib/auth.js`: bytter parsing av `x-ms-client-principal` til
  standard OIDC ID-token-validering (JWT-verifisering mot IdP)
- SWA-cookie-flyt erstattes med OAuth2 Authorization Code Flow +
  refresh-tokens (session-cookie kan opprettholdes med f.eks. iron-session)
- Rolle-tildeling: gruppe-medlemskap fra Keycloak/LDAP mapper til
  `ADMIN_UPNS` og `Rollemedlemskap`-tabellen

### Storage

**Bytt Azure Table Storage med:**
- **PostgreSQL** med JSONB-kolonner for skjema-data. Én tabell per
  legacy-tabell, PK/RK-nøkler bevares som primary key.
- Alternativt **SQLite** for små deploy (én fil, ingen server).

**Bytt Azure Blob Storage med:**
- **MinIO** — S3-kompatibel, lett å drifte selv
- **Lokal filsystem** for enkleste deploy (path-mappet volume)

**Effekt på piloten:**
- Ny `api/src/lib/storage.js` som eksponerer samme funksjoner
  (`tabellKlient`, `containerKlient`) men mot Postgres/MinIO
- Andre lib-filer (`skjema-storage`, `rolle-storage` osv.) uendret
- **Behold** kompakt-format-modul, kryptering-modul, kjerne-logikk

### Compute + deploy

**Bytt SWA Managed Functions med:**
- **Node.js på systemd** — enkleste deploy, `systemctl restart` for
  redeploy
- **Docker Compose** — én container per komponent (frontend nginx +
  api node)
- **Kubernetes** — hvis flere replikaer eller cluster-orkestrering
  trengs

**Frontend-servering:**
- **nginx** som statisk filserver + reverse proxy til Node.js-API
- Alternativt **Caddy** for automatisk Let's Encrypt

**Effekt på piloten:**
- `@azure/functions`-wrapper byttes til **Express** eller **Fastify**
- Endepunktene har samme signatur (POST/GET + params/body) —
  wrapper-lag er lite
- `staticwebapp.config.json` erstattes med nginx-konfig for auth-routes
  og rate-limiting

### CI/CD

**Bytt GitHub Actions med:**
- **GitLab CI** eller **Gitea Actions** hvis git-plattform også byttes
- **Ansible playbooks** for produksjonsdeploy
- **Terraform** for infrastruktur som kode

Trigger ved push til main → bygg → deploy via SSH/kubectl til produksjonsserver.

### Varsling

**Bytt PA-flyter med:**
- **SMTP direkte** via nodemailer (som opprinnelig foreslått i fase 6a)
  mot Postfix/Sendmail på egen server
- **Ekstern SMTP-tjeneste:** SendGrid, Mailgun, EU-baserte alternativer
  som Mailjet

**Effekt på piloten:**
- `api/src/lib/varsling.js`: bytt `sendEpostViaFlyt` til nodemailer-basert
  send. Same signatur ellers.
- SMS-integrasjon: velg leverandør direkte (Sveve, LinkMobility, Twilio) og
  legg inn HTTP-kall i `flyt-kaller.js`.
- Teams-varsler faller bort (ingen tilsvarende i Linux-verden). Alternativ:
  Mattermost eller Matrix.

### Storage-migrering

Migrer legacy Azure-data:
- **Tabeller:** `scripts/migrer/`-scriptet allerede portet — utvid med
  Postgres-target
- **Blobs:** direkte kopi til MinIO via AWS CLI eller minio-mc

### Kryptering

`kryptering.js` bruker Node.js `crypto` — fungerer uten endring.
**Kryptonokler-tabellen:** vurder **HashiCorp Vault** som nøkkellagring i
stedet for database-tabell, for bedre secret-håndtering.

### Fjernes helt

- **SharePoint-integrasjon:** bytt til CSV-eksport til lokal filshare
  eller egen dashboard
- **Power BI-kobling:** bytt til **Grafana** eller **Metabase** som
  leser Postgres direkte
- **Teams-varsler / Planner-oppgaver** (fase 6c/d): bytt til Mattermost
  webhooks / OpenProject-tickets
- **Application Insights:** bytt til **Prometheus + Grafana** eller
  **Loki** for logging

### Kodemessig omfang

Estimert innsats for full port til Ubuntu:
- **Auth-lag rewrite:** 1-2 uker
- **Storage-lag rewrite:** 1 uke (Postgres) + 3 dager (MinIO)
- **Kompute-lag rewrite:** 1 uke (Express + nginx)
- **Varsling-integrasjon:** 3-5 dager
- **Migrering av data:** 1 uke
- **Testing + hardening:** 2-3 uker

**Kritisk:** kjerne-forretningslogikken (skjematyper, behandling,
kryptering, filtrering, PDF, datauttrekk) trenger IKKE røres. Modulær
struktur betyr at porting er kirurgi, ikke omskriving.

## Del 2: Lukket MS-miljø (Begrenset-lignende)

Beholder Microsoft-økosystemet, men uten Azure-cloud og uten internett-
tilgang. On-prem infrastruktur med tradisjonell AD.

### Katalog og auth

**Bytt Entra ID med:**
- **Active Directory** (on-prem) — er allerede standard
- **ADFS** for OAuth2/OIDC mot AD hvis moderne auth-flyt ønskes
- Alternativt **Windows Integrated Authentication** (Kerberos/NTLM)
  hvis all trafikk går via klient med AD-medlemskap

**Effekt på piloten:**
- `auth.js`: parsing bytter til Kerberos-token eller ADFS-utstedt JWT
- Rolle-tildeling: **AD-sikkerhetsgrupper** mapper til roller.
  `Rollemedlemskap`-tabellen kan populeres via LDAP-sync-jobb (samme
  cron-mønster som FS-refresh).
- Team-tilgang: **AD-grupper** i stedet for MS Teams (matcher legacy
  bedre — det var opprinnelig grupper som ble sync'et til Teams uansett)

### Hosting

**Bytt SWA med:**
- **IIS** — standard for Windows Server-miljø. Kan host Node.js via
  iisnode, eller bytt til .NET.
- Alternativ: **Kestrel** direkte hvis .NET, eller Node.js på Windows
  Service

**Effekt på piloten:**
- Node.js-koden fungerer uendret på Windows
- `staticwebapp.config.json` erstattes med IIS `web.config` (URL rewrites,
  auth-integrasjon, CORS)
- Deploy via **PowerShell script** eller **DSC** i stedet for GitHub
  Actions

### Storage

**Bytt Azure Storage med:**
- **SQL Server** (mest naturlig i MS-miljø)
- Alternativt **Azure Stack Hub** hvis on-prem Azure-lag er tilgjengelig
  (samme API som Azure — piloten kjører uendret)
- **Filsystem** for blob-vedlegg (SMB-share)

### E-post og varsling

**Bytt PA-flyter med:**
- **Exchange on-prem** via SMTP (kan bruke nodemailer eller direkte
  System.Net.Mail)
- Sikkerhetsklarerte miljø har typisk egen Exchange-instans allerede

**Bytt Teams/Planner med:**
- **Skype for Business on-prem** hvis fortsatt i drift
- Ellers: kun e-post + intern helpdesk-verktøy

**Bytt SharePoint online med:**
- **SharePoint Server on-prem** — samme REST-API, samme kontrakt.
  `SP_LISTE_FLOW_URL` kan pekes mot on-prem SP-flyt (Power Automate
  on-prem har begrenset connector-støtte men støtter HTTP)
- Alternativt: direkte SQL-write hvis SP ikke er tilgjengelig

### Ingen internett-tilgang

**Konsekvenser:**
- **Ingen offentlig CDN** — alle dependencies må bundles og deployes
  med appen. Ingen `npm install` i produksjon — bygg lokalt og kopier
- **Ingen GitHub Actions** — deploy må skje internt (Azure DevOps Server /
  GitLab CE self-hosted / Jenkins)
- **Ingen public identity provider** — kun AD/ADFS på interne endepunkter
- **Ingen offentlige API-er** — FS-integrasjon må gå via ETL-jobb med
  eksport-filer (CSV/XML) i stedet for direkte GraphQL-kall
- **Ingen Let's Encrypt** — bruk intern PKI (AD Certificate Services)
- **NPM registry:** speil via **Verdaccio** eller **Sonatype Nexus**
  internt. Bygg-servere pipes gjennom disse.

### Sikkerhetsklareringsgrupper

I stedet for Teams-medlemskap:
- `Rollemedlemskap.Rolle = "Emneansvarlig"` mapper til AD-gruppe
  `FHS-Emneansvarlig` (evt. med omfang: `FHS-Emneansvarlig-CBU2501`)
- Ny modul `api/src/lib/ad-sync.js` som via LDAP populerer
  Rollemedlemskap fra AD-grupper (kjøres daglig cron)
- **Ingen manuell rolleadmin-side trengs** hvis alt kommer fra AD —
  eller behold for override-tilfeller

### Deploy uten internett

- **Bygg-pipeline på DMZ-server** som har begrenset internett
- **Artifact-server** (Nexus) holder alle npm-pakker
- **Deploy via signert bundle** (`.zip` + `.sig`) til produksjonsservere
  bak firewall
- Ingen "hot deploy" — planlagte vinduer

### Kodemessig omfang

Estimert innsats:
- **AD-integrasjon (auth):** 1 uke
- **AD-sync til Rollemedlemskap:** 3-5 dager
- **IIS-hosting + web.config:** 3-5 dager
- **Sql Server-storage-lag:** 1-2 uker (avhengig av performance-krav)
- **SMTP + intern varsling:** 3 dager
- **Bundle/deploy-pipeline for offline:** 1-2 uker
- **FS-integrasjon via ETL:** 3-5 dager
- **Testing i lukket miljø:** 3-4 uker (typisk mye friksjon)

**Kritisk observasjon:** hvis on-prem Azure Stack Hub er tilgjengelig,
kjører hele piloten uendret. Da er porting-omfanget ~1 uke (kun deploy-
pipeline og eventuelt AD-integrasjon).

## Sammenligning av porting-omfang

| Komponent | Ubuntu (fra scratch) | Lukket MS |
|-----------|----------------------|-----------|
| Auth-lag | Bytt til Keycloak/OIDC | Bytt til AD/Kerberos eller ADFS |
| Storage | Postgres + MinIO | SQL Server + SMB, eller Azure Stack |
| Kompute | Node/Docker/K8s | IIS eller Windows Service |
| Varsling | Nodemailer + eksterne SMS | Exchange on-prem, egen SMS-provider |
| Team-tilgang | LDAP-grupper | AD-grupper (allerede naturlig) |
| SharePoint | Fjernes (Postgres direkte) | On-prem SP-server, samme API |
| Deploy | GitLab CI + Ansible | Egen intern pipeline |
| PDF/Excel/OTP/kryptering | Ingen endring | Ingen endring |

## Anbefalinger

**For Ubuntu-port:**
1. Start med storage-laget (Postgres) — det bevarer datamodellen
2. Deretter auth (Keycloak) — kritisk for testing
3. Til slutt kompute/deploy — mekanikk, ikke logikk

**For lukket MS-port:**
1. Sjekk om Azure Stack Hub er tilgjengelig — det halverer arbeidet
2. Start med AD-integrasjon som bevis på at auth-flyten funker
3. Deretter offline-bundling — dette er ofte den største tidsluken
4. FS-integrasjon via ETL vil sannsynligvis kreve samarbeid med FS-eier

## Konklusjon

Piloten er *ikke* Azure-låst i praksis — kun i infrastruktur-lagene.
Kjerne-forretningslogikken er ren Node.js og HTML/JS uten spesielle
avhengigheter, og modulstrukturen isolerer alle Azure-spesifikke
integrasjoner i tydelig avgrensede moduler:

- `api/src/lib/storage.js` — kun Azure Table
- `api/src/lib/blob.js` — kun Azure Blob
- `api/src/lib/auth.js` — kun SWA-cookie-parsing
- `api/src/lib/flyt-kaller.js` — kun HTTP mot PA-flyter

Bytting av disse lagene, uten å røre kjerne-logikken, gir en app som
kan kjøre i tilnærmet hvilken som helst kontekst — inkludert
sikkerhetsklarerte miljø hvor MS-tjenester ikke er tilgjengelige.
