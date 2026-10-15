<#
.SYNOPSIS
    Oppretter en Function App med egen identitet, lenket til en SWA.

    Skrevet for steg 1-forsøket 14.10.2026, som svarte ja på spørsmålet det
    ble lagd for. Prøveoppsettet er revet; skriptet er det ikke — det bygger
    nå dev-miljøet i steg 0 (8g i docs/BESLUTNING-EGEN-FUNCTION-APP.md).

.DESCRIPTION
    Svaret avgjør om API-et kan flyttes ut av SWA Managed Functions. Blir det
    nei, stopper forslaget der, og alt dette rives ned igjen.

    REKKEFØLGEN ER POENGET. Første forsøk 14.10.2026 lenket backend-en til en
    SWA som aldri hadde hatt en vellykket deploy. Aktivitetsloggen sa at alt
    var i orden, miljøet sto på «Uploading» i timevis, og ingenting rutet.
    Innholdet må på plass FØR lenkingen.

    DET SKRIPTET GJØR:
      1. Oppretter lagringskonto til Function App-runtime
      2. Oppretter Function App-en, Node 22, Linux
      3. Oppretter en USER-ASSIGNED managed identity, knytter den til
         Function App-en, setter AZURE_CLIENT_ID og tildeler rollene
      4. Oppretter prøve-SWA-en (Standard — lenkede backends finnes ikke på Free)
      5. STOPPER, og ber deg deploye innhold og bekrefte at det vises
      6. Lenker Function App-en til SWA-en

    DET SKRIPTET IKKE GJØR:
      Rører ingenting i pilot eller prod. Setter ingen hemmeligheter.
      Sletter ingenting.

.PARAMETER Trinn
    alt | funcapp | swa | lenk. Hvert trinn krever bare sine egne
    parametere, så den som skal lenke på nytt slipper å oppgi resten.

.PARAMETER Identitet
    Navnet på den user-assigned managed identity-en. Den opprettes som egen
    ressurs, og er bevisst IKKE system-assigned: en system-assigned identitet
    dør med Function App-en, og da må hver håndgitte tildeling gjøres om —
    storage-rollene, Key Vault-rollen, Graph-approllene, SharePoint-tilgangen
    per site, og `oid` i Power Automate-flytenes allow-liste. Se 8g.

.PARAMETER Kjor
    Uten denne tørrkjører skriptet og viser bare hva det ville gjort.

.EXAMPLE
    .\steg1-funcapp.ps1 -Rg FHS-skjema -FuncApp testfapp -Lagring fastate01 `
        -Swa swa-funcapp-proeve -KeyVault kv-fhsskjema-pilot -DataLagring <konto> `
        -Identitet id-fhsskjema-dev -Kjor

.EXAMPLE
    # Bare lenkingen, etter at innholdet er bekreftet:
    .\steg1-funcapp.ps1 -Rg FHS-skjema -FuncApp testfapp -Swa swa-funcapp-proeve2 -Trinn lenk -Kjor
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Rg,
    [string]$FuncApp,
    [string]$Lagring,
    [string]$Swa,
    [string]$KeyVault,
    [string]$DataLagring,
    [string]$Identitet,
    [string]$Sted = 'norwayeast',
    [string]$SwaSted = 'westeurope',
    # Trinn kan kjøres hver for seg. Første versjon hadde alt påkrevd og alt i
    # én kjøring — da spør PowerShell om seks verdier før den gjør noe, og den
    # som bare skal lenke på nytt må oppgi dem alle.
    [ValidateSet('alt', 'funcapp', 'swa', 'lenk')][string]$Trinn = 'alt',
    [switch]$Kjor
)

$ErrorActionPreference = 'Stop'

# Hvert trinn krever sitt. Sjekkes her framfor med [Parameter(Mandatory)], som
# ville spurt om alle seks uansett hvilket trinn du ba om.
$kreves = @{
    'funcapp' = @('FuncApp', 'Lagring', 'KeyVault', 'DataLagring', 'Identitet')
    'swa'     = @('Swa')
    'lenk'    = @('FuncApp', 'Swa')
}
$kreves['alt'] = ($kreves['funcapp'] + $kreves['swa'] + $kreves['lenk'] | Select-Object -Unique)

$mangler = $kreves[$Trinn] | Where-Object { -not (Get-Variable $_ -ValueOnly) }
if ($mangler) {
    Write-Error "Trinn '$Trinn' krever: -$($mangler -join ', -')"
}

if ($Lagring -and $DataLagring -and $Lagring -eq $DataLagring) {
    Write-Error @"
Lagring og DataLagring er den samme kontoen.
Function App-runtime skriver køer, låser og tilstandstabeller i Lagring.
Blandes de med dataene, havner driftsartefaktene i hver backup.
"@
}

if (-not $Kjor) {
    Write-Host "TØRRKJØRING - ingenting gjøres. Legg til -Kjor for å utføre.`n" -ForegroundColor Yellow
}

function Kjør-Az {
    param([string[]]$Argumenter)
    if ($Kjor) {
        Write-Host "-> az $($Argumenter -join ' ')" -ForegroundColor Cyan
        $svar = & az @Argumenter
        if ($LASTEXITCODE -ne 0) { throw "az feilet: $($Argumenter -join ' ')" }
        return $svar
    }
    Write-Host "   az $($Argumenter -join ' ')"
    return $null
}

if ($Trinn -in @('alt','funcapp')) {
Write-Host "== 1. Lagringskonto til Function App-runtime ==" -ForegroundColor Green
Kjør-Az @('storage','account','create','--name',$Lagring,'--resource-group',$Rg,
          '--location',$Sted,'--sku','Standard_LRS',
          '--allow-blob-public-access','false','--min-tls-version','TLS1_2') | Out-Null
}

if ($Trinn -in @('alt','funcapp')) {
Write-Host "`n== 2. Function App, Node 22, Linux ==" -ForegroundColor Green
Kjør-Az @('functionapp','create','--name',$FuncApp,'--resource-group',$Rg,
          '--storage-account',$Lagring,'--consumption-plan-location',$Sted,
          '--runtime','node','--runtime-version','22',
          '--functions-version','4','--os-type','Linux') | Out-Null
}

if ($Trinn -in @('alt','funcapp')) {
Write-Host "`n== 3. User-assigned managed identity og roller ==" -ForegroundColor Green
Write-Host "   (krever User Access Administrator eller Owner)"

# USER-ASSIGNED, ikke system-assigned. En system-assigned identitet dør med
# Function App-en: gjenskapes appen, får den ny oid og ny appId, og da er ALT
# som er håndgitt borte — storage-rollene, Key Vault-rollen, Graph-approllene,
# SharePoint-tilgangen per site, og oid i flytenes allow-liste. Flere av dem
# krever Cyberforsvaret for å settes opp på nytt.
Kjør-Az @('identity','create','--name',$Identitet,'--resource-group',$Rg,'--location',$Sted) | Out-Null

if ($Kjor) {
    $principal   = az identity show --name $Identitet --resource-group $Rg --query principalId -o tsv
    $klientId    = az identity show --name $Identitet --resource-group $Rg --query clientId -o tsv
    $identitetId = az identity show --name $Identitet --resource-group $Rg --query id -o tsv
    $sub = az account show --query id -o tsv
} else {
    $principal   = '<principalId>'
    $klientId    = '<clientId>'
    $identitetId = '<identitets-ressurs-id>'
    $sub = '<abonnements-id>'
}

Kjør-Az @('functionapp','identity','assign','--name',$FuncApp,'--resource-group',$Rg,
          '--identities',$identitetId) | Out-Null

# DefaultAzureCredential må få vite HVILKEN identitet den skal bruke. Uten
# denne prøver den system-assigned og feiler med en melding om at ingen
# identitet er tilgjengelig — som ser ut som at MI ikke er slått på.
#
# --output none er ikke pynt: uten den skriver kommandoen ut ALLE app settings
# på appen, STORAGE_CONNECTION_STRING inkludert.
Kjør-Az @('functionapp','config','appsettings','set','--name',$FuncApp,'--resource-group',$Rg,
          '--settings',"AZURE_CLIENT_ID=$klientId",'--output','none') | Out-Null

# Tre storage-roller, ikke to. Blob Delegator er den backup.js trenger for å
# lage en SAS uten kontonøkkel (getUserDelegationKey) — målt i 8f.
#
# Og MERK: ingen av disse er «Contributor». Den er en kontrollplan-rolle som
# ikke gir tilgang til en eneste tabellrad, og som i tillegg gir rett til å
# liste kontonøklene — full datatilgang gjennom en sidedør, med den delte
# nøkkelen hele øvelsen går ut på å fjerne.
foreach ($rolle in @('Storage Table Data Contributor','Storage Blob Data Contributor','Storage Blob Delegator')) {
    # --assignee-object-id, ikke --assignee: kortformen slår opp prinsipalen i
    # Graph først, og for managed identities feiler eller henger det oppslaget.
    Kjør-Az @('role','assignment','create','--assignee-object-id',$principal,
              '--assignee-principal-type','ServicePrincipal','--role',$rolle,
              '--scope',"/subscriptions/$sub/resourceGroups/$Rg/providers/Microsoft.Storage/storageAccounts/$DataLagring") | Out-Null
}
Kjør-Az @('role','assignment','create','--assignee-object-id',$principal,
          '--assignee-principal-type','ServicePrincipal','--role','Key Vault Secrets User',
          '--scope',"/subscriptions/$sub/resourceGroups/$Rg/providers/Microsoft.KeyVault/vaults/$KeyVault") | Out-Null
}

if ($Trinn -in @('alt','swa')) {
Write-Host "`n== 4. Prøve-SWA ==" -ForegroundColor Green
Write-Host "   Standard-planen er påkrevd: lenkede backends finnes ikke på Free."
Kjør-Az @('staticwebapp','create','--name',$Swa,'--resource-group',$Rg,
          '--location',$SwaSted,'--sku','Standard') | Out-Null
}

if ($Trinn -in @('alt','swa')) {
Write-Host "`n== 5. STOPP HER ==" -ForegroundColor Yellow
Write-Host @"
   SWA-en har ingen build ennå, og en SWA uten build ruter ingenting -
   heller ikke til en lenket backend. Lenker du nå, får du et oppsett der
   aktivitetsloggen sier at alt er i orden mens ingenting virker.

   Gjør dette først:

     1. Hent deploy-tokenet:
          az staticwebapp secrets list --name $Swa --resource-group $Rg ``
             --query "properties.apiKey" -o tsv

     2. Legg det i GitHub-secreten SWA_PROEVE_TOKEN.

     3. Kjør arbeidsflyten «Deploy innhold til prøve-SWA (steg 1)».

     4. BEKREFT at rota viser «Prøve-SWA», ikke Azure sin standardside:
          az staticwebapp environment list --name $Swa --resource-group $Rg ``
             --query "[].{Navn:name,Status:status}" -o table
        Status skal være Ready. Står den på Uploading, er deployen ikke
        ferdig, og lenking vil ikke hjelpe.

   Kjør deretter:  .\steg1-funcapp.ps1 -Rg $Rg -FuncApp $FuncApp -Swa $Swa -Trinn lenk -Kjor
"@

}

if ($Trinn -in @('alt','lenk')) {
Write-Host "`n== 6. Lenkingen (kjøres etter at innholdet er bekreftet) ==" -ForegroundColor Green

if ($Trinn -eq 'alt') {
    Write-Host "   HOPPES OVER i -Trinn alt: innholdet er ikke bekreftet ennå." -ForegroundColor Yellow
    Write-Host "   Kjør -Trinn lenk når miljøet står på Ready."
} else {
    # Rester fra en tidligere lenking blokkerer en ny, med meldingen
    # «Cannot link backend with a preexisting Azure Static Web Apps
    # configuration» — som ikke sier hvor restene ligger. De sitter i Easy
    # Auth på Function App-en, og blir stående også om SWA-en er slettet.
    Write-Host "   Fjerner eventuelle auth-rester fra en tidligere lenking..."
    Kjør-Az @('webapp','auth','update','-n',$FuncApp,'-g',$Rg,'--enabled','false') | Out-Null

    if ($Kjor) {
        $funcId = az functionapp show --name $FuncApp --resource-group $Rg --query id -o tsv
        $region = az functionapp show --name $FuncApp --resource-group $Rg --query location -o tsv
    } else {
        $funcId = '<Function App-ens resource id>'
        $region = $Sted
    }
    Kjør-Az @('staticwebapp','backends','link','-n',$Swa,'-g',$Rg,
              '--backend-resource-id',$funcId,'--backend-region',$region) | Out-Null
    Write-Host ""
    Write-Host "   Angre:  az staticwebapp backends unlink --name $Swa --resource-group $Rg"
}
}

Write-Host "`n== Prøven ==" -ForegroundColor Green
Write-Host @"
   Direkte mot Function App-en svarer 401 etter lenking. Det er riktig:
   lenkingen setter Easy Auth på den, og bare trafikk via SWA slipper inn.

   Alt skal derfor gjøres på SWA-URL-en:

     /api/ping uinnlogget    -> principal.headerMottatt = false
     /.auth/login/aad        -> logg inn
     /api/ping igjen         -> headerMottatt = true, harUpn = true

   Den siste linja er svaret. Skriv det inn i beslutningsnotatet med dato -
   et forsøk ingen har notert utfallet av, blir gjort på nytt om tre måneder.
"@
