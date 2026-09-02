<#
.SYNOPSIS
    Laster de syntetiske teamene inn i team-cachen.

.DESCRIPTION
    team.json er allerede i det formatet /api/cache/teammedlemskap forventer,
    så dette skriptet gjør lite annet enn å sende den — men det sparer deg for
    å bygge kallet for hånd hver gang testdataene skal på plass i et miljø.

    Endepunktet godtar x-flow-key, som er den samme nøkkelen PA-flytene bruker
    når de oppdaterer team-cachen. Derfor trengs ingen innlogging.

    Rollene kan IKKE lastes på samme måte: rolle-endepunktene krever en
    innlogget administrator, ikke en flyt-nøkkel. Bruk
    Administrasjon → Roller → Importer med testdata/roller.csv.

.PARAMETER Url
    Adressen til miljøet, f.eks. https://ashy-meadow-0f2a44503.7.azurestaticapps.net

.PARAMETER FlowKey
    Verdien av FLOW_CALLBACK_KEY i miljøet. Spørres om hvis den utelates.

.PARAMETER Torrkjor
    Vis hva som ville blitt sendt, uten å sende det.

.EXAMPLE
    .\last-inn-team.ps1 -Url https://ashy-meadow-0f2a44503.7.azurestaticapps.net -Torrkjor
    .\last-inn-team.ps1 -Url https://ashy-meadow-0f2a44503.7.azurestaticapps.net
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Url,
    [securestring]$FlowKey,
    [string]$TeamFil = (Join-Path $PSScriptRoot 'team.json'),
    [switch]$Torrkjor
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $TeamFil)) {
    Write-Host "Fant ikke $TeamFil. Kjør 'node testdata/generer.js' først." -ForegroundColor Red
    exit 1
}

$data = Get-Content $TeamFil -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $data.grupper) {
    Write-Host "Fila mangler 'grupper'." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "── Team som lastes $('─' * 44)" -ForegroundColor Cyan
foreach ($g in $data.grupper) {
    "  {0} {1} medlemmer" -f $g.Team.PadRight(26), $g.Medlemmer.Count | Write-Host
}
$totalt = ($data.grupper | ForEach-Object { $_.Medlemmer.Count } | Measure-Object -Sum).Sum
Write-Host "  $($data.grupper.Count) team, $totalt medlemskap"

$mal = "$($Url.TrimEnd('/'))/api/cache/teammedlemskap"
Write-Host ""
Write-Host "  Mål: $mal"

if ($Torrkjor) {
    Write-Host ""
    Write-Host "  TØRRKJØRING — ingenting sendes" -ForegroundColor Yellow
    exit 0
}

if (-not $FlowKey) {
    Write-Host ""
    $FlowKey = Read-Host -AsSecureString "FLOW_CALLBACK_KEY for dette miljøet"
}
$nokkel = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($FlowKey))

# Endepunktet erstatter medlemslista per team, så kallet er idempotent — kjør
# det om igjen uten å få duplikater.
$kropp = $data | ConvertTo-Json -Depth 6 -Compress
try {
    $svar = Invoke-RestMethod -Uri $mal -Method Post `
        -Headers @{ 'x-flow-key' = $nokkel } `
        -ContentType 'application/json; charset=utf-8' `
        -Body ([Text.Encoding]::UTF8.GetBytes($kropp))
} catch {
    Write-Host ""
    Write-Host "Feilet: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.ErrorDetails.Message) { Write-Host "  $($_.ErrorDetails.Message)" }
    Write-Host ""
    Write-Host "  401 betyr som regel feil eller manglende FLOW_CALLBACK_KEY."
    Write-Host "  404 betyr at miljøet ikke har den nye koden ennå."
    exit 1
} finally {
    $nokkel = $null
}

Write-Host ""
Write-Host "  Svar: $($svar.antallTeam) team oppdatert" -ForegroundColor Green
Write-Host ""
Write-Host "── Roller $('─' * 51)" -ForegroundColor Cyan
Write-Host @"
  Rollene kan ikke lastes herfra — rolle-endepunktene krever en innlogget
  administrator, ikke en flyt-nøkkel.

  Administrasjon → 👥 Roller → 📥 Importer → velg testdata/roller.csv

  Importen eier bare rader med Kilde='import', så manuelt innlagte
  innehavere står urørt. Den kan trygt kjøres om igjen.
"@
