# Backup til SharePoint via Microsoft Graph

Backupen lastes opp til et SharePoint-bibliotek rett fra API-et, med en Graph
*upload session*. Denne erstatter veien om Power Automate, som ikke tåler store
filer: HTTP-handlingen der leser hele svaret i minnet med et tak på 100 MiB, og
blir svaret stort nok lagres det som «partial content» som ingen uttrykk kan
røre. Slår man på chunking, overtar PA Range-headeren og kolliderer med vår egen.

Graph har ingen av delene. Vi styrer bitene selv (10 MiB), hver bit sier
eksplisitt hvilke bytes den er, og taket er 250 GB.

PA-flyten er beholdt som reservevei: er `GRAPH_*` ikke satt, kalles
`BACKUP_FLOW_URL` som før. Overgangen kan derfor tas ett miljø om gangen.

## Hvorfor SharePoint og ikke OneDrive

Et personlig OneDrive henger på én ansattkonto. Slutter vedkommende, forsvinner
backupene med kontoen. Et dokumentbibliotek på et team-område overlever
personskifter og har ryddigere tilgangsstyring.

## Hvorfor app-registreringen kan ligge i dev-tenanten

App-registreringen trenger ikke ligge i samme tenant som appen som bruker den.
SWA-en er bare en HTTP-klient med en hemmelighet, og autentiserer seg **mot
måltenanten**. Både pilot og prod kan derfor laste opp til samme bibliotek uten
multi-tenant-oppsett — og uten at noe miljø får lesetilgang til et annet miljøs
data. Hvert miljø leser fortsatt bare sine egne tabeller og blobber.

Filnavnene skiller miljøene fra hverandre: `Production-backup-…` mot
`pilot-backup-…`.

## Oppsett

### 1. Område og bibliotek

Opprett (eller velg) et SharePoint-område og et dokumentbibliotek. Noter
adressen, f.eks. `https://fhs.sharepoint.com/sites/Skjemasystem`.

> **To skript gjør steg 2 og 3 for deg. Velg etter hva du skal gjøre:**
>
> `scripts/opprett-backup-app.ps1` — **PowerShell.** Bare backup-appen, med
> `Sites.Selected` og skriverett på ett område. Kortest vei når det er
> backupen som skal opp, og den eneste av de to som er skrevet for å leses
> før den kjøres. Rollene hvert steg krever står i `.NOTES`, og stegene kan
> deles på tre personer.
>
> `scripts/opprett-graph-apper.sh` — **bash med `az` CLI.** Alle tre appene,
> altså også e-post og oppslag, for den dagen PA-flytene skal legges om. Kjør
> `--sjekk` først: den svarer på hvilke tillatelser som i det hele tatt finnes
> som applikasjonsroller, og det er et åpent spørsmål for Teams og Planner.
>
> Begge er idempotente, og begge har tørrkjøring (`-Torrkjor` / `--torrkjor`).
> Kjør den før du lar noe endres.

### 2. App-registrering

Entra ID → App registrations → New registration. Ingen redirect-URI trengs.
Noter **Application (client) ID** og **Directory (tenant) ID**.

Under **Certificates & secrets**: lag en **client secret**. Legg verdien i Key
Vault, aldri i kode eller env-JSON.

> **Her sto det «lag et sertifikat eller en client secret — sertifikat er å
> foretrekke» til 19.10.2026.** Det var feil, og feilen var dyr: koden støtter
> bare client secret, og steg 4 under har ingen variabel for et sertifikat.
> Noen fulgte anbefalingen, fikk app-registreringen opprettet med sertifikat
> hos en administrator, og sto igjen uten noe å sette inn.
>
> `api/test/graph-legitimasjon.test.js` leser nå BÅDE `graph-opplast.js` og
> tabellen under, og krever at de er enige om hva som støttes.

<!-- legitimasjon-fra-graph-opplast -->

| Legitimasjon | Støttet i dag |
|---|---|
| `client secret` | ja |
| `sertifikat` | nei |

**Hvorfor ikke sertifikat — og hvorfor auth-appen kan.** Prod sin
*innloggings*-app bruker sertifikat fra Key Vault med bare `AAD_CLIENT_ID`
satt. Det ser ut som det samme, men det er det ikke: der er det **plattformen**
som henter sertifikatet, via `clientSecretCertificateKeyVaultReference` i
`staticwebapp.config.prod.json`, med SWA-ressursens egen managed identity.
Koden vår ser aldri sertifikatet.

Graph-kallet gjør **vår egen kode**, og den har ingen slik krok:

| | Auth-appen | Graph-appen |
|---|---|---|
| Hvem ber om tokenet | SWA sin innebygde auth-komponent | `lib/graph-opplast.js` |
| Hvem henter sertifikatet | Plattformen, med SWA-ressursens MI | Ingen |
| Konfigurasjon | `clientSecretCertificateKeyVaultReference` i auth-blokka | finnes ikke |

Og de to andre veiene er stengt i pilot og prod: app settings med
`@Microsoft.KeyVault(...)` løses ikke (målt 12.10.2026, se
`config/keyvault-secrets.md`), og koden kan ikke hente fra Key Vault selv —
SWA Managed Functions eksponerer ingen MI-token.

**Når sertifikat blir støttet, må det være PEM.** Målt 19.10.2026 på Node
22.22: `crypto.createPrivateKey` avviser PKCS#12/PFX i alle former
(`ERR_OSSL_UNSUPPORTED`), mens PEM leses direkte — og `X509Certificate.raw`
gir avtrykket `x5t` trenger. Key Vault sin secret-representasjon av et
sertifikat følger *innholdstypen*: `application/x-pkcs12` gir base64-PFX,
`application/x-pem-file` gir PEM. **Importeres sertifikatet som PFX, kan
koden ikke lese det.** Avklar formatet med den som oppretter det.

Veien videre er en frittstående Function App (dev, og prod v3): den løser
`@Microsoft.KeyVault(...)` i app settings (målt 14.10.2026, 8d), så
sertifikatet kan leveres som en referanse uten at noe står i klartekst.

### 3. Rettighet: `Sites.Selected`, ikke `Files.ReadWrite.All`

Under **API permissions** → Microsoft Graph → **Application permissions** →
`Sites.Selected`. Deretter **Grant admin consent**.

`Sites.Selected` gir i seg selv ingen tilgang til noe som helst. Appen må få
skrivetilgang til nøyaktig ett område, og det gjøres med et eget Graph-kall.
`Files.ReadWrite.All` ville gitt skrivetilgang til alt i tenanten, og er for
mye for denne jobben.

Slå først opp område-ID-en:

```http
GET https://graph.microsoft.com/v1.0/sites/fhs.sharepoint.com:/sites/Skjemasystem
```

Gi så appen skriverett på det området. Kallet må gjøres av noen med
`Sites.FullControl.All` — i praksis en SharePoint- eller global administrator,
f.eks. via Graph Explorer:

```http
POST https://graph.microsoft.com/v1.0/sites/{site-id}/permissions
Content-Type: application/json

{
  "roles": ["write"],
  "grantedToIdentities": [
    {
      "application": {
        "id": "<GRAPH_CLIENT_ID>",
        "displayName": "FHS Skjema — backup"
      }
    }
  ]
}
```

Nyere Graph-versjoner bruker `grantedToIdentitiesV2` i svaret; `grantedToIdentities`
godtas fortsatt ved oppretting. Verifiser med
`GET /sites/{site-id}/permissions` at oppføringen finnes.

### 4. Env-vars i hvert miljø

Settes i SWA Configuration, alle som **klartekst**.

> Her sto det «hemmeligheten som Key Vault-referanse» til 12.10.2026. Det er
> feil: SWA Managed Functions løser ikke `@Microsoft.KeyVault(...)` i app
> settings. Prøvd i pilot — appen fikk referansestrengen som verdi.
> Rolletildeling hjelper ikke. Key Vault er arkivet og rotasjonspunktet, ikke
> kjøretidskilden; se `config/keyvault-secrets.md`.

| Variabel | Verdi |
|---|---|
| `GRAPH_TENANT_ID` | Directory (tenant) ID for tenanten biblioteket ligger i |
| `GRAPH_CLIENT_ID` | Application (client) ID |
| `GRAPH_CLIENT_SECRET` | Klienthemmeligheten i klartekst. Arkiver den i Key Vault som `graph-client-secret` |
| `BACKUP_SHAREPOINT_SITE` | `https://fhs.sharepoint.com/sites/Skjemasystem` |
| `BACKUP_SHAREPOINT_BIBLIOTEK` | Valgfritt. Bibliotekets navn, f.eks. `Backup`. Uten dette brukes områdets standardbibliotek. |
| `BACKUP_SHAREPOINT_MAPPE` | Valgfritt. Undermappe, f.eks. `Skjemasystem/Backup`. |

`BACKUP_SHAREPOINT_SITE` godtar både full URL og Graph-formen
`fhs.sharepoint.com:/sites/Skjemasystem`.

De tre `BACKUP_SHAREPOINT_*`-verdiene vises i admin-panelet under **System**,
siden feil områdeadresse er det som oftest er galt når kopien ikke dukker opp
der noen leter etter den. `GRAPH_*` vises bare som satt/ikke satt.

### 5. Nøkkelkalenderen

Legg hemmeligheten inn under **Administrasjon → 🗓 Nøkkelkalender** med
utløpsdato, konsekvens («backup-kopien til SharePoint stopper stille») og
rotasjonsprosedyre. Uten det står vi der den dagen den utløper — som er hele
poenget med kalenderen.

## Sjekkliste: sette opp backup i prod

Prod kjører i dag **ikke** Graph-veien. `env.prod.json` sier det rett ut:
`GRAPH_*` og `BACKUP_SHAREPOINT_SITE` er bevisst ikke satt, så backupen går
via `BACKUP_FLOW_URL`. Byttet skjer av seg selv: `erKonfigurert()` i
`lib/graph-opplast.js` krever alle fire, og `functions/backup.js` velger
SharePoint-veien først når de er på plass. Det finnes ingen bryter å skru på.

Rekkefølgen under følger hvem som må gjøre hva — stegene kan deles på tre
personer, og skriptet er idempotent, så hver kan kjøre det én gang i
vilkårlig rekkefølge.

**Før møtet**

- [ ] Installer PowerShell-modulene skriptet trenger (krever ikke
      administrator):
      `Install-Module Microsoft.Graph.Authentication, Microsoft.Graph.Applications -Scope CurrentUser`
      De to undermodulene holder — meta-modulen `Microsoft.Graph` drar inn alt
      og tar lang tid uten å gi skriptet noe det trenger. Skriptet sjekker
      selv og sier fra, men det tar tid å installere midt i et møte.
- [ ] Avklar hvilket SharePoint-område prod-backupen skal til, og om et eget
      bibliotek skal brukes. **Kopier adressen fra adressefeltet i
      nettleseren** mens du står i området — ikke skriv den av fra
      visningsnavnet. Stien har som regel ingen mellomrom selv om navnet har
      det, og Graph slår opp på stien.
- [ ] Kjør `.\opprett-backup-app.ps1 -Site <url> -Torrkjor`. Den endrer
      ingenting og viser nøyaktig hva den ville gjort.

**I møtet — hvem må gjøre hva**

- [ ] **Steg 1, app-registrering og hemmelighet** → *Application
      Administrator* (eller Cloud Application Administrator)
- [ ] **Steg 2, samtykke til `Sites.Selected`** → *Privileged Role
      Administrator* eller *Global Administrator*.
      Application Administrator er **ikke** nok: den rollen har et uttrykkelig
      unntak for applikasjonsrettigheter på Microsoft Graph. Dette er den
      vanligste grunnen til at alt annet går igjennom og dette ene feiler.
- [ ] **Steg 3, skriverett på området** → *SharePoint Administrator* eller
      *Global Administrator*. `Sites.Selected` gir i seg selv ingen tilgang;
      uten dette steget kan appen ingenting.
- [ ] **Steg 5, arkivering i Key Vault** → *Key Vault Secrets Officer* på
      `fhs-kv-01`, pluss *Reader* på ressursen. Dette er Azure-roller, ikke
      Entra-roller, og en helt annen tildeling enn de over.

**Etterpå**

- [ ] Sett de fire i SWA Configuration for prod, som klartekst:
      `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`,
      `BACKUP_SHAREPOINT_SITE`. Eventuelt `BACKUP_SHAREPOINT_BIBLIOTEK` og
      `BACKUP_SHAREPOINT_MAPPE`.
- [ ] Fjern `_backup_kommentar` fra `config/env.prod.json` og legg inn de
      fire i inventaret med de ekte formene. `api/test/env-inventar.test.js`
      holder lista komplett.
- [ ] Sjekk `/api/system/info`: de fire skal stå som satt, og
      `BACKUP_SHAREPOINT_SITE` vises i klartekst — feil områdeadresse er det
      som oftest er galt når kopien ikke dukker opp der noen leter.
- [ ] Kjør en backup manuelt og se at fila havner i biblioteket. Går den
      fortsatt via flyten, mangler én av de fire.
- [ ] Legg hemmeligheten inn i **Administrasjon → 🗓 Nøkkelkalender** med
      utløpsdato og konsekvens. Uten det stopper backupen stille den dagen
      den utløper.

**Og så: slå av det som ikke lenger forventes å mangle**

Når prod har Graph-veien, bør `KUN_I_MILJO` i `api/src/functions/system.js`
rydde seg selv — i dag melder helsesjekken `GRAPH_*` som manglende i prod, og
det er riktig fram til nå. Etterpå er det støy.

## Slik virker opplastingen

1. Token via client credentials mot `GRAPH_TENANT_ID`, caches til like før utløp.
2. Slå opp område og bibliotek.
3. `createUploadSession` på `{mappe}/{filnavn}`, med `conflictBehavior: replace`.
4. Les 10 MiB om gangen fra backup-blobben og PUT den til `uploadUrl` med
   `Content-Range`. Minnebruken er en konstant, ikke en funksjon av filstørrelsen.
5. Siste bit svarer 200/201 med selve fila. **Størrelsen Graph rapporterer
   sammenlignes med backupens.** Stemmer den ikke, meldes kjøringen som feil.

Punkt 5 er verdt å merke seg: nettopp den kontrollen manglet i PA-veien, og
resultatet var en fil i OneDrive på 4 bytes som så vellykket ut.

Alle biter unntatt den siste må være et multiplum av 320 KiB — det er et krav
fra Graph, og `beregnBiter` runder av deretter.

## Feilsøking

| Symptom | Årsak |
|---|---|
| `Fikk ikke token fra Entra (HTTP 401)` | Feil `GRAPH_CLIENT_SECRET`, eller utløpt hemmelighet |
| `Graph GET /sites/… feilet (HTTP 404)` | Feil `BACKUP_SHAREPOINT_SITE`, eller området finnes ikke |
| `Kunne ikke opprette opplastingssesjon (HTTP 403)` | `Sites.Selected` er gitt, men appen mangler skriverett på området — steg 3 |
| `Fant ikke biblioteket «X»` | Feil `BACKUP_SHAREPOINT_BIBLIOTEK`. Feilmeldingen lister de som finnes. |
| `Fila i SharePoint er N bytes, men backupen er M` | Ufullstendig opplasting. Kjør på nytt; `conflictBehavior: replace` overskriver. |

Status per kjøring ligger i `GET /api/backup/status` — feltet `Kanal` viser om
kopien gikk via `graph` eller `pa-flyt`.
