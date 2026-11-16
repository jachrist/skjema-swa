# Sjekkliste: cutover til v3-prod og riving av v2

Alt som skal være gjort før v3-prod er eneste prod, og før v2 er borte i
begge tenantene — med en **test til hvert punkt**. En test er en kommando
med et forventet svar. Stemmer svaret, er punktet ferdig; stemmer det ikke,
er det ikke det, uansett hva hukommelsen sier.

Bakgrunn og feilsøking står i `docs/KOKEBOK-PROD-V3.md`: kapittel 10
(cutover), «Gentle-dune etter cutover», og ryddelista i kapittel 13.

| Del | Tenant | Hva |
|---|---|---|
| A | prod | Det som skal være gjort FØR pausen |
| B | prod | Beslutninger som må tas før riving |
| C | prod | Cutover — pausen |
| D | prod | Neste morgen |
| E | prod | Riving av v2-prod |
| F | dev | Riving av pilot (v2-dev) |
| G | begge | Sikkerhet som først kan strammes inn når v2 er borte |
| H | GitHub og repo | Opprydding |

**Rekkefølgen er ikke valgfri.** E og F river ressurser. Det som rives, kan
ikke testes etterpå — og tilbakeveien i kokeboka forutsetter at v2 står.

> **Datakontoen til v2-prod skal IKKE slettes.** Etter ompekingen (form A) er
> den v3-prods datakonto. Den ligger i samme ressursgruppe som v2-SWA-en, og
> den har v2 i navnet. Det er derfor den står her.
>
> **Aldri `az group delete`.** Ressursgruppa `fhs-prod-rg-01` deles av v2,
> v3, Key Vault og datakontoen (kokeboka 0.3). Slett ressurs for ressurs.

---

## Startblokk — prod-tenanten

Kjøres ved hver oppstart av Cloud Shell, som i installasjonsveiledningen. Alt
under leser herfra. v2-ressursene slås opp fra vertsnavnet og fra v3 sine app
settings, så ingen navn skal skrives inn for hånd.

```powershell
$GHREPO  = 'jachrist/skjema-swa'
$RG      = 'fhs-prod-rg-01'
$FA      = 'fa-skjema-3-prod'
$SWA     = 'swa-skjema-3-prod'
$MI      = 'mi-skjema-3-prod'
$KV      = 'fhs-kv-01'
$V3BLANK = 'stskjema3prod'
$V2VERT  = 'gentle-dune-00a313603.7.azurestaticapps.net'
$OFFENTLIG = 'https://www.fskjema.no'

$v2 = az staticwebapp list --query "[?defaultHostname=='$V2VERT'] | [0].{navn:name, rg:resourceGroup}" -o json | ConvertFrom-Json
$V2SWA = $v2.navn
$V2RG  = $v2.rg
$DATA  = az functionapp config appsettings list --name $FA --resource-group $RG --query "[?name=='STORAGE_ACCOUNT_NAME'].value | [0]" -o tsv
$V3VERT = az staticwebapp show --name $SWA --resource-group $RG --query defaultHostname -o tsv
$PRINCIPAL = az identity show --name $MI --resource-group $RG --query principalId -o tsv
$KV_ID = az keyvault show --name $KV --query id -o tsv
[pscustomobject]@{ V2SWA = $V2SWA; V2RG = $V2RG; Datakonto = $DATA; V3Vert = $V3VERT; Identitet = $PRINCIPAL } | Format-List
```

`V2SWA` er tom når v2-prod er revet. `Datakonto` skal være v2 sin konto, ikke
`stskjema3prod` — se A3.

---

## A. Før pausen

Mye av dette ble gjort i uka før. Testene sier hva som faktisk står.

| ☐ | Punkt | Test | Forventet |
|---|---|---|---|
| ☐ | A1. v3-prod kjører siste `main` | `Invoke-RestMethod "https://$V3VERT/api/ping"` → `bygg.commit` | Lik `git ls-remote https://github.com/$GHREPO main` |
| ☐ | A2. Frontend og API fra samme commit | Se under | Samme SHA i begge |
| ☐ | A3. v3 leser v2 sin datakonto | `$DATA` fra startblokka | v2 sin konto, ikke `stskjema3prod` |
| ☐ | A4. Identiteten har de tre rollene på den | Se under | Tre linjer |
| ☐ | A5. Ingen tilkoblingsstreng på v3 | Se under | Tomt |
| ☐ | A6. Timerne er på | Se under | Tomt — ingen `AzureWebJobs.…Disabled` |
| ☐ | A7. Cron mot v2-prod er stoppet | `gh variable list --repo $GHREPO` | `SWA_URL_PROD` står **ikke** i lista |
| ☐ | A8. `HASH_SALT`, `OTP_HMAC_KEY`, `FLOW_CALLBACK_KEY` er like | **Administrasjon → ⚙️ System** i begge appene | Likt avtrykk på alle tre (kokeboka 7b) |
| ☐ | A9. Nøkkelkalenderen har `prod`-rader | **Administrasjon → 🗓 Nøkkelkalender** på v3-prod → «Legg inn standardinventaret» (også på nytt etter en kodeendring — teksten oppdateres, datoene står) | 13 rader under `prod`, med utløpsdato eller planlagt rotasjonsdato der de ikke leses automatisk. Rader meldingen kaller «ikke i standarden» (`STORAGE_CONNECTION_STRING`, `GRAPH_CLIENT_SECRET`) slettes under `prod` |
| ☐ | A10. Flytene som forgrener på `miljø` tåler `"prod"` | Gå gjennom flytene | Ingen tester `== "production"` alene (kokeboka 10, «Miljønavnet skifter») |
| ☐ | A11. TTL på `www` er 5 minutter | `nslookup -debug www.fskjema.no 8.8.8.8` | `ttl = 300` eller lavere |
| ☐ | A12. Beslutningene i B er tatt | — | — |
| ☐ | A13. Sperren for deploy-valget er ute (PR #212) | `gh run list --repo $GHREPO --workflow deploy-prod.yml --limit 1` etter merge | Siste kjøring har steget «Sjekk API-valget mot målet» |

> **Deploy i denne perioden.** 16.11.2026 gikk en deploy med standardtokenet
> og uten haken for Managed Functions til v2-prod. Den fjernet API-et, og
> `/api/*` svarte «Backend call failure» til v2 ble rullet ut på nytt med
> haken. Etter #212 stopper workflowen den kombinasjonen. Regelen til da:
> **uten `swa_token_secret` → huk av; med → ikke huk av.**

A2, A4, A5 og A6:

```powershell
$api = (Invoke-RestMethod "https://$V3VERT/api/ping").bygg.commit
$fe = [regex]::Match((Invoke-WebRequest "https://$V3VERT/js/config.js" -UseBasicParsing).Content, '"commit":\s*"([0-9a-f]+)"').Groups[1].Value
[pscustomobject]@{ API = $api; Frontend = $fe; Like = ($api -eq $fe) } | Format-List

$DATA_ID = az storage account show --name $DATA --query id -o tsv
az role assignment list --assignee-object-id $PRINCIPAL --scope $DATA_ID --query "[].roleDefinitionName" -o tsv

az functionapp config appsettings list --name $FA --resource-group $RG --query "[?name=='STORAGE_CONNECTION_STRING'].name" -o tsv
az functionapp config appsettings list --name $FA --resource-group $RG --query "[?starts_with(name, 'AzureWebJobs.') && ends_with(name, '.Disabled')].{navn:name, verdi:value}" -o table
```

Rollene: `Storage Table Data Contributor`, `Storage Blob Data Contributor` og
`Storage Blob Delegator`.

---

## B. Beslutninger før riving

Tre ting avgjør om v2-prod kan rives samme dag, eller må stå en tid.

### B1. Lenker i omløp som peker på gentle-dune

Lenker i e-post bygges av `SWA_URL` i appen som sendte dem. Har v2-prod hatt
`SWA_URL` satt til gentle-dune-adressen, peker disse dit — og slutter å virke
når v2-prod rives:

* utsendingslenker (gyldige i 90 dager)
* lenker i varsler og kvitteringer
* Power BI-feeder (`pb-token`) — URL-en Power BI henter fra

```powershell
az staticwebapp appsettings list --name $V2SWA --resource-group $V2RG --query "properties.SWA_URL" -o tsv
```

| Svaret | Følge |
|---|---|
| `https://www.fskjema.no` | Lenkene peker på `www`, som etter cutover er v3. Ingenting går tapt |
| `https://gentle-dune-…` | Lenker sendt fra v2 dør med v2. Velg: **rive likevel** (utsendinger sendes på nytt fra v3, og Power BI-feeder lages på nytt), eller **videresendingsside** på v2 i 90 dager (valg A i kokeboka 7c) |

Power BI-koblingene opprettes fra **Datauttrekk**-siden, og tokenene ligger
i tabellen `Tilgangskontroll`. Det finnes ingen samlet liste i appen. Peker
v2-prods `SWA_URL` på gentle-dune, må hver eier lage en ny kobling fra
`www.fskjema.no` og bytte URL-en i Power BI — gi beskjed før riving.

### B2. Gentle-dune etter cutover

Kokeboka 7c. Besluttet retning: **rive** (B i 7c). Da får den som har en
lagret 301 fra `fskjema.no`, en feilside til nettleserens buffer er tømt. B1
avgjør om det er nok.

### B3. Den tomme v3-kontoen

`stskjema3prod` var v3-prods datakonto før ompekingen. Den har testdata fra
perioden før cutover, og ingenting leser den nå. Skal den slettes (E7), eller
står den som arkiv?

---

## C. Cutover — pausen

Trinnene er kokebokas 11–16, med test.

| ☐ | Punkt | Test | Forventet |
|---|---|---|---|
| ☐ | C1. `VARSLING_DEAKTIVERT` er borte på v3-prod | `az functionapp config appsettings list --name $FA --resource-group $RG --query "[?name=='VARSLING_DEAKTIVERT'].name" -o tsv` | Tomt |
| ☐ | C2. `SWA_URL` på v3-prod er `www` | `az functionapp config appsettings list --name $FA --resource-group $RG --query "[?name=='SWA_URL'].value" -o tsv` | `https://www.fskjema.no` |
| ☐ | C3. `www` er tatt av som standarddomene på v2-prod | Portalen: v2-SWA → **Custom domains** | `gentle-dune-…` er standard |
| ☐ | C4. `www` er flyttet | Se under | Står på v3, `Ready`. Står ikke på v2 |
| ☐ | C5. DNS peker på v3 | `nslookup -type=CNAME www.fskjema.no 8.8.8.8` | `$V3VERT` |
| ☐ | C6. Full backup fra v3 | **Jobber → Backup (full) → Kjør nå** | `prod-backup-…` i SharePoint |

C4:

```powershell
az staticwebapp hostname list --name $SWA --resource-group $RG --query "[].{navn:name, status:status}" -o table
az staticwebapp hostname list --name $V2SWA --resource-group $V2RG --query "[].name" -o tsv
```

Første kommando skal vise `www.fskjema.no` med `Ready`. Den andre skal ikke
vise `www.fskjema.no`.

**Kontroll rett etter pausen** — i en nettleser som ikke har vært på
`fskjema.no` før (privat vindu er ikke nok for en lagret 301):

| ☐ | Test | Forventet |
|---|---|---|
| ☐ | `curl.exe -sI https://fskjema.no` | `location: https://www.fskjema.no/` |
| ☐ | `Invoke-RestMethod "$OFFENTLIG/api/ping"` | `miljø` = `prod`, `bygg.commit` som A1 |
| ☐ | Logg inn på `www.fskjema.no` | Inn, med egen UPN |
| ☐ | **Administrasjon → ⚙️ System** | `lagring.maate` = `managed-identity`, kontoen er `$DATA`, `flytAuth` = `entra` |
| ☐ | Send inn et testskjema | Kvittering og behandlervarsel kommer, med lenker til `www` |
| ☐ | Skjemaet i Hendelser | Varselet har `"miljø": "prod"` i flyten (ikke `Production`) |

---

## D. Neste morgen

| ☐ | Test | Forventet |
|---|---|---|
| ☐ | **Jobber**-fanen på v3-prod | Alle ti nattjobbene `ok`, startet av `timer` |
| ☐ | GitHub Actions, en av cron-workflowene | `prod`-raden er hoppet over med `::notice::` |
| ☐ | Hendelser på v3-prod, siste døgn | Ingen jobb kjørt to ganger (to `refresh-fs.oppdatert` samme natt betyr at v2 kjører også) |
| ☐ | Backup i SharePoint | `prod-delta-…` fra natten |
| ☐ | Ingen varsler fra v2 | Flytenes kjørehistorikk: ingen kall med `"miljø": "Production"` etter pausen |

**Når D er grønn, er cutover ferdig.** La v2-prod stå et døgn eller to til
før E — det er tilbakeveien.

---

## E. Riving av v2-prod

Først når D er grønn og B er avgjort.

| ☐ | Punkt | Kommando / sted |
|---|---|---|
| ☐ | E1. Hent v2-SWA-ens identitet | `$V2MI = az staticwebapp identity show --name $V2SWA --resource-group $V2RG --query principalId -o tsv` |
| ☐ | E2. Fjern rollene den har (Key Vault og eventuelle storage-roller) | Se under |
| ☐ | E3. Fjern gentle-dune som redirect-URI på påloggingsappen | Se under |
| ☐ | E4. Slett v2-SWA-en | `az staticwebapp delete --name $V2SWA --resource-group $V2RG --yes` |
| ☐ | E5. Slett `production`-radene i nøkkelkalenderen | **Administrasjon → 🗓 Nøkkelkalender** på v3-prod — admin-lista viser alle partisjoner |
| ☐ | E6. Application Insights for v2, hvis den er egen | Portalen. Ikke den v3-prod bruker |
| ☐ | E7. `stskjema3prod`, hvis B3 sa slett | `az storage account delete --name $V3BLANK --resource-group $RG --yes` |
| ☐ | E8. De stoppede Function App-ene `fhsskjema` og `fhsSkjemaV2` i `azuufscarg0006` | Rester etter v1, stoppet. Ikke lenket til noen SWA — bekreft først med `az staticwebapp backends show --name Skjema --resource-group fhs-prod-rg-01 -o table` (tom). Avklar med den som stoppet dem, og slett ressurs for ressurs |

E2 — listen først, så sletting. Les lista før du sletter:

```powershell
az role assignment list --assignee-object-id $V2MI --all --query "[].{rolle:roleDefinitionName, omfang:scope}" -o table
$ider = az role assignment list --assignee-object-id $V2MI --all --query "[].id" -o tsv
foreach ($id in $ider) { az role assignment delete --ids $id --output none }
```

E3 — påloggingsappen deles av v2 og v3. Bare gentle-dune skal bort:

```powershell
$APPID = az staticwebapp appsettings list --name $SWA --resource-group $RG --query "properties.AAD_CLIENT_ID" -o tsv
$alle = az ad app show --id $APPID --query 'web.redirectUris' -o tsv
$beholdes = @($alle) | Where-Object { $_ -and $_ -notlike "*$V2VERT*" }
$arg = @('ad', 'app', 'update', '--id', $APPID, '--web-redirect-uris') + $beholdes
az @arg
az ad app show --id $APPID --query 'web.redirectUris' -o tsv
```

Den siste skal vise `www`, `v3` og v3 sitt `azurestaticapps.net`-navn — og
ikke gentle-dune.

**Test etter E:**

| ☐ | Test | Forventet |
|---|---|---|
| ☐ | `az staticwebapp list --query "[?defaultHostname=='$V2VERT'].name" -o tsv` | Tomt |
| ☐ | **`az storage account show --name $DATA --query name -o tsv`** | **Kontonavnet — den skal FORTSATT finnes** |
| ☐ | `Invoke-RestMethod "$OFFENTLIG/api/ping"` | Svarer som før |
| ☐ | Logg inn på `www.fskjema.no` | Virker |

---

## F. Riving av pilot (v2-dev)

Dev-tenanten. v3-dev (`gray-beach-…`, `dev.v3.fskjema.no`) blir stående — det
er der testbrukerne er.

```powershell
az login --tenant 02ff6bc3-07c5-4ed5-835e-5c68c26ab8eb --use-device-code --output none
$PILOT = az staticwebapp list --query "[?starts_with(defaultHostname, 'ashy-meadow-0f2a44503')] | [0].{navn:name, rg:resourceGroup, vert:defaultHostname}" -o json | ConvertFrom-Json
$PILOT | Format-List
```

**Finn pilotens datakonto uten å skrive ut nøkkelen.** Den står i en
tilkoblingsstreng i app settings; bare kontonavnet hentes ut:

```powershell
$cs = az staticwebapp appsettings list --name $PILOT.navn --resource-group $PILOT.rg --query "properties.STORAGE_CONNECTION_STRING" -o tsv
$PILOTDATA = (($cs -split ';') | Where-Object { $_ -like 'AccountName=*' }) -replace '^AccountName=', ''
Remove-Variable cs
$PILOTDATA
```

> **Kontroller at `$PILOTDATA` ikke er v3-dev sin konto** (`stskjema3dev`) og
> ikke den delte lista-kontoen (se G4). Er den det, stopp.

| ☐ | Punkt | Kommando / sted |
|---|---|---|
| ☐ | F1. Pilotens jobber stoppes | `gh variable delete SWA_URL --repo $GHREPO` — pilot-radene i cron-workflowene hopper da over. Diagnose-workflowene leser den også (H) |
| ☐ | F2. Rollene til pilot-SWA-ens identitet | Som E1–E2, med `$PILOT.navn` / `$PILOT.rg`. Kokeboka sier de er levninger uten effekt |
| ☐ | F3. Pilotens redirect-URI | Som E3, men med `$APPID` fra pilot-SWA-ens `AAD_CLIENT_ID` og pilotens vertsnavn. Bruker bare pilot appen, kan den slettes i stedet — da også klienthemmeligheten (`AAD_CLIENT_SECRET`) |
| ☐ | F4. Slett pilot-SWA-en | `az staticwebapp delete --name $PILOT.navn --resource-group $PILOT.rg --yes` |
| ☐ | F5. Pilotens datakonto | Ta en siste backup om dataene skal tas vare på. Deretter `az storage account delete --name $PILOTDATA --resource-group $PILOT.rg --yes` |
| ☐ | F6. `kv-fhsskjema-pilot` | Slett, eller la stå som arkiv. Har den purge protection, blir den liggende slettet i oppbevaringstiden |
| ☐ | F7. Flyter bare pilot brukte | Slå av i Power Automate. v3-dev bruker sine egne, med Entra |

**Test etter F:**

| ☐ | Test | Forventet |
|---|---|---|
| ☐ | `az staticwebapp list --query "[?starts_with(defaultHostname, 'ashy-meadow')].name" -o tsv` | Tomt |
| ☐ | `Invoke-RestMethod https://dev.v3.fskjema.no/api/ping` | Svarer, `miljø` = `dev` |
| ☐ | Logg inn på `dev.v3.fskjema.no` | Virker |
| ☐ | Neste natt: en cron-workflow i GitHub | Pilot-raden hoppet over, ikke rød |

---

## G. Sikkerhet som strammes inn når v2 er borte

Dette er gevinsten. Alt her var umulig så lenge v2 brukte en delt nøkkel.

| ☐ | Punkt | Hvorfor | Test |
|---|---|---|---|
| ☐ | G1. Roter begge kontonøklene på datakontoen | Tilkoblingsstrengen sto i klartekst i v2 sine app settings (sikkerhetsdokumentet 7.2) | Se under |
| ☐ | G2. Slett `storage-connection-string` i `fhs-kv-01` | Ingen bruker den | `az keyvault secret show --vault-name $KV --name storage-connection-string` gir `SecretNotFound` |
| ☐ | G3. Fjern klienthemmeligheten på backup-appen | v3 bruker sertifikat. Hemmeligheten vinner over sertifikatet hvis begge er satt (kokeboka 0.5) | `az ad app credential list --id <backup-appens appId> --query "[].{navn:displayName, utloper:endDateTime}" -o table` er tom. Slett `graph-client-secret` i vaulten |
| ☐ | G4. Slå av delt nøkkel på datakontoen | Da finnes ingen nøkkel å lekke. **Først** etter testen under | `az storage account show --name $DATA --query allowSharedKeyAccess` gir `false` |
| ☐ | G5. Flytene krever Entra, og `sig=`-adressene slutter å virke | v2 kalte med `sig=`. v3 bruker token | Hver HTTP-trigger: «Spesifikke brukere i leieren». Et kall med den gamle `sig=`-URL-en og uten token gir 401 |
| ☐ | G6. Fjern SWA-identitetens storage-roller i dev | Levninger (kokeboka 7.3) | E2-kommandoen mot dev gir ingen storage-roller |

G1 — roter én nøkkel om gangen, og test mellom:

```powershell
az storage account keys renew --account-name $DATA --resource-group $RG --key primary --output none
Invoke-RestMethod "$OFFENTLIG/api/ping"
az storage account keys renew --account-name $DATA --resource-group $RG --key secondary --output none
```

Etter rotasjonen: send inn et testskjema. v3 bruker identiteten, ikke
nøkkelen, så ingenting skal merkes.

**Før G4 — er det noe som fortsatt bruker kontonøkkelen?** En konto-SAS er
signert med nøkkelen, og slutter å virke når delt nøkkel slås av. Den delte
lista-kontoen (oppgaver og nøkkelkalender, `TODO_STORAGE_CONNECTION_STRING`)
er den kjente kandidaten. Hent bare vertsnavnet:

```powershell
$sas = az keyvault secret show --vault-name $KV --name todo-storage-connection-string --query value -o tsv
(($sas -split ';') | Where-Object { $_ -like 'TableEndpoint=*' -or $_ -like 'BlobEndpoint=*' -or $_ -like 'AccountName=*' })
Remove-Variable sas
```

| Svaret | G4 |
|---|---|
| En annen konto enn `$DATA` | Kan slås av |
| `$DATA` | **Ikke slå av** — oppgavelista og nøkkelkalenderen slutter da å virke. Flytt dem først |

G4:

```powershell
az storage account update --name $DATA --resource-group $RG --allow-shared-key-access false --output none
```

Etterpå: logg inn, åpne et skjema med vedlegg, last ned vedlegget, og kjør
**Backup (delta)**. Alt går via identiteten og delegert SAS. Feiler noe, slå
den på igjen med `true` og les hva som feilet.

---

## H. GitHub og repoet

| ☐ | Punkt | Når |
|---|---|---|
| ☐ | H1. Slett hemmelighetene `AZURE_STATIC_WEB_APPS_API_TOKEN_PROD` (v2) og `AZURE_STATIC_WEB_APPS_API_TOKEN_ASHY_MEADOW_0F2A44503` (pilot) | Etter E og F |
| ☐ | H2. Slett `SCHEDULER_KEY` og `SCHEDULER_KEY_PROD` i GitHub | Etter E og F. Ingen workflow kaller da noen app |
| ☐ | H3. Slett GitHub-miljøet `pilot` | Etter F |
| ☐ | H4. Ryddelista i kokeboka kapittel 13 | En egen PR, etter E og F: de åtte cron-workflowene, tre deploy-workflows → én, `deploy_api`, `--velg`, `production` i `MILJO_ALIAS`, `KUN_I_MILJO`, inventaret for pilot |
| ☐ | H5. Dokumentasjonen | Samme PR: miljøtabellen i `CLAUDE.md`, og `SIKKERHET-OG-ARKITEKTUR.md`, som fortsatt beskriver v2 som gjeldende |

Test etter H1–H3:

```powershell
gh secret list --repo $GHREPO
gh variable list --repo $GHREPO
```

Ingen av de fire hemmelighetene i H1–H2 står i den første. `SWA_URL` og
`SWA_URL_PROD` står ikke i den andre.

---

## Klar?

v3-prod er eneste prod når **A–D** er grønne. v2 er borte når **E og F** er
grønne. Løsningen er ryddet når **G og H** er det. G kan tas i sin egen fart,
men G1 bør gjøres samme uke som E: nøkkelen som sto i klartekst, gjelder til
den er rotert.
