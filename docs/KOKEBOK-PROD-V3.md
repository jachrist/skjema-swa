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

> **Flere kommandoer i dette kapittelet bruker variablene fra kapittel 1.**
> Den blokka setter bare navn og slår opp abonnements-ID-en — den oppretter
> ingenting, og kan kjøres før noe av dette finnes. Kjør den først hvis du
> vil lime kommandoene her rett inn. Uten den sendes en tom streng videre, og
> feilen kommer ut som noe annet enn en manglende variabel.

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

#### Slik legges den konverterte PEM-en inn

Konverteringen gir en fil med privatnøkkelen i klartekst. Den skal inn som en
**secret**, ved siden av sertifikatet — ikke som et nytt sertifikatobjekt. Et
importert sertifikat er et nytt objekt med sin egen secret-rygg, og det var
nettopp innholdstypen på den som var problemet.

```powershell
$NOTAFTER = az keyvault certificate show --vault-name $KV --name <sertifikatnavn> --query attributes.expires -o tsv
$UTLOPER = [datetimeoffset]::Parse($NOTAFTER, [cultureinfo]::InvariantCulture).UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ss') + 'Z'
$arg = @(
    'keyvault', 'secret', 'set',
    '--vault-name', $KV,
    '--name', 'graph-client-cert-pem',
    '--file', "$arbeid/c.pem",
    '--encoding', 'utf-8',
    '--content-type', 'application/x-pem-file',
    '--expires', $UTLOPER,
    '--output', 'none'
)
az @arg
```

**Datoen må oversettes, og det er ikke valgfritt.** `az` skriver den som
`2031-10-19T10:52:53+00:00`, men `az keyvault secret set --expires` tar den
ikke imot:

> `argument --expires: invalid datetime_type value:
> '2031-10-19T10:52:53+00:00'`

`datetime_type` i keyvault-modulen prøver fire former —
`%Y-%m-%dT%H:%M:%SZ`, `%Y-%m-%dT%H:%MZ`, `%Y-%m-%dT%HZ` og `%Y-%m-%d` — og
alle fire krever `Z`, ikke en forskyvning. Derfor linja over. To detaljer i
den er med vilje:

| Detalj | Hvorfor |
|---|---|
| `[datetimeoffset]::Parse(...).UtcDateTime`, ikke `-replace '\+00:00$', 'Z'` | Tekstbyttet stemmer bare så lenge forskyvningen ER `+00:00`. Er den `+02:00`, omdøper byttet et lokalt klokkeslett til UTC og flytter utløpet to timer — stille. Parsingen regner om |
| `+ 'Z'` utenfor formatstrengen | `Z` er ikke et formattegn i .NET. Står den inni, avhenger utfallet av at ukjente tegn kopieres ordrett. Utenfor er det en bokstav |

Fire valg, og hvert av dem er der for å unngå noe:

| Valg | Hvorfor |
|---|---|
| `--file`, ikke `--value` | Privatnøkkelen havner da aldri på kommandolinja — ikke i historikken, ikke på skjermen, ikke i et skulderkikk |
| `--content-type application/x-pem-file` | Gjør at sjekken over svarer riktig også for DENNE secreten. Uten den står den som `null`, og «er formatet riktig?» blir ubesvarlig |
| `--expires` lest av sertifikatet | Secreten og sertifikatet utløper samtidig. Føres datoen bare på sertifikatet, varsler nøkkelkalenderen om noe annet enn det appen bruker. Verdien må oversettes først — se over |
| `--output none` | `secret set` skriver ellers hele secreten, verdien inkludert, som JSON |

**Rydd opp etterpå.** Filen er en privatnøkkel i klartekst:

```powershell
Set-Location ~
Remove-Item -Recurse -Force $arbeid
```

> **Konverteringsutskriften virker som den står.** `openssl pkcs12 -nodes` gir
> ikke bare to PEM-blokker: den legger «Bag Attributes», `localKeyID`,
> `subject=` og `issuer=` som ren tekst mellom dem, og sertifikatet kommer
> FØR nøkkelen. Målt 21.10.2026: `createPrivateKey` og `X509Certificate`
> leser den uendret, `x5t` blir riktig og signaturen verifiserer. **Ikke
> klipp i fila** — formen er dekket av `api/test/graph-sertifikat.test.js`.

Til slutt peker app-settingen på DENNE secreten, ikke på sertifikatet:
`GRAPH_CLIENT_CERT_PEM` =
`@Microsoft.KeyVault(SecretUri=https://<vault>.vault.azure.net/secrets/graph-client-cert-pem/)`.

#### Slik utstedes det, hvis det skal lages nytt

**Først: skal det lages nytt i det hele tatt?** Gjenbrukes v2 sin backup-app
(0.5), kan den alt ha et sertifikat. Da gjelder ikke dette avsnittet —
sjekk innholdstypen over, og konverter hvis den er PFX.

Et NYTT sertifikat betyr nytt nøkkelpar, og da må den offentlige delen
lastes opp på app-registreringen. En app kan bære flere sertifikater, så v2
sitt kan bli stående.

Krever **`Key Vault Certificates Officer`** på vaulten — `Secrets Officer`
dekker ikke sertifikater, se 0.2.

```powershell
$CERT = 'graph-backup-prod'
$policy = az keyvault certificate get-default-policy | ConvertFrom-Json
$policy.secretProperties.contentType = 'application/x-pem-file'
$policy.x509CertificateProperties.subject = 'CN=fhs-skjema-backup'
$policy | ConvertTo-Json -Depth 10 | Set-Content -Path policy.json -Encoding utf8NoBOM
az keyvault certificate create --vault-name $KV --name $CERT --policy '@policy.json'
```

Tre feller i de fem linjene, og alle gir en fil som *ser* riktig ut:

| Felle | Hvorfor |
|---|---|
| `ConvertTo-Json` uten **`-Depth 10`** | Standarddybden er **2**. Policyen er dypere, og de indre objektene blir til `System.Object[]`-tekst |
| `--policy @policy.json` uten **anførselstegn** | `@` er splatting-operatoren i PowerShell og prøver å splatte `$policy` |
| `jq` | Finnes ikke i PowerShell-Cloud Shell. `ConvertFrom-Json` gjør samme jobb |

`issuerParameters.name` er `"Self"` i standardpolicyen — altså selvsignert, og
det er det normale for app-til-app: Entra validerer ingen kjede, bare at
signaturen stemmer med den offentlige nøkkelen du lastet opp.

**Verifiser formatet med en gang**, før du bygger videre på det:

```powershell
az keyvault secret show --vault-name $KV --name $CERT --query contentType -o tsv
```

Står det noe annet enn `application/x-pem-file`, ble ikke policyen brukt.

**Så den offentlige delen til app-registreringen.** Ingen privatnøkkel
forlater Key Vault:

```powershell
az keyvault certificate download --vault-name $KV --name $CERT --file cert.cer --encoding DER
```

Last `cert.cer` opp under **App registrations → appen → Certificates &
secrets → Certificates**. Bruk portalen: `az ad app credential reset` FJERNER
eksisterende legitimasjon uten `--append`, og på en app v2 bruker er det en
dyr feil.

Til slutt peker app-settingen på secret-ryggen av sertifikatet — altså
`GRAPH_CLIENT_CERT_PEM` satt til
`@Microsoft.KeyVault(SecretUri=https://<vault>.vault.azure.net/secrets/<CERT>/)`.
Uten versjon til slutt gir alltid nyeste, og det er riktig her: rotasjon skal
ikke kreve en endring i app settings.

> **`GRAPH_CLIENT_SECRET` må stå tom.** Er begge satt, vinner hemmeligheten i
> `tokenKropp()`, og sertifikatveien blir aldri prøvd — den feilen oppdages
> den dagen hemmeligheten utløper. Se 0.5.

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

**Fem identiteter er i bruk, og de blandes lett.** To er app-registreringer
som gjenbrukes, én opprettes ny, og to er managed identities — altså ikke
app-registreringer i det hele tatt:

| Identitet | Hva den er | Brukes NÅR | Peker fra |
|---|---|---|---|
| **Auth-appen** | app-registrering | en BRUKER logger inn | `AAD_CLIENT_ID` + auth-sertifikatet, på **SWA-ressursen** |
| **Backup-appen** (`Sites.Selected`) | app-registrering | API-et laster opp backup til SharePoint | `GRAPH_CLIENT_ID` + `GRAPH_CLIENT_CERT_PEM`, på **Function App-en** |
| **Deploy-objektet** (`sp-skjema-3-prod-deploy`) | app-registrering, opprettes NY i kapittel 8 | **bare i GitHub Actions**, når API-et rulles ut | `AZURE_FUNCAPP_CREDENTIALS` i GitHub-miljøet `prod` |
| **`mi-skjema-3-prod`** | **managed identity**, user-assigned | API-et leser og skriver LAGRING, og løser `@Microsoft.KeyVault(...)` | `AZURE_CLIENT_ID` + `keyVaultReferenceIdentity`, på **Function App-en** |
| **SWA-ens plattformidentitet** | **managed identity**, systemtildelt | plattformen henter auth-sertifikatet | `clientSecretCertificateKeyVaultReference` i SWA-configen (6.1) |

Tre skiller er verdt å lese nøye:

* **Lagringen går IKKE gjennom noen app-registrering.** Den går på
  `mi-skjema-3-prod` med tre storage-roller (kapittel 3). Spørsmålet «hvilken
  app gir tilgang til lageret» har derfor ikke noe svar — det er feil
  spørsmål, og et billig sted å lete lenge.
* **Deploy-objektet brukes aldri i drift.** Det logger inn i Azure fra en
  GitHub-jobb og legger kode på Function App-en. Står det stille, merker
  ingen bruker noe; feiler det, er det utrullingen som stopper.
* **`sp-skjema-*` er ALLTID deploy-objektet, aldri backup-appen.** Backup-appen
  heter `fhs-skjema-backup*`. 20.10.2026 ble backup-sertifikatet lastet opp på
  `sp-skjema-3-dev` — deploy-objektet i dev — og avtrykket stemte med Key
  Vault, så sammenligningen så riktig ut. Entra svarte `AADSTS700027`
  likevel, fordi den slår opp appen `GRAPH_CLIENT_ID` navngir. Se
  navnefellen i `docs/BACKUP-SHAREPOINT.md`.
* **De to managed identitetene er ikke den samme.** Den ene hører på Function
  App-en, den andre på SWA-ressursen, og de trenger hver sine roller. Det var
  nettopp den sammenblandingen som holdt innloggingen nede 22.10.2026 — se
  6.1.

Begge app-registreringene fra v2 kan gjenbrukes, og det sparer to
bestillinger. En app-registrering er ikke bundet til
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
>
> Dette får konsekvenser i kapittel 4: inventaret bærer begge, så både
> kommandogeneratoren og kravlista må få `--velg GRAPH_CLIENT_CERT_PEM`.
> Se 4.0.

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

Navnene står i kapittel 1 og skal ikke skrives opp en gang til her — to
lister med de samme navnene er to lister som kan bli uenige:

```powershell
$p = @{
    Rg          = $RG
    FuncApp     = $FA
    Lagring     = $RT
    DataLagring = $DATA
    Identitet   = $MI
    KeyVault    = $KV
    Swa         = $SWA
}
$tomme = ($p.GetEnumerator() | Where-Object { -not $_.Value } | ForEach-Object { $_.Key })
if ($tomme) { throw "Tomme: $($tomme -join ', '). Kjor blokka i kapittel 1 forst." }
```

**Vakten er ikke pynt.** Er en variabel tom, splattes en tom streng inn, og
skriptet stopper med `Cannot bind argument to parameter 'Rg' because it is
an empty string` — en melding som leter etter en variabel som heter `Rg`.
Den finnes ikke; `Rg` er en NØKKEL i `$p`, og `@p` gjør den om til `-Rg`.

> **Cloud Shell mister variablene.** En ny økt starter med tomt skall, og da
> er både blokka i kapittel 1 og `$p` borte — også midt i kjøringen, hvis
> økten har stått stille. Symptomet er det samme hver gang: et skript som
> klager på en parameter du aldri skrev. Kjør begge blokkene på nytt; de
> setter bare variabler og kan gjentas.

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

**Hent identitetens objekt-ID nå.** Resten av kapittelet bruker den, og den
brukes igjen i 10 og 11:

```powershell
$PRINCIPAL = az identity show --name $MI --resource-group $RG --query principalId -o tsv
if (-not $PRINCIPAL) { throw "Fant ikke $MI. Kjorte trinnet over med -Kjor?" }
$PRINCIPAL
```

Linja slår bare opp og kan gjentas — **kjør den på nytt etter en ny Cloud
Shell-økt**, sammen med blokkene over. Uten den sendes en tom streng som
`--assignee-object-id`, og feilen kommer ut som noe annet enn en manglende
variabel. Det har skjedd to ganger i denne kokeboka alt.

### 3.1 Hvis Key Vault ligger i en annen ressursgruppe

Skriptet bygger rolle-scopet med **samme ressursgruppe** som Function App-en.
Gjenbrukes `fhs-kv-01` og den ligger et annet sted, feiler den ene
rolletildelingen. Gjør den da manuelt, med full ressurs-ID:

```powershell
$KV_ID = az keyvault show --name $KV --query id -o tsv
```

`$PRINCIPAL` er satt i kapittel 3 over.

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

### 4.0 Få kommandoene generert

22 referanser skrevet for hånd er 22 sjanser til en skrivefeil som først viser
seg når appen prøver å løse dem. Generer dem i stedet:

```powershell
node scripts/vis-appsettings.js prod --kommandoer --vault $KV --velg GRAPH_CLIENT_CERT_PEM --velg STORAGE_ACCOUNT_NAME
```

**To `--velg`, fordi to par utelukker hverandre.** Det andre er lagringen:
`STORAGE_CONNECTION_STRING` mot `STORAGE_ACCOUNT_NAME`. Settes strengen,
vinner den i `lagringsvalg.js` — og den leser til og med KONTONAVNET ut av
strengen, så `STORAGE_ACCOUNT_NAME` kan peke på en annen konto uten at noe
sier fra. v3 skal gå på identitet (kapittel 9, punkt 3), så strengen skal
stå tom.

Det første `--velg` er der fordi Graph-legitimasjonen finnes i to varianter, og
inventaret bærer begge: **`GRAPH_CLIENT_SECRET`** (pilot og prod v2) og
**`GRAPH_CLIENT_CERT_PEM`** (v3, etter 0.4). Uten flagget genereres
hemmeligheten — og settes den, vinner den i `tokenKropp()`, så sertifikatet
du nettopp la inn blir aldri prøvd. Valgte du hemmeligheten i 0.5 i stedet,
dropper du flagget.

Utskriften navngir begge medlemmene, det fravalgte også, med `skal stå TOM`.
En utelatt setting som ikke er forklart, ser ut som et hull i kommandoen.

Den SETTER ingenting. Utskriften er PowerShell-blokker du leser og limer inn
— én kommando per form, ikke én per setting, fordi hver
`appsettings set` starter appen på nytt.

Den dekker to av formene, og skillet er prinsipielt:

| Form | Dekkes? | Hvorfor |
|---|---|---|
| `keyvault` | ja | Referansen er bygget av vaultnavn + secret-navn. Ingen hemmelighet involvert — referansen er en PEKER |
| `value` | ja | Verdien står i `config/env.prod.json` og er ikke hemmelig |
| `settes_direkte` | nei | Verdiene finnes ikke i repoet. Det er hele poenget med formen — de listes med merknaden sin i stedet |

> **`SWA_URL` settes ikke automatisk**, selv om verdien står i inventaret.
> Den er den EKSISTERENDE instansens adresse. Setter du opp en ny SWA, skal
> den nyes vertsnavn inn — ellers peker lenker i e-poster og varsler til den
> gamle, **uten at noe feiler**. Under parallellkjøring er begge i drift, så
> det oppdages av en bruker som havner i feil versjon.

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
node scripts/vis-appsettings.js prod --navn --velg GRAPH_CLIENT_CERT_PEM --velg STORAGE_ACCOUNT_NAME | Set-Content krav.txt
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
| `<=` | står i inventaret, mangler på verten — **ikke ferdig** |
| `=>` | står på verten, ikke i inventaret — en levning, en plattformsetting, eller et utdatert inventar |
| ingen `<=` | ferdig |

**Utskriften blir ikke tom, og det er normalt.** Ferdig-kriteriet er at det
ikke står noen `<=`. `=>`-siden har alltid treff, fordi Function App-en har
settinger ingen av oss har satt — de kom med `az functionapp create` og med
deployen:

| `=>` du skal forvente | Hvorfra |
|---|---|
| `AzureWebJobsStorage` | `functionapp create` — verten trenger et lager til sin egen bokføring |
| `WEBSITE_CONTENTAZUREFILECONNECTIONSTRING`, `WEBSITE_CONTENTSHARE` | samme, på Consumption-planen |
| `FUNCTIONS_EXTENSION_VERSION`, `FUNCTIONS_WORKER_RUNTIME` | samme — vertsversjon og språk |
| `WEBSITE_RUN_FROM_PACKAGE` | kommer med zip-deployen av API-et |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` eller `APPINSIGHTS_INSTRUMENTATIONKEY` | App Insights, hvis det ble koblet på |
| `AzureFunctionsJobHost__functionTimeout` | **du satte den selv**, i 4.1 |

Disse leses av VERTEN, ikke av koden vår, og hører derfor ikke i inventaret:
`api/test/env-inventar.test.js` krever at hver `process.env` i `api/src` står
i alle tre miljøfilene, og en setting ingen av dem leser ville gjort lista
lengre uten å gjøre den sannere.

**Et `=>` som ikke står i tabellen over, skal forklares før du går videre.**
Det er enten en levning fra et tidligere forsøk, eller en setting inventaret
har mistet — og det siste er den dyre varianten, fordi inventaret er det
neste miljøet settes opp fra.

**Samme `--velg` som i 4.0.** Lista er kravlista, og kravet er ikke det
samme i de to variantene: med sertifikatet er `GRAPH_CLIENT_CERT_PEM`
påkrevd selv om inventaret kaller den `valgfri`, og `GRAPH_CLIENT_SECRET`
skal ikke stå på verten i det hele tatt. Glemmes flagget her, melder
sammenligningen hemmeligheten som manglende — og den som retter opp etter
den, slår av sertifikatveien.

`--navn` lister bare det som MÅ ha en verdi: `keyvault`, `value` og
`settes_direkte`. `valgfri` og `kun_dokumentasjon` er ute — den første har en
standard i koden, den andre settes av plattformen. `AAD_CLIENT_ID` er også
ute, fordi den hører på SWA-ressursen (4.3); en liste med én kjent falsk
positiv er en liste folk slutter å lese.

> Dette krever repoet og `node`. Har du en efemer Cloud Shell, må `scripts/`
> og `config/` være på plass — klon, eller last opp de to filene.
>
> **Har du klonen fra før: `git pull` først.** Inventaret og `--velg`-gruppene
> endrer seg mens kjøringen pågår, og en klone i Cloud Shell blir liggende.
> 22.10.2026 ga en gammel klone «`--velg STORAGE_ACCOUNT_NAME`: ikke et navn
> i en enten/eller-gruppe» — navnet var riktig, skriptet var gammelt.

**Rydd opp etterpå.** De to filene er et øyeblikksbilde av en liste som har
en kilde — inventaret — og en kopi som blir liggende, blir lest som fasit en
dag den ikke er det:

```powershell
Remove-Item krav.txt, satt.txt
```

De er også gitignorert, så en glemt fil ikke kan havne i en commit. `satt.txt`
har bare NAVN, ingen verdier, men en liste over hva som er satt i prod hører
likevel ikke i et repo.

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
(dev-tenanten) eller **«Deploy prod eller pilot»** med `miljo = prod`
(prod-tenanten, bekreft med
`DEPLOY-PROD`), og oppgi hemmeligheten du satte i 5.1 under
`swa_token_secret`.

> **`deploy_api` MÅ settes til `false` for v3.** «Deploy prod eller pilot» er skrevet for
> v2, som kjører API-et PÅ SWA-en. v3 har arkitekturen fra dev: API-et bor i
> en lenket Function App, og app settingene står DER.
>
> Rulles API-et likevel ut som managed functions, svarer den kopien på
> `/api/*` — med SWA-ressursens app settings, som ikke har lagringsoppsettet.
> Utslaget 22.10.2026: forsiden og innloggingen virket, og `/api/skjematyper`
> svarte **«Lagring er ikke konfigurert»**. Det leses som at Function App-en
> mangler verdier, og Function App-en var ikke involvert i det hele tatt.
>
> En SWA kan dessuten ikke både ha managed functions og en lenket backend.
> Står kopien der, er **5.3 stengt**.

**Står kopien der alt?** Rull ut på nytt med `deploy_api = false` FØR du går
videre til 5.3. **Målt 22.10.2026: det er nok.** En ny utrulling med tom
`api_location` fjerner managed functions-kopien, og lenkingen i 5.3 gikk
rett igjennom etterpå — ingen egen riving trengs.

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

> **Og så kommer innloggingen til å feile. Det er riktig her.** Forsiden
> vises anonymt, men første pålogging ender i
> `AADSTS50011: The redirect URI … does not match`, fordi det nye
> vertsnavnet ikke står på app-registreringen ennå. Det er kapittel 6, og
> det er ikke en mislykket deploy. Feilen kommer ETTER at forsiden vistes,
> og ser derfor ut som at noe gikk i stykker etterpå.

### 5.3 Lenk Function App-en til SWA-en — først nå

**Forutsetning: SWA-en har ingen managed functions.** Er API-et rullet ut
dit (5.2), kan den ikke lenkes — de to utelukker hverandre. Rull ut på nytt
med `deploy_api = false` først; det er målt å være nok.

> **Tørrkjøringen viser ikke de ekte verdiene i dette trinnet.** Function
> App-ens ressurs-ID og region slås opp først når `-Kjor` er med, så den
> tørre utskriften har `<Function App-ens resource id>` og regionen fra
> `$STED`. Den ekte kjøringen viste `'Norway East'` der tørrkjøringen sa
> `norwayeast`. Begge er riktige — det er samme region, skrevet som API-et
> oppgir den. Sammenlign derfor FORMEN, ikke verdiene.

```powershell
.\scripts\steg1-funcapp.ps1 @p -Trinn lenk -Kjor
az staticwebapp backends show --name $SWA --resource-group $RG -o table
```

---

## 6. Innlogging (Entra)

**Du trenger ingen ny app-registrering.** En app-registrering bærer mange
redirect-URI-er under Web-plattformen, én per vertsnavn, og v2 sin skal
beholde sine. Det som mangler er én URI til.

Og feilmeldingen sier selv at appen er funnet:

| Entra svarer | Hva det forteller |
|---|---|
| `AADSTS50011` — redirect URI matcher ikke | Appen ER funnet, `AAD_CLIENT_ID` er riktig satt på SWA-ressursen, og sertifikatet lot seg hente. **Bare vertsnavnet mangler** |
| `AADSTS700016` — application not found | `AAD_CLIENT_ID` peker på noe som ikke finnes i denne tenanten, eller står ikke på SWA-ressursen i det hele tatt |
| Feil om klientlegitimasjon | App-ID-en stemmer, men sertifikatet nås ikke — se rollene nederst i dette kapittelet |

De tre ser like ut i nettleseren og har ikke samme årsak. `AADSTS50011` er
den billigste av dem: alt annet er på plass.

```powershell
$VERT = az staticwebapp show --name $SWA --resource-group $RG --query defaultHostname -o tsv
"https://$VERT/.auth/login/aad/callback"
```

Adressen legges inn under **Authentication** på app-registreringen i Entra.
Portalen legger den TIL; de gamle står igjen.

Med `az` må den eksisterende lista leses først:

```powershell
$APPID = '<verdien i AAD_CLIENT_ID>'
$NY = "https://$VERT/.auth/login/aad/callback"
$gamle = az ad app show --id $APPID --query 'web.redirectUris' -o tsv
$alle = @($gamle) + $NY | Where-Object { $_ } | Select-Object -Unique
$arg = @('ad', 'app', 'update', '--id', $APPID, '--web-redirect-uris') + $alle
az @arg
```

`--web-redirect-uris` setter HELE samlingen, ikke ett element — samme familie
som `az ad app credential reset` uten `--append`, der v2 sin legitimasjon
forsvinner. Formen over er trygg uansett: sendes de gamle inn sammen med den
nye, blir resultatet det samme enten flagget erstatter eller legger til.
`Select-Object -Unique` gjør at den kan kjøres to ganger.

**Kontroller etterpå at de gamle står igjen:**

```powershell
az ad app show --id $APPID --query 'web.redirectUris' -o tsv
```

#### Har du ikke rollen: bestillingen

Trinn 6 krever **Application Administrator**, eller at du står som *eier* av
den ene app-registreringen — og det siste er billigere, se merknad 3 i 0.1 C.
Må det bestilles, er dette teksten:

> Legg til én redirect-URI på app-registreringen `<navn/app-id som
> AAD_CLIENT_ID peker på>`:
>
> `https://<vertsnavn>/.auth/login/aad/callback`
>
> Den skal inn under plattformen **Web**, ikke «Single-page application».
>
> **Legg den TIL.** De eksisterende redirect-URI-ene skal stå igjen — de er i
> bruk av dagens løsning. Ingenting annet på registreringen skal endres.

**Plattformvalget er ikke en formalitet.** SWA-en innløser koden på
serversiden, med sertifikatet — den er en fortrolig klient. Registreres
URI-en under «Single-page application», behandler Entra klienten som
offentlig, og innløsningen avvises med en feil om at tokenet bare kan
innløses via cross-origin. Innloggingen kommer altså like langt som nå, og
feiler ett steg senere, med en melding som ikke nevner plattformvalget.

**Kontroller hvor den landet** — de to plattformene er to ulike lister:

```powershell
az ad app show --id $APPID --query 'web.redirectUris' -o tsv
az ad app show --id $APPID --query 'spa.redirectUris' -o tsv
```

Står den i den andre, er bestillingen utført på feil plattform. Det er ikke
synlig i nettleseren, og det er den eneste måten å se det på.

> **Hvert vertsnavn trenger sin egen URI.** Default-vertsnavnet er ett.
> Flytter du domenet ved cutover, må domenet ha sin (se 0.5). Og et navngitt
> preview-miljø har sitt eget vertsnavn — Entra avviser innloggingen DER, og
> bare der, til URI-en er lagt inn. `deploy-prod.yml` skriver den ferdige
> URL-en i sammendraget; gjett aldri på den.

`AAD_CLIENT_ID` og auth-sertifikatet settes på **SWA-ressursen**, ikke på
Function App-en. I prod hentes sertifikatet fra Key Vault via
`clientSecretCertificateKeyVaultReference` i `staticwebapp.config.prod.json`.

#### 6.1 SWA-ens egen identitet, og to roller på vaulten

Det oppslaget gjøres av *plattformen*, med SWA-ressursens **systemtildelte
identitet** — en annen identitet enn `mi-skjema-3-prod`, og den finnes ikke
før noen slår den på. Dette er et eget trinn, ikke en merknad.

**Symptomet når den mangler er ikke en feilmelding om Key Vault.**
Innloggingen kommer HELT igjennom brukernavn, passord og MFA — autorisering
trenger ikke sertifikatet — og feiler først når SWA-en skal veksle inn koden,
som er en server-til-server-samtale brukeren ikke ser. Det brukeren ser er at
Microsoft avviser etter MFA-koden, uten at noe nevner verken SWA-en eller
vaulten.

```powershell
$SWAMI = az staticwebapp identity show --name $SWA --resource-group $RG --query principalId -o tsv
$SWAMI
```

Er den tom, slå den på:

```powershell
$SWAMI = az staticwebapp identity assign --name $SWA --resource-group $RG --query principalId -o tsv
```

Så de to rollene. `Key Vault Secrets User` alene holder ikke her — rollene i
Key Vault er delt per objekttype, og referansen peker på et **sertifikat**:

```powershell
$KV_ID = az keyvault show --name $KV --query id -o tsv
foreach ($rolle in @('Key Vault Secrets User', 'Key Vault Certificate User')) {
    $arg = @(
        'role', 'assignment', 'create',
        '--assignee-object-id', $SWAMI,
        '--assignee-principal-type', 'ServicePrincipal',
        '--role', $rolle,
        '--scope', $KV_ID,
        '--output', 'none'
    )
    az @arg
}
```

**Kontroller at begge står der:**

```powershell
az role assignment list --assignee $SWAMI --scope $KV_ID --query '[].roleDefinitionName' -o tsv
```

To linjer forventes. Én linje er den stille varianten: oppslaget feiler
fortsatt, og symptomet er det samme som før.

> **`enableRbacAuthorization` må være `true`** for at disse rollene skal bety
> noe. Står vaulten på tilgangspolicyer, lykkes kommandoene over og
> oppslaget feiler likevel — se fella i 0.2.

**Slik skilles den fra en Entra-feil.** Symptomet — avvist etter MFA — ser ut
som noe i app-registreringen. Tre observasjoner avgjør det, og den siste er
den som nesten sendte feilsøkingen feil vei:

| Observasjon | Hva den utelukker |
|---|---|
| **v2 logger inn** | App-registreringen, Conditional Access, «assignment required» og ID-token-innstillingen. De er delte, så de kan ikke være årsaken |
| **Ingen mislykkede pålogginger i Entra** | Hele Entra-siden. Avvisningen skjedde ikke der, og fravær av rader er her et funn, ikke mangel på informasjon |
| **dev har ingen SWA-identitet** | **Ingenting.** Dev og pilot bruker `clientSecretSettingName` — en app setting, som plattformen leser uten noen identitet. Bare prod-configen har en Key Vault-referanse, og bare den må *hentes* |

Den siste raden er verdt å lese to ganger. «Dev klarer seg uten» er et
nærliggende motbevis, og det er ugyldig: de tre miljøene oppgir
klientlegitimasjonen på to ulike måter, og forskjellen er nettopp det som
avgjør om en identitet trengs.

> **Målt 22.10.2026.** v2 sin SWA har en systemtildelt identitet; v3 hadde
> ingen. Da den ble slått på og de to rollene gitt, gikk innloggingen
> igjennom. Fasiten for hva v3 skal ha, er alltid v2 — den kjører samme
> config og virker.

> **`openIdIssuer` skal aldri settes til `/common/` eller `/organizations/`.**
> Da slipper hvilken som helst Entra-tenant inn.

---

## 7. Flytene

v3 bruker `FLYT_AUTH=entra`, som dev. Det betyr:

1. **I flyten, per HTTP-trigger:** «Hvem kan utløse flyten?» settes til
   **«Spesifikke brukere i leieren»**. Står den på «Hvem som helst», er
   URL-en med `sig=` hele adgangen, og et token blir ikke engang lest.
2. **Identitetens `objectId` inn i «Tillatte brukere»** på hver av dem:

```powershell
az identity show --name $MI --resource-group $RG --query principalId -o tsv
```

   Verdien er **per miljø**. Settes den som en miljøvariabel i løsningen og
   fylles ved eksport/import, er det prod-identitetens `oid` som skal inn —
   står dev-identitetens der, avviser prod-flytene prod-API-et, og
   feilmeldingen peker på tokenet, ikke på variabelen.

3. **Skråstreken er VÅR, ikke flytens.** Det er ingenting å sette i Power
   Automate: `aud` kommer av hvilken ressurs vi ber om et token for.
   `lib/flyt-auth.js` ber om `https://service.flow.microsoft.com/` **med
   skråstrek**, og `lib/plattform-token.js` finnes utelukkende fordi
   Azure-SDK-en ville klippet den bort — den oversetter `<ressurs>/.default`
   til plattformens `resource` ved å fjerne `/.default`, og da forsvinner
   skråstreken med. Power Automate sammenligner `aud` bokstavelig, så det
   feiler på ett tegn.

   Det er altså ikke et trinn her, men det forklarer en 401 du ellers ville
   lett etter i flyten. **Og en 401 lager ingen kjøring i historikken** —
   tom historikk betyr ikke at kallet uteble. `/api/mi-diagnose` svarer med
   `ressursSomBleSpurtOm`, nettopp for at det skal være synlig hvilken av de
   to formene som faktisk ble sendt.

4. Flyt-URLene settes som app settings (`*_FLOW_URL`). **Uten `sig=` er de
   ikke hemmeligheter**, og da trenger de ikke Key Vault — adressen er ikke
   legitimasjon når kallet krever et Entra-token og identitetens `oid` står i
   flytens «Tillatte brukere».

   Men svaret hviler på en egenskap ved FLYTEN, ikke på noe i dette repoet.
   Bekreft derfor, per URL, før du velger bort vaulten:

   | Sjekk | Hva den avgjør |
   |---|---|
   | Ingen `sig=` i query-strengen | Adressen er ikke legitimasjon |
   | Flytens trigger krever Entra | Et kall uten token avvises |
   | Identitetens `oid` i allow-lista | Vårt kall slipper inn |

   Velger du bort vaulten, endre formen i `config/env.prod.json` fra
   `{"keyvault": …}` til `{"settes_direkte": true}` — som i `env.dev.json`.
   Inventaret og virkeligheten må stemme, ellers ber kapittel 4 om åtte
   secrets som ikke finnes.

   > **Vakten for veien tilbake.** Importeres en gammel flyt senere, eller
   > settes en HTTP-trigger opp uten Entra, kommer `sig=` tilbake — og da
   > ligger en hemmelighet i klartekst i app settings mens `FLYT_AUTH=entra`
   > sier at alt er i orden. `/api/system/info` melder det nå per URL:
   > «URL-en bærer en SAS-signatur (sig=) mens FLYT_AUTH=entra». Signaturen
   > gjentas aldri i svaret — bare at den finnes.
4. **Connectorene eies av en servicebruker.** Den har ingen rettigheter ut
   over en vanlig bruker: for å opprette oppgaver eller skrive i Teams må den
   meldes eksplisitt inn som teammedlem.

`VARSLING_DEAKTIVERT=true` ble satt i trinn 4, og skal stå til v3 er testet.
Flytene i prod-tenanten skriver til ekte Teams og sender ekte e-post, uansett
hvor blank lagringen er.

---

## 8. Deploy av API-et

**Prøv 8.1 først. Lykkes den, hopper du over resten av kapitlet** — og
trenger verken app-registrering, bestilling eller venting.

### 8.1 Publiseringsprofil (førstevalget)

`Azure/functions-action` kan autentisere seg rett mot Function App-ens
SCM-endepunkt, uten noen Entra-identitet. Da faller hele resten av dette
kapitlet bort.

**REKKEFØLGEN ER DET VIKTIGSTE I DETTE AVSNITTET.** Slå på bryteren FØRST,
hent profilen ETTERPÅ. En profil hentet mens basic auth var av, virker ikke —
heller ikke etter at bryteren er slått på. Den må hentes på nytt.

Gjennomkjøringen 27.10.2026 gikk i nettopp den fella: profilen ble hentet,
bryteren slått på, deployen kjørt på nytt med den GAMLE profilen, og
feilmeldingen var den samme 401 som før. Det så ut som at bryteren ikke
hjalp.

Forutsetningen er at **basic auth på SCM** er påslått på ressursen. Det er
policyen `basicPublishingCredentialsPolicies/scm` som avgjør det, og den må
leses direkte:

```powershell
az resource show --resource-group $RG --name "$FA/scm" --resource-type Microsoft.Web/sites/basicPublishingCredentialsPolicies --api-version 2023-01-01 --query properties.allow
```

**`--api-version` er ikke valgfri.** Uten den gjetter `az` en standardversjon
som ikke kjenner underressurstypen, og svarer `Operation returned an invalid
status 'Not Found'` — en melding som leses som «Function App-en finnes ikke».
Skill dem med `az functionapp show -g $RG -n $FA --query name -o tsv` først.

Går ikke `az`-kommandoen gjennom i det hele tatt — den har svart
`Not Found` på flere former — svarer portalen på det samme: Function App →
Settings → Configuration → General settings → **«SCM Basic Auth Publishing
Credentials»**. Husk **Apply**; avkryssingen alene lagrer ingenting.

**At profilen lar seg HENTE er ikke en sjekk.** 27.10.2026 ble
`list-publishing-profiles` brukt som prøve, den svarte, og konklusjonen ble at
veien var åpen. Deployen feilet likevel med `Failed to fetch Kudu App
Settings. Unauthorized (CODE: 401)` — profilen ble lest riktig, men Kudu
avviste legitimasjonen. Hentingen går mot ARM; bruken går mot SCM, og det er
to ulike dører.

Svarer policyen `false`, kan den slås på — hvis ingen Azure Policy hindrer det:

```powershell
az resource update --resource-group $RG --name "$FA/scm" --resource-type Microsoft.Web/sites/basicPublishingCredentialsPolicies --set properties.allow=true --api-version 2023-01-01
```

Blir den stående `false` etter oppdateringen, er den styrt av en policy på
abonnementet, og da er 8.2 veien.

Svarer policyen `true`, hent profilen **nå** — etter at bryteren er på — og
legg den rett i GitHub-miljøet:

```powershell
az functionapp deployment list-publishing-profiles --resource-group $RG --name $FA --xml | gh secret set AZURE_FUNCAPP_PUBLISH_PROFILE --env prod
```

`gh` må være logget inn (`gh auth login`); `az`-påloggingen i Cloud Shell
gjelder ikke for GitHub. Kloning trengs ikke når `--repo <eier>/<repo>` er med.

#### Får du 401 likevel

> `Successfully parsed SCM credential from publish-profile format.`
> `Failed to fetch Kudu App Settings. Unauthorized (CODE: 401)`

Profilen er altså LEST riktig — formatet og hemmeligheten er på plass. Det er
SCM som avviser den. Denne prøven skiller de to årsakene, og skriver ingenting
hemmelig:

```powershell
$x = [xml](az functionapp deployment list-publishing-profiles -g $RG -n $FA --xml)
$p = $x.publishData.publishProfile | Where-Object { $_.publishMethod -eq 'MSDeploy' }
$b64 = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$($p.userName):$($p.userPWD)"))
try { "HTTP " + (Invoke-WebRequest -Uri "https://$FA.scm.azurewebsites.net/api/settings" -Headers @{Authorization="Basic $b64"} -UseBasicParsing).StatusCode }
catch { "HTTP " + $_.Exception.Response.StatusCode.value__ }
Remove-Variable x,p,b64
```

| Svar | Hva det betyr |
|---|---|
| **200** | Kudu tar imot den FERSKE profilen. Da er det den i GitHub som er gammel — hent på nytt og sett hemmeligheten igjen. Det var utfallet 27.10.2026 |
| **401** | Kudu avviser legitimasjonen uansett hvem som spør. Sjekk nettverksrestriksjonene under; er de åpne, er 8.2 veien |

```powershell
az functionapp config access-restriction show --resource-group $RG --name $FA --query "{hoved: ipSecurityRestrictions[].name, scm: scmIpSecurityRestrictions[].name, scmArverHoved: scmIpSecurityRestrictionsUseMain}"
```

Arbeidsflyten velger vei av seg selv: er `AZURE_FUNCAPP_PUBLISH_PROFILE` satt,
hoppes `azure/login` over, og kjøringen melder «API-deploy:
publiseringsprofil» i sammendraget. Er den ikke satt, går den veien under.

To ting å vite om profilen:

| | |
|---|---|
| Den er like hemmelig som SP-legitimasjonen | den flytter hvor hemmeligheten ligger, den fjerner den ikke |
| Den blir ugyldig hvis noen nullstiller publiseringslegitimasjonen | ingenting varsler om det — deployen feiler på autentisering neste gang |

Lar policyen seg ikke slå på, er veien under den riktige.

### 8.2 Tjenestehovedobjekt (når basic publishing er av)

**Hva dette objektet er:** den tredje identiteten i tabellen i 0.5 — den
GitHub Actions logger inn med for å legge kode på Function App-en. Den
brukes aldri i drift, og den har ingenting med lagringen å gjøre.

**Dette trinnet krever en Entra-rolle du kanskje ikke har.** Les avsnittet
«Får du `Insufficient privileges`» under FØR du kjører — det er den
sannsynligste utgangen.

Utskriften fra `az ad sp create-for-rbac` **er en hemmelighet**. Den går rett
inn i GitHub-secreten, ikke via en sak, e-post eller chat:

```powershell
$scope = "/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.Web/sites/$FA"
$creds = az ad sp create-for-rbac --name sp-skjema-3-prod-deploy --role Contributor --scopes $scope --json-auth
if (-not $creds) { throw "create-for-rbac ga ingenting - les feilen over. Ikke gaa videre." }
gh secret set AZURE_FUNCAPP_CREDENTIALS --env prod --body $creds
Remove-Variable creds
```

Tre detaljer, og hver av dem har et symptom som peker et annet sted:

| Detalj | Hvorfor |
|---|---|
| `--json-auth`, ikke `--sdk-auth` | `--sdk-auth` er avviklet og skriver en advarsel. `docs/BESLUTNING-EGEN-FUNCTION-APP.md` bruker alt den nye — to steder som svarer ulikt er den feilklassen dette repoet oftest har |
| `--env prod`, og navnet UTEN `_PROD` | `deploy-funcapp-pilot.yml` leser `secrets.AZURE_FUNCAPP_CREDENTIALS` i **GitHub-miljøet** `${{ inputs.miljo }}`. En repo-secret som heter `AZURE_FUNCAPP_CREDENTIALS_PROD` leses aldri, og deployen feiler i `azure/login` med en JSON-feil om en tom verdi |
| Vakten på `$creds` | Feiler kommandoen over, er `$creds` tom, og `gh secret set --body $creds` svarer `flag needs an argument: --body`. Det ser ut som en feil i `gh`-kallet. Vakten stopper der feilen faktisk er |

#### Får du `Insufficient privileges`

> `ERROR: Directory permission is needed for the current user to register the
> application. … Insufficient privileges to complete the operation.`

`az ad sp create-for-rbac` er **to operasjoner i én kommando**, med
rettigheter fra hver sin verden (0.1 C, merknad 1):

| Del | Hva den gjør | Rolle |
|---|---|---|
| App-registreringen | Oppretter tjenestehovedobjektet i Entra | **`Application Administrator`**, eller at tenanten tillater at brukere registrerer apper |
| `--role ... --scopes ...` | Tildeler `Contributor` på Function App-en | `Owner`/`User Access Administrator` på ressursgruppa — den du alt har |

Feilmeldingen gjelder den FØRSTE. Ingenting ble opprettet, og ingen rolle ble
tildelt.

**Del jobben i stedet for å be om rollen.** En administrator oppretter
tjenestehovedobjektet UTEN rolle — da trenger de ikke røre ressursgruppa
— og du tildeler rollen selv etterpå:

> **Bestilling:** Opprett et tjenestehovedobjekt (app-registrering med
> service principal) med navnet `sp-skjema-3-prod-deploy` — tilsvarer
> `sp-skjema-3-dev` i dev-tenanten. Ingen roller, ingen
> API-tillatelser, ingen redirect-URI-er. Send meg `appId`, `tenant` og en
> klienthemmelighet. Hemmeligheten skal IKKE sendes i e-post eller en sak —
> avtal en egen kanal.

Når du har verdiene, gjør du resten selv:

```powershell
$APPID = '<appId fra administratoren>'
$arg = @(
    'role', 'assignment', 'create',
    '--assignee', $APPID,
    '--role', 'Contributor',
    '--scope', $scope,
    '--output', 'none'
)
az @arg
```

Og bygger JSON-en `azure/login@v2` forventer. **Hele objektet**, ikke bare
hemmeligheten — får den noe annet, feiler den med
`Login failed with SyntaxError: Unexpected token`:

```powershell
$hemmelig = Read-Host -AsSecureString 'Klienthemmeligheten'
$klar = [System.Net.NetworkCredential]::new('', $hemmelig).Password
$creds = @{
    clientId = $APPID
    clientSecret = $klar
    subscriptionId = $SUB
    tenantId = (az account show --query tenantId -o tsv)
} | ConvertTo-Json
gh secret set AZURE_FUNCAPP_CREDENTIALS --env prod --body $creds
Remove-Variable creds, klar, hemmelig
```

`Read-Host -AsSecureString` holder hemmeligheten utenfor skjermen og utenfor
PSReadLine-historikken. `Remove-Variable` til slutt, på alle tre.

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
| 8 | **Jobber → Kjør nå** på oppslagslister | Panelet svarer «✓ Ferdig», og statusraden går til `ok` |

> Punkt 1 sparer mest tid senere: `/api/ping` og `/js/config.js` bærer hver sin
> SHA. Avvik mellom dem betyr en halv deploy — og symptomet er en funksjon som
> «mangler», ikke en feilmelding.

> **Punkt 8 er valgt med vilje: oppslagslister er en RASK jobb.** På en Function
> App venter verten på invokasjonen, så «Kjør nå» venter nå på jobben og svarer
> «✓ Ferdig» når den er ferdig. For postnumre (30–90 s), FS-data (2–4 min) og
> backup rekker gatewayen å gi opp først — panelet sier da «Ingen svar … jobben
> kan likevel ha kjørt», og det er riktig: verten venter fortsatt, jobben
> fullfører og bokfører seg selv. Trykk **Oppdater** og les statusraden, ikke
> svaret på knappen.

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

**Observert 19.10.2026, bekreftet 28.10.2026:** den opprinnelige løsningen
(v1) kjører fortsatt cron-jobber mot sin egen lagringskonto. Den tas ned
før cutover — se trinn 0 i sjekklisten under. Det ble
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

v1 skriver ikke i v2 sin lagring, så den ødelegger ingen data der. Men den
kan sende varsler og e-post som ser ut til å komme fra løsningen, og da er
det tre stabler å holde rede på i stedet for to.

### Uansett form: stopp de doble kjøringene

v2 trigges av GitHub Actions-cron; v3 har timere. Peker begge på samme
lagring, kjører hver jobb **to ganger** — og fire av dem sender ut av huset.
Utsending og purring ville gått dobbelt til eksterne mottakere.

**Slett repo-variabelen `SWA_URL_PROD` i samme operasjon**, ikke etterpå.
Det er ingen kodeendring: hver av de åtte cron-workflowene har en matrise
med en `pilot`- og en `prod`-rad, og prod-raden hopper over med en
`::notice::` når `SWA_URL_PROD` eller `SCHEDULER_KEY_PROD` er tom. Jobben
blir grønn, og pilot-raden går som før. Ingenting annet i repoet leser de to
navnene.

Som belte: roter `SCHEDULER_KEY` på **v2-prod-SWA-en**, ikke i GitHub, så et
gjenglemt cron-kall får 401 i stedet for å kjøre. `SCHEDULER_KEY_PROD` i
GitHub kan stå; den er ubrukt når variabelen er borte.

### Miljønavnet skifter: `Production` → `prod`

v2-prod har `MILJO=Production`, v3-prod har `MILJO=prod` (pinget
27.10.2026). Tre steder bruker verdien **rått** som identitet — med vilje,
fordi de må skille v2-prod fra v2-dev, og `miljonavn()` ville gjort begge til
`pilot`. Det er også derfor de skifter ved cutover, uten at noen kode endres:

| Hvor | Hva skjer ved skiftet | Gjør dette |
|---|---|---|
| Nøkkelkalenderen (`lib/nokkelkalender-storage.js`) | `MILJO` i små bokstaver er `PartitionKey`. Varslingsjobben (`lib/nokkelkalender-jobb.js`) leser **bare sin egen** partisjon, mens admin-lista viser alle. Radene under `production` står altså fortsatt i lista — og varsles aldri igjen | **Ikke flytt radene.** `production` beskriver v2-prod sine nøkler, og v3-prod har egne: egen Key Vault, eget auth-sertifikat, egen MI. Fyll `prod` med v3 sine — «Legg inn standardinventaret» i admin på v3-prod, deretter utløpsdatoene. Nøkler de to deler (FS-passordet, den delte SAS-en, flyt-URL-ene) kopieres over. `production`-radene slettes når v2-prod rives |
| Flytene (`miljø` i kroppen, `lib/flyt-kaller.js` og backup) | Alt v3-prod sender har `"miljø": "prod"`. `SkjemaMiljo` er dokumentert som `pilot` / `production` | Gå gjennom hver flyt som forgrener på `miljø` eller `SkjemaMiljo`. Tester en av dem `== "production"` for å velge ekte mottakere eller Planner-plan, havner v3-prod i else-grenen — som er test |
| Backupfilnavnet (`functions/backup.js`) | Nye filer heter `prod-backup-…` / `prod-delta-…`, ikke `Production-…` | Har biblioteket eller lagringskontoen livssyklusregler på prefiks, må de få det nye prefikset. Ellers ligger de nye filene utenfor oppbevaringsregelen |

Dette er ikke en grunn til å gi v3-prod `MILJO=Production`. Da ville v3-prod
lest som pilot, mistet timerne og gått tilbake til fire-and-forget — som er
det som ikke virker på en Function App. Se `KJORER_TIMERE` i
`lib/plattform.js`.

### Sjekkliste for cutover

Gjelder **form A, ompeking**, og domenet slik det er satt opp 28.10.2026:

| Navn | Post (ServeTheWorld) | Peker på |
|---|---|---|
| `fskjema.no` | Videresending, 301, uten `+www` | `https://www.fskjema.no` |
| `www.fskjema.no` | CNAME | v2-prod i dag (`gentle-dune-00a313603.7.azurestaticapps.net.`), v3-prod etter cutover |

Cutover er altså å flytte `www` fra v2-prod til v3-prod, og lagringen fra
v3 sin konto til v2 sin. Pausen er satt til to timer.

**Dager før**

| ☐ | Hva | Merknad |
|---|---|---|
| ☐ | 0. Ta ned v1 | Se «Er v2 den eneste som skriver?» over |
| ☐ | 1. Senk TTL på `www` fra 1 time til 5 minutter | Minst en time før pausen, så den gamle verdien er glemt. Uten dette kan både DNS-endringen og tilbakeveien bruke en time |
| ☐ | 2. Fyll `prod` i nøkkelkalenderen med v3 sine nøkler | Se tabellen i «Miljønavnet skifter» |
| ☐ | 3. Gå gjennom flytene som forgrener på `miljø` / `SkjemaMiljo` | v3-prod sender `"prod"`, ikke `"production"` |
| ☐ | 4. Livssyklusregler på backupprefiks | `prod-` i stedet for `Production-` |
| ☐ | 5. Rollene for v3-prod sin MI på v2 sin lagringskonto | Kommandoen under form A øverst i kapittelet. Kan gjøres når som helst — rollene gjør ingenting før `STORAGE_ACCOUNT_NAME` peker dit |
| ☐ | 6. Redirect-URI for `www.fskjema.no` på påloggingsappen | v2 og v3 bruker samme app (kapittel 6), så den er på plass hvis `www` virker på v2 i dag. Kontroller med `az ad app show` |
| ☐ | 7. Ny `SCHEDULER_KEY` til v2-prod, klar til å limes inn | Lag den nå, ikke i pausen |
| ☐ | 7b. `HASH_SALT`, `OTP_HMAC_KEY` og `FLOW_CALLBACK_KEY` er LIKE på v2-prod og v3-prod | Se under. `FLOW_CALLBACK_KEY` var ikke satt på v3-prod 28.10.2026 |

Ny nøkkel:

```powershell
[Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

**7b — tre hemmeligheter som følger dataene, ikke appen.** v3-prod har egen
Key Vault, men disse tre skal ha v2-prod sin verdi, ikke en ny:

| Hemmelighet | Ulik verdi gir |
|---|---|
| `HASH_SALT` | Nye pseudonymer for anonymiserte innsendere. Samme person blir to, og svargrensen teller feil. Kan ikke repareres i etterkant |
| `OTP_HMAC_KEY` | Utsendingslenkene sendt fra v2-prod — gyldige i 90 dager — avvises av v3-prod |
| `FLOW_CALLBACK_KEY` | Flytene sender den i `x-flow-key`. Uten den, eller med en annen, avviser v3-prod kvitteringen fra backup-flyten, hendelser og callbacks fra eksterne flyter (`lib/auth.js`) |

Sammenlign under **Administrasjon → System** i begge appene: de tre har et
**avtrykk** (første 8 tegn av SHA-256) ved siden av lengden. Avtrykket skal
være likt. Verdien vises aldri, og lengden alene sier ingenting — to ulike
verdier kan ha samme lengde.

Er de ulike: legg v2-prod sin verdi i v3-prod sin vault under samme
secret-navn, og start Function App-en på nytt så referansen leses igjen.
`SCHEDULER_KEY` skal derimot være ULIK — se trinn 9.

**I pausen — i denne rekkefølgen**

Varsle brukerne. Ingen datakopi trengs i form A, og en bruker som går inn
via v2-prod sin gamle `gentle-dune`-adresse etter cutover, skriver i den
samme lagringen — det er ufarlig. Det som IKKE skal skje to ganger, er
jobbene: utsending og purring sender ut av huset. Derfor er trinn 8 først.

| ☐ | Hva | Merknad |
|---|---|---|
| ☐ | 8. Slett repo-variabelen `SWA_URL_PROD` | *Settings → Secrets and variables → Actions → Variables*. Stopper alle åtte cron-jobbene mot v2-prod |
| ☐ | 8b. Slå PÅ timerne på v3-prod, hvis de ble slått av i en testperiode | *Functions* → hver av de ni → *Enable*. Se «Parallelldrift» |
| ☐ | 9. Sett ny `SCHEDULER_KEY` på v2-prod-SWA-en | Belte i tillegg til 8 |
| ☐ | 10. `STORAGE_ACCOUNT_NAME` på v3-prod til v2 sin konto | Fra nå leser og skriver v3 produksjonsdataene |
| ☐ | 11. Fjern `VARSLING_DEAKTIVERT` på v3-prod | Satt i trinn 4 for testingen. Står den, sender v3-prod ingen varsler i drift |
| ☐ | 12. `SWA_URL` på v3-prod til `https://www.fskjema.no` | E-postlenker og flyt-callbacks bygges fra den |
| ☐ | 13. Flytt `www.fskjema.no` fra v2-prod til v3-prod | Se under. Et vertsnavn kan bare ligge på én SWA om gangen |
| ☐ | 14. `SWA_URL` på v2-prod til sin egen `gentle-dune`-adresse | Bare én stabel skal påstå å være den offentlige adressen |
| ☐ | 15. Full backup på v3-prod | Deltaene bygger på siste fulle. Den første etter ompekingen skal være full |
| ☐ | 16. Kontroller | Under |

Trinn 10–12 på Function App-en:

```powershell
az functionapp config appsettings set --name $FA --resource-group $RG --settings STORAGE_ACCOUNT_NAME=<v2-konto> SWA_URL=https://www.fskjema.no --output none
az functionapp config appsettings delete --name $FA --resource-group $RG --setting-names VARSLING_DEAKTIVERT --output none
az functionapp config appsettings list --name $FA --resource-group $RG --query "[].name" -o tsv | Select-String -Pattern '^(STORAGE_ACCOUNT_NAME|SWA_URL|VARSLING_DEAKTIVERT)$'
```

Den siste skal liste `STORAGE_ACCOUNT_NAME` og `SWA_URL`, og **ikke**
`VARSLING_DEAKTIVERT`.

Trinn 13, domenet. Fjern det fra v2-prod, endre CNAME-en hos ServeTheWorld
til v3-prod sin adresse, og legg det på v3-prod:

```powershell
az staticwebapp hostname delete --name <v2-swa> --resource-group <v2-rg> --hostname www.fskjema.no --yes
az staticwebapp show --name $SWA --resource-group $RG --query defaultHostname -o tsv
nslookup -type=CNAME www.fskjema.no 8.8.8.8
az staticwebapp hostname set --name $SWA --resource-group $RG --hostname www.fskjema.no --validation-method cname-delegation
az staticwebapp hostname show --name $SWA --resource-group $RG --hostname www.fskjema.no -o table
```

Den andre linja gir adressen CNAME-en skal peke på — med punktum bakerst i
ServeTheWorld sitt panel, og med bare `www` i navnefeltet (panelet legger
til domenet selv; `www.fskjema.no` i feltet ga `www.fskjema.no.fskjema.no`
28.10.2026). Vent til `nslookup` viser den nye adressen før `hostname set`,
ellers svarer Azure «CNAME Record is invalid». `ns3.servetheworld.net` svarer
med en gang; 8.8.8.8 kan henge etter med TTL-en fra trinn 1. Sertifikatet
tar noen minutter etter det.

`Resolve-DnsName` finnes ikke i Cloud Shell — det er Linux også i
PowerShell-modus. Bruk `nslookup`.

Trinn 16, kontroll:

| ☐ | Hva | Forventet |
|---|---|---|
| ☐ | `https://www.fskjema.no/api/ping` | `miljø` er `prod`, og commit-SHA-en er den som er deployet |
| ☐ | `https://fskjema.no` | Havner på `https://www.fskjema.no` — test i en nettleser som ikke har vært der før. En 301 huskes, og Edge i privat vindu slapp ikke innloggingen gjennom 28.10.2026 |
| ☐ | Innlogging og skjemalista | De samme skjematypene som på v2-prod |
| ☐ | `/api/system/info` | Kontoen som leses fra er v2 sin |
| ☐ | Send inn et testskjema | Kvittering og varsel kommer fram |
| ☐ | Jobber-fanen | Timerne er registrert; kjør oppslagslister og nøkkelkalenderen |
| ☐ | Backupen fra trinn 15 | Ligger i SharePoint som `prod-backup-…` |
| ☐ | Neste morgen | Nattjobbene står `ok` i Jobber-fanen, og GitHub Actions viser prod-raden som hoppet over |

**Etterpå:** sett TTL på `www` tilbake til 1 time når v3-prod er bekreftet.

### Parallelldrift: v2-prod og v3-prod på samme lagring

Går fint, og er i praksis det form A er — men bare med fire ting på plass:

1. **Bare én av dem kjører jobbene.** To veier, og valget er hvem som eier
   jobbene i perioden:

   | Jobbene kjøres av | Gjør dette |
   |---|---|
   | **v2-prod** (testperiode før cutover) | Slå av de ni timerne på v3-prod — under |
   | **v3-prod** (etter cutover) | Slett `SWA_URL_PROD`, se trinn 8 |

   **Begge samtidig er ikke bare dobbelt arbeid.** FS-refreshen kjører kl.
   04:00 UTC i begge, og to samtidige kjøringer sletter hverandres rader i
   `FilterStudent`: hver av dem sletter det som ikke har dens egen generasjon
   (`slettGamleGenerasjoner` i `lib/emner-storage.js`). Utsending og purring
   ville i tillegg gått dobbelt til eksterne mottakere.

   «Kjør nå» i Jobber-fanen kjører jobben i den appen du står i, uansett
   hvem som eier timerne. Bruk den bare i appen som eier jobbene.

   **Slå av timerne på v3-prod** i portalen: Function App-en → *Functions* →
   hver av de ni → *Disable*. Portalen lager app-settingen
   (`AzureWebJobs.<navn>.Disabled`) i riktig form for plattformen; skriv den
   ikke for hånd. Navnene står i Jobber-fanen under «registrert»:
   `postnumreTimer`, `refreshFsTimer`, `oppslaglisterTimer`, `teamSynkTimer`,
   `nokkelsjekkTimer`, `sendUtsendingerTimer`, `purreUtsendingerTimer`,
   `backupFullTimer`, `backupDeltaTimer`.

   Jobber-fanen vet ikke at de er slått av — den viser fortsatt «Timer i
   appen». Kontroller i portalen, og neste morgen at statusradene er skrevet
   av `scheduler` (v2-prod sin cron), ikke av `timer`.

   **`VARSLING_DEAKTIVERT=true` på v3-prod** i samme periode stopper det
   testerne gjør der fra å varsle: behandlingsvarsler, team-synk, og — fra
   28.10.2026 — også utsending og purring. Husk at det er EKTE skjemaer i
   felles lagring: en behandler som får en sak via v3-prod, får ikke vite
   det.

   Ved cutover snus alt: timerne på igjen, bryteren av, `SWA_URL_PROD` bort.

2. **De tre hemmelighetene i 7b er like.**
3. **Samme kode.** De to deployes hver for seg:
   - v2-prod med «Deploy prod eller pilot» (standard-token, `deploy_api` på)
   - v3-prod med begge jobbene

   Deployes bare den ene, kan den nye koden skrive noe den gamle ikke leser.
   Sjekk commit-SHA-en i `/api/ping` på begge.
4. **Nøkkelkalenderen er ikke delt mellom dem** — partisjonene er
   `production` og `prod`. Det er riktig, siden nøklene er ulike.

Det som tåler to skrivere fra før, fordi det allerede må tåle flere
instanser av samme app: skjemanummeret (`lib/skjema-id.js`, ETag mot
samtidige innsendinger), krypteringsnøklene (ligger i lagringen og følger
dataene), og lesecachene (60 sekunder i `lib/emner-storage.js`).

### Tilbakevei

Gjør cutover til et **domenebytte**, ikke en ny URL. Da er tilbakeveien én
DNS-endring. Får folk en ny adresse å bokmerke, er fallback rotete uansett
hvor ren koden er.

Tilbakeveien er sjekklisten baklengs:

1. `www.fskjema.no` fra v3-prod tilbake til v2-prod (trinn 13 med navnene
   byttet), og `SWA_URL` tilbake på begge.
2. `STORAGE_ACCOUNT_NAME` på v3-prod tilbake til `stskjema3prod`.
3. Legg inn `SWA_URL_PROD` igjen med `gentle-dune`-adressen, og den nye
   `SCHEDULER_KEY` fra trinn 9 i `SCHEDULER_KEY_PROD`. Da kjører v2-prod sine
   jobber fra neste tidspunkt.

Lagringen er felles i form A, så v2-prod ser det v3-prod skrev i
mellomtiden. Det er meningen — men det er også det eneste i tilbakeveien som
ikke er prøvd. Prøv det på en kopi før cutover, ikke for første gang under.

Med et eget domene kan versjonene også adresseres hver for seg, f.eks.
`v3prod.fskjema.no` for v3-prod mens v2-prod har `www`. Hvert navn trenger
sin egen redirect-URI.

### Domenet: DNS, egendefinert domene og CORS

Et eget domene er det som gjør cutover til én DNS-endring. Oppsettet er tre
ting, og den tredje er at det ikke er noe å gjøre.

> **Slik ble det, 28.10.2026:** ServeTheWorld har ikke ALIAS/ANAME på apex.
> `fskjema.no` videresendes derfor (301) til `www.fskjema.no`, som er en
> CNAME. Tabellen øverst i «Sjekkliste for cutover» er det gjeldende
> oppsettet; resten av dette avsnittet beskriver alternativene.

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

---

## 13. Fellene fra første gjennomkjøring (21.–22.10.2026)

Hver av disse kostet tid under den første ekte kjøringen mot prod. De er
rettet der de hører hjemme — denne lista er registeret, ikke rettelsen.

**Hvorfor den står her:** neste gjennomkjøring setter opp v3 på nytt i den
andre tenanten, og rydder bort v2 og pilot samtidig. Da er dette fasiten på
hva som skal prøves, og kolonnen helt til høyre sier hva som kan STRYKES når
v2 er borte.

### Meldinger som peker feil vei

| Det du ser | Det det betyr | Dekket i |
|---|---|---|
| `AuthorizationFailed … or the scope is invalid` | **To ting:** manglende rett ELLER et scope som ikke finnes. Fem runder gikk med; årsaken var en ressursgruppe som ikke fantes | 3.3 |
| `will continue to update the existing account` | Lagringskontonavn er globalt unike. Meldingen kommer selv om ressursgruppa du oppga ikke finnes | 2 |
| `Cannot find user or service principal in graph database` | `--assignee` fikk et NAVN. Den vil ha en objekt-ID | 3.1 |
| `Cannot bind argument to parameter 'Rg'` | `$p` er tom — Cloud Shell mistet variablene. `Rg` er en nøkkel i `$p`, ikke en variabel | 3 |
| `flag needs an argument: --body` | `$creds` er tom fordi kommandoen FØR feilet. Feilen er ikke i `gh` | 8 |
| `invalid datetime_type value: '…+00:00'` | `--expires` tar bare `Z`-formen. `attributes.expires` gir forskyvning | 0.4 |
| `--velg <navn>: ikke et navn i en enten/eller-gruppe` | Navnet er riktig; **klonen er gammel**. `git pull` | 4.2 |
| `AADSTS50011` | Appen BLE funnet. Bare vertsnavnet mangler — alt annet er på plass | 6 |
| `AADSTS700027` med riktig avtrykk i Key Vault | Sertifikatet ligger på feil app. `sp-skjema-*` er deploy-objektet, ikke backup-appen | 0.5 |
| «Lagring er ikke konfigurert» på en lenket SWA | Svaret kom fra en API-KOPI på SWA-en, ikke fra Function App-en | 5.2 |
| Avvist etter MFA, uten rader i Entras innloggingslogg | Kodevekslingen feilet, ikke autentiseringen. SWA-ens egen identitet mangler | 6.1 |
| `Resource <navn> of type Microsoft.Web/Sites doesn't exist` | **To ting:** feil navn, ELLER at deploy-objektet ikke ser ressursen. Workflowen lister nå det den ser, så de to kan skilles. Konvensjonen er `fa-skjema-3-<miljø>` — ikke visningsnavnet på SWA-en ved siden av | 8 |
| `Deploy verifisert: prod kjører <sha>` etter en PILOT-deploy | Merkelappen sto fast på «prod» etter at de to workflowene ble slått sammen. Sjekken var riktig og traff pilot — det var navnet som løy. Verste sorten: et sammendrag ingen mistror, som sier at prod er oppdatert når prod ikke er rørt | `deploy-prod.yml` |
| «SWA-token fra hemmeligheten» med ingenting etter | Linja skrev ut VALGET (`swa_token_secret`), og en kjøring uten eget valg bruker miljøets standard. Den svarte ikke på det eneste den finnes for: hvilken SWA ble truffet | `deploy-prod.yml` |
| `Failed to fetch Kudu App Settings. Unauthorized (CODE: 401)` med publiseringsprofil | **To ting:** basic auth på SCM er av, ELLER profilen ble hentet FØR den ble slått på. Den andre ser ut som at bryteren ikke hjalp — samme 401 etterpå. Profilen må hentes på nytt. Prøv den ferske mot `/api/settings` fra Cloud Shell: 200 betyr at det er den i GitHub som er gammel | 8.1 |
| `Operation returned an invalid status 'Not Found'` på `basicPublishingCredentialsPolicies` | **To ting:** Function App-en finnes ikke, ELLER `--api-version` mangler og `az` gjettet en versjon som ikke kjenner underressurstypen | 8.1 |
| «Vi må bestille en app-registrering for å deploye API-et» | **Ikke nødvendigvis.** `Azure/functions-action` tar en publiseringsprofil og trenger da ingen Entra-identitet. Hele kapittel 8.2 — og ventetiden på `Application Administrator` — faller bort når basic publishing er påslått. Sjekk det FØR du bestiller | 8.1 |
| `202 startet` på en jobb som står på «aldri kjørt» | **Fire-and-forget dør på en Function App.** Verten fullfører invokasjonen ved retur, og dreper det ingen ventet på — jobben rakk ikke engang sin første statusskriving. «Aldri kjørt» var det ene svaret som var sant. Fem ruter og tre varslingssteder gjorde det samme; de går nå gjennom `lib/bakgrunn.js`, som venter der plattformen krever det | 9 |
| `Unexpected input(s) 'deployment_environment'` | **Advarselen peker feil vei:** `@v1` løses til taggen, og dens `action.yml` erklærer bare 11 inputs. Men det er en docker-action — løperen eksporterer `with:`-nøklene som `INPUT_*` uansett, og beholderen leser den. Preview VIRKER. Konsekvensen er at en SKRIVEFEIL i navnet ville vært like stille | `deploy-prod.yml` |

### Krav uten et trinn

| Felle | Utslag |
|---|---|
| SWA-ens systemtildelte identitet + to Key Vault-roller sto som KRAV i 0.2 og 0.5, men ingen kommando utførte det | Innloggingen nede, og symptomet pekte mot Entra |
| `$PRINCIPAL` ble satt i 3.1 — et VILKÅRSAVSNITT | Tom variabel i 3.2, 3.3, 10 og 11 |
| Kapittel 4 hadde ikke noe ferdig-kriterium som kunne inntreffe | «Tom utskrift» skjer aldri: verten har alltid egne settinger |

### To lister som svarte ulikt

Den tilbakevendende feilklassen i dette repoet, og den tok fire former på to
dager:

| Hva som sto to steder | Hva det ga |
|---|---|
| `AZURE_FUNCAPP_CREDENTIALS_PROD` i kokeboka mot `AZURE_FUNCAPP_CREDENTIALS` i miljøet i workflowen | Deployen ville feilet i `azure/login`, i et helt annet kapittel |
| Kravlista krevde `AAD_CLIENT_SECRET` i prod; helsesjekken sa den skal stå tom | Ba om å lime v2 sin klienthemmelighet inn på v3 |
| `--navn` filtrerte `kun_dokumentasjon`, `--kommandoer` gjorde det ikke | Generatoren ba om å sette noe kravlista ikke krevde |
| `--sdk-auth` i kokeboka, `--json-auth` i beslutningsnotatet | Avviklingsadvarsel midt i en prod-kjøring |
| **Tokenet** sa hvilken SWA deployen gikk til; **`vars.SWA_URL`** sa hvilken som skulle verifiseres | Prod-deployen i kjøring #49 verifiserte PILOT og ble grønn — se under |

Alle fem er nå bundet av tester som leser BEGGE kildene.

**Den siste er verdt å lese nøye**, for den er feilen verifiseringssteget ble
skrevet for å fange, gjort av steget selv.

Kjøring #49 (22.10.2026) rullet ut til prod-SWA-en og sjekket `/api/ping` på
pilot. Den ble grønn bare fordi den automatiske pilot-deployen fortsatt sto
på den formiddagen, så pilot bar samme commit. Da den ble slått av (#173),
sto feilen igjen uten det som skjulte den.

Roten er at `miljo` har **to** verdier mens prod har **to SWA-er** — v2 og v3,
valgt med `swa_token_secret`. Én variabel per miljø kan ikke være riktig for
begge. Adressen må følge TOKENET, og den eneste kilden som vet hvor
opplastingen havnet, er deploy-stegets eget `static_web_app_url`. Det er nå
den eneste kilden, uten reserve: en reserve som kan peke på en annen SWA er
nettopp det som ga det grønne svaret.

### Ting kokeboka ba om som ikke kan gjøres

| Teksten sa | Virkeligheten |
|---|---|
| «Flytene må ha `…/` som audience, med skråstrek bakerst» | `aud` bestemmes av hvilken ressurs VI ber om token for. Det finnes ingen slik innstilling i Power Automate |
| «Flytenes allow-liste» | Feltet heter **Tillatte brukere**. Et oppslagsord som ikke finnes i verktøyet, finner ingen |

### Det som forsvinner når v2 og pilot rives

Dette er ryddelista for neste runde. Hver linje finnes BARE fordi to
versjoner kjører samtidig, eller fordi pilot har en annen arkitektur:

| Kan strykes | Hvorfor det står der nå |
|---|---|
| `--velg`-mekanismen og begge enten/eller-parene | Inventaret bærer både hemmelighet og sertifikat, både tilkoblingsstreng og kontonavn, fordi pilot og v2 bruker den ene og v3 den andre. Steg 6 i `BESLUTNING-EGEN-FUNCTION-APP.md` river gaffelen |
| `deploy_api`-valget i `deploy-prod.yml` | Finnes bare fordi v2 kjører API-et på SWA-en og v3 ikke gjør det |
| `KUN_I_MILJO` for `AAD_CLIENT_ID` | Erklæringen beskriver v2-arkitekturen, inventaret v3. De kan ikke bli enige før v2 er borte |
| `AAD_CLIENT_SECRET` i prod-inventaret | Står igjen bare fordi pilot bruker secret-navnet |
| `SWA_URL` som instansspesifikk | Relevant bare under parallellkjøring |
| 0.3 og 0.5 i sin helhet | Begge handler om å dele ressursgruppe og app-registreringer med v2 |
| `production` i `MILJO_ALIAS` | v2-prods `MILJO`. Aliaset får den til å lese som pilot, og må stå så lenge v2-prod finnes |
| **De åtte cron-workflowene** (`refresh-fs.yml`, `refresh-postnumre.yml`, `refresh-oppslagsliste.yml`, `team-synk.yml`, `sjekk-nokler.yml`, `send-utsendinger.yml`, `purre-utsendinger.yml`, `backup.yml`) | De kjører jobbene der plattformen ikke har timere — pilot og v2-prod. Når begge er revet, har alle miljøene timere. Ta med det som leser workflowene: `workflow` og `workflowCron` i `lib/jobber.js`, cron-sammenligningen i `api/test/timer-trigger.test.js`, og GitHub Actions-merknaden i `functions/jobber.js`. `SCHEDULER_KEY` og HTTP-veien inn til jobbene kan stå — «Kjør nå» bruker den |
| **Tre deploy-workflows → én** (`deploy-dev.yml`, `deploy-prod.yml`, `deploy-funcapp-pilot.yml`) | Tre fordi tre arkitekturer: frontend til dev-SWA, SWA med Managed Functions, og API til Function App. Med bare v3-dev og v3-prod igjen er det én: én workflow med `miljo: dev \| prod` som ruller ut API-et til Function App-en og så frontenden til SWA-en, **fra samme commit**. Da forsvinner `swa_token_secret`, `deploy_api`, `appnavn` og to SHA-er som kan skille lag. Prod beholder Environment approval |
| `refresh-fs-diag.yml` og `refresh-fs-diag-lu.yml` | Kaller pilot (`vars.SWA_URL`). Diagnostikk-knappen i FS-panelet gjør det samme fra appen |

> **Rydd ikke før v3 er verifisert i begge tenantene.** Hver av linjene over
> er en gaffel som bærer to oppsett. Fjernes den ene siden før den andre er
> prøvd, er det ingen vei tilbake — og tilbakeveien i 10 forutsetter at v2
> fortsatt står.
