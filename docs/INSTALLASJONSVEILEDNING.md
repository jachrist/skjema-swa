# Installasjonsveiledning

Trinnene for å sette opp v3-løsningen — Function App, Static Web App, Key
Vault og lagring — i en tenant der den ikke finnes fra før. Bare det som skal
gjøres, i den rekkefølgen det skal gjøres.

**Hvorfor, feilsøking og forklaringer står i `docs/KOKEBOK-PROD-V3.md`.** Hvert
steg her peker til avsnittet der. Står du fast, les det før du prøver noe
annet: det meste som kan gå galt, har gått galt én gang, og står der.

Alt kjøres i **PowerShell i Azure Cloud Shell**. Ingen kommando er delt over
flere linjer med et fortsettelsestegn — se «Om kommandoene» øverst i
kokeboka.

---

## Startblokka — kjøres ved HVER oppstart av Cloud Shell

> **Kjør hele blokka hver gang du åpner Cloud Shell, også midt i
> installasjonen.** Cloud Shell glemmer alle variabler når økta lukkes, går i
> dvale eller startes på nytt — og i en *kortvarig* økt (uten lagringskonto)
> forsvinner også klonen av repoet og GitHub-innloggingen. Kommandoene i
> stegene under forutsetter at variablene herfra er satt. En kommando med en
> tom variabel feiler sjelden pent: den treffer feil ressurs eller ingen.
>
> Blokka er trygg å kjøre så ofte du vil. Den oppretter ingenting i Azure, og
> den slår opp det som alt finnes — så etter et avbrudd fortsetter du på det
> steget du var på.

Verdiene i del 1 er de eneste som skal endres, og de endres **før første
kjøring, én gang**. De som står der, er oppsettet for v3-prod i
FHS-tenanten. Alt i stegene under leser herfra; ingen kommando lenger ned har
noe du skal bytte ut.

```powershell
# =====================================================================
#  STARTBLOKK - kjor HELE blokka ved hver ny oppstart av Cloud Shell
# =====================================================================

# ---------- 1. Verdiene for denne installasjonen (endres bare her) ----------
$TENANT     = '1e0e6195-b5ec-427a-9cc1-db95904592f9'  # tenanten v3 installeres i
$ABONNEMENT = ''                     # tom = det eneste abonnementet i tenanten
$GHREPO     = 'jachrist/skjema-swa'  # repoet det deployes fra (eier/navn)
$RG         = 'fhs-prod-rg-01'       # ressursgruppe
$STED       = 'norwayeast'           # region for alt unntatt SWA
$SWASTED    = 'westeurope'           # SWA finnes ikke i norwayeast
$FA         = 'fa-skjema-3-prod'     # Function App (API)
$MI         = 'mi-skjema-3-prod'     # managed identity for API-et
$DATA       = 'stskjema3prod'        # datalagring - ny konto er TOM
$RT         = 'stskjema3prodrt'      # runtime-lagring for Function App-en
$SWA        = 'swa-skjema-3-prod'    # Static Web App
$KV         = 'fhs-kv-01'            # Key Vault
$AUTHAPP    = 'fhs-adminskjema-api'  # app-registrering for innlogging
$AUTHCERT   = 'authapi'              # auth-sertifikatet i Key Vault
$BACKUPAPP  = 'fhs-skjema-backup'    # app-registrering for backup til SharePoint
$BACKUPCERT = 'graph-backup-prod'    # backup-sertifikatet i Key Vault
$SPSITE     = 'https://fhs.sharepoint.com/sites/Skjemasystem'  # backupens omraade
$DOMENE     = ''                     # eget domene, f.eks. v3.fskjema.no - tom = ingen
$APPTITTEL  = 'FHS Skjema'           # tittelen brukerne ser
$SWATOKEN   = 'AZURE_STATIC_WEB_APPS_API_TOKEN_PROD_V3'  # GitHub-hemmelighet for SWA-token
$DEPLOYSP   = 'sp-skjema-3-prod-deploy'                  # deploy-objekt, bare hvis 13b trengs
$MAPPE      = Join-Path $HOME 'skjema-swa'

# ---------- 2. GitHub: innlogging og klon ----------
gh auth status *> $null
if ($LASTEXITCODE -ne 0) { gh auth login --hostname github.com --git-protocol https --web }
gh auth setup-git
if (Test-Path (Join-Path $MAPPE '.git')) {
    git -C $MAPPE switch main
    git -C $MAPPE pull --ff-only
} else {
    gh repo clone $GHREPO $MAPPE
}
Set-Location $MAPPE

# ---------- 3. Azure: riktig tenant og abonnement ----------
$konto = az account show -o json 2>$null | ConvertFrom-Json
if (-not $konto -or $konto.tenantId -ne $TENANT) { az login --tenant $TENANT --use-device-code --output none }
if (-not $ABONNEMENT) {
    $abonnementer = @(az account list --query "[?tenantId=='$TENANT' && state=='Enabled'].id" -o tsv)
    if ($abonnementer.Count -ne 1) { az account list --query "[?tenantId=='$TENANT'].{navn:name, id:id}" -o table; throw "Tenanten har $($abonnementer.Count) abonnementer. Sett `$ABONNEMENT i del 1." }
    $ABONNEMENT = $abonnementer[0]
}
az account set --subscription $ABONNEMENT
$SUB = az account show --query id -o tsv
if ((az account show --query tenantId -o tsv) -ne $TENANT) { throw "Feil tenant. Stopp her." }

# ---------- 4. Det som alt finnes (tomt = ikke opprettet ennaa) ----------
$PRINCIPAL   = az identity show --name $MI --resource-group $RG --query principalId -o tsv 2>$null
$KV_ID       = az keyvault show --name $KV --query id -o tsv 2>$null
$VAULT       = az keyvault show --name $KV --query properties.vaultUri -o tsv 2>$null
$VERT        = az staticwebapp show --name $SWA --resource-group $RG --query defaultHostname -o tsv 2>$null
$SWAMI       = az staticwebapp identity show --name $SWA --resource-group $RG --query principalId -o tsv 2>$null
$AUTHAPPID   = az ad app list --display-name $AUTHAPP --query "[0].appId" -o tsv
$BACKUPAPPID = az ad app list --display-name $BACKUPAPP --query "[0].appId" -o tsv
$ADMINER     = az ad signed-in-user show --query userPrincipalName -o tsv
$ADRESSE     = if ($DOMENE) { "https://$DOMENE" } elseif ($VERT) { "https://$VERT" } else { '' }
$p = @{
    Rg = $RG; FuncApp = $FA; Lagring = $RT; DataLagring = $DATA; Identitet = $MI
    KeyVault = $KV; Swa = $SWA; Sted = $STED; SwaSted = $SWASTED
}

# ---------- 5. Status ----------
[pscustomobject]@{
    Tenant = $TENANT; Abonnement = $SUB; Repo = (git rev-parse --short HEAD)
    Identitet = $PRINCIPAL; KeyVault = $VAULT; SwaVert = $VERT; SwaIdentitet = $SWAMI
    AuthApp = $AUTHAPPID; BackupApp = $BACKUPAPPID; Adresse = $ADRESSE; Admin = $ADMINER
} | Format-List
```

Blokka avslutter med en statusliste. Tomme felt er det som ikke er opprettet
ennå — de fylles etter hvert som stegene kjøres, og neste kjøring av blokka
finner dem. Stegene som oppretter noe, setter også variabelen selv, så du
trenger ikke kjøre blokka om igjen mellom stegene i samme økt.

`ADMIN_UPNS` blir den som er logget inn. Flere administratorer: kommaseparert
liste i `ADMIN_UPNS`, steg 10.

**Miljønavnet er `prod`, og det står fast i kommandoene.** Ikke finn opp et
nytt for en ny tenant — et nytt navn koster fire filer i repoet og gir
dårligere diagnostikk (kokeboka 0.6). Det som skiller installasjonene, er
ressursnavnene i del 1.

---

## Steg 1. Rettigheter og ressursleverandører

Før noe opprettes: har du rettighetene? Tabellene i **kokeboka 0.1** sier
hvilken rolle hvert steg krever, og hva som må bestilles. Kort: `Owner` på
ressursgruppa, `User Access Administrator` på vaulten, `Application
Administrator` i Entra for steg 7, og `Global Administrator` eller
`Privileged Role Administrator` for backup-samtykket i steg 8.

```powershell
az role assignment list --assignee $ADMINER --all --include-inherited --query "[].{rolle:roleDefinitionName, omfang:scope}" -o table
```

Ressursleverandørene må være registrert i abonnementet (krever Contributor på
abonnementet — kokeboka 0.1 B):

```powershell
foreach ($ns in @('Microsoft.Web', 'Microsoft.Storage', 'Microsoft.ManagedIdentity', 'Microsoft.KeyVault')) {
    az provider register --namespace $ns --wait --output none
}
az provider list --query "[?namespace=='Microsoft.Web' || namespace=='Microsoft.Storage' || namespace=='Microsoft.ManagedIdentity' || namespace=='Microsoft.KeyVault'].{navn:namespace, status:registrationState}" -o table
```

Alle fire skal stå `Registered`.

---

## Steg 2. Ressursgruppe og lagring

Kokeboka **2** (og **0.3** hvis gruppa deles med noe annet).

```powershell
if ((az group exists --name $RG) -eq 'true') { "Ressursgruppa $RG finnes - gjenbrukes" } else { az group create --name $RG --location $STED --output none }
foreach ($konto in @($DATA, $RT)) {
    $arg = @(
        'storage', 'account', 'create',
        '--name', $konto,
        '--resource-group', $RG,
        '--location', $STED,
        '--sku', 'Standard_LRS',
        '--kind', 'StorageV2',
        '--min-tls-version', 'TLS1_2',
        '--allow-blob-public-access', 'false',
        '--output', 'none'
    )
    az @arg
}
az storage account list --resource-group $RG --query "[].name" -o tsv
```

Navnet er globalt unikt. Svarer Azure `StorageAccountAlreadyTaken`, velg et
nytt i startblokka og kjør den på nytt.

---

## Steg 3. Key Vault

Kokeboka **0.2** — og les fella om RBAC mot tilgangspolicy før du går videre.

```powershell
if (-not $KV_ID) {
    az keyvault create --name $KV --resource-group $RG --location $STED --enable-rbac-authorization true --output none
}
$KV_ID = az keyvault show --name $KV --query id -o tsv
$VAULT = az keyvault show --name $KV --query properties.vaultUri -o tsv
az keyvault show --name $KV --query "{rbac:properties.enableRbacAuthorization, nettverk:properties.networkAcls.defaultAction}" -o table
```

`rbac` skal være `True`. Er den `False`, gjelder ikke rollene under — se 0.2.
Står `nettverk` på `Deny`, når ikke Function App-en vaulten uansett rolle.

Du trenger selv å skrive hemmeligheter og lage sertifikater:

```powershell
$meg = az ad signed-in-user show --query id -o tsv
foreach ($rolle in @('Key Vault Secrets Officer', 'Key Vault Certificates Officer')) {
    $arg = @(
        'role', 'assignment', 'create',
        '--assignee-object-id', $meg,
        '--assignee-principal-type', 'User',
        '--role', $rolle,
        '--scope', $KV_ID,
        '--output', 'none'
    )
    az @arg
}
```

En ny rolle kan bruke et par minutter på å slå gjennom. Får du `Forbidden` i
steg 7–9 rett etterpå, vent og prøv igjen.

---

## Steg 4. Tilpass repoet til tenanten

Innloggingen leser tenant-ID, vault og sertifikatnavn fra
`staticwebapp.config.prod.json` — den eneste fila i repoet som er bundet til
én tenant. Står det en annen tenant der, sender innloggingen brukerne til
feil sted. Sjekk først (vaulten fra steg 3 må finnes):

```powershell
$fil = Join-Path $MAPPE 'staticwebapp.config.prod.json'
$reg = (Get-Content $fil -Raw | ConvertFrom-Json).auth.identityProviders.azureActiveDirectory.registration
$UTSTEDER = "https://login.microsoftonline.com/$TENANT/v2.0"
$CERTREF  = "@Microsoft.KeyVault(SecretUri=$($VAULT)certificates/$AUTHCERT/)"
[pscustomobject]@{ Tenant = ($reg.openIdIssuer -eq $UTSTEDER); Sertifikat = ($reg.clientSecretCertificateKeyVaultReference -eq $CERTREF) } | Format-List
```

**Begge `True`: hopp til steg 5.** Ellers skrives fila om, testene kjøres, og
endringen går inn som en PR:

```powershell
$tekst = (Get-Content $fil -Raw).Replace($reg.openIdIssuer, $UTSTEDER).Replace($reg.clientSecretCertificateKeyVaultReference, $CERTREF)
Set-Content -Path $fil -Value $tekst -NoNewline -Encoding utf8NoBOM
git -C $MAPPE diff --stat
Push-Location (Join-Path $MAPPE 'api'); npm test; Pop-Location
```

Er testene grønne:

```powershell
git -C $MAPPE config user.name (az ad signed-in-user show --query displayName -o tsv)
git -C $MAPPE config user.email $ADMINER
git -C $MAPPE switch -c "tenant-$SUB"
git -C $MAPPE commit -am "Innlogging mot tenant $TENANT"
git -C $MAPPE push -u origin "tenant-$SUB"
gh pr create --repo $GHREPO --fill
```

Merge PR-en før steg 12. Deploy kjører testene og stopper på rødt.

> **Bytter du vault-navn, blir `api/test/keyvault-navn.test.js` rød.** Den
> leser prod-vaulten ut av denne fila og krever at hvert annet vault-navn i
> repoet er kjent. `fhs-kv-01` står da igjen i dokumentasjonen uten å være
> noen kjent vault. Legg det inn i `UNNTAK` i testen, med grunnen «FHS sin
> vault, ikke denne installasjonens». Se også `docs/DEPLOY.md`, «Sertifikat-
> oppsett for prod».

---

## Steg 5. Function App, identitet og roller

Kokeboka **3**, **3.1–3.3**. Skriptet tørrkjører uten `-Kjor` — les
utskriften først:

```powershell
.\scripts\steg1-funcapp.ps1 @p -Trinn funcapp
```

```powershell
.\scripts\steg1-funcapp.ps1 @p -Trinn funcapp -Kjor
$PRINCIPAL = az identity show --name $MI --resource-group $RG --query principalId -o tsv
if (-not $PRINCIPAL) { throw "Fant ikke $MI - les feilen over." }
```

Ligger vaulten i en annen ressursgruppe, tildeles vault-rollen her (3.1).
Kommandoen er ufarlig hvis rollen alt finnes:

```powershell
$arg = @(
    'role', 'assignment', 'create',
    '--assignee-object-id', $PRINCIPAL,
    '--assignee-principal-type', 'ServicePrincipal',
    '--role', 'Key Vault Secrets User',
    '--scope', $KV_ID,
    '--output', 'none'
)
az @arg
az role assignment list --assignee-object-id $PRINCIPAL --all --query "[].{rolle:roleDefinitionName, scope:scope}" -o table
```

Forventet: tre storage-roller på `$DATA` (Table Data Contributor, Blob Data
Contributor, Blob Delegator) og `Key Vault Secrets User` på vaulten.
`AuthorizationFailed` → **3.3**: det betyr enten manglende rett, eller at
omfanget ikke finnes.

---

## Steg 6. Static Web App og dens identitet

Kokeboka **5** og **6.1**.

```powershell
.\scripts\steg1-funcapp.ps1 @p -Trinn swa -Kjor
$VERT = az staticwebapp show --name $SWA --resource-group $RG --query defaultHostname -o tsv
$ADRESSE = if ($DOMENE) { "https://$DOMENE" } else { "https://$VERT" }
$SWAMI = az staticwebapp identity assign --name $SWA --resource-group $RG --query principalId -o tsv
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
az role assignment list --assignee $SWAMI --scope $KV_ID --query "[].roleDefinitionName" -o tsv
```

Begge rollene skal stå i lista. Dette er SWA-ressursens **egen** identitet —
ikke `$MI`. Det var sammenblandingen av de to som holdt innloggingen nede
22.10.2026 (6.1).

---

## Steg 7. Innlogging: app-registrering og sertifikat

Kokeboka **6**, og `docs/DEPLOY.md` «Sertifikat-oppsett for prod». Krever
`Application Administrator` (kokeboka 0.1 C).

**Sertifikatet** lages i vaulten. Innloggingen bruker det som det er (PFX);
det er bare backup-sertifikatet i steg 8 som må være PEM.

```powershell
if (-not (az keyvault certificate show --vault-name $KV --name $AUTHCERT --query id -o tsv 2>$null)) {
    $policy = az keyvault certificate get-default-policy | ConvertFrom-Json
    $policy.x509CertificateProperties.subject = "CN=$AUTHAPP"
    $policy | ConvertTo-Json -Depth 10 | Set-Content -Path policy.json -Encoding utf8NoBOM
    az keyvault certificate create --vault-name $KV --name $AUTHCERT --policy '@policy.json' --output none
    Remove-Item policy.json
}
az keyvault certificate show --vault-name $KV --name $AUTHCERT --query "{status:attributes.enabled, utloper:attributes.expires}" -o table
```

**App-registreringen** — med ID-token på (uten det: `AADSTS700054`) og
redirect-URI for SWA-vertsnavnet og eventuelt domenet:

```powershell
$uris = @("https://$VERT/.auth/login/aad/callback")
if ($DOMENE) { $uris += "https://$DOMENE/.auth/login/aad/callback" }
if (-not $AUTHAPPID) {
    $AUTHAPPID = az ad app create --display-name $AUTHAPP --sign-in-audience AzureADMyOrg --query appId -o tsv
    az ad sp create --id $AUTHAPPID --output none
}
$gamle = az ad app show --id $AUTHAPPID --query 'web.redirectUris' -o tsv
$alle = @($gamle) + $uris | Where-Object { $_ } | Select-Object -Unique
$arg = @('ad', 'app', 'update', '--id', $AUTHAPPID, '--enable-id-token-issuance', 'true', '--web-redirect-uris') + $alle
az @arg
az ad app show --id $AUTHAPPID --query "{uris:web.redirectUris, idToken:web.implicitGrantSettings.enableIdTokenIssuance}" -o json
```

**Den offentlige delen av sertifikatet** på appen. `--append` er påkrevd —
uten den fjernes all eksisterende legitimasjon. Sjekken hindrer at samme
sertifikat legges på to ganger:

```powershell
$avtrykk = az keyvault certificate show --vault-name $KV --name $AUTHCERT --query x509ThumbprintHex -o tsv
$paa = az ad app credential list --id $AUTHAPPID --cert --query "[].customKeyIdentifier" -o tsv
if ($paa -notcontains $avtrykk) { az ad app credential reset --id $AUTHAPPID --keyvault $KV --cert $AUTHCERT --append --output none }
az ad app credential list --id $AUTHAPPID --cert --query "[].{avtrykk:customKeyIdentifier, utloper:endDateTime}" -o table
```

Avtrykket i tabellen skal være lik `$avtrykk`.

Har du ikke rollen: bestillingen står i kokeboka **6**, «Har du ikke rollen».

---

## Steg 8. Backup-appen og sertifikatet

Kokeboka **0.4** og **0.5**, og `docs/BACKUP-SHAREPOINT.md`. Samtykket krever
`Global Administrator` eller `Privileged Role Administrator`.

App-registrering med `Sites.Selected` og skrivetilgang til ett område.
Skriptet spør om innlogging til Microsoft Graph:

```powershell
.\scripts\opprett-backup-app.ps1 -Site $SPSITE -Navn $BACKUPAPP -Sertifikat -Torrkjor
```

```powershell
.\scripts\opprett-backup-app.ps1 -Site $SPSITE -Navn $BACKUPAPP -Sertifikat
$BACKUPAPPID = az ad app list --display-name $BACKUPAPP --query "[0].appId" -o tsv
```

Sertifikatet — **PEM**, ellers kan ikke Node lese nøkkelen (0.4):

```powershell
if (-not (az keyvault certificate show --vault-name $KV --name $BACKUPCERT --query id -o tsv 2>$null)) {
    $policy = az keyvault certificate get-default-policy | ConvertFrom-Json
    $policy.secretProperties.contentType = 'application/x-pem-file'
    $policy.x509CertificateProperties.subject = "CN=$BACKUPAPP"
    $policy | ConvertTo-Json -Depth 10 | Set-Content -Path policy.json -Encoding utf8NoBOM
    az keyvault certificate create --vault-name $KV --name $BACKUPCERT --policy '@policy.json' --output none
    Remove-Item policy.json
}
az keyvault secret show --vault-name $KV --name $BACKUPCERT --query contentType -o tsv
```

Svaret skal være `application/x-pem-file`. Er det noe annet: **0.4**, «Ble det
PFX likevel?».

Den offentlige delen på backup-appen — **ikke** på deploy-objektet
(`sp-skjema-*`). Det er appen `GRAPH_CLIENT_ID` peker på som teller
(`AADSTS700027`, 0.5):

```powershell
$avtrykk = az keyvault certificate show --vault-name $KV --name $BACKUPCERT --query x509ThumbprintHex -o tsv
$paa = az ad app credential list --id $BACKUPAPPID --cert --query "[].customKeyIdentifier" -o tsv
if ($paa -notcontains $avtrykk) { az ad app credential reset --id $BACKUPAPPID --keyvault $KV --cert $BACKUPCERT --append --output none }
az ad app credential list --id $BACKUPAPPID --cert --query "[].{avtrykk:customKeyIdentifier, utloper:endDateTime}" -o table
```

---

## Steg 9. Hemmelighetene i Key Vault

Inventaret i `config/env.prod.json` navngir hver hemmelighet. Blokka under
går gjennom dem som mangler i vaulten:

* **Nøkler som bare er tilfeldige tall** — `hash-salt`, `otp-hmac-key`,
  `flow-callback-key`, `scheduler-key`, `backup-passphrase` — lages her og
  vises aldri.
* **Resten** (FS-API, flyt-URL-er, Anthropic-nøkkelen) spør den om. Verdien
  skrives ikke på skjermen. **Tom verdi = hopp over**; app-settingen fjernes
  da i steg 10, og funksjonen er av til verdien legges inn.
* **Tre hører ikke til v3** og hoppes over: `storage-connection-string`
  (v3 bruker identiteten), `graph-client-secret` (sertifikatet brukes) og
  `aad-client-secret` (innloggingen bruker sertifikatet).

```powershell
$inventar = Get-Content (Join-Path $MAPPE 'config/env.prod.json') -Raw | ConvertFrom-Json
$ikkeV3 = @('storage-connection-string', 'graph-client-secret', 'aad-client-secret')
$tilfeldig = @('hash-salt', 'otp-hmac-key', 'flow-callback-key', 'scheduler-key', 'backup-passphrase')
$finnes = @(az keyvault secret list --vault-name $KV --query "[].name" -o tsv)
foreach ($post in $inventar.PSObject.Properties) {
    $navn = $post.Value.keyvault
    if (-not $navn -or $ikkeV3 -contains $navn -or $finnes -contains $navn) { continue }
    if ($tilfeldig -contains $navn) {
        $klar = [Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLower()
    } else {
        $hemmelig = Read-Host -AsSecureString "$($post.Name) ($navn) - tom = hopp over"
        $klar = [System.Net.NetworkCredential]::new('', $hemmelig).Password
    }
    if ($klar) { az keyvault secret set --vault-name $KV --name $navn --value $klar --output none; "lagt inn: $navn" }
}
Remove-Variable klar, hemmelig -ErrorAction SilentlyContinue
```

To av de tilfeldige skal brukes andre steder senere — hent dem fra vaulten
når du trenger dem, ikke kopier dem rundt:

* `flow-callback-key` skal inn i flytene (steg 15).
* `backup-passphrase` trengs for å lese en backup. Den er lagret i vaulten,
  og der skal den være.

`todo-storage-connection-string` skal normalt stå tom: da er oppgavelista og
nøkkelkalenderen lokale for installasjonen (kokeboka 0.6).

Kjøres blokka på nytt, spør den bare om det som fortsatt mangler.

---

## Steg 10. App settings

Kokeboka **4**, **4.0–4.3**. Først Key Vault-referansene og de faste
verdiene, generert fra inventaret og kjørt direkte:

```powershell
node scripts/vis-appsettings.js prod --kommandoer --vault $KV --velg GRAPH_CLIENT_CERT_PEM --velg STORAGE_ACCOUNT_NAME | Out-String | Invoke-Expression
```

Så fjernes referansene til hemmeligheter som ikke finnes i vaulten (hoppet
over i steg 9). En uløst referanse blir ellers stående som tekst, og
koden tror verdien er satt:

```powershell
$inventar = Get-Content (Join-Path $MAPPE 'config/env.prod.json') -Raw | ConvertFrom-Json
$finnes = @(az keyvault secret list --vault-name $KV --query "[].name" -o tsv)
$uten = @($inventar.PSObject.Properties | Where-Object { $_.Value.keyvault -and ($finnes -notcontains $_.Value.keyvault) } | ForEach-Object { $_.Name })
if ($uten) { az functionapp config appsettings delete --name $FA --resource-group $RG --setting-names @uten --output none; "fjernet: $($uten -join ', ')" }
```

Så verdiene som ikke står i inventaret, eller som er tenantens egne. Varsling
er AV til løsningen er testet (steg 18):

```powershell
$verdier = @(
    "STORAGE_ACCOUNT_NAME=$DATA",
    "KEYVAULT_NAME=$KV",
    "ADMIN_UPNS=$ADMINER",
    "GRAPH_TENANT_ID=$TENANT",
    "GRAPH_CLIENT_ID=$BACKUPAPPID",
    "GRAPH_CLIENT_CERT_PEM=@Microsoft.KeyVault(SecretUri=$($VAULT)secrets/$BACKUPCERT/)",
    "BACKUP_SHAREPOINT_SITE=$SPSITE",
    "SWA_URL=$ADRESSE",
    "APP_TITTEL=$APPTITTEL",
    'FLYT_AUTH=entra',
    'VARSLING_DEAKTIVERT=true',
    'AzureFunctionsJobHost__functionTimeout=00:10:00'
)
$arg = @('functionapp', 'config', 'appsettings', 'set', '--name', $FA, '--resource-group', $RG, '--settings') + $verdier + @('--output', 'none')
az @arg
```

`AAD_CLIENT_ID` hører på **SWA-ressursen**, ikke Function App-en (4.3):

```powershell
az staticwebapp appsettings set --name $SWA --resource-group $RG --setting-names "AAD_CLIENT_ID=$AUTHAPPID" --output none
```

**Kontroll** — sammenligner navn, aldri verdier (4.2):

```powershell
node scripts/vis-appsettings.js prod --navn --velg GRAPH_CLIENT_CERT_PEM --velg STORAGE_ACCOUNT_NAME | Set-Content krav.txt
$arg = @('functionapp', 'config', 'appsettings', 'list', '--name', $FA, '--resource-group', $RG, '--query', '[].name', '-o', 'tsv')
az @arg | Set-Content satt.txt
Compare-Object (Get-Content krav.txt | Sort-Object) (Get-Content satt.txt | Sort-Object)
Remove-Item krav.txt, satt.txt
```

`<=` er krav som ikke er satt. Det skal bare være dem som ble fjernet over,
`=>` er satt uten å være krav —
forventet er `AZURE_CLIENT_ID`, `FLYT_AUTH`, `VARSLING_DEAKTIVERT`,
tidsgrensen og plattformens egne.

---

## Steg 11. GitHub: miljø og deploy-legitimasjon

Kokeboka **5.1** og **8.1**. Krever admin på GitHub-repoet (0.1 D).

GitHub-miljøet `prod` — deployene kjører i det, og hemmelighetene for API-et
står der:

```powershell
gh api --method PUT "repos/$GHREPO/environments/prod" --silent
```

**SWA-tokenet** i en egen hemmelighet. Bytt aldri verdien på en hemmelighet en
annen SWA alt bruker (5.2):

```powershell
$token = az staticwebapp secrets list --name $SWA --resource-group $RG --query "properties.apiKey" -o tsv
gh secret set $SWATOKEN --repo $GHREPO --body $token
Remove-Variable token
```

**API-et: publiseringsprofil (13a).** Slå på basic publishing hvis det er av,
og legg profilen i miljøet:

```powershell
$tillatt = az resource show --resource-group $RG --name "$FA/scm" --resource-type Microsoft.Web/sites/basicPublishingCredentialsPolicies --api-version 2023-01-01 --query properties.allow -o tsv
if ($tillatt -ne 'true') { az resource update --resource-group $RG --name "$FA/scm" --resource-type Microsoft.Web/sites/basicPublishingCredentialsPolicies --set properties.allow=true --api-version 2023-01-01 --output none }
az functionapp deployment list-publishing-profiles --resource-group $RG --name $FA --xml | gh secret set AZURE_FUNCAPP_PUBLISH_PROFILE --repo $GHREPO --env prod
```

Nekter en policy basic publishing (`RequestDisallowedByPolicy`), bruk 13b i
steg 13 i stedet.

---

## Steg 12. Deploy frontend

Kokeboka **5.2**. PR-en fra steg 4 må være merget. `deploy_api=false` er
påkrevd: v3 har API-et i Function App-en, ikke på SWA-en.

```powershell
gh workflow run "Deploy prod eller pilot" --repo $GHREPO --ref main -f miljo=prod -f bekreft=DEPLOY-PROD -f deploy_api=false -f swa_token_secret=$SWATOKEN
Start-Sleep -Seconds 10
gh run watch --repo $GHREPO (gh run list --repo $GHREPO --workflow deploy-prod.yml --limit 1 --json databaseId --jq '.[0].databaseId')
```

Jobben venter på godkjenning hvis miljøet `prod` krever det. Når den er grønn:

```powershell
(Invoke-WebRequest -Uri "https://$VERT/" -UseBasicParsing).StatusCode
```

`200` — forsiden vises. **Ikke gå videre før den gjør det:** en SWA uten
vellykket deploy kan ikke lenkes (5).

---

## Steg 13. Lenk Function App-en og deploy API-et

Kokeboka **5.3** og **8**.

```powershell
.\scripts\steg1-funcapp.ps1 @p -Trinn lenk -Kjor
az staticwebapp backends show --name $SWA --resource-group $RG -o table
```

**13a — med publiseringsprofilen fra steg 11:**

```powershell
gh workflow run "Deploy API til Function App" --repo $GHREPO --ref main -f appnavn=$FA -f miljo=prod -f verifiser_url=$ADRESSE
Start-Sleep -Seconds 10
gh run watch --repo $GHREPO (gh run list --repo $GHREPO --workflow deploy-funcapp-pilot.yml --limit 1 --json databaseId --jq '.[0].databaseId')
```

Får jobben 401 mot Kudu: **8.1**, «Får du 401 likevel».

**13b — bare hvis basic publishing er nektet.** Et tjenestehovedobjekt med
Contributor på Function App-en alene (8.2). Profilen må da fjernes, ellers
vinner den:

```powershell
gh secret delete AZURE_FUNCAPP_PUBLISH_PROFILE --repo $GHREPO --env prod
$scope = "/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.Web/sites/$FA"
$creds = az ad sp create-for-rbac --name $DEPLOYSP --role Contributor --scopes $scope --json-auth
if (-not $creds) { throw "create-for-rbac ga ingenting - les feilen over (8.2)." }
gh secret set AZURE_FUNCAPP_CREDENTIALS --repo $GHREPO --env prod --body $creds
Remove-Variable creds
```

Kjør så 13a på nytt. `Insufficient privileges` → **8.2**, «Får du
`Insufficient privileges`».

---

## Steg 14. Første innlogging

```powershell
"$ADRESSE/login"
```

Åpne adressen i et privat nettleservindu og logg inn. Feilene, og hva de
betyr (kokeboka **6**):

| Entra svarer | Steg å se på |
|---|---|
| `AADSTS50011` — redirect URI | 7: vertsnavnet mangler på appen |
| `AADSTS700016` — application not found | 10: `AAD_CLIENT_ID` på SWA-en |
| `AADSTS700054` — `id_token` not enabled | 7: ID-token |
| Feil om klientlegitimasjon | 6: SWA-identitetens vault-roller, og 4: sertifikatreferansen |
| `AADSTS65001` — samtykke | En administrator gir samtykke under **Enterprise applications → appen → Permissions** |

---

## Steg 15. Flytene

Kokeboka **7**, og `docs/FLYT-DEPLOY.md` for importen. Dette steget gjøres i
Power Automate, ikke i Cloud Shell.

Verdiene flytene trenger:

```powershell
"Tillatte brukere (oid):  $PRINCIPAL"
"SwaBaseUrl:              $ADRESSE"
```

1. Importer flytløsningen, og sett `SwaBaseUrl`.
2. På hver HTTP-trigger: **«Spesifikke brukere i leieren»**, og `oid` over i
   **«Tillatte brukere»**.
3. Flytene som kaller tilbake, trenger `flow-callback-key`. Les den rett
   inn i utklippstavlen, ikke på skjermen:

```powershell
az keyvault secret show --vault-name $KV --name flow-callback-key --query value -o tsv | Set-Clipboard
```

4. Kopier hver flyts trigger-URL inn i vaulten (steg 9 på nytt spør om dem
   som fortsatt mangler), og kjør steg 10 på nytt.
5. Servicebrukeren som eier connectorene, meldes inn i teamet.

> `Set-Clipboard` finnes ikke i alle Cloud Shell-økter. Mangler den, hent
> verdien i portalen under vaulten → **Secrets** i stedet.

---

## Steg 16. Verifikasjon

Kokeboka **9** — i denne rekkefølgen.

```powershell
$ping = Invoke-RestMethod -Uri "$ADRESSE/api/ping"
[pscustomobject]@{ ApiKjorer = $ping.bygg.commit; Repoet = (git -C $MAPPE rev-parse HEAD) } | Format-List
az functionapp function list --name $FA --resource-group $RG --query "[].name" -o tsv
```

Commit-SHA-ene skal være like. Funksjonslista skal ha ni timere.

I appen:

| # | Hvor | Forventet |
|---|---|---|
| 1 | **Administrasjon → ⚙️ System** | `lagring.maate` = `managed-identity`, `flytAuth` = `entra`, ingen uløst Key Vault-referanse |
| 2 | **Administrasjon → ⏱ Jobber** | Ni timere, alle `registrert` |
| 3 | **Skjematyper → 📥 Importer definisjoner** | Last inn definisjonene fra et eksisterende miljø, les forhåndsvisningen |
| 4 | Send inn et testskjema | Skrives til `$DATA` |
| 5 | **Jobber → Kjør nå** på oppslagslister | «✓ Ferdig» |
| 6 | **Jobber → Kjør nå** på backup | Fila havner i `$SPSITE` (feil: `docs/BACKUP-SHAREPOINT.md`, «Feilsøking») |

---

## Steg 17. Eget domene (hvis `$DOMENE` er satt)

Kokeboka **10**, «Domenet: DNS, egendefinert domene og CORS». Først en CNAME
hos den som eier sonen:

```powershell
"CNAME  $DOMENE  ->  $VERT"
```

Når posten er ute:

```powershell
Resolve-DnsName -Name $DOMENE -Type CNAME -Server 8.8.8.8
az staticwebapp hostname set --name $SWA --resource-group $RG --hostname $DOMENE --output none
az staticwebapp hostname list --name $SWA --resource-group $RG --query "[].{navn:name, status:status}" -o table
```

`Ready` når sertifikatet er utstedt. Redirect-URI-en for domenet ble lagt på
i steg 7 — var `$DOMENE` tom da, kjør steg 7 på nytt nå, og steg 10 for
`SWA_URL`.

---

## Steg 18. Slå på varsling

Først når steg 16 er gjennomført og flytene er prøvd. Til da sender ikke
løsningen e-post eller Teams-meldinger:

```powershell
az functionapp config appsettings delete --name $FA --resource-group $RG --setting-names VARSLING_DEAKTIVERT --output none
```

---

## Hvor står hva

| Trenger du | Se |
|---|---|
| Hvorfor et steg er slik | Kokeboka, kapitlet steget peker til |
| Rettigheter og bestillinger | Kokeboka 0.1 |
| Overgang fra en v2-installasjon | Kokeboka 10 |
| Feller som er gått i før | Kokeboka 13 |
| Backup i detalj | `docs/BACKUP-SHAREPOINT.md` |
| Flytene i detalj | `docs/FLYTER.md`, `docs/FLYT-DEPLOY.md` |
