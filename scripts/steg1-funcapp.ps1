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
    # Parametrene samles i en hashtabell og brees ut med @p. Formen er
    # valgt fordi den ikke trenger fortsettelsestegn: en backtick er
    # usynlig, og et mellomrom etter den slår den av — klipp-og-lim
    # ødelegger kommandoen uten at noe ser galt ut. Se «Om kommandoene» i
    # docs/KOKEBOK-PROD-V3.md.
    $p = @{
        Rg          = 'FHS-skjema'
        FuncApp     = 'testfapp'
        Lagring     = 'fastate01'
        DataLagring = '<konto>'
        Identitet   = 'id-fhsskjema-dev'
        KeyVault    = 'kv-fhsskjema-pilot'
        Swa         = 'swa-funcapp-proeve'
    }
    .\steg1-funcapp.ps1 @p -Kjor

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

# Kommandoen slik den KAN limes inn igjen.
#
# `-join ' '` alene gir «--role Storage Table Data Contributor», og limer man
# den linja tilbake i skallet, leser az bare «Storage» som rollenavn og klager
# over «unrecognized arguments». Kallet selv er riktig — argumentene sendes som
# en liste — men utskriften var det ikke, og det er utskriften folk kopierer
# når de feilsøker.
function Som-Kommando {
    param([string[]]$Argumenter)
    $deler = foreach ($a in $Argumenter) {
        if ($a -match '[\s"]') { "'" + ($a -replace "'", "''") + "'" } else { $a }
    }
    return ($deler -join ' ')
}

function Kjør-Az {
    param([string[]]$Argumenter)
    if ($Kjor) {
        Write-Host "-> az $(Som-Kommando $Argumenter)" -ForegroundColor Cyan
        $svar = & az @Argumenter
        if ($LASTEXITCODE -ne 0) { throw "az feilet: $(Som-Kommando $Argumenter)" }
        return $svar
    }
    Write-Host "   az $(Som-Kommando $Argumenter)"
    return $null
}

# Finnes ressursen? En prøve som IKKE kaster.
#
# Grunnen står i trinn 3: Azure svarer `AuthorizationFailed` både når du
# mangler rettigheten OG når omfanget ikke finnes. «or the scope is invalid»
# står i meldingen, men den drukner i resten, og feilsøkingen går mot
# rettigheter som er helt i orden.
function Finnes-Az {
    param([string[]]$Argumenter)
    if (-not $Kjor) { return $true }   # tørrkjøring påstår ingenting
    & az @Argumenter 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
}

# Finnes ressursgruppa i det hele tatt?
#
# Dette er den aller første sjekken, fordi en feil her forkler seg som noe
# annet i HVERT ETTERFØLGENDE steg: Azure svarer `AuthorizationFailed` på en
# ressursgruppe som ikke finnes, med «or the scope is invalid» til slutt. Du
# kan være Owner på gruppa du TROR du jobber i, og få en rettighetsfeil på en
# gruppe som aldri ble opprettet.
#
# Skjedde 21.10.2026: `$p` bar `rg-skjema-3-prod` fra kokebokas gamle
# navnetabell, mens beslutningen var å gjenbruke `fhs-prod-rg-01`. Lagrings-
# kontoen fins — navnet er globalt unikt — så `az` meldte «will continue to
# update the existing account» og feilet deretter på en gruppe som ikke er der.
# En halvtime gikk til rolletildelinger som var helt i orden.
$rgFinnes = (& az group exists --name $Rg) -eq 'true'
if (-not $rgFinnes) {
    Write-Host ""
    Write-Host "   Ressursgruppa «$Rg» finnes ikke i dette abonnementet." -ForegroundColor Red
    Write-Host "   $(& az account show --query '{abonnement:name, id:id}' -o tsv)" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "   Alt under ville feilet med «AuthorizationFailed ... or the" -ForegroundColor Yellow
    Write-Host "   scope is invalid» — som ser ut som en manglende rettighet." -ForegroundColor Yellow
    Write-Host "   Sjekk -Rg, og at du står i riktig abonnement." -ForegroundColor Yellow
    if ($Kjor) { throw "Ressursgruppa $Rg finnes ikke" }
    Write-Host "   (tørrkjøring fortsetter, men tallene under betyr ingenting)" -ForegroundColor DarkGray
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

# OG DET SAMME FOR KEY VAULT-REFERANSER, som er en EGEN innstilling.
#
# @Microsoft.KeyVault(...) løses av plattformen, ikke av koden, og plattformen
# bruker SYSTEM-ASSIGNED identitet med mindre den får beskjed om noe annet.
# Med bare en user-assigned identitet feiler hver referanse med
#
#     Status: MSINotEnabled
#     Reference was not able to be resolved because site Managed Identity
#     not enabled.
#
# — selv når rolletildelingen på vaulten er helt riktig. Det ser ut som en
# manglende rettighet og er det ikke.
#
# Merk at denne tar RESSURS-ID-en, ikke clientId. De to forveksles lett, og
# feilmeldingen blir like kryptisk begge veier.
Kjør-Az @('functionapp','update','--name',$FuncApp,'--resource-group',$Rg,
          '--set',"keyVaultReferenceIdentity=$identitetId",'--output','none') | Out-Null

# Tre storage-roller, ikke to. Blob Delegator er den backup.js trenger for å
# lage en SAS uten kontonøkkel (getUserDelegationKey) — målt i 8f.
#
# Og MERK: ingen av disse er «Contributor». Den er en kontrollplan-rolle som
# ikke gir tilgang til en eneste tabellrad, og som i tillegg gir rett til å
# liste kontonøklene — full datatilgang gjennom en sidedør, med den delte
# nøkkelen hele øvelsen går ut på å fjerne.
# Finnes de to ressursene rollene skal tildeles PÅ?
#
# Skriptet oppretter `$Lagring` (runtime-kontoen) i trinn 1, men ikke
# `$DataLagring` og ikke vaulten — de kommer fra kapittel 2 og 3.1 i
# kokeboka. Kjører du bare `-Trinn funcapp` i en ressursgruppe der de ikke
# står, feiler rolletildelingen med `AuthorizationFailed` og en melding om
# `roleAssignments/write`. Det ser ut som en manglende rettighet, og er det
# ikke. Skjedde 21.10.2026 i prod-tenanten.
$manglendeOmfang = @()
if (-not (Finnes-Az @('storage','account','show','--name',$DataLagring,'--resource-group',$Rg))) {
    $manglendeOmfang += "lagringskontoen «$DataLagring» (kapittel 2 i kokeboka)"
}
if (-not (Finnes-Az @('keyvault','show','--name',$KeyVault))) {
    $manglendeOmfang += "Key Vault «$KeyVault» (kapittel 3.1)"
}
if ($manglendeOmfang.Count -gt 0) {
    Write-Host ""
    Write-Host "   Kan ikke tildele roller — omfanget finnes ikke:" -ForegroundColor Red
    foreach ($m in $manglendeOmfang) { Write-Host "     - $m" -ForegroundColor Red }
    Write-Host ""
    Write-Host "   Dette er IKKE en rettighetsfeil. Azure svarer" -ForegroundColor Yellow
    Write-Host "   «AuthorizationFailed ... or the scope is invalid» i begge tilfeller," -ForegroundColor Yellow
    Write-Host "   og den andre halvdelen er lett å lese forbi." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "   Opprett dem først, og kjør dette trinnet om igjen." -ForegroundColor Yellow
    throw "Omfanget for rolletildelingene finnes ikke"
}

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
          az staticwebapp secrets list --name $Swa --resource-group $Rg --query "properties.apiKey" -o tsv

     2. Legg det i GitHub-secreten SWA_PROEVE_TOKEN.

     3. Kjør arbeidsflyten «Deploy innhold til prøve-SWA (steg 1)».

     4. BEKREFT at rota viser «Prøve-SWA», ikke Azure sin standardside:
          az staticwebapp environment list --name $Swa --resource-group $Rg --query "[].{Navn:name,Status:status}" -o table
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

# Sluttmeldingen hører til DET TRINNET som ble kjørt.
#
# Prøven under gjelder etter LENKINGEN, og sto utenfor alle trinn-vaktene:
# den ble skrevet ut også etter `-Trinn funcapp`, der ingen SWA finnes og
# ingenting er lenket. Da ber skriptet deg prøve en URL som ikke er
# opprettet, og det leses som at man har hoppet over noe. Meldt 21.10.2026.
if ($Trinn -eq 'lenk') {
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
}

if ($Trinn -eq 'funcapp') {
Write-Host "`n== Ferdig med trinn 3 ==" -ForegroundColor Green
Write-Host @"
   Function App-en, identiteten og rollene står nå. Det er IKKE testbart
   ennå: API-et er ikke deployet, så Function App-en har ingen funksjoner å
   svare med, og /api/ping gir 404. Det er forventet og ikke en feil.

   Kontroller det som ER gjort - rollene, med kapittel 3.2 i kokeboka.
   MERK at --assignee vil ha en PRINSIPAL-ID, ikke navnet paa identiteten.
   Gir du navnet, svarer az «Cannot find user or service principal in graph
   database» - som ser ut som at identiteten mangler, og den star rett over.
   Id-en hentes i samme linje:

     az role assignment list --assignee $principal --all -o table

   Deretter kapittel 4 (app settings) og 5 (SWA og innhold). Prøven mot
   /api/ping hører til ETTER lenkingen i trinn 'lenk'.
"@
}
