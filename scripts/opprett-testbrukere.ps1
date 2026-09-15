<#
.SYNOPSIS
    Oppretter lisensierte testbrukere i utviklingstenanten.

.DESCRIPTION
    Ett formål: et minimumsutvalg testbrukere som dekker rollene løsningen
    faktisk har, uten å bruke opp lisensene.

    DET SKRIPTET GJØR:
      1. Verifiserer at du er logget inn i RIKTIG tenant — domenet du oppgir
         må være et verifisert domene der. Ellers stopper det.
      2. Slår opp lisensen og teller ledige seter. Er det færre seter enn
         brukere, stopper det før noe er opprettet.
      3. Oppretter brukerne som mangler, med usageLocation satt og et
         tilfeldig engangspassord som må byttes ved første pålogging.
      4. Tildeler lisens.
      5. Skriver ut passordene ÉN gang, og en ferdig ADMIN_UPNS-verdi.

    DET SKRIPTET IKKE GJØR:
      Sletter ingen brukere, endrer ingen eksisterende, rører ingen grupper
      eller app-registreringer. Lagrer ikke passordene noe sted.

    Skriptet er idempotent. En bruker som finnes fra før rapporteres og
    hoppes over — den får hverken nytt passord eller ny lisens.

    Rollene i tabellen under er LØSNINGENS roller, ikke Entra-roller. De
    brukes bare til å skrive ut hva som skal videre inn i ADMIN_UPNS,
    Rollemedlemskap og Publikum/Eiere. Ingen av dem tildeles av skriptet.

    Bruker Azure CLI mot Microsoft Graph (`az rest`), så ingen ekstra
    PowerShell-moduler trengs. Krever Global Administrator i tenanten.

.PARAMETER Domene
    Det verifiserte domenet brukerne skal ligge under, f.eks.
    jccodevel.onmicrosoft.com

.PARAMETER Lisens
    SKU-navnet som skal tildeles. Standard: DEVELOPERPACK_E5 (Microsoft 365
    E5 Developer). Kjør med -VisLisenser for å se hva tenanten har.

.PARAMETER Bruksland
    usageLocation på brukerne. Standard NO. Må settes FØR lisens kan
    tildeles — Graph avviser assignLicense uten den.

.PARAMETER Passord
    Felles passord for alle brukerne, i stedet for et tilfeldig per bruker.

    Da settes også forceChangePasswordNextSignIn til FALSE — et felles passord
    du må bytte ved første pålogging er ikke felles særlig lenge, og da er
    poenget borte.

    Prisen er reell: kontoene er lisensierte og kan sende e-post fra
    tenanten. Bruk det bare på testkontoer i en utviklingstenant.

.PARAMETER TilbakestillPassord
    Setter passordet også på brukerne som finnes fra før — de i tabellen
    under, ingen andre. Krever -Passord.

    Finnes fordi brukerne kan være opprettet med tilfeldige passord i en
    tidligere kjøring. Uten denne hoppes de over, og du sitter igjen med
    halve utvalget på ett passord og halve på noe du ikke har.

.PARAMETER TorrKjor
    Viser hva som ville blitt gjort, og oppretter ingenting.

.PARAMETER VisLisenser
    Lister tenantens lisenser med ledige seter, og avslutter.

.PARAMETER UtenLisens
    Oppretter brukerne, men tildeler ingen lisens.

.EXAMPLE
    az login --tenant 02ff6bc3-07c5-4ed5-835e-5c68c26ab8eb --allow-no-subscriptions
    .\opprett-testbrukere.ps1 -Domene jccodevel.onmicrosoft.com -VisLisenser
    .\opprett-testbrukere.ps1 -Domene jccodevel.onmicrosoft.com -TorrKjor
    .\opprett-testbrukere.ps1 -Domene jccodevel.onmicrosoft.com
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Domene,
    [string]$Lisens = 'DEVELOPERPACK_E5',
    [string]$Bruksland = 'NO',
    [string]$Passord,
    [switch]$TilbakestillPassord,
    [switch]$TorrKjor,
    [switch]$VisLisenser,
    [switch]$UtenLisens
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Utvalget.
#
# Ti brukere, ikke de tjuetre lisensene tillater. Hver rad finnes fordi noe
# i løsningen oppfører seg ULIKT for den — ikke for å ha mange å teste med.
# Trenger du en til, legg den til her med en begrunnelse i samme kolonne.
# ---------------------------------------------------------------------------
$BRUKERE = @(
    @{ Konto = 'admin1';      Navn = 'Test Administrator 1'; Rolle = 'admin';     Hvorfor = 'ADMIN_UPNS — full tilgang' }
    @{ Konto = 'admin2';      Navn = 'Test Administrator 2'; Rolle = 'admin';     Hvorfor = 'To admins: test at lista tåler flere' }
    @{ Konto = 'eier1';       Navn = 'Test Skjemaeier 1';    Rolle = 'eier';      Hvorfor = 'Eier av skjematype, uten admin' }
    @{ Konto = 'eier2';       Navn = 'Test Skjemaeier 2';    Rolle = 'eier';      Hvorfor = 'Eier nummer to: test at Eiere-lista skiller' }
    @{ Konto = 'behandler1';  Navn = 'Test Behandler 1';     Rolle = 'behandler'; Hvorfor = 'Team A — teammedlemskap' }
    @{ Konto = 'behandler2';  Navn = 'Test Behandler 2';     Rolle = 'behandler'; Hvorfor = 'Team A — to i samme team' }
    @{ Konto = 'behandler3';  Navn = 'Test Behandler 3';     Rolle = 'behandler'; Hvorfor = 'Team B — test at team faktisk skiller' }
    @{ Konto = 'innsender1';  Navn = 'Test Innsender 1';     Rolle = 'innsender'; Hvorfor = 'Vanlig innsending' }
    @{ Konto = 'innsender2';  Navn = 'Test Innsender 2';     Rolle = 'innsender'; Hvorfor = 'Masseutsending til flere mottakere' }
    @{ Konto = 'ingenting';   Navn = 'Test Uten Roller';     Rolle = 'ingen';     Hvorfor = 'Negativ test — skal IKKE slippe inn' }
)

# ---------------------------------------------------------------------------
# Hjelpere
# ---------------------------------------------------------------------------

function Graf {
    param(
        [string]$Metode = 'GET',
        [Parameter(Mandatory = $true)][string]$Sti,
        $Kropp
    )
    $url = "https://graph.microsoft.com/v1.0$Sti"

    # az skriver svaret som flere linjer. ConvertFrom-Json binder én streng,
    # så en ufullstendig første linje blir «Invalid JSON» — en feil som ser ut
    # som at Graph svarte rart. Derfor -join først, alltid.
    if ($null -eq $Kropp) {
        $ut = (az rest --method $Metode --url $url --headers 'Content-Type=application/json' 2>$null) -join "`n"
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($ut)) { return $null }
        return ($ut | ConvertFrom-Json)
    }

    # Kroppen går via fil. Å sende JSON med hermetegn rett inn i az på
    # Windows er en kilde til feil som ser ut som Graph-feil, men ikke er det.
    $fil = New-TemporaryFile
    try {
        # UTF-8 UTEN BOM. Set-Content -Encoding utf8 skriver BOM i Windows
        # PowerShell 5.1, og az sender den videre — Graph svarer da med en
        # parsefeil som ser ut som feil i kroppen.
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($fil, ($Kropp | ConvertTo-Json -Depth 6), $utf8)
        $svar = (az rest --method $Metode --url $url --headers 'Content-Type=application/json' --body "@$fil" 2>&1) -join "`n"
        if ($LASTEXITCODE -ne 0) { throw "Graph $Metode $Sti feilet: $svar" }
        if ([string]::IsNullOrWhiteSpace($svar)) { return $null }
        return ($svar | ConvertFrom-Json)
    } finally {
        Remove-Item $fil -ErrorAction SilentlyContinue
    }
}

function NyttPassord {
    # 64 tegn i alfabetet gjør modulo 256 → 64 rettferdig, uten skjevhet.
    $alfabet = ('abcdefghijklmnopqrstuvwxyz' +
                'ABCDEFGHIJKLMNOPQRSTUVWXYZ' +
                '0123456789-_').ToCharArray()
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        while ($true) {
            $bytes = New-Object byte[] 24
            $rng.GetBytes($bytes)
            $pw = -join ($bytes | ForEach-Object { $alfabet[$_ % 64] })
            # Entra krever tre av fire tegnklasser. Kast og prøv på nytt
            # heller enn å lime på faste tegn til slutt.
            if ($pw -cmatch '[a-z]' -and $pw -cmatch '[A-Z]' -and $pw -match '[0-9]') { return $pw }
        }
    } finally {
        $rng.Dispose()
    }
}

function Linje { Write-Host ('-' * 72) -ForegroundColor DarkGray }

# ---------------------------------------------------------------------------
# 1. Riktig tenant?
#
# Det viktigste steget i skriptet. En az-innlogging mot feil tenant ville
# ellers opprettet ti brukere i produksjonskatalogen.
# ---------------------------------------------------------------------------
if ($TilbakestillPassord -and -not $Passord) {
    throw '-TilbakestillPassord krever -Passord. Skriptet setter aldri et tilfeldig passord på en bruker som finnes fra før — da ville du mistet det du hadde.'
}

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    throw 'Azure CLI (az) finnes ikke i PATH. Installer den, eller kjør fra Cloud Shell.'
}

$org = Graf -Sti '/organization'
if (-not $org) { throw 'Fikk ikke svar fra Graph. Kjør: az login --tenant <id> --allow-no-subscriptions' }

$tenant = $org.value[0]
$domener = $tenant.verifiedDomains | ForEach-Object { $_.name }

Linje
Write-Host "Tenant : $($tenant.displayName)"
Write-Host "Id     : $($tenant.id)"
Write-Host "Domener: $($domener -join ', ')"
Linje

if ($domener -notcontains $Domene) {
    throw "'$Domene' er ikke et verifisert domene i denne tenanten. Sjekk at du er logget inn riktig sted — INGEN brukere er opprettet."
}

# ---------------------------------------------------------------------------
# 2. Lisens og ledige seter
# ---------------------------------------------------------------------------
$skuer = (Graf -Sti '/subscribedSkus').value

if ($VisLisenser) {
    $skuer | ForEach-Object {
        $ledig = $_.prepaidUnits.enabled - $_.consumedUnits
        '{0,-28} {1,3} ledige av {2}' -f $_.skuPartNumber, $ledig, $_.prepaidUnits.enabled
    }
    return
}

$sku = $null
if (-not $UtenLisens) {
    $sku = $skuer | Where-Object { $_.skuPartNumber -eq $Lisens } | Select-Object -First 1
    if (-not $sku) {
        throw "Fant ingen lisens med navnet '$Lisens'. Kjør med -VisLisenser for å se hva tenanten har."
    }
    $ledige = $sku.prepaidUnits.enabled - $sku.consumedUnits
    Write-Host "Lisens : $Lisens — $ledige ledige seter av $($sku.prepaidUnits.enabled)"
}

# ---------------------------------------------------------------------------
# 3. Hvem finnes fra før?
# ---------------------------------------------------------------------------
$aaLage = @()
$finnesAlt = @()
foreach ($b in $BRUKERE) {
    $upn = "$($b.Konto)@$Domene"
    $finnes = $null
    try { $finnes = Graf -Sti "/users/$upn" } catch { $finnes = $null }
    if ($finnes) {
        Write-Host "  finnes   $upn" -ForegroundColor DarkGray
        $finnesAlt += [pscustomobject]@{ Upn = $upn; Id = $finnes.id; Rolle = $b.Rolle }
    } else {
        $aaLage += $b
    }
}

# Passordet på dem som finnes fra før. Bare kontoene i tabellen over —
# skriptet rører ingen andre brukere i tenanten.
if ($TilbakestillPassord -and $finnesAlt.Count -gt 0) {
    if ($TorrKjor) {
        Write-Host "`nVille satt nytt passord på $($finnesAlt.Count) eksisterende bruker(e)." -ForegroundColor Yellow
    } else {
        foreach ($f in $finnesAlt) {
            Graf -Metode PATCH -Sti "/users/$($f.Id)" -Kropp @{
                passwordProfile = @{
                    forceChangePasswordNextSignIn = $false
                    password                      = $Passord
                }
            } | Out-Null
            Write-Host "  passord   $($f.Upn)" -ForegroundColor Green
        }
    }
}

if ($aaLage.Count -eq 0) {
    Write-Host "`nAlle brukerne finnes allerede. Ingenting mer å gjøre." -ForegroundColor Green
    return
}

if (-not $UtenLisens -and $aaLage.Count -gt $ledige) {
    throw "Trenger $($aaLage.Count) seter, har $ledige. INGEN brukere er opprettet. Frigjør lisenser, eller kjør med -UtenLisens."
}

Linje
Write-Host "Skal opprette $($aaLage.Count) bruker(e):"
$aaLage | ForEach-Object { '  {0,-14} {1,-10} {2}' -f "$($_.Konto)@$Domene", $_.Rolle, $_.Hvorfor }
Linje

if ($TorrKjor) {
    Write-Host 'Tørrkjøring — ingenting er opprettet.' -ForegroundColor Yellow
    return
}

# ---------------------------------------------------------------------------
# 4. Opprett og tildel
# ---------------------------------------------------------------------------
$resultat = @()
foreach ($b in $aaLage) {
    $upn = "$($b.Konto)@$Domene"
    # Et felles passord som må byttes ved første pålogging er ikke felles
    # særlig lenge. Derfor henger de to sammen: oppgitt passord → ingen tvungen
    # endring, tilfeldig passord → tvungen endring.
    $pw = if ($Passord) { $Passord } else { NyttPassord }

    $ny = Graf -Metode POST -Sti '/users' -Kropp @{
        accountEnabled    = $true
        displayName       = $b.Navn
        mailNickname      = $b.Konto
        userPrincipalName = $upn
        usageLocation     = $Bruksland
        passwordProfile   = @{
            forceChangePasswordNextSignIn = (-not $Passord)
            password                      = $pw
        }
    }
    if (-not $ny.id) { throw "Opprettelsen av $upn ga ingen id tilbake. Stopper her — de foregående er opprettet." }
    Write-Host "  opprettet $upn" -ForegroundColor Green

    if (-not $UtenLisens) {
        Graf -Metode POST -Sti "/users/$($ny.id)/assignLicense" -Kropp @{
            addLicenses    = @(@{ disabledPlans = @(); skuId = $sku.skuId })
            removeLicenses = @()
        } | Out-Null
        Write-Host "  lisens    $upn" -ForegroundColor Green
    }

    $resultat += [pscustomobject]@{ Upn = $upn; Rolle = $b.Rolle; Passord = $pw }
}

# ---------------------------------------------------------------------------
# 5. Det du trenger videre
# ---------------------------------------------------------------------------
Linje
if ($Passord) {
    Write-Host 'Alle brukerne har passordet du oppga. Ingen tvungen endring.' -ForegroundColor Yellow
    Write-Host 'Kontoene er lisensierte og kan sende e-post — hold dem i utviklingstenanten.' -ForegroundColor Yellow
    Linje
    $resultat | Format-Table Upn, Rolle -AutoSize
} else {
    Write-Host 'ENGANGSPASSORD — vises bare nå, og lagres ikke noe sted.' -ForegroundColor Yellow
    Write-Host 'Alle må byttes ved første pålogging.' -ForegroundColor Yellow
    Linje
    $resultat | Format-Table Upn, Rolle, Passord -AutoSize
}

$adminer = ($BRUKERE | Where-Object { $_.Rolle -eq 'admin' } | ForEach-Object { "$($_.Konto)@$Domene" }) -join ','
Linje
Write-Host 'Neste steg, i denne rekkefølgen:'
Write-Host ''
Write-Host '  1. ADMIN_UPNS i SWA Configuration — behold de gamle ved siden av'
Write-Host '     til omleggingen er ferdig:'
Write-Host ''
Write-Host "       $adminer" -ForegroundColor Cyan
Write-Host ''
Write-Host '     Varm deretter opp med /api/ping FØR du logger inn — rollen'
Write-Host '     settes bare ved innlogging, og en kald app rekker ikke fram.'
Write-Host '     Se «Første innlogging etter en endring i Configuration» i'
Write-Host '     docs/DEPLOY.md.'
Write-Host ''
Write-Host '  2. Rollemedlemskap — eier-kontoene som Skjemaskaper'
Write-Host '  3. Publikum og Eiere på skjematypene som skal testes'
Write-Host '  4. Teammedlemskap — behandler1+2 i ett team, behandler3 i et annet'
Write-Host ''
Write-Host '  ingenting@-kontoen skal IKKE inn noe sted. Den er negativ test.'
Linje
