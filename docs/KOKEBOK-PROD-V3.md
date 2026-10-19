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
| ☐ | Hvem som kan tildele RBAC-roller, og hvem som har Entra-rollene | **Se 0.1 — hele matrisen.** Uten avklaringen stopper møtet på trinn 3, 6 eller 8 |
| ☐ | Key Vault: gjenbruk `fhs-kv-01`, eller ny `kv-skjema-3-prod`? | Se 3.1 — valget avgjør én kommando |
| ☐ | Flytene er kopiert til prod-tenanten med **Entra-autentisering** | Se trinn 7. Uten dette sender v3 ingenting |
| ☐ | Domene/subdomene bestemt | Se 10. Ikke nødvendig for oppsettet, men avgjør cutover |
| ☐ | **Skriver v1 fortsatt?** | Se under. Avklares før cutover, ikke etter |

```powershell
az login --tenant <prod-tenant-id>
az account set --subscription <abonnements-id>
az account show --query "{abonnement:name, id:id, tenant:tenantId}" -o table
```

---

### 0.1 Rettigheter: hva du gjør selv, og hva som må bestilles

Tre myndigheter er i spill, og de henger **ikke** sammen. Eier på
ressursgruppa gir deg ingenting i katalogen, og en Global Administrator har
ikke automatisk tilgang til en eneste ressurs. Det er her et arbeidsmøte
stopper: alt i Azure går, og så står man fast på én app-registrering.

**A. Azure RBAC inne i `rg-skjema-3-prod` — dette gjør du selv**

| Trinn | Operasjon | Minsterolle |
|---|---|---|
| 2 | `storage account create` (to kontoer) | Contributor |
| 3 | `functionapp create`, `identity create`, `identity assign` | Contributor |
| 3 | `functionapp update --set keyVaultReferenceIdentity` | Contributor |
| 3 | `role assignment create` på **datalagringen** | **Owner** eller **User Access Administrator** |
| 4 | `functionapp config appsettings set` | Contributor |
| 5 | `staticwebapp create`, `secrets list`, `backends link` | Contributor |
| 5 | `webapp auth update --enabled false` | Contributor |
| 9 | all verifikasjon | Reader |
| 11 | riving | Owner |

`Contributor` dekker alt unntatt én ting: **å tildele en rolle er en egen
rett**, og den følger ikke med. Den krever `Owner` eller `User Access
Administrator` på nøyaktig det scopet rollen skal gjelde.

`identity assign` med en user-assigned identitet trenger i tillegg
`Managed Identity Operator` på identiteten — den ligger inne i `Owner` på
ressursgruppa, så i praksis merker du den ikke.

**B. Azure RBAC utenfor ressursgruppa — må bestilles**

| Operasjon | Hvorfor den faller utenfor | Minsterolle, og hvor |
|---|---|---|
| `az group create` | **Ressursgruppa finnes ikke ennå** — du kan ikke eie den før den er opprettet | Contributor på **abonnementet** |
| Første `functionapp create` i et nytt abonnement | `Microsoft.Web`, `Microsoft.Storage` og `Microsoft.ManagedIdentity` må være registrert som ressursleverandører | Contributor på **abonnementet** |
| `Key Vault Secrets User` på `fhs-kv-01` (3.1) | Vaulten ligger ikke i din ressursgruppe | Owner/UAA på **vaulten** |
| Rollene SWA-ens plattformidentitet trenger (6) | Samme scope | Owner/UAA på **vaulten** |
| DNS-postene (10) | Sonen ligger hos registraren, eller i en annen ressursgruppe | `DNS Zone Contributor` på sonen, eller tilgang hos registraren |

**Be om to ting: `Owner` på ressursgruppa, og `User Access Administrator`
avgrenset til den ene vaulten.** Det er mindre enn det ser ut som, og det er
forskjellen mellom å kjøre kokeboka selv og å bestille fire kjøringer.

**C. Entra-roller — her hjelper ressursgruppa deg ikke**

| Trinn | Operasjon | Rolle som faktisk kreves |
|---|---|---|
| 6 | App-registrering for innlogging, eller ny redirect-URI på v2 sin | **Application Administrator**, *eller* å stå som **eier av den ene app-registreringen** |
| 8 | `az ad sp create-for-rbac`, app-registreringsdelen | **Application Administrator** (eller at tenanten tillater at brukere registrerer apper) |
| 8 | `az ad sp create-for-rbac`, `--role contributor --scopes <rg>` | Owner/UAA på ressursgruppa — altså A, ikke C |
| backup | `Sites.Selected` med administrator-samtykke | **Privileged Role Administrator** eller **Global Administrator** |
| backup | Skriverett på ett SharePoint-område | **SharePoint Administrator** eller Global Administrator |

Tre merknader som har kostet tid:

1. **`az ad sp create-for-rbac` er to operasjoner i én kommando**, med
   rettigheter fra hver sin verden. Mangler du den ene, feiler den halvveis
   — enten står app-registreringen igjen uten rolletildeling, eller omvendt.
   Kan du ikke registrere apper: la en administrator opprette
   tjenestehovedobjektet, og tildel rollen på ressursgruppa selv etterpå.
2. **`Application Administrator` kan ikke gi samtykke til
   applikasjonsrettigheter på Microsoft Graph.** Rollen dekker samtykke til
   det meste annet, men har et uttrykkelig unntak for nettopp disse. Det er
   derfor backup-appen trenger en høyere rolle enn resten — se
   `scripts/opprett-backup-app.ps1`, som deler jobben i steg og sier hvilken
   rolle hvert steg mangler.
3. **Den billigste veien rundt Application Administrator** er å bli ført opp
   som *eier* av den ene app-registreringen. En eier kan legge til
   redirect-URI-er og hemmeligheter på sin egen app uten noen katalogrolle.
   Trenger du bare trinn 6, spør om det i stedet for en rolle.

**D. Myndigheter som ikke er Azure i det hele tatt**

| Operasjon | Hvem |
|---|---|
| `gh secret set` (5.1 og 8) | Admin på GitHub-repoet |
| Import av flytløsningen, `SwaBaseUrl` (7) | Power Platform-miljøadministrator |
| Identitetens `oid` inn i flytenes allow-liste (7) | Eieren av flyten |
| Servicebrukeren meldt inn i teamet (7) | Teameieren |
| DNS-poster (10) | Den som eier sonen |

### 0.2 Key Vault: fire tilgangsbehov, og én felle

Fire prinsipaler trenger noe av vaulten, og de blandes lett:

| Hvem | Hva den gjør | Rolle på vaulten |
|---|---|---|
| **Du**, når verdiene limes inn | Skriver hemmeligheter | `Key Vault Secrets Officer`, pluss `Reader` på ressursen så verktøyet finner den |
| **`mi-skjema-3-prod`** | Løser `@Microsoft.KeyVault(...)` i app settings | `Key Vault Secrets User` |
| **SWA-ens plattformidentitet** | Henter auth-sertifikatet via `clientSecretCertificateKeyVaultReference` | `Key Vault Secrets User` **og** `Key Vault Certificate User` |
| **Den som tildeler de tre over** | Rolletildeling | `Owner` eller `User Access Administrator` på vaulten |

`Key Vault Administrator` dekker alt — og gir samtidig rett til å lese hver
hemmelighet i vaulten. `fhs-kv-01` deles med v2, så hold deg til de smale.

> **Fella: RBAC eller tilgangspolicy.** En vault kjører på én av to modeller.
> Står den på **tilgangspolicyer**, gjør en `Key Vault Secrets User`-tildeling
> ingenting: kommandoen lykkes, rollen står i lista, og oppslaget feiler
> likevel. Samme feilklasse som resten av dette repoet — to kilder, og begge
> tause. Sjekk først:

```powershell
az keyvault show --name $KV --query properties.enableRbacAuthorization
```

> `true` → rollene i tabellen over. `false` → det er en tilgangspolicy som
> skal settes (`az keyvault set-policy --secret-permissions get list`), og
> rollene er pynt.

Og et nettverksforbehold: står vaulten med `defaultAction: Deny`, feiler
referansene uansett rolle, fordi Function App-en ikke slipper gjennom
brannmuren.

```powershell
az keyvault show --name $KV --query "properties.networkAcls" -o json
```

---

### 0.3 Hvis v2 og v3 deler ressursgruppe

En ressursgruppe er en forvaltningsbeholder, ikke en grense ved kjøring. v2 og
v3 i samme gruppe deler ingen kvote, ingen vert og ingen kjøretid, og navnene
kolliderer ikke: `*-skjema-3-prod` mot v2 sine `*-fhsskjema-prod`, og
lagringskonto, Function App og SWA har globalt unike navn uansett.

Det er dessuten **én reell fordel**: ved cutover skal v3 sin identitet ha de
tre storage-rollene på v2 sin datakonto. Ligger begge i samme gruppe, er den
tildelingen innenfor et scope du eier, og trenger ingen bestilling.

Fire ting må likevel gjøres annerledes.

**1. Tjenestehovedobjektet for deploy må ikke få ressursgruppa.**

Dette er den som betyr noe. Kokeboka ga tidligere `sp-skjema-3-prod-deploy`
rollen `contributor` på **ressursgruppa**. Deles gruppa med v2, rekker den
samme GitHub-hemmeligheten over v2 sin lagringskonto — og `Contributor` gir
rett til å liste kontonøklene, altså full datatilgang til produksjonsdata
gjennom en sidedør. `app-name` i deploy-workflowen er dessuten et *input*,
så en feil utfylling peker på en ekte v2-ressurs. Trinn 8 scoper derfor til
**den ene Function App-en**.

**2. Sjekk låser og policyer FØR du oppretter noe.**

En `CanNotDelete`-lås på gruppa arver nedover og treffer v3 også — og under
testing skal v3-ressurser kunne rives og settes opp på nytt. En
`allowed-locations`-policy på gruppa kan avvise SWA-en, som opprettes i
`westeurope` mens resten står i `norwayeast`.

```powershell
az lock list --resource-group $RG -o table
az policy assignment list --resource-group $RG --query "[].{navn:displayName, policy:policyDefinitionId}" -o table
```

Skal v2 beskyttes, hører låsen på **v2 sine ressurser**, ikke på gruppa. Og
den som faktisk er verdt å sette, er en `CanNotDelete` på v2 sin
datalagringskonto — den skal overleve både cutover og rivingen av v3.

**3. Merk alt med versjon.**

Uten en tagg er det ingen måte å skille v2 fra v3 i kostnadsanalysen, og
rivingen i trinn 11 blir en navneøvelse.

```powershell
az tag update --resource-id (az functionapp show --name $FA --resource-group $RG --query id -o tsv) --operation merge --tags versjon=v3 --output none
az resource list --resource-group $RG --query "[].{navn:name, type:type, versjon:tags.versjon}" -o table
```

**4. `az group delete` er forbudt så lenge begge lever.**

Rivingen i trinn 11 sletter ved navn, én ressurs om gangen, og det er med
vilje. En delt gruppe gjør snarveien til et totalhavari.

> **To Application Insights-ressurser i samme gruppe.** `functionapp create`
> kan opprette sin egen, ved siden av v2 sin `ai-fhsskjema-prod`. Ingen
> konflikt, men loggene ligger da på to steder — og en feilsøking i feil
> ressurs ser ut som «ingen trafikk».

**Når er en egen ressursgruppe likevel riktig?** Når du vil kunne rive v3 med
én kommando, og når blast radius skal være null. Prisen er at `az group
create` krever Contributor på **abonnementet** (0.1 B), altså en bestilling.
Har du gruppa fra før og ikke abonnementet, er delt gruppe med punktene over
det rimelige valget.

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

Forventet er rollene `scripts/steg1-funcapp.ps1` tildeler. Tabellen under og
lista i skriptet er to kilder til det samme, så `api/test/kokebok.test.js`
leser begge og krever likt svar:

<!-- roller-fra-steg1 -->

| Rolle | Scope |
|---|---|
| `Storage Table Data Contributor` | datalagringen `stskjema3prod` |
| `Storage Blob Data Contributor` | datalagringen `stskjema3prod` |
| `Storage Blob Delegator` | datalagringen `stskjema3prod` |
| `Key Vault Secrets User` | vaulten |

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
$scope = "/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.Web/sites/$FA"
$creds = az ad sp create-for-rbac --name sp-skjema-3-prod-deploy --role contributor --scopes $scope --sdk-auth
gh secret set AZURE_FUNCAPP_CREDENTIALS_PROD --body $creds
Remove-Variable creds
```

**Scopet er den ene Function App-en, ikke ressursgruppa.** Deles gruppa med
v2 (0.3), rekker ellers denne GitHub-hemmeligheten over v2 sin lagringskonto,
og `Contributor` gir rett til å liste kontonøklene — produksjonsdata gjennom
en sidedør. `app-name` i workflowen er et input, så en feil utfylling peker
på en ekte v2-ressurs.

> **Prøv det i dev først.** `Azure/functions-action` slår opp appen på navn,
> og et oppslag kan trenge leserett bredere enn den ene ressursen. Virker det
> ikke, er neste trinn `Reader` på ressursgruppa **i tillegg** til
> `contributor` på appen — ikke `contributor` på gruppa.

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

### Er v2 den eneste som skriver?

**Observert 19.10.2026, ikke bekreftet:** den opprinnelige løsningen (v1) ser
ut til å kjøre oppdateringer fortsatt, mot sin egen lagringskonto. Det ble
oppdaget fordi en tom LU-kolonne ble feilsøkt i v1 sin `Emner`-tabell i den
tro at det var prod — tabellen har samme navn og samme form, og v1 sine
jobber skriver ikke LU-feltet.

To ting følger av det, og begge hører hjemme FØR cutover:

1. **Planen under forutsetter at v2 er den eneste som skriver.** Er v1 også i
   drift, er det tre stabler, ikke to — og «ta prod ut av matrisene» dekker
   ikke v1 sine jobber, som ligger et annet sted.
2. **Lagringskontoene må kunne skilles fra hverandre på navn alene.** To
   konti med samme tabellnavn og samme kolonner er ikke til å se forskjell på
   i en portal. Fra 19.10.2026 melder `/api/system/info` hvilken konto
   miljøet faktisk leser fra — sjekk den, ikke hukommelsen.

Avklar hva v1 fortsatt gjør, og om noe eller noen leser fra den.

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

### Domenet: DNS, egendefinert domene og CORS

Et eget domene er det som gjør cutover til én DNS-endring. Oppsettet er tre
ting, og den tredje er at det ikke er noe å gjøre.

**1. Postene. CNAME på subdomenene, ALIAS eller ANAME på apex.**

En CNAME kan ikke stå på sonens apex — det er DNS-standarden, ikke Azure. Så:

| Navn | Posttype | Peker på |
|---|---|---|
| `pilot.fskjema.no` | CNAME | pilot-SWA-ens `*.azurestaticapps.net` |
| `dev.fskjema.no` | CNAME | dev-SWA-ens `*.azurestaticapps.net` |
| `v3.fskjema.no` | CNAME | `swa-skjema-3-prod` sin `*.azurestaticapps.net` |
| `fskjema.no` (apex) | ALIAS / ANAME | samme vertsnavn — se under |

Apex har tre veier, i synkende renhet:

1. **Sonen i Azure DNS.** Da opprettes TXT-posten for validering og
   ALIAS-posten automatisk når domenet legges til, forutsatt at den som gjør
   det har `DNS Zone Contributor` på sonen. Dette er den eneste varianten der
   cutover og tilbakevei er samme kommando med to forskjellige verdier.
2. **ALIAS eller ANAME hos registraren**, om den støtter det. Flere norske
   registrarer gjør det. Fungerer, men flyttingen skjer i registrarens panel.
3. **A-post mot en IP — ikke gjør dette.** To grunner: SWA garanterer ingen
   statisk IP, og en A-post sender all trafikk til én region, så den globale
   distribusjonen forsvinner.

Apex krever **TXT-token-validering** (`dns-txt-token`), ikke
CNAME-delegering. Les host-verdien ut av portalen eller kommandoen under —
noen leverandører vil ha hosten uten domenesuffikset, og det er den vanligste
grunnen til at valideringen står og henger i to døgn. Bekreft at posten er
synlig *før* du begynner å vente:

```powershell
Resolve-DnsName -Name _dnsauth.fskjema.no -Type TXT -Server 8.8.8.8
```

Har sonen en CAA-post, må den slippe inn **DigiCert**. Har den ingen CAA, er
det ingenting å gjøre.

**2. Egendefinert domene settes på SWA-ressursen, én gang per miljø.**

```powershell
az staticwebapp hostname set --name $SWA --resource-group $RG --hostname v3.fskjema.no --validation-method cname-delegation
az staticwebapp hostname show --name $SWA --resource-group $RG --hostname v3.fskjema.no -o table
```

Apex tar `--validation-method dns-txt-token` i stedet. Sjekk flaggene mot
`az staticwebapp hostname set --help` først — CLI-en har endret dem før.

Standardnavnet `*.azurestaticapps.net` forsvinner ikke; det svarer videre,
parallelt. Sertifikatet utsteder og fornyer SWA selv. Kvoten er to
egendefinerte domener på Free og seks på Standard, og v3 er Standard uansett
fordi lenkede backends ikke finnes på Free.

**3. CORS: ingenting å sette opp — og ingenting som skal settes opp.**

Frontend og API er **samme origin**. Alle kall i `frontend/js/api-client.js`
går til relative stier (`/api/...`), og SWA-fronten proxer dem videre til den
lenkede Function App-en server-til-server. Nettleseren snakker aldri med
`*.azurewebsites.net`. Det finnes derfor ingen preflight og ingen
`Access-Control-Allow-Origin` å sette, og CSP-en kan stå med
`connect-src 'self'` gjennom et domenebytte — `'self'` følger dokumentets
origin, uansett hva det heter.

Tre konsekvenser:

- **Ikke åpne CORS på Function App-en.** Den skal bare ta imot fra
  SWA-fronten; en CORS-liste der er en vei inn som omgår lenkingens
  Easy Auth. Kontroller at lista er tom:

```powershell
az functionapp cors show --name $FA --resource-group $RG -o json
```

- **Krever noe CORS, er det et symptom.** Da kaller noe et absolutt vertsnavn
  i stedet for en relativ sti, og rettelsen er å fjerne vertsnavnet.
- Inngående kall fra Power Automate og Power BI-connectoren er
  server-til-server. CORS gjelder dem ikke i noen retning.

**4. Det som må følge etter vertsnavnet**

Dette er delen som brekker stille:

| Hva | Hvor | Merknad |
|---|---|---|
| Redirect-URI `https://<nytt-navn>/.auth/login/aad/callback` | App-registreringen i Entra | **Behold den gamle.** Flere URI-er er greit; fjerner du den gamle, ryker innloggingen på den adressen midt i testingen |
| `SWA_URL` | App setting på Function App-en | Adressen e-postlenker og flyt-callbacks bygges fra |
| `SwaBaseUrl` | Miljøvariabel i Power Platform-løsningen | Det inngående flytene bygger URL-er fra. Se `docs/FLYTER.md` |

**Under testing skal `SWA_URL` peke på v3 sitt eget navn**, ikke på det
offentlige. Ellers sender testkjøringene eksterne mottakere til kjørende prod.

```powershell
az functionapp config appsettings set --name $FA --resource-group $RG --settings SWA_URL=https://v3.fskjema.no --output none
```

Ved cutover settes den til `https://fskjema.no` på v3 — og **bort** fra det
navnet på v2, slik at bare én stabel påstår å være den offentlige adressen.


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
