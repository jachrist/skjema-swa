<#
.SYNOPSIS
    Steg 1 i docs/BESLUTNING-EGEN-FUNCTION-APP.md — oppretter prøveoppsettet
    som svarer på ett spørsmål: sender SWA x-ms-client-principal videre til en
    lenket backend?

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
      3. Slår på managed identity og tildeler rollene den trenger
      4. Oppretter prøve-SWA-en (Standard — lenkede backends finnes ikke på Free)
      5. STOPPER, og ber deg deploye innhold og bekrefte at det vises
      6. Lenker Function App-en til SWA-en

    DET SKRIPTET IKKE GJØR:
      Rører ingenting i pilot eller prod. Setter ingen hemmeligheter.
      Sletter ingenting.

.PARAMETER Kjor
    Uten denne tørrkjører skriptet og viser bare hva det ville gjort.

.EXAMPLE
    .\steg1-funcapp.ps1 -Rg FHS-skjema -FuncApp testfapp -Lagring fastate01 `
        -Swa swa-funcapp-proeve -KeyVault kv-fhsskjema-pilot -DataLagring <konto>
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Rg,
    [Parameter(Mandatory)][string]$FuncApp,
    [Parameter(Mandatory)][string]$Lagring,
    [Parameter(Mandatory)][string]$Swa,
    [Parameter(Mandatory)][string]$KeyVault,
    [Parameter(Mandatory)][string]$DataLagring,
    [string]$Sted = 'norwayeast',
    [string]$SwaSted = 'westeurope',
    [switch]$Kjor
)

$ErrorActionPreference = 'Stop'

if ($Lagring -eq $DataLagring) {
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

Write-Host "== 1. Lagringskonto til Function App-runtime ==" -ForegroundColor Green
Kjør-Az @('storage','account','create','--name',$Lagring,'--resource-group',$Rg,
          '--location',$Sted,'--sku','Standard_LRS',
          '--allow-blob-public-access','false','--min-tls-version','TLS1_2') | Out-Null

Write-Host "`n== 2. Function App, Node 22, Linux ==" -ForegroundColor Green
Kjør-Az @('functionapp','create','--name',$FuncApp,'--resource-group',$Rg,
          '--storage-account',$Lagring,'--consumption-plan-location',$Sted,
          '--runtime','node','--runtime-version','22',
          '--functions-version','4','--os-type','Linux') | Out-Null

Write-Host "`n== 3. Managed identity og roller ==" -ForegroundColor Green
Write-Host "   (krever User Access Administrator eller Owner)"
Kjør-Az @('functionapp','identity','assign','--name',$FuncApp,'--resource-group',$Rg) | Out-Null

if ($Kjor) {
    $principal = az functionapp identity show --name $FuncApp --resource-group $Rg --query principalId -o tsv
    $sub = az account show --query id -o tsv
} else {
    $principal = '<principalId>'
    $sub = '<abonnements-id>'
}
foreach ($rolle in @('Storage Table Data Contributor','Storage Blob Data Contributor')) {
    Kjør-Az @('role','assignment','create','--assignee',$principal,'--role',$rolle,
              '--scope',"/subscriptions/$sub/resourceGroups/$Rg/providers/Microsoft.Storage/storageAccounts/$DataLagring") | Out-Null
}
Kjør-Az @('role','assignment','create','--assignee',$principal,'--role','Key Vault Secrets User',
          '--scope',"/subscriptions/$sub/resourceGroups/$Rg/providers/Microsoft.KeyVault/vaults/$KeyVault") | Out-Null

Write-Host "`n== 4. Prøve-SWA ==" -ForegroundColor Green
Write-Host "   Standard-planen er påkrevd: lenkede backends finnes ikke på Free."
Kjør-Az @('staticwebapp','create','--name',$Swa,'--resource-group',$Rg,
          '--location',$SwaSted,'--sku','Standard') | Out-Null

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

   Kjør deretter dette skriptet på nytt med -BareLenk.
"@

Write-Host "`n== 6. Lenkingen (kjøres etter at innholdet er bekreftet) ==" -ForegroundColor Green
if ($Kjor) {
    $funcId = az functionapp show --name $FuncApp --resource-group $Rg --query id -o tsv
} else {
    $funcId = '<Function App-ens resource id>'
}
Write-Host "   az staticwebapp backends link --name $Swa --resource-group $Rg ``"
Write-Host "      --backend-resource-id $funcId --backend-region $Sted"
Write-Host ""
Write-Host "   Angre:  az staticwebapp backends unlink --name $Swa --resource-group $Rg"

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
