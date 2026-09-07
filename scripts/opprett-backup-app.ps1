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

.PARAMETER KeyVault
    Valgfritt. Navnet på en Key Vault hemmeligheten skal skrives rett inn i,
    f.eks. fhs-kv-01. Oppgis den, vises hemmeligheten aldri på skjermen — du
    får en ferdig `@Microsoft.KeyVault(...)`-referanse i stedet.

    Krever modulen Az.KeyVault og skriverett i vaulten (rollen «Key Vault
    Secrets Officer»). Er det en annen person enn den som kjører resten, la
    parameteren stå tom: da skrives hemmeligheten ut som før.

.PARAMETER HemmelighetNavn
    Navnet hemmeligheten får i Key Vault. Standard: graph-client-secret

.PARAMETER Torrkjor
    Vis hva som ville blitt gjort, uten å endre noe.

.PARAMETER NyHemmelighet
    Lag en ny klienthemmelighet selv om appen finnes fra før.

.EXAMPLE
    .\opprett-backup-app.ps1 -Site https://fhs.sharepoint.com/sites/Skjemasystem -Torrkjor
    .\opprett-backup-app.ps1 -Site https://fhs.sharepoint.com/sites/Skjemasystem

.NOTES
    NØDVENDIGE ROLLER

    Global Administrator dekker steg 1–3, men trengs ikke. Stegene kan deles
    på tre personer — skriptet er idempotent og hopper over det som er gjort,
    så det kan kjøres én gang av hver, i hvilken som helst rekkefølge:

      Steg 1  App-registrering og hemmelighet
              → Application Administrator (eller Cloud Application Administrator)

      Steg 2  Samtykke til Graph-rettigheten «Sites.Selected»
              → Privileged Role Administrator eller Global Administrator

              MERK: Application Administrator er IKKE nok her. Den rollen kan
              gi samtykke til det meste, men har et uttrykkelig unntak for
              applikasjonsrettigheter på Microsoft Graph — som er akkurat
              denne. Det er den vanligste grunnen til at steg 2 feiler mens
              alt annet går igjennom.

      Steg 3  Skriverett på SharePoint-området
              → SharePoint Administrator eller Global Administrator
              (kallet krever Graph-rettigheten Sites.FullControl.All)

      Steg 5  Skriving til Key Vault — bare med -KeyVault
              → «Key Vault Secrets Officer» på vaulten, pluss «Reader» på
              ressursen så cmdleten finner den. Dette er Azure-roller, ikke
              Entra-roller, og en helt annen tildeling enn de over.

    Feiler et steg på manglende rettighet, sier skriptet hvilken rolle som
    mangler og fortsetter med resten. Til slutt lister det opp hva som gjenstår.

    Installer én gang:  Install-Module Microsoft.Graph -Scope CurrentUser
    Kjører også i Azure Cloud Shell (PowerShell), der modulen er forhåndsinstallert.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Site,
    [string]$Navn = 'fhs-skjema-backup',
    [int]$MaanederGyldig = 12,
    [string]$KeyVault = '',
    [string]$HemmelighetNavn = 'graph-client-secret',
    [switch]$Torrkjor,
    [switch]$NyHemmelighet
)

$ErrorActionPreference = 'Stop'
$GRAPH_APP_ID = '00000003-0000-0000-c000-000000000000'
$RETTIGHET = 'Sites.Selected'

# Key Vault-skriving sjekkes FØR noe opprettes. Oppdager vi først etterpå at
# modulen mangler, står vi med en fersk hemmelighet vi ikke har noe sted å
# gjøre av — og den vises bare én gang.
if ($KeyVault -and -not $Torrkjor) {
    if (-not (Get-Module -ListAvailable -Name Az.KeyVault)) {
        Write-Host "Modulen Az.KeyVault mangler. Installer den med" -ForegroundColor Red
        Write-Host "  Install-Module Az.KeyVault -Scope CurrentUser" -ForegroundColor Red
        Write-Host "eller kjør uten -KeyVault og legg hemmeligheten inn manuelt." -ForegroundColor Red
        exit 1
    }
    Import-Module Az.KeyVault -ErrorAction Stop
    # Key Vault er ikke Graph — datalaget krever sitt eget token.
    if (-not (Get-AzContext -ErrorAction SilentlyContinue)) { Connect-AzAccount | Out-Null }
}

function Steg([string]$t) { Write-Host "`n── $t" -ForegroundColor Cyan }
function Ok([string]$t) { Write-Host "   $t" -ForegroundColor Green }
function Info([string]$t) { Write-Host "   $t" }
function Ville([string]$t) { Write-Host "   [tørrkjøring] $t" -ForegroundColor Yellow }

# Hva som ikke lot seg gjøre, og hvem som kan gjøre det. Et steg som feiler på
# manglende rettighet skal ikke stoppe de andre — stegene krever ulike roller,
# og i et driftsmiljø sitter de sjelden hos samme person.
$gjenstar = @()
function Mangler([string]$hva, [string]$rolle, [string]$detalj) {
    Write-Host "   Ikke utført: $hva" -ForegroundColor Yellow
    Write-Host "   Krever: $rolle" -ForegroundColor Yellow
    if ($detalj) { Write-Host "   ($detalj)" -ForegroundColor DarkGray }
    $script:gjenstar += [pscustomobject]@{ Hva = $hva; Rolle = $rolle }
}

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
    try {
        # Ingen redirect-URI og ingen delegerte rettigheter: appen logger aldri
        # inn en bruker, den kjører som seg selv.
        $app = New-MgApplication -DisplayName $Navn -SignInAudience 'AzureADMyOrg'
        Ok "Opprettet — appId $($app.AppId)"
    } catch {
        Mangler 'opprette app-registreringen' 'Application Administrator' $_.Exception.Message
        # Uten appen har de neste stegene ingenting å feste seg til.
        Write-Host "`nIngenting mer kan gjøres uten app-registreringen." -ForegroundColor Red
        exit 1
    }
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
        try {
            # En app-rolletildeling ER administrator-samtykket. Ingen egen
            # «Grant admin consent»-knapp i portalen er nødvendig etterpå.
            New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id `
                -PrincipalId $sp.Id -ResourceId $graphSp.Id -AppRoleId $rolle.Id | Out-Null
            Ok "Tildelt $RETTIGHET"
        } catch {
            Mangler "gi samtykke til $RETTIGHET" 'Privileged Role Administrator eller Global Administrator' `
                'Application Administrator har et unntak for applikasjonsrettigheter på Microsoft Graph'
        }
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

$omraade = $null
try {
    $omraade = Invoke-MgGraphRequest -Method GET -Uri "v1.0/sites/$omraadeRef"
    Info "Område-ID: $($omraade.id)"
} catch {
    Mangler 'slå opp SharePoint-området' 'SharePoint Administrator eller Global Administrator' `
        "sjekk også at adressen stemmer: $Site"
}

$harAlt = $false
if ($app -and $omraade) {
    try {
        $eksisterende = Invoke-MgGraphRequest -Method GET -Uri "v1.0/sites/$($omraade.id)/permissions"
        $harAlt = @($eksisterende.value | Where-Object {
            ($_ | ConvertTo-Json -Depth 6 -Compress) -match [regex]::Escape($app.AppId)
        }).Count -gt 0
    } catch { $harAlt = $false }
}

if (-not $omraade) {
    # Oppslaget feilet alt — allerede rapportert over.
} elseif ($harAlt) {
    Ok 'Skriverett på området — allerede gitt'
} elseif ($Torrkjor -or -not $app) {
    Ville 'ville gitt appen skriverett på området'
} else {
    try {
        $kropp = @{
            roles = @('write')
            grantedToIdentities = @(@{ application = @{ id = $app.AppId; displayName = $Navn } })
        } | ConvertTo-Json -Depth 6
        Invoke-MgGraphRequest -Method POST -Uri "v1.0/sites/$($omraade.id)/permissions" `
            -Body $kropp -ContentType 'application/json' | Out-Null
        Ok 'Gitt skriverett — kun på dette området'
    } catch {
        Mangler 'gi appen skriverett på området' 'SharePoint Administrator eller Global Administrator' `
            $_.Exception.Message
    }
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
    try {
        $utloper = (Get-Date).AddMonths($MaanederGyldig)
        $ny = Add-MgApplicationPassword -ApplicationId $app.Id -PasswordCredential @{
            displayName = "backup $(Get-Date -Format 'yyyy-MM-dd')"
            endDateTime = $utloper
        }
        $hemmelig = $ny.SecretText
        Ok "Opprettet, utløper $($utloper.ToString('yyyy-MM-dd'))"
    } catch {
        $utloper = $null
        Mangler 'lage klienthemmelighet' 'Application Administrator' $_.Exception.Message
    }
}

# ------------------------------------------------- 5. rett i Key Vault
$kvReferanse = $null
if ($KeyVault -and $Torrkjor) {
    Steg '5. Key Vault'
    Ville "ville lagret hemmeligheten som «$HemmelighetNavn» i $KeyVault"
} elseif ($KeyVault -and $hemmelig) {
    Steg '5. Key Vault'
    try {
        # Samme utløpsdato på hemmeligheten som på app-legitimasjonen, slik at
        # vaulten selv bærer datoen og ikke bare et notat et annet sted.
        $sikker = ConvertTo-SecureString $hemmelig -AsPlainText -Force
        $lagret = Set-AzKeyVaultSecret -VaultName $KeyVault -Name $HemmelighetNavn `
            -SecretValue $sikker -Expires $utloper.ToUniversalTime()
        Ok "Lagret som «$HemmelighetNavn» i $KeyVault"

        # Uten versjon i URI-en henter SWA alltid nyeste — da overlever
        # app-settingen en rotering uten at noen må endre den.
        $kvReferanse = "@Microsoft.KeyVault(SecretUri=$($lagret.Id -replace '/[^/]+$', '/'))"
        # Hemmeligheten er trygt plassert; ikke la den ligge igjen i minnet
        # eller havne i oppsummeringen nedenfor.
        $hemmelig = $null
    } catch {
        Write-Host "   Kunne ikke skrive til $KeyVault — $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "   Hemmeligheten er opprettet og vises nedenfor. Legg den inn manuelt." -ForegroundColor Yellow
    }
} elseif ($KeyVault) {
    Steg '5. Key Vault'
    Info 'Ingen ny hemmelighet å lagre — bruk -NyHemmelighet hvis du vil rotere'
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

if ($kvReferanse) {
    Write-Host ""
    Write-Host "  GRAPH_CLIENT_SECRET       $kvReferanse" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Hemmeligheten ligger i Key Vault og har aldri vært på skjermen." -ForegroundColor Green
    Write-Host "  SWA-ens managed identity må ha «Key Vault Secrets User» på" -ForegroundColor Green
    Write-Host "  $KeyVault for at referansen skal la seg løse." -ForegroundColor Green
} elseif ($hemmelig) {
    Write-Host ""
    Write-Host "  GRAPH_CLIENT_SECRET" -ForegroundColor Yellow
    Write-Host "  $hemmelig" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  Vises bare denne ene gangen. Legg den i Key Vault og referer" -ForegroundColor Yellow
    Write-Host "  til den fra app-settingen — ikke lim den inn som ren tekst." -ForegroundColor Yellow
    Write-Host "  Neste gang kan -KeyVault <navn> gjøre dette steget for deg." -ForegroundColor Yellow
}
if ($utloper) {
    Write-Host ""
    Write-Host "  Utløper $($utloper.ToString('yyyy-MM-dd')). Registrer datoen i"
    Write-Host "  Administrasjon → Nøkkelkalender, så kommer varselet i tide."
}

if ($gjenstar.Count -gt 0) {
    Write-Host ""
    Write-Host ('─' * 68) -ForegroundColor Yellow
    Write-Host " Gjenstår — krever andre rettigheter enn dine" -ForegroundColor Yellow
    Write-Host ('─' * 68) -ForegroundColor Yellow
    foreach ($g in $gjenstar) {
        Write-Host ("  • {0}" -f $g.Hva) -ForegroundColor Yellow
        Write-Host ("    {0}" -f $g.Rolle) -ForegroundColor DarkGray
    }
    Write-Host ""
    Write-Host "  Skriptet er idempotent: den som har rollen kan kjøre det om" -ForegroundColor Yellow
    Write-Host "  igjen med samme parametre. Det som alt er gjort, hoppes over." -ForegroundColor Yellow
    Write-Host ""
    exit 2
}
Write-Host ""
