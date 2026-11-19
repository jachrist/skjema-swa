<#
.SYNOPSIS
    Oppretter en utsending til noen få testmottakere og sender den med en
    gang — og purrer den, om du vil. For å prøve e-post via Graph i dev.

.DESCRIPTION
    Gjør det en flyt ellers gjør, i tre kall mot API-et:

      1. POST /api/utsending                — oppretter batchen (x-flow-key)
      2. POST /api/utsending/send-forfalte  — sender den nå (x-scheduler-key)
      3. POST /api/utsending/purre          — purrer den nå, med -Purr

    Batchen får utsendingsdato i dag, så sendejobben plukker den opp med en
    gang. Med -Purr får den også purredato i dag, så purringen kan prøves
    uten å vente. Hvilken vei e-posten går — Graph eller flyten — avgjøres av
    EPOST_VEI på Function App-en, ikke av skriptet.

    Nøklene hentes fra Key Vault med az og holdes i variabler. De skrives
    aldri ut, og slettes til slutt. Har du ikke tilgang til vaulten, spør
    skriptet om dem i stedet (skjult inntasting).

    Skjematypen må ha «Ekstern innsender» på — ellers avviser API-et
    utsendingen. Mottakerne får ekte e-post.

    Virker i Windows PowerShell 5.1 og i PowerShell 7 (Cloud Shell). Bruker
    derfor verken «??» eller -SkipHttpErrorCheck, som 5.1 ikke kjenner — og
    hele fila tolkes før første linje kjøres, så en versjonssjekk hjelper ikke.

.PARAMETER SkjematypeId
    Skjematypen som sendes ut. Må ha Ekstern innsender på.

.PARAMETER Mottakere
    E-postadressene. Skriptet stopper før noe sendes hvis én av dem ikke ser
    ut som en adresse.

.PARAMETER Base
    Adressen til miljøet. Standard er v3-dev.

.PARAMETER Vault
    Key Vault-en nøklene hentes fra. Standard er dev sin.

.PARAMETER Purretekst
    Teksten i purringen. Tom gir standardteksten.

.PARAMETER Purr
    Purr batchen rett etter at den er sendt.

.PARAMETER TorrKjor
    Vis hva som ville blitt sendt til API-et, og gjør ingenting.

.EXAMPLE
    ./scripts/test-utsending.ps1 -SkjematypeId 108 -Mottakere innsender1@<domene>, innsender2@<domene>

.EXAMPLE
    ./scripts/test-utsending.ps1 -SkjematypeId 108 -Mottakere jan@<domene> -Purr -Purretekst "Husk å svare!"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $SkjematypeId,
    [Parameter(Mandatory)] [string[]] $Mottakere,
    [string] $Base = 'https://dev.v3.fskjema.no',
    [string] $Vault = 'kv-skjema-3-dev',
    [string] $Purretekst = '',
    [switch] $Purr,
    [switch] $TorrKjor
)

$ErrorActionPreference = 'Stop'

# Verdien, eller en reserve når den er tom. Erstatter «??», som 5.1 ikke har.
function Eller($verdi, $reserve) {
    if ($null -ne $verdi -and "$verdi" -ne '') { return $verdi }
    return $reserve
}

# ---------- mottakerne ----------
$ugyldige = @($Mottakere | Where-Object { $_ -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$' })
if ($ugyldige.Count -gt 0) {
    throw "Ugyldige adresser — ingenting er sendt: $($ugyldige -join ', ')"
}
$Base = $Base.TrimEnd('/')

# ---------- batchen ----------
$idag = (Get-Date).ToString('yyyy-MM-dd')
$batchId = 'test-' + (Get-Date).ToString('yyyyMMdd-HHmmss')
$kropp = [ordered]@{
    skjematypeId    = $SkjematypeId
    batchId         = $batchId
    utsendingsdato  = $idag
    avslutningsdato = (Get-Date).AddDays(14).ToString('yyyy-MM-dd')
    mottakere       = @($Mottakere | ForEach-Object { @{ mottaker = $_.Trim().ToLower() } })
}
if ($Purr) { $kropp.purredato = $idag }
if ($Purretekst) { $kropp.purretekst = $Purretekst }

Write-Host "Miljø:      $Base"
Write-Host "Skjematype: $SkjematypeId"
Write-Host "Batch:      $batchId"
Write-Host "Mottakere:  $($Mottakere -join ', ')"
if ($TorrKjor) {
    Write-Host ''
    Write-Host 'TØRRKJØRING — dette ville blitt sendt til POST /api/utsending:'
    $kropp | ConvertTo-Json -Depth 5
    return
}

# ---------- nøklene ----------
function Hent-Nokkel([string] $secret, [string] $navn) {
    $verdi = $null
    try {
        $verdi = az keyvault secret show --vault-name $Vault --name $secret --query value -o tsv 2>$null
    } catch { $verdi = $null }
    if (-not $verdi) {
        Write-Host "Fikk ikke $navn fra $Vault. Lim den inn (vises ikke):"
        $sikker = Read-Host -AsSecureString
        $verdi = [System.Net.NetworkCredential]::new('', $sikker).Password
    }
    if (-not $verdi) { throw "$navn mangler — ingenting er sendt." }
    return $verdi.Trim()
}

$flytNokkel = Hent-Nokkel 'flow-callback-key' 'FLOW_CALLBACK_KEY'
$planNokkel = Hent-Nokkel 'scheduler-key' 'SCHEDULER_KEY'

function Vis-Utfall($svar, [string] $antallFelt) {
    $d = $svar.Data
    Write-Host "   HTTP $($svar.Status), $($antallFelt): $(Eller $d.$antallFelt 0) av $(Eller $d.antallKandidater '?') kandidater"
    if ($d.gjenstaar -gt 0) {
        Write-Host "   $($d.gjenstaar) gjenstår til neste kjøring (høyst 25 per kjøring via Graph). Kjør jobben igjen fra Administrasjon → Jobber." -ForegroundColor Yellow
    }
    if ($d.feil) { Write-Host "   Feil: $($d.feil)" -ForegroundColor Red }
    if ($d.melding) { Write-Host "   $($d.melding)" }
}

function Kall([string] $sti, [hashtable] $headere, $innhold) {
    $json = $innhold | ConvertTo-Json -Depth 5
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $status = 0
    $tekst = ''
    try {
        $svar = Invoke-WebRequest -Uri "$Base$sti" -Method Post -Headers $headere -ContentType 'application/json; charset=utf-8' -Body $bytes -UseBasicParsing
        $status = [int]$svar.StatusCode
        # Lest som UTF-8 fra bytene: 5.1 gjetter ellers feil tegnsett, og
        # æ, ø og å i meldingene blir til rot.
        $tekst = [System.Text.Encoding]::UTF8.GetString($svar.RawContentStream.ToArray())
    } catch {
        # Et svar med feilkode kaster i begge versjoner. Svaret er likevel
        # det vi vil se — meldingen fra API-et sier hvorfor.
        $resp = $_.Exception.Response
        if (-not $resp) { throw }
        $status = [int]$resp.StatusCode
        $tekst = $_.ErrorDetails.Message
        if (-not $tekst) {
            try { $tekst = (New-Object System.IO.StreamReader($resp.GetResponseStream())).ReadToEnd() } catch { $tekst = '' }
        }
    }
    $data = $null
    try { $data = $tekst | ConvertFrom-Json } catch { $data = $tekst }
    return [pscustomobject]@{ Status = $status; Data = $data }
}

try {
    # ---------- 1. opprett ----------
    Write-Host ''
    Write-Host '1. Oppretter utsendingen ...'
    $r = Kall '/api/utsending' @{ 'x-flow-key' = $flytNokkel } $kropp
    if ($r.Status -ne 200) {
        Write-Host "   Avvist ($($r.Status)): $(Eller $r.Data.melding $r.Data)" -ForegroundColor Red
        return
    }
    # Lenkene er personlige — bare mottaker og utløp skrives ut.
    foreach ($l in @($r.Data.lenker)) { Write-Host "   $($l.mottaker)  (lenka utløper $($l.utloper))" }
    Write-Host "   Sendes av appen: $($r.Data.sendesAvAppen)"

    # ---------- 2. send ----------
    Write-Host ''
    Write-Host '2. Sender nå ...'
    $s = Kall '/api/utsending/send-forfalte' @{ 'x-scheduler-key' = $planNokkel } @{ batchId = $batchId }
    Vis-Utfall $s 'antallSendt'

    # ---------- 3. purr ----------
    if ($Purr) {
        Write-Host '3. Purrer nå ...'
        $p = Kall '/api/utsending/purre' @{ 'x-scheduler-key' = $planNokkel } @{ batchId = $batchId }
        Vis-Utfall $p 'antallPurret'
    }

    Write-Host "Ferdig. Status per mottaker: Administrasjon → Utsendinger, batch $batchId."
    Write-Host 'Hvilken vei e-posten gikk, står i Hendelser (vei: graph) og på systemsiden (epostVei).'
}
finally {
    Remove-Variable flytNokkel, planNokkel -ErrorAction SilentlyContinue
}
