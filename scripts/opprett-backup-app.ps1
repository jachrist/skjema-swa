<#
.SYNOPSIS
    Setter opp app-registreringen som skriver backup til SharePoint.

.DESCRIPTION
    Ett formål, minst mulig rettigheter. Skriptet er ment å leses før det
    kjøres — det er kort med vilje.

    DET SKRIPTET GJØR:
      1. Oppretter app-registreringen (eller finner den, hvis den finnes)
      2. Gir den Microsoft Graph-rollen «Sites.Selected» som applikasjons-
         rettighet, og administrator-samtykke for den
      3. Gir appen SKRIVETILGANG TIL ETT SHAREPOINT-OMRÅDE — det du oppgir
         med -Site, og ingen andre
      4. Lager en klienthemmelighet og skriver den ut én gang

    DET SKRIPTET IKKE GJØR:
      Rører ingen andre apper, områder eller brukere. Leser ingen data.
      Sletter ingenting. Lagrer ikke hemmeligheten noe sted.

    Hvorfor «Sites.Selected» og ikke «Files.ReadWrite.All»: den siste ville
    gitt appen skrivetilgang til alt innhold i hele tenanten. Sites.Selected
    gir i seg selv ingen tilgang i det hele tatt — først når området i steg 3
    er tildelt eksplisitt, kan appen skrive, og bare der.

    Skriptet er idempotent. Kjører du det om igjen, opprettes ingenting på
    nytt; det rapporterer bare hva som allerede er på plass. Unntaket er
    -NyHemmelighet, som alltid lager en ny (gamle står til de utløper).

.PARAMETER Site
    SharePoint-området backupen skal skrives til, f.eks.
    https://fhs.sharepoint.com/sites/Skjemasystem

.PARAMETER Navn
    Visningsnavn på app-registreringen. Standard: fhs-skjema-backup

.PARAMETER MaanederGyldig
    Levetid på klienthemmeligheten. Standard 12 måneder.

.PARAMETER Torrkjor
    Vis hva som ville blitt gjort, uten å endre noe.

.PARAMETER NyHemmelighet
    Lag en ny klienthemmelighet selv om appen finnes fra før.

.EXAMPLE
    .\opprett-backup-app.ps1 -Site https://fhs.sharepoint.com/sites/Skjemasystem -Torrkjor
    .\opprett-backup-app.ps1 -Site https://fhs.sharepoint.com/sites/Skjemasystem

.NOTES
    Krever modulen Microsoft.Graph og en pålogget bruker som kan:
      - opprette app-registreringer      (Application Administrator eller mer)
      - gi administrator-samtykke        (Privileged Role Administrator / Global)
      - tildele rettighet på et område   (SharePoint Administrator / Global)

    Installer én gang:  Install-Module Microsoft.Graph -Scope CurrentUser
    Kjører også i Azure Cloud Shell (PowerShell), der modulen er forhåndsinstallert.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Site,
    [string]$Navn = 'fhs-skjema-backup',
    [int]$MaanederGyldig = 12,
    [switch]$Torrkjor,
    [switch]$NyHemmelighet
)

$ErrorActionPreference = 'Stop'
$GRAPH_APP_ID = '00000003-0000-0000-c000-000000000000'
$RETTIGHET = 'Sites.Selected'

function Steg([string]$t) { Write-Host "`n── $t" -ForegroundColor Cyan }
function Ok([string]$t) { Write-Host "   $t" -ForegroundColor Green }
function Info([string]$t) { Write-Host "   $t" }
function Ville([string]$t) { Write-Host "   [tørrkjøring] $t" -ForegroundColor Yellow }

# ---------------------------------------------------------------- pålogging
Steg 'Kobler til Microsoft Graph'
$scopes = @('Application.ReadWrite.All', 'AppRoleAssignment.ReadWrite.All', 'Sites.FullControl.All')
Connect-MgGraph -Scopes $scopes -NoWelcome
$ctx = Get-MgContext
Info "Pålogget som $($ctx.Account) i tenant $($ctx.TenantId)"
if ($Torrkjor) { Write-Host "   TØRRKJØRING — ingenting endres" -ForegroundColor Yellow }

# ------------------------------------------------------- 1. appregistrering
Steg "1. App-registrering «$Navn»"
$app = Get-MgApplication -Filter "displayName eq '$Navn'" -ConsistencyLevel eventual -CountVariable c -ErrorAction SilentlyContinue | Select-Object -First 1
if ($app) {
    Ok "Finnes fra før — appId $($app.AppId)"
} elseif ($Torrkjor) {
    Ville "ville opprettet app-registreringen"
} else {
    # Ingen redirect-URI og ingen delegerte rettigheter: appen logger aldri
    # inn en bruker, den kjører som seg selv.
    $app = New-MgApplication -DisplayName $Navn -SignInAudience 'AzureADMyOrg'
    Ok "Opprettet — appId $($app.AppId)"
}

# Tjenestehovedobjektet er det rettigheter faktisk henger på.
$sp = $null
if ($app) {
    $sp = Get-MgServicePrincipal -Filter "appId eq '$($app.AppId)'" -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $sp -and -not $Torrkjor) {
        $sp = New-MgServicePrincipal -AppId $app.AppId
        Ok 'Opprettet tjenestehovedobjekt'
    }
}

# ------------------------------------------------------------ 2. rettighet
Steg "2. Graph-rettighet «$RETTIGHET» med administrator-samtykke"
$graphSp = Get-MgServicePrincipal -Filter "appId eq '$GRAPH_APP_ID'"
# Rolle-ID-en slås opp ved kjøring i stedet for å hardkodes — da feiler det
# tydelig hvis rettigheten ikke finnes som APPLIKASJONSrolle.
$rolle = $graphSp.AppRoles | Where-Object { $_.Value -eq $RETTIGHET -and $_.AllowedMemberTypes -contains 'Application' } | Select-Object -First 1
if (-not $rolle) { Write-Host "   Fant ikke applikasjonsrollen $RETTIGHET i Graph" -ForegroundColor Red; exit 1 }
Info "Rolle-ID: $($rolle.Id)"

if ($sp) {
    $alt = Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id -ErrorAction SilentlyContinue |
        Where-Object { $_.AppRoleId -eq $rolle.Id -and $_.ResourceId -eq $graphSp.Id }
    if ($alt) {
        Ok 'Allerede tildelt og samtykket'
    } elseif ($Torrkjor) {
        Ville "ville tildelt $RETTIGHET"
    } else {
        # En app-rolletildeling ER administrator-samtykket. Ingen egen
        # «Grant admin consent»-knapp i portalen er nødvendig etterpå.
        New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id `
            -PrincipalId $sp.Id -ResourceId $graphSp.Id -AppRoleId $rolle.Id | Out-Null
        Ok "Tildelt $RETTIGHET"
    }
} else {
    Ville "ville tildelt $RETTIGHET"
}

# -------------------------------------------------- 3. tilgang til området
Steg '3. Skrivetilgang til ETT SharePoint-område'
# Graph vil ha området som «vertsnavn:/sti», ikke som full URL.
$u = [Uri]$Site
$omraadeRef = "$($u.Host):$($u.AbsolutePath.TrimEnd('/'))"
Info "Område: $Site"

try {
    $omraade = Invoke-MgGraphRequest -Method GET -Uri "v1.0/sites/$omraadeRef"
} catch {
    Write-Host "   Fant ikke området — sjekk adressen" -ForegroundColor Red
    Write-Host "   $($_.Exception.Message)"
    exit 1
}
Info "Område-ID: $($omraade.id)"

$harAlt = $false
if ($app) {
    try {
        $eksisterende = Invoke-MgGraphRequest -Method GET -Uri "v1.0/sites/$($omraade.id)/permissions"
        $harAlt = @($eksisterende.value | Where-Object {
            ($_ | ConvertTo-Json -Depth 6 -Compress) -match [regex]::Escape($app.AppId)
        }).Count -gt 0
    } catch { $harAlt = $false }
}

if ($harAlt) {
    Ok 'Skriverett på området — allerede gitt'
} elseif ($Torrkjor -or -not $app) {
    Ville 'ville gitt appen skriverett på området'
} else {
    $kropp = @{
        roles = @('write')
        grantedToIdentities = @(@{ application = @{ id = $app.AppId; displayName = $Navn } })
    } | ConvertTo-Json -Depth 6
    Invoke-MgGraphRequest -Method POST -Uri "v1.0/sites/$($omraade.id)/permissions" `
        -Body $kropp -ContentType 'application/json' | Out-Null
    Ok 'Gitt skriverett — kun på dette området'
}

# ------------------------------------------------------- 4. hemmelighet
Steg '4. Klienthemmelighet'
$hemmelig = $null
$utloper = $null
if ($Torrkjor) {
    Ville "ville laget en hemmelighet med $MaanederGyldig måneders levetid"
} elseif (-not $NyHemmelighet -and $app.PasswordCredentials.Count -gt 0) {
    Ok "Appen har $($app.PasswordCredentials.Count) hemmelighet(er) fra før — bruk -NyHemmelighet for å lage en ny"
} else {
    $utloper = (Get-Date).AddMonths($MaanederGyldig)
    $ny = Add-MgApplicationPassword -ApplicationId $app.Id -PasswordCredential @{
        displayName = "backup $(Get-Date -Format 'yyyy-MM-dd')"
        endDateTime = $utloper
    }
    $hemmelig = $ny.SecretText
    Ok "Opprettet, utløper $($utloper.ToString('yyyy-MM-dd'))"
}

# ------------------------------------------------------------ oppsummering
Write-Host "`n$('═' * 68)" -ForegroundColor Cyan
Write-Host ' Verdier som skal inn i SWA Configuration' -ForegroundColor Cyan
Write-Host ('═' * 68) -ForegroundColor Cyan
Write-Host ""
Write-Host "  GRAPH_TENANT_ID           $($ctx.TenantId)"
Write-Host "  GRAPH_CLIENT_ID           $(if ($app) { $app.AppId } else { '(ikke opprettet — tørrkjøring)' })"
Write-Host "  BACKUP_SHAREPOINT_SITE    $Site"
Write-Host ""
Write-Host "  Valgfritt:"
Write-Host "  BACKUP_SHAREPOINT_BIBLIOTEK   bibliotekets navn, f.eks. Backup"
Write-Host "  BACKUP_SHAREPOINT_MAPPE       undermappe, f.eks. Skjemasystem/Backup"

if ($hemmelig) {
    Write-Host ""
    Write-Host "  GRAPH_CLIENT_SECRET" -ForegroundColor Yellow
    Write-Host "  $hemmelig" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  Vises bare denne ene gangen. Legg den i Key Vault og referer" -ForegroundColor Yellow
    Write-Host "  til den fra app-settingen — ikke lim den inn som ren tekst." -ForegroundColor Yellow
    Write-Host "  Utløpsdato $($utloper.ToString('yyyy-MM-dd')) bør registreres i" -ForegroundColor Yellow
    Write-Host "  Administrasjon → Nøkkelkalender, så varselet kommer i tide." -ForegroundColor Yellow
}
Write-Host ""
