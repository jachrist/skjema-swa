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

**Og noen variabelnavn er opptatt.** PowerShell har innebygde,
skrivebeskyttede variabler, og `$pid` er en av dem — den er prosess-ID-en.
Tilordner du den, feiler linja med «Cannot overwrite variable PID because it
is read-only or constant», midt i en ellers riktig kommando. Målt
21.10.2026. De vanligste å snuble i: `$pid`, `$host`, `$error`, `$input`,
`$args`, `$matches`, `$home`, `$pwd`. Variablene i denne kokeboka er valgt
utenom dem.

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
| ☐ | **Backup-sertifikatet importeres som PEM** | Se 0.4, der hele veien er prøvd i dev. Importeres det som PFX, kan koden ikke lese det — og en omgjøring etterpå krever at privatnøkkelen håndteres manuelt |

```powershell
az login --tenant <prod-tenant-id>
az account set --subscription <abonnements-id>
az account show --query "{abonnement:name, id:id, tenant:tenantId}" -o table
```

**Den siste linja er ikke pynt.** Har du logget inn i flere tenanter, står
dev-abonnementet i samme liste som prod, og `az` husker det som var sist
valgt — også mellom to økter. Hver kommando i denne kokeboka treffer da et
annet miljø enn du tror, og de fleste av dem er ikke reversible. Les ut
tenant-ID-en og sammenlign med den i 1, hver gang du åpner et nytt vindu.

### 0.0 `az` uten administratorrettigheter på PC-en

MSI-installasjonen krever administrator. **ZIP-pakken gjør det ikke** — den er
Microsofts egen, og pakkes ut hvor som helst:

```powershell
$mal = "$env:LOCALAPPDATA\AzureCLI"
Invoke-WebRequest -Uri 'https://aka.ms/installazurecliwindowszipx64' -OutFile "$env:TEMP\azurecli.zip"
Expand-Archive -Path "$env:TEMP\azurecli.zip" -DestinationPath $mal -Force

# Stien til az.cmd slås OPP, ikke gjettet: om arkivet pakker ut med en
# toppmappe (azure-cli-<versjon>\bin) eller rett i bin\, er ikke garantert og
# har variert mellom versjoner. Et hardkodet "$mal\bin\az.cmd" feiler da med
# «finner ikke stien», som ser ut som en mislykket nedlasting.
$az = Get-ChildItem -Path $mal -Recurse -Filter 'az.cmd' | Select-Object -First 1
if (-not $az) { throw "Fant ikke az.cmd under $mal - sjekk at utpakkingen gikk" }
& $az.FullName --version
```

Virker den siste linja, er resten bare PATH. Den settes for BRUKEREN, som
heller ikke krever administrator — men les kommandoen før du kjører den.
`SetEnvironmentVariable` ERSTATTER verdien, så faller `$naa` ut av strengen,
står brukerens PATH igjen med bare denne ene mappa.

```powershell
$bin = $az.Directory.FullName
$naa = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($naa -notlike "*$bin*") {
    [Environment]::SetEnvironmentVariable('Path', "$naa;$bin", 'User')
}
```

Kjør den i samme vindu som blokka over — `$az` kommer derfra.

Åpne et nytt PowerShell-vindu etterpå — et vindu som alt står åpent, leser
ikke PATH på nytt.

To forbehold:

* **`az upgrade` virker ikke** på en ZIP-installasjon. Oppgradering er å pakke
  ut en nyere ZIP over den samme mappa.
* **På en administrert PC blir den sannsynligvis blokkert likevel.** Målt
  20.10.2026: nedlasting og utpakking gikk fint, men kjøring ga

  > «Dette programmet er blokkert for gruppepolicy. Kontakt systemansvarlig
  > for mer informasjon.»

  Det er en policy som hindrer kjøring av programmer fra brukerskrivbare
  mapper — AppLocker, WDAC eller en SRP. **Den skal ikke omgås.** Den er
  nettopp det som hindrer at nedlastet kode kjører, og en kokebok som viste
  en vei rundt, ville vært en oppskrift på å svekke maskinen som har tilgang
  til prod.

### 0.0.1 Når `az` er blokkert lokalt

Rekkefølgen her er praktisk, ikke prinsipiell:

**1. Azure Cloud Shell.** `az` er forhåndsinstallert og alltid oppdatert, og
hele denne kokeboka kjører der som den står — ingen installasjon, ingen
policy, ingen unntak å be om. Velg **PowerShell** som skall, så stemmer
syntaksen med kommandoene her.

Skal du kjøre `.ps1`-skriptene i `scripts/`, er de to veiene inn å klone
repoet i Cloud Shell, eller laste opp den enkelte fila med
opplastingsknappen. `Microsoft.Graph`- og `Az.KeyVault`-modulene skriptene
trenger, er forhåndsinstallert der.

> **To ulike Cloud Shell, og du må vite hvilken du har.** Er en lagringskonto
> montert, ligger `$HOME` i en Azure Files-andel og overlever økta — da hører
> private nøkler i `/tmp`, ikke i hjemmemappa (se 0.4). Kjører sesjonen
> **efemert** (uten lagringskonto), slettes `$HOME` ved omstart, og da
> forsvinner klonen og alt du har endret lokalt med den. Målt 21.10.2026:
> hjemmemappa var tom etter en omstart, og en lokalt rettet kopi av skriptet
> var borte.
>
> ```powershell
> if (Test-Path ~/clouddrive) { "montert - `$HOME` overlever" } else { "efemer - `$HOME` slettes" }
> ```
>
> Regelen for private nøkler er den samme uansett: bruk `/tmp`. Men er
> sesjonen efemer, må alt du vil beholde pushes eller lastes ned FØR du
> lukker vinduet.

**2. Be systemansvarlig installere `az` med MSI-en.** Det er den sanksjonerte
veien til `az` lokalt: Microsofts signerte MSI legger seg i `Program Files`,
som policyen normalt tillater. Spør om det framfor et unntak for
`%LOCALAPPDATA%` — et unntak der gjelder alt du laster ned senere også.

**3. Az-modulene i PowerShell** (`Install-Module Az -Scope CurrentUser`).
Moduler er ikke programmer og rammes ofte ikke av samme policy, så prøv
`Connect-AzAccount` og se. Men kommandoene i denne kokeboka er
`az`-kommandoer, og da må hver av dem oversettes — det er mer arbeid enn
Cloud Shell, og en oversettelse gjort under tidspress er en ny feilkilde i en
kokebok der de fleste stegene ikke er reversible.

---

### 0.1 Rettigheter: hva du gjør selv, og hva som må bestilles

Tre myndigheter er i spill, og de henger **ikke** sammen. Eier på
ressursgruppa gir deg ingenting i katalogen, og en Global Administrator har
ikke automatisk tilgang til en eneste ressurs. Det er her et arbeidsmøte
stopper: alt i Azure går, og så står man fast på én app-registrering.

**A. Azure RBAC inne i ressursgruppa (`fhs-prod-rg-01`) — dette gjør du selv**

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
| **Du**, når backup-sertifikatet utstedes (0.4) | Oppretter et sertifikat | **`Key Vault Certificates Officer`** — `Secrets Officer` dekker IKKE sertifikater. Se under |
| **`mi-skjema-3-prod`** | Løser `@Microsoft.KeyVault(...)` i app settings | `Key Vault Secrets User` — også for en secret som er ryggen av et SERTIFIKAT (målt 20.10.2026 i dev); `Key Vault Certificate User` trengs ikke her |
| **SWA-ens plattformidentitet** | Henter auth-sertifikatet via `clientSecretCertificateKeyVaultReference` | `Key Vault Secrets User` **og** `Key Vault Certificate User` |
| **Den som tildeler de tre over** | Rolletildeling | `Owner` eller `User Access Administrator` på vaulten |

`Key Vault Administrator` dekker alt — og gir samtidig rett til å lese hver
hemmelighet i vaulten. `fhs-kv-01` deles med v2, så hold deg til de smale.

> **`Secrets Officer` er ikke nok til å lage et sertifikat.** Rollene i Key
> Vault er delt per objekttype: `Secrets Officer` gjelder hemmeligheter,
> `Certificates Officer` gjelder sertifikater. `az keyvault certificate
> create` i 0.4 feiler med «forbidden» uten den siste — og feilmeldingen
> peker på vaulten, ikke på rollen.
>
> De henger likevel sammen her: `Certificates Officer` dekker ikke
> nødvendigvis det å LESE secret-ryggen av sertifikatet, og det er nettopp
> den `az keyvault secret show --query contentType` leser når du
> kontrollerer at PEM-policyen slo gjennom. Har du begge, er du dekket.
>
> **`Owner` på ressursen gir ikke dataplantilgang** i en RBAC-vault — men den
> gir rett til å tildele roller, også til deg selv. Mangler du
> `Certificates Officer`, kan du altså gi deg den (og bør fjerne den igjen
> etterpå):
>
> ```powershell
> $meg = az ad signed-in-user show --query id -o tsv
> az role assignment create --assignee-object-id $meg --assignee-principal-type User `
>     --role "Key Vault Certificates Officer" `
>     --scope "/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.KeyVault/vaults/$KV"
> ```

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

### 0.4 Backup-appen: sertifikatet må være PEM

Backup-appen (`Sites.Selected` mot SharePoint) kan autentisere seg med **enten**
en client secret **eller** et sertifikat. Velges sertifikat, er det ett krav
som må stå i bestillingen:

> **Sertifikatet skal importeres i Key Vault med innholdstype
> `application/x-pem-file`**, ikke `application/x-pkcs12`.

Grunnen er målt 19.10.2026 på Node 22.22: `crypto.createPrivateKey` avviser
PKCS#12/PFX i **alle** former (`ERR_OSSL_UNSUPPORTED`). PEM leses direkte.
Key Vault sin secret-representasjon — den app-settingen refererer til — følger
innholdstypen sertifikatet ble importert med. Er den PFX, finnes det ingen vei
videre fra koden.

**Standardvalget er feil vei.** Laster noen opp en `.pfx`-fil, blir
innholdstypen `application/x-pkcs12` uten at noen tar et valg. Det er derfor
dette står i bestillingen og ikke i en feilsøkingsliste.

Sjekk hva som faktisk ble importert — kommandoen skriver bare dommen, aldri
nøkkelen:

```powershell
az keyvault secret show --vault-name $KV --name <sertifikatnavn> --query "contentType" -o tsv
```

> **Ble det PFX likevel?** Da må privatnøkkelen konverteres, og den er i
> klartekst mens det skjer. **Gjenopprett ikke sertifikatet** — et nytt
> nøkkelpar betyr at app-registreringen må oppdateres av en administrator på
> nytt. Konverter i stedet, og legg PEM-en inn som en **egen secret** ved
> siden av sertifikatet, f.eks. `graph-client-cert-pem`. Framgangsmåten, og
> hvorfor `$HOME` i Cloud Shell er feil sted å gjøre det, står i
> `docs/BACKUP-SHAREPOINT.md`.

Velges client secret i stedet, gjelder ingenting av dette — da er
`GRAPH_CLIENT_SECRET` hele oppsettet, og `GRAPH_CLIENT_CERT_PEM` står tom.

**Veien er prøvd 20.10.2026, i dev** — ikke bare formatkravet, men hele
kjeden: Key Vault utstedte sertifikatet med PEM-policyen,
`@Microsoft.KeyVault(...)` løste det på Function App-en,
`lagKlientAssertion()` signerte, Entra godtok, og backupen havnet i
SharePoint. Fire funn hører i bestillingen:

| Funn | Hva det betyr for bestillingen |
|---|---|
| `Key Vault Secrets User` **alene** var nok for en sertifikat-secret | API-identiteten trenger ikke `Key Vault Certificate User`. Den står i 0.2 for SWA-ens *plattformidentitet*, som henter auth-sertifikatet — en annen tildeling til et annet formål |
| Ingen client secret i det hele tatt | `scripts/opprett-backup-app.ps1 -Sertifikat` hopper over steget. En hemmelighet som ikke skal brukes er en ekstra vei inn, en ekstra utløpsdato — og den **vinner** over sertifikatet i `tokenKropp()` |
| Sertifikatet må ligge på appen `GRAPH_CLIENT_ID` peker på | `AADSTS700027` handler om nettopp den appen, ikke om en app der avtrykket tilfeldigvis også finnes. I dev havnet det først på deploy-tjenestehovedobjektet, og avtrykket stemte med Key Vault hele tiden |
| Skrivetilgangen til området gis **bare** via Graph | Det finnes ingen portalside for `Sites.Selected`-tildelingen. Feiler steget, er `(Get-MgContext).Scopes` sjekken: `Connect-MgGraph -Scopes` *ber* om delegerte rettigheter, og Global Administrator-rollen gir dem ikke av seg selv |

Framgangsmåten, kommando for kommando, står i `docs/BACKUP-SHAREPOINT.md`
under «Prøv i dev først». Den begynner nå med at app-registreringen må finnes
— det var det som manglet.

---

### 0.5 App-registreringene fra v2 kan gjenbrukes

Begge, og det sparer to bestillinger. En app-registrering er ikke bundet til
en SWA eller en Function App — den er bundet til tenanten.

**Auth-appen (pålogging).** Gjenbrukes med en NY redirect-URI, se trinn 6.
Begge URI-ene står side om side mens v2 og v3 kjører parallelt, og den gamle
fjernes ved riving. Tre forbehold:

* Flytter du domenet ved cutover, må redirect-URI-en for domenet også ligge
  der — se 10.
* `AAD_CLIENT_ID` blir den samme i begge miljøene. Det er greit, men det
  betyr at en endring på appen (f.eks. rotasjon av auth-sertifikatet) treffer
  v2 og v3 SAMTIDIG. Under parallellkjøring er det en fordel; ved feilsøking
  er det en felle, for «bare v3 er nede» kan ikke skyldes appen alene.
* Sertifikatet hentes av SWA-ens EGEN plattformidentitet. Den nye SWA-en har
  en annen identitet enn v2, og den trenger `Key Vault Secrets User` **og**
  `Key Vault Certificate User` på vaulten — se 0.2. Appen gjenbrukes,
  rolletildelingen gjør det ikke.

**Backup-appen (`Sites.Selected`).** Gjenbrukes uendret: `Sites.Selected` og
områdetildelingen henger på appen, ikke på miljøet. v3 trenger bare
`GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID` og én legitimasjon i sine egne app
settings.

Og her er det en vei som sparer enda et steg: **en app-registrering kan bære
en client secret OG et sertifikat samtidig.** De ligger i to ulike
samlinger. Legg sertifikatet på den eksisterende backup-appen, la v2 beholde
hemmeligheten sin, og la v3 bruke sertifikatet. Ingen ny app, ingen bestilling,
og ingenting å endre i v2.

> **`GRAPH_CLIENT_SECRET` MÅ stå tom i v3.** Er begge satt, vinner
> hemmeligheten i `tokenKropp()`, og da kjører v3 på v2 sin legitimasjon uten
> at noe sier fra. Sertifikatveien er da aldri prøvd — og det oppdages den
> dagen hemmeligheten utløper.

**To backupjobber mot samme område.** Kjører v2 og v3 backup parallelt, legger
begge filer i det samme biblioteket. Sjekk at filnavnene skiller miljøene fra
hverandre før du slår på den andre jobben; to filer med samme navn er ikke en
backup, det er én.

---

### 0.6 Gjennomkjøring i dev-tenanten først

Kokeboka kan prøves ende til ende i dev-tenanten før den kjøres mot prod. Da
opprettes et v3-oppsett ved siden av det som alt står der, og rives etterpå.

**Bruk `MILJO=dev`. Ikke finn opp et nytt miljønavn.** Det er ikke bare
enklere — det er riktigere:

| Hva navnet styrer | Hvorfor `dev` er svaret |
|---|---|
| `LØSER_KEYVAULT_REFERANSER` i `lib/plattform.js` | Inneholder `dev`. Et nytt navn ville fått helsesjekken til å gi råd for SWA Managed Functions — «lim inn verdien som klartekst» — i et miljø der referansene virker |
| `KJORER_TIMERE` | Inneholder `dev`. Et ukjent navn gir ingen timer |
| `KJENTE_MILJOER` | Et navn utenfor settet er «vet ikke», ikke «gjelder ikke». Alle miljøspesifikke råd blir da uttrykt med forbehold |
| `config/env.<navn>.json` | Et nytt navn krever en ny, KOMPLETT inventarfil — `env-inventar.test.js` krever at hver `process.env` i `api/src` står i hver av dem |

Et nytt miljønavn koster altså fire filer og gir dårligere diagnostikk. Det
som faktisk må være nytt, er ressursnavnene — og de er parametre, ikke kode:

| Hva | Hvordan |
|---|---|
| Function App | `appnavn` er et input til «Deploy API til Function App». Velg `miljo: dev` |
| SWA | `swa_token_secret` er et input til frontend-workflowen (5.2). Legg v3-tokenet i en EGEN hemmelighet — ikke bytt verdien på den faste |
| Lagringskonto, Key Vault | Opprettes av kokeboka. Isolasjonen mellom prøveoppsettet og det ekte dev-miljøet ligger HER, ikke i miljønavnet |

To ting som deler på tvers av miljønavnet, og som må vurderes bevisst:

* **`TODO_STORAGE_CONNECTION_STRING`.** Er den satt, havner oppgavelista og
  nøkkelkalenderen i det DELTE lageret, med miljønavnet som partisjonsnøkkel.
  To `dev`-apper skriver da i samme rader. La den stå tom i prøveoppsettet;
  da er listene lokale, og UI-et sier det.
* **Backupfilnavnet** er `<MILJO>-backup-<tidsstempel>.fsbk`. To
  `dev`-oppsett gir filer med samme navnemønster. Skiller de seg bare på
  tidsstempelet, kan du ikke se hvilket oppsett som laget hvilken fil — gi
  prøveoppsettet et eget bibliotek eller en egen mappe.

**Globalt unike navn** er lagringskonto, Key Vault, Function App og
SWA-vertsnavn. Et prefiks på disse fire er riktig grep i en tenant som alt har
et oppsett — men da avviker navnene fra kapittel 1, så skriv ned
oversettelsen før du begynner, ikke underveis.

---

## 1. Navn og variabler

Samme konvensjon som dev, med `dev` → `prod`.

| Rolle | dev | **prod v3** |
|---|---|---|
| Ressursgruppe | `rg-skjema-3-dev` | **`fhs-prod-rg-01`** — den eksisterende gjenbrukes, se 0.3 |
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

Ressursgruppa er den v2 alt kjører i. Det er en beslutning, ikke en
forenkling: `az group create` krever Contributor på abonnementet, og 0.3 sier
hva man må passe på når to versjoner deler gruppe.

```powershell
$RG   = 'fhs-prod-rg-01'
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

**Ressursgruppa opprettes IKKE hvis den finnes.** I prod er valget å gjenbruke
den eksisterende — se 0.3. Og `az group create` er ikke gratis selv om gruppa
finnes: kommandoen krever **Contributor på abonnementet** (0.1 B), og den
rettigheten har ikke den som bare eier gruppa. Da stopper kapittel 2 på sin
første linje, av en grunn som ikke har noe med oppgaven å gjøre.

```powershell
if ((az group exists --name $RG) -eq 'true') {
    Write-Host "Ressursgruppa $RG finnes - gjenbrukes, se 0.3"
} else {
    az group create --name $RG --location $STED --output none
}
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
    Rg          = 'fhs-prod-rg-01'
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

Forventet er rollene `scripts/steg1-funcapp.ps1` tildeler — **og ingen
andre.** Står det noe mer i lista, er det noe som er lagt til for hånd, og da
skal det enten forklares eller fjernes. 21.10.2026 lå det igjen en `Reader`
på ressursgruppa fra prøven i 3.3 steg 7; identiteten trenger den ikke, og en
tildeling ingen har besluttet hører ikke i prod:

```powershell
$arg = @(
    'role', 'assignment', 'delete',
    '--assignee', $PRINCIPAL,
    '--role', 'Reader',
    '--scope', "/subscriptions/$SUB/resourceGroups/$RG"
)
az @arg
```

Tabellen under og lista i skriptet er to kilder til det samme, så
`api/test/kokebok.test.js` leser begge og krever likt svar:

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

### 3.3 `AuthorizationFailed` betyr to ulike ting

Feiler en rolletildeling, ser meldingen slik ut:

> (AuthorizationFailed) The client '…' with object id '…' does not have
> authorization to perform action
> 'Microsoft.Authorization/roleAssignments/write' over scope
> '…/storageAccounts/stskjema3prod/…' **or the scope is invalid.**

**«or the scope is invalid» til slutt er halve meldingen, og den drukner.**
Azure svarer det samme når du mangler rettigheten OG når ressursen du tildeler
på ikke finnes. Skjedde 21.10.2026: trinnet ble kjørt i en ressursgruppe der
datalagringskontoen ennå ikke var opprettet, og feilen leste som en
rettighetsfeil hos en bruker som var `Owner`.

`steg1-funcapp.ps1` sjekker nå at omfangene finnes før den tildeler, og sier
hvilket som mangler. Møter du meldingen likevel, er rekkefølgen her:

**1. Finnes ressursen?** Et navn på feil plass gir ugyldig omfang.

```powershell
az storage account show --name $DATA --resource-group $RG --query name -o tsv
az keyvault show --name $KV --query name -o tsv
```

**2. Er det DEG feilen handler om?** Meldingen oppgir `object id` på klienten.
Sammenlign den med din egen — to kontoer i samme tenant, eller en
tjenestehovedobjekt-innlogging som ligger igjen i Cloud Shell, gir en
«rettighetsfeil» på en identitet du ikke tenkte på.

```powershell
az ad signed-in-user show --query "{navn:userPrincipalName, objectId:id}" -o table
```

**3. Hvilke roller har du EGENTLIG, og på hvilket nivå?**

```powershell
$meg = az ad signed-in-user show --query id -o tsv
$arg = @(
    'role', 'assignment', 'list',
    '--assignee', $meg,
    '--scope', "/subscriptions/$SUB/resourceGroups/$RG",
    '--include-inherited',
    '--query', '[].{rolle:roleDefinitionName, omfang:scope}',
    '-o', 'table'
)
az @arg
```

`Owner` på ressursgruppa dekker rolletildeling på ressursene inne i den —
`Contributor` gjør det IKKE. Den gir rett til å lage og endre ressurser, men
ikke til å tildele roller, og forskjellen vises først her.

Står rollen i lista, er den en FAST tildeling. Står den ikke der selv om
portalen sier du er Owner, er den PIM-styrt — se 5.

**4. Har `Owner`-tildelingen din en BETINGELSE?** Dette er det som ser mest ut
som en selvmotsigelse, og det er helt lovlig: en `Owner`- eller
`User Access Administrator`-tildeling kan bære en betingelse som begrenser
HVILKE roller innehaveren får tildele, og til hvilke prinsipaltyper. Da er du
Owner, omfanget finnes, og `roleAssignments/write` avvises likevel — med samme
`AuthorizationFailed`.

Sentral IT bruker dette for å delegere eierskap uten å gi bort retten til å
dele ut dataplanroller. Og det er nettopp dataplanroller trinn 3 tildeler.

```powershell
$meg = az ad signed-in-user show --query id -o tsv
$arg = @(
    'role', 'assignment', 'list',
    '--assignee', $meg,
    '--scope', "/subscriptions/$SUB/resourceGroups/$RG",
    '--include-inherited',
    '--query', '[].{rolle:roleDefinitionName, betingelse:condition, versjon:conditionVersion}',
    '-o', 'json'
)
az @arg
```

Er `betingelse` noe annet enn `null`, er svaret funnet. Les uttrykket: det
navngir rolle-ID-ene du har lov til å tildele. Mangler
`Storage Table Data Contributor`, `Storage Blob Data Contributor`,
`Storage Blob Delegator` eller `Key Vault Secrets User` blant dem, er dette
en bestilling — 0.1 sier til hvem, og de fire rollene står i 3.2.

**5. Er `Owner` aktivert, eller bare tilgjengelig?** Er rollen styrt av PIM, må
den aktiveres — og tokenet ditt må fornyes etterpå. Det er nettopp det
«If access was recently granted, please refresh your credentials» viser til:

```powershell
az account clear
az login --tenant <prod-tenant-id>
```

**6. Finnes en deny assignment?** De overstyrer `Owner`, og settes av Azure
Blueprints eller en managed application. Står du i lista med `Owner` uten
betingelse, og omfanget finnes, er dette det som er igjen.

**Spør på BEGGE nivåene.** En deny assignment satt på abonnementet eller en
administrasjonsgruppe gjelder nedover, og et oppslag på ressursgruppa alene
viser den ikke nødvendigvis. Et tomt svar på ressursgruppenivå er derfor ikke
et svar — 21.10.2026 ble det lest som ett.

```powershell
$url = "https://management.azure.com/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.Authorization/denyAssignments?api-version=2022-04-01"
$arg = @(
    'rest', '--method', 'get', '--url', $url,
    '--query', 'value[].{navn:properties.denyAssignmentName, beskrivelse:properties.description}',
    '-o', 'table'
)
az @arg
```

Bytt `/resourceGroups/$RG` ut med bare `/subscriptions/$SUB` i URL-en og kjør
den om igjen.

Finner du en, er den ikke din å fjerne — da er dette en bestilling, og 0.1
sier til hvem.

**7. Er det rettigheten eller omfanget?** Når alt over er rent, skiller denne
prøven de to siste verdenene fra hverandre. `Reader` er harmløs og tildeles på
RESSURSGRUPPA, der `Owner` er direkte tildelt — ikke arvet:

```powershell
$arg = @(
    'role', 'assignment', 'create',
    '--assignee-object-id', $PRINCIPAL,
    '--assignee-principal-type', 'ServicePrincipal',
    '--role', 'Reader',
    '--scope', "/subscriptions/$SUB/resourceGroups/$RG"
)
az @arg
```

| Utfall | Hva det betyr |
|---|---|
| Feiler også | Du får ikke tildele roller i det hele tatt. Ingenting av det kokeboka ber om i trinn 3 vil gå, og det er en bestilling |
| Går igjennom | Rettigheten finnes. Da er det noe ved det smalere omfanget, eller ved de fire rollene — se 4 og 6 igjen, og prøv på nytt etter en ny innlogging |

**Rydd opp etterpå**, uansett utfall — en `Reader`-tildeling som blir
stående, er en tildeling ingen har besluttet:

```powershell
$arg = @(
    'role', 'assignment', 'delete',
    '--assignee', $PRINCIPAL,
    '--role', 'Reader',
    '--scope', "/subscriptions/$SUB/resourceGroups/$RG"
)
az @arg
```

**8. Og det meldingen selv foreslår.** ARM mellomlagrer rolletildelinger i noen
minutter, og et token hentet før tildelingen ble gitt bærer ikke
gruppemedlemskapene den hviler på. Er `Owner` gitt i dag, er dette ikke en
formalitet:

**I Cloud Shell: start sesjonen på nytt.** Det er den enkleste veien til et
ferskt token — menyen øverst, «Restart». Ingen kommando, ingenting å angre på.

Utenfor Cloud Shell:

```powershell
az account clear
az login --tenant <prod-tenant-id>
```

> **`az account clear` rører ingenting i Azure.** Navnet høres verre ut enn
> det er: den tømmer `az` sin LOKALE hurtigbuffer over kontoer og tokener på
> maskinen du står på. Ingen ressurs, ingen rolletildeling og ingen kjørende
> løsning berøres — og den eksisterende prod-løsningen i samme ressursgruppe
> merker ingenting. Virkningen er at du må logge inn på nytt.
>
> `az logout` gjør det samme for den aktive kontoen alene. Ingen av dem
> tilbakekaller tokener på Azure-siden; de fjerner bare den lokale kopien.

Vent noen minutter før du prøver igjen. Det er den billigste av alle sjekkene,
og den eneste som løser seg selv.

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
| `settes_direkte` | Sett verdien direkte på **Function App-en** — se 4.3. Unntaket er `AAD_CLIENT_ID`, som hører på SWA-ressursen |
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

### 4.2 Ferdig med kapittel 4 — og kontroll uten å lekke

**Kommandoene over er eksempler på FORMEN, ikke lista.** Prod har 32 settings
som må ha en verdi, og de står i inventaret — ikke her. Kapittelet er ferdig
når hver av dem står på Function App-en, og det er en sammenligning, ikke en
magefølelse:

```powershell
node scripts/vis-appsettings.js prod --navn | Set-Content krav.txt
$arg = @(
    'functionapp', 'config', 'appsettings', 'list',
    '--name', $FA, '--resource-group', $RG,
    '--query', '[].name', '-o', 'tsv'
)
az @arg | Set-Content satt.txt
Compare-Object (Get-Content krav.txt | Sort-Object) (Get-Content satt.txt | Sort-Object)
```

| I `Compare-Object` | Betyr |
|---|---|
| `<=` | står i inventaret, mangler på verten — ikke ferdig |
| `=>` | står på verten, ikke i inventaret — enten en levning, eller inventaret er utdatert. Begge skal forklares |
| tom utskrift | ferdig |

`--navn` lister bare det som MÅ ha en verdi: `keyvault`, `value` og
`settes_direkte`. `valgfri` og `kun_dokumentasjon` er ute — den første har en
standard i koden, den andre settes av plattformen. `AAD_CLIENT_ID` er også
ute, fordi den hører på SWA-ressursen (4.3); en liste med én kjent falsk
positiv er en liste folk slutter å lese.

> Dette krever repoet og `node`. Har du en efemer Cloud Shell, må `scripts/`
> og `config/` være på plass — klon, eller last opp de to filene.

Navnene er greie å se. Den fulle lista med VERDIER hører ikke hjemme i en
terminal — derfor `--query "[].name"`, og derfor `--output none` når du
setter.

### 4.3 Hvilken vert får hva

`settes_direkte` betyr «verdien hører ikke hjemme i repoet» — det er
definisjonen env-filene selv gir. Men `vis-appsettings.js` skrev den ut som
«hører hjemme på SWA-ressursen, ikke på Function App-en», og tabellen over
sa det samme, fram til 20.10.2026. Det var riktig så lenge API-et BODDE i
SWA-en. I v3 gjør det ikke det, og **seks av de sju leses av API-et selv:**

| Variabel | Leses av | Står den ikke på Function App-en |
|---|---|---|
| `STORAGE_ACCOUNT_NAME` | `lib/lagringsvalg.js` | identitetsveien slår aldri inn — lagringen faller til tilkoblingsstreng, eller feiler |
| `ADMIN_UPNS` | `lib/auth.js` (`erAdmin`) | ingen er administrator |
| `GRAPH_TENANT_ID` | `lib/graph-opplast.js` | backupen hopper over Graph-veien |
| `GRAPH_CLIENT_ID` | `lib/graph-opplast.js` | samme |
| `BACKUP_SHAREPOINT_SITE` | `lib/graph-opplast.js` | samme |
| `KEYVAULT_NAME` | bare visning i `functions/system.js` | ingenting i drift |

Følger man 4-tabellen bokstavelig slik den sto, får man altså en prod v3 uten
administratorer, uten identitetsbasert lagring og uten Graph-backup — tre
feil som hver for seg ser ut som noe annet.

`AAD_CLIENT_ID` er den ene som **ikke** skal på Function App-en: SWA-en leser
auth-innstillingene fra SINE egne app settings, og en kopi her er ikke i bruk
og kan drive fra originalen. Samme grunn som `config/env.dev.json` oppgir for
dev. Se kapittel 6.

Fasiten etterpå er `/api/system/info`, som melder hvilke av dem API-et
faktisk ser — ikke en portalside.

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

Frontend-workflowene tar navnet på token-hemmeligheten som et valg, nettopp
fordi en tenant kan ha mer enn én SWA. Kjør **«Deploy frontend til dev-SWA»**
(dev-tenanten) eller **«Deploy prod»** (prod-tenanten, bekreft med
`DEPLOY-PROD`), og oppgi hemmeligheten du satte i 5.1 under
`swa_token_secret`.

> **Ikke bytt verdien på en hemmelighet som alt er i bruk.** `AZURE_STATIC_WEB_APPS_API_TOKEN_PROD`
> peker på v2 sin SWA. Skriver du v3-tokenet dit, går neste ordinære
> prod-deploy til v3 — altså til et miljø ingen brukere skal se ennå, mens v2
> står uendret og ser ut som om deployen ikke virket. Egen hemmelighet, og
> `swa_token_secret` på kjøringen.

Finnes ikke hemmeligheten, stopper jobben med
«Hemmeligheten «…» finnes ikke, eller er tom» — ikke med SWA-actionens
«deployment token is invalid», som ser ut som en utløpt token og sender
feilsøkingen mot portalen.

**Bekreft i nettleseren at forsiden vises** før du går videre. En
SWA uten vellykket deploy kan ikke lenkes til en backend — se advarselen
øverst i 5.

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
