<#
.SYNOPSIS
    Oppretter de syntetiske testbrukerne fra brukere.json i Entra ID.

.DESCRIPTION
    Rolle- og teamlogikken kan ikke testes med én bruker. Dette skriptet lager
    kontoene som befolker rollene og de syntetiske teamene i dev-tenanten.

    Alle brukerne legges i en sikkerhetsgruppe (standard: FHS-Testbrukere).
    Grunnen er MFA: kravet kan ikke slås av per bruker, bare via Security
    Defaults eller en betinget tilgang-policy. Med en gruppe blir unntaket én
    operasjon i stedet for femti — og opprydding likeså.

    Skriptet er idempotent. Kjør det om igjen; brukere som finnes hoppes over.

.PARAMETER Passord
    Felles passord for alle testbrukerne. Utelates det, spørres det om.
    Passordet vises aldri i klartekst og lagres ingen steder.

.PARAMETER Gruppe
    Sikkerhetsgruppa testbrukerne legges i. Opprettes hvis den ikke finnes.

.PARAMETER Torrkjor
    Vis hva som ville blitt gjort, uten å endre noe.

.PARAMETER Fjern
    Slett testbrukerne og gruppa igjen. Femti kontoer du ikke blir kvitt er
    et problem i seg selv.

.EXAMPLE
    .\opprett-testbrukere.ps1 -Torrkjor
    .\opprett-testbrukere.ps1
    .\opprett-testbrukere.ps1 -Fjern

.NOTES
    Krever Microsoft.Graph-modulen og en konto som kan opprette brukere og
    grupper — User Administrator eller Global Administrator.

    Brukerne trenger ingen lisens. De skal befolke roller og den syntetiske
    team-cachen i skjemaløsningen, ikke brukes i Teams eller e-post.
#>
[CmdletBinding()]
param(
    [securestring]$Passord,
    [string]$Gruppe = 'FHS-Testbrukere',
    [string]$BrukerFil = (Join-Path $PSScriptRoot 'brukere.json'),
    [switch]$Torrkjor,
    [switch]$Fjern
)

$ErrorActionPreference = 'Stop'

function Skriv-Steg  { param([string]$T) Write-Host "  $T" }
function Skriv-Ok    { param([string]$T) Write-Host "  $T" -ForegroundColor Green }
function Skriv-Hopp  { param([string]$T) Write-Host "  $T" -ForegroundColor DarkGray }
function Skriv-Advar { param([string]$T) Write-Host "  $T" -ForegroundColor Yellow }
function Skriv-Tittel {
    param([string]$T)
    Write-Host ""
    Write-Host "── $T $('─' * [Math]::Max(0, 58 - $T.Length))" -ForegroundColor Cyan
}

# ---------- forutsetninger ----------
if (-not (Get-Module -ListAvailable -Name Microsoft.Graph.Users)) {
    Write-Host "Microsoft.Graph-modulen mangler. Installer den med:" -ForegroundColor Red
    Write-Host "  Install-Module Microsoft.Graph -Scope CurrentUser"
    exit 1
}
if (-not (Test-Path $BrukerFil)) {
    Write-Host "Fant ikke $BrukerFil. Kjør 'node testdata/generer.js' først." -ForegroundColor Red
    exit 1
}

$brukere = Get-Content $BrukerFil -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $brukere -or $brukere.Count -eq 0) {
    Write-Host "Brukerlista er tom." -ForegroundColor Red
    exit 1
}

Import-Module Microsoft.Graph.Users, Microsoft.Graph.Groups -ErrorAction Stop
Connect-MgGraph -Scopes 'User.ReadWrite.All', 'Group.ReadWrite.All' -NoWelcome

$kontekst = Get-MgContext
Skriv-Tittel 'Tenant'
Skriv-Steg "Innlogget som : $($kontekst.Account)"
Skriv-Steg "Tenant        : $($kontekst.TenantId)"
Skriv-Steg "Brukere i fila : $($brukere.Count)"
if ($Torrkjor) { Skriv-Advar 'TØRRKJØRING — ingenting endres' }

# Domenet i UPN-ene må være verifisert i tenanten, ellers avvises hver eneste
# oppretting med en melding som ikke sier hvorfor.
$domene = ($brukere[0].UPN -split '@')[1]
$verifiserte = (Get-MgDomain -ErrorAction SilentlyContinue | Where-Object { $_.IsVerified }).Id
if ($verifiserte -and $domene -notin $verifiserte) {
    Write-Host ""
    Write-Host "Domenet '$domene' er ikke verifisert i denne tenanten." -ForegroundColor Red
    Write-Host "  Verifiserte domener: $($verifiserte -join ', ')"
    Write-Host "  Endre domenet i generer.js og kjør den på nytt, eller verifiser domenet."
    exit 1
}

# ---------- fjerning ----------
if ($Fjern) {
    Skriv-Tittel 'Fjerner testbrukere'
    $slettet = 0
    foreach ($b in $brukere) {
        $finnes = Get-MgUser -Filter "userPrincipalName eq '$($b.UPN)'" -ErrorAction SilentlyContinue
        if (-not $finnes) { Skriv-Hopp "$($b.UPN) — finnes ikke"; continue }
        if ($Torrkjor) { Skriv-Advar "[tørrkjøring] ville slettet $($b.UPN)"; continue }
        Remove-MgUser -UserId $finnes.Id -Confirm:$false
        Skriv-Ok "$($b.UPN) — slettet"
        $slettet++
    }
    $g = Get-MgGroup -Filter "displayName eq '$Gruppe'" -ErrorAction SilentlyContinue
    if ($g -and -not $Torrkjor) {
        Remove-MgGroup -GroupId $g.Id -Confirm:$false
        Skriv-Ok "Gruppa $Gruppe — slettet"
    }
    Write-Host ""
    Write-Host "Ferdig. $slettet bruker(e) slettet." -ForegroundColor Green
    Write-Host "Merk: slettede kontoer ligger 30 dager i papirkurven før de fjernes permanent."
    exit 0
}

# ---------- passord ----------
if (-not $Passord) {
    Write-Host ""
    $Passord = Read-Host -AsSecureString "Felles passord for testbrukerne"
}
$klartekst = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Passord))
if ($klartekst.Length -lt 8) {
    Write-Host "Passordet er for kort — Entra krever minst 8 tegn." -ForegroundColor Red
    exit 1
}

# ---------- gruppe ----------
Skriv-Tittel "Gruppe: $Gruppe"
$gruppeObj = Get-MgGroup -Filter "displayName eq '$Gruppe'" -ErrorAction SilentlyContinue
if ($gruppeObj) {
    Skriv-Hopp "Finnes fra før ($($gruppeObj.Id))"
} elseif ($Torrkjor) {
    Skriv-Advar "[tørrkjøring] ville opprettet gruppa"
} else {
    $gruppeObj = New-MgGroup -DisplayName $Gruppe `
        -MailEnabled:$false -MailNickname ($Gruppe -replace '[^a-zA-Z0-9]', '') `
        -SecurityEnabled:$true `
        -Description 'Syntetiske testbrukere for skjemaløsningen. Ingen ekte personer.'
    Skriv-Ok "Opprettet ($($gruppeObj.Id))"
}

# ---------- brukere ----------
Skriv-Tittel 'Brukere'
$opprettet = 0; $fantes = 0; $lagtIGruppe = 0

foreach ($b in $brukere) {
    $finnes = Get-MgUser -Filter "userPrincipalName eq '$($b.UPN)'" -ErrorAction SilentlyContinue
    if ($finnes) {
        Skriv-Hopp "$($b.UPN) — finnes fra før"
        $fantes++
    } elseif ($Torrkjor) {
        Skriv-Advar "[tørrkjøring] ville opprettet $($b.UPN) ($($b.Navn))"
        continue
    } else {
        # ForceChangePasswordNextSignIn = $false: hensikten er å kunne logge inn
        # som hvem som helst av dem uten en passordbytte-runde først.
        $profil = @{
            Password                      = $klartekst
            ForceChangePasswordNextSignIn = $false
        }
        $finnes = New-MgUser -UserPrincipalName $b.UPN `
            -DisplayName $b.Navn `
            -GivenName $b.Fornavn `
            -Surname $b.Etternavn `
            -MailNickname (($b.UPN -split '@')[0]) `
            -AccountEnabled:$true `
            -UsageLocation 'NO' `
            -PasswordProfile $profil
        Skriv-Ok "$($b.UPN) — opprettet"
        $opprettet++
    }

    if ($gruppeObj -and -not $Torrkjor) {
        $erMedlem = Get-MgGroupMember -GroupId $gruppeObj.Id -Filter "id eq '$($finnes.Id)'" -ErrorAction SilentlyContinue
        if (-not $erMedlem) {
            New-MgGroupMember -GroupId $gruppeObj.Id -DirectoryObjectId $finnes.Id
            $lagtIGruppe++
        }
    }
}

$klartekst = $null

# ---------- oppsummering ----------
Skriv-Tittel 'Oppsummering'
Skriv-Steg "Opprettet     : $opprettet"
Skriv-Steg "Fantes fra før: $fantes"
Skriv-Steg "Lagt i gruppa : $lagtIGruppe"

if (-not $Torrkjor) {
    Write-Host ""
    Write-Host "── Gjenstår manuelt $('─' * 42)" -ForegroundColor Cyan
    Write-Host @"
  MFA kan ikke slås av per bruker. Velg én av disse, én gang, for gruppa
  '$Gruppe':

  a) Har tenanten Security Defaults på, må de skrus av for at
     passordinnlogging skal virke i det hele tatt. Det gjelder HELE tenanten,
     også din egen konto — vurder heller (b).

  b) Betinget tilgang: lag en policy som krever MFA for alle, og EKSKLUDER
     '$Gruppe'. Da beholder du kravet der det betyr noe.

  Entra ID → Protection → Conditional Access.

  Testbrukerne har ingen lisens, og trenger det ikke — de skal befolke roller
  og team-cachen i skjemaløsningen, ikke brukes i Teams eller e-post.

  Rydd opp med:  .\opprett-testbrukere.ps1 -Fjern
"@
}
