# Kokebok: opprett prod v3

**Formål:** sette opp en ny, parallell produksjonsstakk i prod-tenanten —
samme arkitektur som dev — mot en **blank lagringskonto**, slik at den kan
testes ved siden av dagens prod (v2) før en cutover.

Skrevet for å kjøres i ett arbeidsmøte sammen med admin fra Cyberforsvaret.
Hver kommando står i dokumentet; ingen skriptkjøringer skal bestilles.

> **Dette dokumentet er speilet av dev.** Oppsettet er målt der (8g–8p i
> `BESLUTNING-EGEN-FUNCTION-APP.md`), og navnene er dev-navnene med `dev`
> byttet ut med `prod`. Det som IKKE er målt, er prod-tenantens egne rammer:
> policyer, tillatte regioner, navnekrav og hvem som har hvilke roller.
> Derfor skal en admin med rettigheter sitte i rommet.

---

## Om kommandoene: PowerShell, og ingen delte linjer

**Alt i dette dokumentet kjøres i PowerShell** (5.1 eller 7). Grunnen er at
`scripts/steg1-funcapp.ps1` er PowerShell, og to skall i samme kokebok er en
kilde til feil ingen oppdager før midt i et møte.

**Ingen kommando er delt over flere linjer med et fortsettelsestegn.** Det er
med vilje:

* PowerShell fortsetter en linje med **backtick** (`` ` ``), bash med
  **bakstrek** (`\`). Limes en bash-linje inn i PowerShell, blir bakstreken
  lest som et tegn i argumentet, og feilen peker et helt annet sted.
* En backtick på slutten av en linje er dessuten usynlig: et mellomrom etter
  den gjør at den slutter å virke, og klipp-og-lim legger ofte igjen ett.

Lange kommandoer står derfor enten på **én linje**, eller som en **liste med
argumenter** i parentes. En parentes holder uttrykket åpent over linjeskift
helt uten fortsettelsestegn:

```powershell
$arg = @(
    'functionapp', 'config', 'appsettings', 'set',
    '--name', $FA,
    '--resource-group', $RG
)
az @arg --settings MILJO=prod --output none
```

`@arg` er *splatting*: PowerShell brer lista ut som separate argumenter.
Formen tåler klipp-og-lim, og den tåler at noen setter inn en linje til.

---

## 0. Før møtet

| Avklart? | Hva | Hvorfor det må være avklart først |
|---|---|---|
| ☐ | Abonnement og ressursgruppe | Alle kommandoene peker på dem |
| ☐ | Hvem som kan tildele RBAC-roller | `Owner` eller `User Access Administrator`. Uten dette stopper trinn 3 |
| ☐ | Key Vault: gjenbruk `fhs-kv-01`, eller ny `kv-skjema-3-prod`? | Se 3.1 — valget avgjør én kommando |
| ☐ | Flytene er kopiert til prod-tenanten med **Entra-autentisering** | Se trinn 7. Uten dette sender v3 ingenting |
| ☐ | Domene/subdomene bestemt | Se 10. Ikke nødvendig for oppsettet, men avgjør cutover |

```powershell
az login --tenant <prod-tenant-id>
az account set --subscription <abonnements-id>
az account show --query "{abonnement:name, id:id, tenant:tenantId}" -o table
```

---

## 1. Navn og variabler

Samme konvensjon som dev, med `dev` → `prod`.

| Rolle | dev | **prod v3** |
|---|---|---|
| Ressursgruppe | `rg-skjema-3-dev` | `rg-skjema-3-prod` |
| Function App (API) | `fa-skjema-3-dev` | `fa-skjema-3-prod` |
| Managed identity | `mi-skjema-3-dev` | `mi-skjema-3-prod` |
| Datalagring (blank!) | `stskjema3dev` | `stskjema3prod` |
| Runtime-lagring | (egen konto) | `stskjema3prodrt` |
| Static Web App | *(dev-SWA)* | `swa-skjema-3-prod` |
| Key Vault | `kv-skjema-3-dev` | `fhs-kv-01` *eller* `kv-skjema-3-prod` |
| Region | `norwayeast` | `norwayeast` (SWA: `westeurope`) |

Lagringskontonavn tåler ikke bindestrek, derfor `stskjema3prod`.

> **`stskjema3prod` skal være TOM.** Hele poenget med v3 er å teste uten å
> røre v2 sine data. Cutover skjer ved å peke v3 mot v2 sin konto senere —
> se 10.

Kjør denne blokka først. Alt under bruker variablene:

```powershell
$RG   = 'rg-skjema-3-prod'
$STED = 'norwayeast'
$FA   = 'fa-skjema-3-prod'
$MI   = 'mi-skjema-3-prod'
$DATA = 'stskjema3prod'
$RT   = 'stskjema3prodrt'
$SWA  = 'swa-skjema-3-prod'
$KV   = 'fhs-kv-01'
$SUB  = az account show --query id -o tsv
```

---

## 2. Ressursgruppe og lagring

```powershell
az group create --name $RG --location $STED --output none
```

```powershell
$datakonto = @(
    'storage', 'account', 'create',
    '--name', $DATA,
    '--resource-group', $RG,
    '--location', $STED,
    '--sku', 'Standard_LRS',
    '--kind', 'StorageV2',
    '--min-tls-version', 'TLS1_2',
    '--allow-blob-public-access', 'false',
    '--output', 'none'
)
az @datakonto
```

```powershell
$runtimekonto = @(
    'storage', 'account', 'create',
    '--name', $RT,
    '--resource-group', $RG,
    '--location', $STED,
    '--sku', 'Standard_LRS',
    '--kind', 'StorageV2',
    '--min-tls-version', 'TLS1_2',
    '--allow-blob-public-access', 'false',
    '--output', 'none'
)
az @runtimekonto
```

**Runtime-lagringen er en EGEN konto, ikke datalagringen.** Timer-triggerne
lagrer sin plassering i planen der, sammen med låser og logger. En jobb som
roter i den kontoen skal ikke kunne røre data.

> **`--output none` er ikke pynt.** `az storage account ...` uten den skriver
> ut kontonøkler i klartekst. De skal aldri havne i en terminal-logg, et
> møtereferat eller en commit.

---

## 3. Function App, identitet og roller

Dette trinnet kjøres av `scripts/steg1-funcapp.ps1`, som bygde dev-miljøet.
**Skriptet tørrkjører uten `-Kjor`** — kjør alltid tørt først og les utskriften.

Parametrene samles i en hashtabell, slik at tørrkjøringen og den ekte
kjøringen er samme linje pluss ett ord:

```powershell
$p = @{
    Rg          = 'rg-skjema-3-prod'
    FuncApp     = 'fa-skjema-3-prod'
    Lagring     = 'stskjema3prodrt'
    DataLagring = 'stskjema3prod'
    Identitet   = 'mi-skjema-3-prod'
    KeyVault    = 'fhs-kv-01'
    Swa         = 'swa-skjema-3-prod'
}
```

```powershell
.\scripts\steg1-funcapp.ps1 @p -Trinn funcapp
```

Ser utskriften riktig ut:

```powershell
.\scripts\steg1-funcapp.ps1 @p -Trinn funcapp -Kjor
```

Skriptet gjør, i denne rekkefølgen:

1. runtime-lagringskonto (hvis den ikke finnes)
2. Function App, Node 22, Linux
3. **user-assigned** managed identity, knyttet til appen, `AZURE_CLIENT_ID`
   satt og `keyVaultReferenceIdentity` pekt på den
4. tre storage-roller på datalagringen, og `Key Vault Secrets User`

**Identiteten er user-assigned med vilje.** En system-assigned identitet dør
med Function App-en, og da må hver håndgitte tildeling gjøres om — rollene,
Graph-approllene, SharePoint-tilgangen per site, og `oid` i flytenes
allow-liste.

### 3.1 Hvis Key Vault ligger i en annen ressursgruppe

Skriptet bygger rolle-scopet med **samme ressursgruppe** som Function App-en.
Gjenbrukes `fhs-kv-01` og den ligger et annet sted, feiler den ene
rolletildelingen. Gjør den da manuelt, med full ressurs-ID:

```powershell
$PRINCIPAL = az identity show --name $MI --resource-group $RG --query principalId -o tsv
$KV_ID = az keyvault show --name $KV --query id -o tsv
```

```powershell
$kvrolle = @(
    'role', 'assignment', 'create',
    '--assignee-object-id', $PRINCIPAL,
    '--assignee-principal-type', 'ServicePrincipal',
    '--role', 'Key Vault Secrets User',
    '--scope', $KV_ID,
    '--output', 'none'
)
az @kvrolle
```

**Anbefaling: gjenbruk `fhs-kv-01`.** Hemmelighetene ligger der allerede, og
en ny vault betyr at hver verdi må kopieres — altså innom noens skjerm.

### 3.2 Kontroller rollene

```powershell
az role assignment list --assignee-object-id $PRINCIPAL --all --query "[].{rolle:roleDefinitionName, scope:scope}" -o table
```

Forventet: `Storage Table Data Contributor`, `Storage Blob Data Contributor`
og `Storage Blob Delegator` på `stskjema3prod`, pluss `Key Vault Secrets User`
på vaulten.

**Ingen av dem heter «Contributor».** Den rollen gir ikke tilgang til en
eneste tabellrad, men gir rett til å liste kontonøklene — full datatilgang
gjennom en sidedør, med den delte nøkkelen hele øvelsen går ut på å fjerne.

---

## 4. App settings på Function App-en

Inventaret er fasiten, ikke dette dokumentet. Hent lista:

```powershell
node scripts/vis-appsettings.js prod
```

Skriptet skriver ut navnene gruppert etter form — og **aldri verdiene**.
For `keyvault`-formen vises secret-navnet, som er pekeren inn i vaulten.

| Form | Hva du gjør |
|---|---|
| `keyvault` | Sett som Key Vault-referanse, se under |
| `value` | Kopier verdien fra `config/env.prod.json`. Ikke hemmelig |
| `settes_i_swa` | Hører hjemme på SWA-ressursen, ikke her |
| `valgfri` | Trenger ingen verdi. Alle `*_SCHEDULE` er her |
| `kun_dokumentasjon` | Settes av plattformen, eller står for oversiktens skyld |

**Key Vault-referanser** — og dette er forskjellen fra v2: en frittstående
Function App LØSER dem (målt 14.10.2026, 8d). SWA Managed Functions gjør det
ikke, og det er derfor v2 har klartekst.

```powershell
$VAULT = az keyvault show --name $KV --query properties.vaultUri -o tsv
az functionapp config appsettings set --name $FA --resource-group $RG --settings "HASH_SALT=@Microsoft.KeyVault(SecretUri=$($VAULT)secrets/hash-salt/)" --output none
```

Flere ikke-hemmelige verdier i ett kall:

```powershell
$verdier = @(
    'MILJO=prod',
    'FLYT_AUTH=entra',
    'VARSLING_DEAKTIVERT=true'
)
az functionapp config appsettings set --name $FA --resource-group $RG --settings @verdier --output none
```

**`--output none` på HVER av disse.** Uten den skriver `az` ut alle app
settings, inkludert de hemmelige, som JSON i terminalen.

### 4.1 Én setting som ikke står i inventaret

Timer-jobben `refresh-fs` tar 2–4 minutter, og **timeren venter på hele
kjøringen**. Standarden på Consumption er fem minutter. Denne hever grensen
for DENNE appen alene — `host.json` deployes også til SWA Managed Functions i
v2, og en verdi den verten ikke godtar tar ned appen der.

```powershell
az functionapp config appsettings set --name $FA --resource-group $RG --settings AzureFunctionsJobHost__functionTimeout=00:10:00 --output none
```

### 4.2 Kontroller uten å lekke

```powershell
az functionapp config appsettings list --name $FA --resource-group $RG --query "[].name" -o tsv | Sort-Object
```

Navnene er greie. Den fulle lista med verdier hører ikke hjemme i en terminal.

---

## 5. Static Web App, innhold og lenking

**REKKEFØLGEN ER POENGET.** Første forsøk 14.10.2026 lenket en backend til en
SWA som aldri hadde hatt en vellykket deploy. Aktivitetsloggen sa at alt var i
orden, miljøet sto på «Uploading» i timevis, og ingenting rutet. **Innholdet
må på plass FØR lenkingen.**

```powershell
.\scripts\steg1-funcapp.ps1 @p -Trinn swa -Kjor
```

### 5.1 Deploy-token til GitHub

Tokenet skal ikke skrives ut i terminalen. Legg det i en variabel og send det
videre med `--body`:

```powershell
$token = az staticwebapp secrets list --name $SWA --resource-group $RG --query "properties.apiKey" -o tsv
gh secret set AZURE_STATIC_WEB_APPS_API_TOKEN_PROD_V3 --body $token
Remove-Variable token
```

> **`--body $token`, ikke `| gh secret set`.** PowerShell 5.1 koder utdata til
> et eksternt program etter `$OutputEncoding`, og en pipe kan legge på en BOM
> eller endre tegnsett. Tokenet blir da lagret feil, og feilen viser seg
> først som en mislykket deploy. PSReadLine lagrer den *skrevne* linja, så
> `$token` havner ikke i historikken som en verdi.

### 5.2 Deploy frontend

Kjør frontend-workflowen mot v3-tokenet. **Bekreft i nettleseren at forsiden
vises** før du går videre.

### 5.3 Lenk Function App-en til SWA-en — først nå

```powershell
.\scripts\steg1-funcapp.ps1 @p -Trinn lenk -Kjor
az staticwebapp backends show --name $SWA --resource-group $RG -o table
```

---

## 6. Innlogging (Entra)

SWA-en trenger sin egen app-registrering, eller gjenbruk av v2 sin med en ny
redirect-URI.

```powershell
$VERT = az staticwebapp show --name $SWA --resource-group $RG --query defaultHostname -o tsv
"https://$VERT/.auth/login/aad/callback"
```

Adressen legges inn under **Authentication** på app-registreringen i Entra.

`AAD_CLIENT_ID` og auth-sertifikatet settes på **SWA-ressursen**, ikke på
Function App-en. I prod hentes sertifikatet fra Key Vault via
`clientSecretCertificateKeyVaultReference` i `staticwebapp.config.prod.json`.
Det oppslaget gjøres av *plattformen*, med SWA-ens egen identitet, og den
trenger `Key Vault Secrets User` **og** `Key Vault Certificate User`.

> **`openIdIssuer` skal aldri settes til `/common/` eller `/organizations/`.**
> Da slipper hvilken som helst Entra-tenant inn.

---

## 7. Flytene

v3 bruker `FLYT_AUTH=entra`, som dev. Det betyr:

1. Flytene i prod-tenanten må være de **nye versjonene** med
   `https://service.flow.microsoft.com/` som audience — **med skråstrek
   bakerst**. Uten den avvises tokenet, og en 401 fra en flyt lager **ingen
   kjøring i historikken**: tom historikk betyr ikke at kallet uteble.
2. Identitetens **objectId** må inn i flytenes allow-liste:

```powershell
az identity show --name $MI --resource-group $RG --query principalId -o tsv
```

3. Flyt-URLene settes som app settings (`*_FLOW_URL`). Uten `sig=` i URL-en er
   de ikke hemmeligheter — men bekreft at de faktisk er Entra-beskyttet først.
4. **Connectorene eies av en servicebruker.** Den har ingen rettigheter ut
   over en vanlig bruker: for å opprette oppgaver eller skrive i Teams må den
   meldes eksplisitt inn som teammedlem.

`VARSLING_DEAKTIVERT=true` ble satt i trinn 4, og skal stå til v3 er testet.
Flytene i prod-tenanten skriver til ekte Teams og sender ekte e-post, uansett
hvor blank lagringen er.

---

## 8. Deploy av API-et

Utskriften fra `az ad sp create-for-rbac` **er en hemmelighet**. Den går rett
inn i GitHub-secreten, ikke via en sak, e-post eller chat:

```powershell
$scope = "/subscriptions/$SUB/resourceGroups/$RG"
$creds = az ad sp create-for-rbac --name sp-skjema-3-prod-deploy --role contributor --scopes $scope --sdk-auth
gh secret set AZURE_FUNCAPP_CREDENTIALS_PROD --body $creds
Remove-Variable creds
```

Kjør så workflowen **Deploy API til Function App** med
`appnavn = fa-skjema-3-prod` og `miljo = prod`.

---

## 9. Verifikasjon — i denne rekkefølgen

| # | Sjekk | Forventet |
|---|---|---|
| 1 | `https://<vert>/api/ping` | Svarer, med **commit-SHA-en** du nettopp deployet |
| 2 | Logg inn | Du kommer inn, med din egen UPN øverst |
| 3 | **Administrasjon → ⚙️ System** | `lagring.maate` = `managed-identity`, `flytAuth` = `entra` |
| 4 | Samme side | Ingen Key Vault-referanse står uløst |
| 5 | **Administrasjon → ⏱ Jobber** | Ni timere, alle med `registrert: …` |
| 6 | **Skjematyper → 📥 Importer definisjoner** | Last inn pakken fra v2. Les forhåndsvisningen |
| 7 | Send inn et testskjema | Skrives til `stskjema3prod` |
| 8 | **Jobber → Kjør nå** på oppslagslister | Statusraden går til `ok` |

> Punkt 1 sparer mest tid senere: `/api/ping` og `/js/config.js` bærer hver sin
> SHA. Avvik mellom dem betyr en halv deploy — og symptomet er en funksjon som
> «mangler», ikke en feilmelding.

---

## 10. Cutover og tilbakevei

To former, og de skal ikke blandes:

**A. Ompeking** — `STORAGE_ACCOUNT_NAME` på v3 endres fra `stskjema3prod` til
v2 sin konto. Ingen datakopi, ingen frys.

Identiteten må ha rollene på **den** kontoen også. Gjør dette FØR ompekingen:

```powershell
$V2_ID = az storage account show --name <v2-konto> --resource-group <v2-rg> --query id -o tsv
foreach ($rolle in @('Storage Table Data Contributor', 'Storage Blob Data Contributor', 'Storage Blob Delegator')) {
    az role assignment create --assignee-object-id $PRINCIPAL --assignee-principal-type ServicePrincipal --role $rolle --scope $V2_ID --output none
}
```

**B. Full migrering** — `scripts/migrer/` kopierer tabeller og vedlegg til en
ny konto. Krever 24 timers kjørestopp for å unngå endringer underveis, men
lar v2 sine data stå helt urørt.

### Uansett form: stopp de doble kjøringene

v2 trigges av GitHub Actions-cron; v3 har timere. Peker begge på samme
lagring, kjører hver jobb **to ganger** — og fire av dem sender ut av huset.
Utsending og purring ville gått dobbelt til eksterne mottakere.

**Ta prod ut av matrisene i de åtte workflowene i samme operasjon**, ikke
etterpå. Som belte: roter `SCHEDULER_KEY` på v2, så et gjenglemt cron-kall får
401 i stedet for å kjøre.

### Tilbakevei

Gjør cutover til et **domenebytte**, ikke en ny URL. Da er tilbakeveien én
DNS-endring. Får folk en ny adresse å bokmerke, er fallback rotete uansett
hvor ren koden er.

Med et eget domene kan versjonene adresseres hver for seg — `fskjema.no` for
gjeldende prod, `v3.fskjema.no` mens den testes, `dev.fskjema.no` for dev.
Må avtales med Cyberforsvaret.

---

## 11. Riving, hvis v3 skal bort

```powershell
az staticwebapp backends unlink --name $SWA --resource-group $RG
az staticwebapp delete --name $SWA --resource-group $RG --yes
az functionapp delete --name $FA --resource-group $RG
az storage account delete --name $DATA --resource-group $RG --yes
az storage account delete --name $RT --resource-group $RG --yes
az identity delete --name $MI --resource-group $RG
```

Rolletildelingene forsvinner ikke med identiteten:

```powershell
$ider = az role assignment list --assignee-object-id $PRINCIPAL --all --query "[].id" -o tsv
foreach ($id in $ider) { az role assignment delete --ids $id }
```

---

## 12. Regler som gjelder hele veien

- **`--output none` på alt som setter eller leser app settings og
  lagringsnøkler.** Utskriften inneholder hemmeligheter.
- **`az ad sp create-for-rbac`-utskriften er en hemmelighet.** Rett inn i
  GitHub-secreten, aldri innom en fil eller en sak.
- **Ingen hemmeligheter i `config/env.*.json`.** Bare Key Vault-referanser
  eller ikke-sensitive verdier.
- **En Power Automate-URL med `sig=` er legitimasjon.** Den som har lenken har
  tilgangen.
- **Ingen utskrift fra `az ... appsettings list` i en commit, e-post eller
  sak.** Navnene er greie; verdiene er det ikke.
