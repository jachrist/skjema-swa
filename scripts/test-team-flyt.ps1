<#
.SYNOPSIS
    Kaller team-synk-flyten med en payload, slik API-et ville gjort det.

.DESCRIPTION
    Til å prøve ut PA-flyten før den kobles på (TODO 71). Skriptet bygger
    NØYAKTIG samme payload som api/src/lib/team-synk.js gjør, slik at det du
    tester er det flyten faktisk vil få.

    FLYTEN OPPDATERER TEAMET DESTRUKTIVT. Den melder ut alle som ikke står i
    -Medlemmer. Bruk et testteam til dette, ikke et ekte.

    Skriptet gjør derfor tre ting for å gjøre feil vanskelig:

      1. Det viser payloaden og ber om bekreftelse før noe sendes. -Force
         hopper over spørsmålet — bruk den bare i en kjøring du har prøvd før.
      2. Det nekter en tom -Medlemmer-liste, som API-et også gjør. En tom
         liste ville meldt ut alle.
      3. -TorrKjor viser payloaden og sender ingenting.

    Flyt-URL-en inneholder en signatur og er en hemmelighet. Skriptet tar den
    fra miljøvariabelen TEAM_FLOW_URL hvis den finnes, ellers spør det. Den
    skal ikke skrives inn på kommandolinja — den havner i PowerShell-historikken.

.PARAMETER Team
    Teamnavn eller gruppe-ID (GUID). Ser verdien ut som en GUID, sendes den
    som TeamId, ellers som TeamNavn — samme regel som i team-synk.js.

.PARAMETER Medlemmer
    UPN-ene som skal være medlemmer ETTER kjøringen. Alle andre meldes ut.

.PARAMETER Rolle
    Rollenavnet payloaden skal si at lista kommer fra. Standard: Publikum.

.PARAMETER Omfang
    Omfanget. Standard: TEST.

.PARAMETER Miljo
    Miljøfeltet i payloaden. Standard: pilot.

.PARAMETER TorrKjor
    Bygg og vis payloaden, men send ingenting.

.PARAMETER Force
    Ikke spør om bekreftelse.

.EXAMPLE
    ./test-team-flyt.ps1 -Team "Test FFT" -Medlemmer ola@mil.no,kari@mil.no -TorrKjor

    Viser payloaden uten å sende den.

.EXAMPLE
    $env:TEAM_FLOW_URL = "https://prod-00.westeurope.logic.azure.com/..."
    ./test-team-flyt.ps1 -Team 3fa85f64-5717-4562-b3fc-2c963f66afa6 -Medlemmer ola@mil.no

    Sender for ekte. Alle andre enn ola@mil.no meldes ut av teamet.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Team,

    [Parameter(Mandatory = $true)]
    [string[]]$Medlemmer,

    [string]$Rolle = 'Publikum',
    [string]$Omfang = 'TEST',
    [string]$Miljo = 'pilot',
    [switch]$TorrKjor,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

# ---- medlemslista, samme behandling som upnListe() i team-synk.js ----
# Små bokstaver, uten duplikater, sortert. Ikke kosmetikk: to skrivemåter av
# samme person ville blåst opp antallet, og flyten bør få det samme som
# produksjon sender.
$upner = @($Medlemmer |
    ForEach-Object { $_.Trim().ToLowerInvariant() } |
    Where-Object { $_ } |
    Sort-Object -Unique)

if ($upner.Count -eq 0) {
    throw 'Tom medlemsliste. API-et sender aldri en tom liste — den ville meldt ut alle i teamet.'
}

# ---- teamets identitet, samme regel som teamIdentitet() ----
$erGuid = $Team -match '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

# Regnes ut før hashtabellen: `if` som verdi rett i en hashtabell-literal er
# ikke noe man skal stole på på tvers av PowerShell-versjoner.
$teamId = ''
$teamNavn = $Team
if ($erGuid) { $teamId = $Team; $teamNavn = '' }

$payload = [ordered]@{
    Handling  = 'synkroniserTeamDestruktivt'
    TeamId    = $teamId
    TeamNavn  = $teamNavn
    Rolle     = $Rolle
    Omfang    = $Omfang
    Medlemmer = $upner
    Antall    = $upner.Count
    Miljo     = $Miljo
    Tidspunkt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
}

# -Depth: uten den klipper ConvertTo-Json nøstede strukturer på nivå 2 og
# skriver «System.Object[]» i stedet for lista.
$json = $payload | ConvertTo-Json -Depth 5

Write-Host ''
Write-Host 'Payload:' -ForegroundColor Cyan
Write-Host $json
Write-Host ''

if ($TorrKjor) {
    Write-Host 'Tørrkjøring — ingenting ble sendt.' -ForegroundColor Yellow
    return
}

# ---- hemmelighetene ----
$url = $env:TEAM_FLOW_URL
if (-not $url) {
    # Read-Host, ikke en parameter: det er PARAMETERE som havner i
    # kommandohistorikken, ikke det man skriver inn på et spørsmål.
    $url = Read-Host -Prompt 'TEAM_FLOW_URL'
}
if (-not $url) { throw 'Ingen flyt-URL oppgitt.' }

$headere = @{ 'Content-Type' = 'application/json' }
if ($env:FLOW_CALLBACK_KEY) { $headere['x-flow-key'] = $env:FLOW_CALLBACK_KEY }

# ---- bekreftelse ----
$hvem = if ($erGuid) { "gruppe-ID $Team" } else { "teamet «$Team»" }
if (-not $Force) {
    Write-Host "Dette kaller flyten for ekte mot $hvem." -ForegroundColor Yellow
    Write-Host "Alle medlemmer som IKKE står i lista over blir meldt ut." -ForegroundColor Yellow
    $bekreftelse = Read-Host 'Skriv SEND for å fortsette'
    if ($bekreftelse -ne 'SEND') {
        Write-Host 'Avbrutt.' -ForegroundColor Yellow
        return
    }
}

Write-Host "Sender $($upner.Count) medlem(mer) …" -ForegroundColor Cyan
try {
    $svar = Invoke-WebRequest -Uri $url -Method Post -Headers $headere `
        -Body ([Text.Encoding]::UTF8.GetBytes($json)) -UseBasicParsing
    Write-Host "HTTP $($svar.StatusCode)" -ForegroundColor Green
    if ($svar.Content) { Write-Host $svar.Content }
}
catch {
    # Flyten svarer ofte med en forklaring i kroppen. Uten dette ser man bare
    # «(400) Bad Request» og må gjette.
    #
    # Kroppen ligger ulike steder: PowerShell 7 legger den i ErrorDetails,
    # Windows PowerShell 5.1 i responsstrømmen. Begge prøves.
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
        Write-Host $_.ErrorDetails.Message -ForegroundColor Red
    }
    elseif ($_.Exception.Response) {
        try {
            $strom = New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())
            Write-Host $strom.ReadToEnd() -ForegroundColor Red
        }
        catch { }
    }
    throw
}
