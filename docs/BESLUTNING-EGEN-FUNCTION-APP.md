# Beslutningsnotat: egen Function App i stedet for SWA Managed Functions

| | |
|---|---|
| Dato | 13.10.2026 |
| Status | **Steg 0, 1 og 2 gjort, steg 7 bevist, steg 3 del 1 i koden 16.10.2026. Forslaget står — ikke besluttet** |
| Gjelder | Punkt 2 og 3 i `docs/SIKKERHET-OG-ARKITEKTUR.md` kapittel 10 |
| Krever | Beslutning hos oppdragsgiver + ressursoppsett hos Cyberforsvaret |

## Spørsmålet

Hemmelighetene i løsningen står i klartekst i SWA Configuration, fordi SWA
Managed Functions verken eksponerer en managed identity til koden eller løser
`@Microsoft.KeyVault(...)`-referanser i app settings. Det er fastslått ved
forsøk i pilot 12.10.2026, ikke antatt (`docs/SIKKERHET-OG-ARKITEKTUR.md` 7.2).

Finnes det en arkitektur i Azure som håndterer dette ordentlig, og som
samtidig kan bruke Managed Identity mot Power Automate-flytene?

## Anbefalingen, kort

**Flytt API-et fra SWA Managed Functions til en egen Function App, lenket til
SWA-en som «bring your own functions».** Frontend, innlogging og ruteregler
blir liggende der de er.

Det fjerner klartekst-hemmelighetene, fjerner `STORAGE_CONNECTION_STRING`
helt, fjerner `SCHEDULER_KEY` og åtte cron-workflows, og gir Log stream
tilbake. Kodeendringen er liten.

Det løser **ikke** `FLOW_CALLBACK_KEY` (se «Hva det ikke løser»). Flytene er
en egen beslutning, og tas per flyt.

---

## 1. Hvorfor dette er en plattformbegrensning, ikke en designfeil

Microsofts egen sammenligning av de to API-modellene for Static Web Apps
lister `managed identity` og `Key Vault references` som **ikke støttet** for
managed functions og **støttet** for bring-your-own functions. Begrensningen
følger altså av hvilken av de to modellene som er valgt — ikke av hvordan
koden er skrevet.

Det betyr også at ingen mengde rolletildelinger eller omskriving løser det
innenfor dagens modell. Vi har prøvd begge retninger.

## 2. Alternativene som er vurdert

| Alternativ | Løser klartekst | MI mot storage | Timer-triggere | Kostnad å gjennomføre | Vurdering |
|---|---|---|---|---|---|
| **Bli stående** | nei | nei | nei | ingen | Akseptabelt i dag fordi listing av app settings er en privilegert ARM-operasjon. Men kontrollen er plattformens, ikke vår |
| **BYO Functions, lenket til SWA** | **ja** | **ja** | **ja** | lav–middels | **Anbefalt** |
| Frittstående Function App, frontend kaller direkte | ja | ja | ja | høy | SWA slutter å injisere `x-ms-client-principal`; hele `lib/auth.js` og tilgangsmodellen må legges om til egen token-validering. Gir til gjengjeld Entra-auth på inngående flyt-kall |
| Azure Container Apps | ja | ja | ja (egen scheduler) | høy | Mer infrastruktur å forvalte, uten at det løser noe BYO Functions ikke løser |

## 3. To ting gjør dette uvanlig billig akkurat her

**Vi er allerede på SWA Standard.** `rolesSource: "/api/roller-swa"` i
`staticwebapp.config.*.json` krever Standard-planen, og det er den samme
planen linked backend krever. Ingen oppgradering, ingen ny lisenskostnad på
SWA-siden.

**`api/host.json` har allerede `routePrefix: "api"`.** Rutene lander på
`/api/*` på en frittstående Function App nøyaktig slik SWA-proxyen forventer.
Koden er allerede Azure Functions v4 på Node 22 — samme kjøretid, samme
`app.http(...)`-registreringer.

Med andre ord: dette er i hovedsak infrastruktur, ikke omskriving.

---

## 4. Hva som endres i koden

### `api/src/lib/storage.js` og `api/src/lib/blob.js`

> **Gjort 16.10.2026.** Avsnittet her beskrev hva som skulle gjøres. Det er
> gjort — se 8j for hva som faktisk står i koden, og hva som gjenstår.

I dag bygges klientene med `fromConnectionString(...)`. Med en MI blir det
`new TableClient(url, tabell, new DefaultAzureCredential())` og
`new BlobServiceClient(url, new DefaultAzureCredential())`, der url-en bygges
fra et kontonavn — en ikke-sensitiv verdi som kan stå i `env.*.json`.

Begge modulene laster SDK-ene **lat**, slik at logikktestene kan kjøre uten
`node_modules`. Det mønsteret må beholdes: `@azure/identity` må lastes på
samme måte, ellers ryker `npm test` uten pakker.

**Én connection string overlever uansett.** `*Fra`-variantene i begge
modulene finnes for TODO-lista, som ligger på en annen tenant.
`TODO_STORAGE_CONNECTION_STRING` kan ikke erstattes av MI — en managed
identity virker ikke over tenantgrenser. Den blir stående som delt nøkkel, og
det skal da stå i dokumentasjonen som det ene gjenværende unntaket, ikke
glemmes bort fordi resten ble ryddet.

### `api/src/lib/keyvault.js`

Slutter å være død kode. Den er allerede skrevet for
`DefaultAzureCredential` + `KEYVAULT_NAME`, og vil virke som den står. Merk
at den da blir **et alternativ** til Key Vault-referanser i app settings, ikke
et tillegg: velg én vei og hold den. Referanser i app settings er enklest,
fordi koden ikke trenger å vite at Key Vault finnes.

### Cron-jobbene

Åtte GitHub Actions-workflows kaller i dag HTTP-endepunkter med
`x-scheduler-key`, fordi SWA Managed Functions ikke støtter timer-triggere.
På en egen Function App blir de `app.timer(...)`.

Det fjerner:

* åtte workflow-filer og `SWA_URL`-oppslagene i dem,
* `SCHEDULER_KEY` — én av tre delte nøkler,
* `x-scheduler-key`-vakten i sju handlere,
* og grunnen til at de sju endepunktene i det hele tatt er anonyme i
  gatewayen.

Endepunktene bør **bli stående** ved siden av timeren, med admin-vakt, så en
jobb fortsatt kan kjøres manuelt når noe har feilet. Men da er de ikke lenger
anonyme, og `docs/API-OVERSIKT.md` krymper tilsvarende.

### Alt annet

`lib/auth.js` er uendret. SWA injiserer `x-ms-client-principal` også når den
proxer til en lenket backend — det er dokumentert oppførsel, og det er
forutsetningen hele migreringen hviler på. **Den må verifiseres først**, se
steg 1 i planen under.

## 5. Hva som endres i infrastruktur

Dette er lista Cyberforsvaret trenger. Den overlapper med samtalen som
allerede står åpen om app-registreringen for prod-backup, så det bør tas i
samme runde.

1. **En Function App per miljø** (pilot, prod). Node 22, Flex Consumption
   eller Consumption. Samme region som SWA-en.
2. **En user-assigned managed identity** per miljø, knyttet til Function
   App-en. **Ikke system-assigned** — begrunnelsen står i 8g, og den er
   verdt å lese før noen oppretter noe: en system-assigned identitet dør med
   appen, og da må hver håndgitte tildeling under gjøres om.
3. **Rolletildelinger** på lagringskontoen i samme miljø:
   `Storage Table Data Contributor`, `Storage Blob Data Contributor` og
   `Storage Blob Delegator`. Den siste er den `backup.js` trenger for å lage
   en SAS uten kontonøkkel — se 8f. **`Contributor` er ikke en av dem**, og
   skal ikke tildeles.
4. **`Key Vault Secrets User`** på miljøets Key Vault, for at
   Key Vault-referanser i app settings skal løses.
5. **Lenking**: SWA-en konfigureres med Function App-en som linked backend.
   Azure setter da en identitetsleverandør «Azure Static Web Apps (Linked)» på
   Function App-en, som bare slipper gjennom trafikk proxet via SWA.
6. **`AzureWebJobsStorage`** settes opp som identitetsbasert tilkobling
   (`AzureWebJobsStorage__accountName` + MI), ellers har vi innført en ny
   connection string i klartekst samtidig som vi fjernet den gamle.
7. **Deploy**: `deploy-pilot.yml` og `deploy-prod.yml` får et ekstra steg som
   publiserer Function App-en. OIDC federated credential bør settes opp her
   med én gang — det er punkt 3 i kapittel 10, og det er billigere å gjøre nå
   enn å komme tilbake til.

### Hva som IKKE skal gjøres

Pilot-SWA-ens egen managed identity har storage-roller i dag. De er levninger
og uten effekt. **De skal ikke kopieres til Function App-ene «for sikkerhets
skyld»** — rollene hører på Function App-ens identitet, ikke på SWA-ens, og en
identitet med tilgang den ikke bruker er nettopp det vi prøver å slutte med.

---

## 6. Hva det ikke løser

**`FLOW_CALLBACK_KEY` blir stående.** Når Function App-en lenkes til SWA,
overtar SWA autentiseringen på den: backend-en konfigureres til bare å godta
trafikk proxet gjennom SWA. En Power Automate-flyt som kaller tilbake må
derfor fortsatt inn gjennom SWA, på en anonym rute, med en delt nøkkel i
headeren.

Svakhet 9.3 i overleveringsdokumentet — én nøkkel for fem inngangspunkter,
delt med skjemaeiere — trenger altså fortsatt sin egen løsning. De to veiene
som er skissert der (`STEG_CALLBACK_KEY`, eller HMAC-bundet `callbackUrl`)
gjelder uendret, og de er uavhengige av denne beslutningen. De kan gjøres før,
etter eller i stedet for.

**Krypteringsnøklene ligger fortsatt i samme lagringskonto som dataene.**
Tilgangen blir rollestyrt og revisjonsbar i stedet for en streng som kan limes
inn hvor som helst, men punkt 5 i kapittel 10 består.

**Linked backend virker ikke i PR-miljøer**, og det er **én Function App per
SWA**. Begge er greie her — vi har ingen PR-miljøer i bruk, og ett API — men
de skal være kjent før noen planlegger rundt dem.

---

## 7. Flytene: kan de bruke Managed Identity?

**Ja.** Det var et åpent spørsmål da dette kapitlet ble skrevet; 15.10.2026
ble det kjørt ende til ende. Se 8f for målingen.

Det er fortsatt en **egen beslutning per flyt**, ikke en del av migreringen
over. En flytendring er dyr: utrulling er en fire-stegs prosess på tvers av
tenanter (`docs/FLYT-DEPLOY.md`), så gevinsten må veies mot kostnaden for
hver enkelt flyt.

### 7.1 Entra-auth på HTTP-triggeren

Power Automates «when an HTTP request is received»-trigger kan kreve Entra i
stedet for SAS. Settes «hvem kan utløse flyten» til **Specific users in my
tenant** med identitetens `oid` i lista, forsvinner `sig=`-parameteren fra
URL-en, og kalleren må sende et bearer-token.

Det fjerner hele «lenken er en hemmelighet»-kategorien for flytene (9.1 i
overleveringsdokumentet), og gjør flyt-URLene til ordinære, ikke-sensitive
konfigurasjonsverdier.

Gevinsten er større enn bare det: **en SAS-signatur på avveie må byttes, og
alle som bruker den må få den nye. En `oid` som skal ut av lista, fjernes.**
Det er forskjellen på en hemmelighet og en tilgang.

#### Prøvd, ikke antatt

Kjørt 15.10.2026 med `testfapp`s managed identity mot en testflyt på
dev-tenanten (8f): `harSignatur: false`, og flyten svarte **200**.

Tre ting ble avklart underveis, og alle tre er verdt å ha skrevet ned før
noen prøver dette på en ekte flyt:

* **Allow-lista tar `oid`, ikke `appid`.** En managed identity har begge.
  `appid` ble prøvd først og avvist med `MisMatchingOAuthClaims`.
* **Audiencen må ha skråstrek til slutt.** Microsoft sier det rett ut:
  *«Audience values must be an exact match, including trailing slashes»* —
  for public cloud `https://service.flow.microsoft.com/`. Sammenligningen er
  bokstavelig og feiler på ett tegn.
* **`DefaultAzureCredential` klipper den skråstreken av.** SDK-en tar et
  *scope* (`<ressurs>/.default`) og oversetter det til plattformens
  `resource`-parameter ved å fjerne `/.default`. Avsluttende skråstrek
  forsvinner underveis, og `aud` blir feil. Tokenet må hentes fra
  `IDENTITY_ENDPOINT` med `resource` ordrett. Dette er den fellen som gjorde
  at prøven feilet tre ganger før den virket, og den er usynlig uten et felt
  som viser hva som faktisk ble spurt om.

**Ikke prøvd:** «Any user in my tenant». Det er ikke avklart om Power
Automate regner en tjenestehovedstol som en «user» der. Den eksplisitte lista
virker, og er uansett den strammere innstillingen.

**Forbeholdet som står:** flyten ser ikke hvem som kalte. Tokenet og claimene
er ikke tilgjengelige inne i flyten. Revisjonssporet flytter til Entras
pålogningslogger. For backup-kvitteringer betyr det lite; for noe som utløser
en masseutsending betyr det mer.

### 7.2 Det som kanskje er bedre: fjern flyten

For noen av flytene er svaret ikke å autentisere bedre, men å ikke ha dem.

Løsningen bruker allerede Microsoft Graph mot SharePoint, i dag med
`GRAPH_CLIENT_SECRET`. Med en Function App kan Graph-approller tildeles
**direkte til MI-ens tjenestehovedstol** — `Mail.Send` for e-post,
`Sites.Selected` for backup-opplasting. Da er det ingen hemmelighet igjen å
rotere: hverken flyt-URL eller client secret.

Cyberforsvaret bekreftet 15.10.2026 at dette er mulig, og at det er å
foretrekke framfor en «løs» app-registrering som ingen eier.

**Mekanismen.** En managed identity har en tjenestehovedstol i Entra, akkurat
som en app-registrering, og approller tildeles den direkte. For
`Sites.Selected` er det to trinn, som ellers:

1. **Approllen** tildeles MI-ens tjenestehovedstol i Entra.
2. **Sted-tilgangen** gis per SharePoint-site, med MI-ens `appId`.

Trinn 1 har **ingen portalknapp** — MI-er dukker ikke opp i «API
permissions»-bildet — så det gjøres med Graph eller PowerShell:

```powershell
Connect-MgGraph -Scopes "AppRoleAssignment.ReadWrite.All","Application.Read.All"
$mi    = Get-MgServicePrincipal -Filter "displayName eq '<identitetsnavn>'"
$graph = Get-MgServicePrincipal -Filter "appId eq '00000003-0000-0000-c000-000000000000'"
$rolle = $graph.AppRoles | Where-Object { $_.Value -eq 'Sites.Selected' -and $_.AllowedMemberTypes -contains 'Application' }
New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $mi.Id `
    -PrincipalId $mi.Id -ResourceId $graph.Id -AppRoleId $rolle.Id
```

Trinn 2 er `POST /sites/{siteId}/permissions` med MI-ens `appId`, eller
PnP-PowerShell. Det krever `Sites.FullControl.All` hos den som utfører det —
altså en engangsjobb for Cyberforsvaret, i samme runde som resten.

**Forbehold om kildene:** cmdlet-navnene og den nøyaktige formen på
site-grantet er skrevet fra hukommelsen, ikke lest i dokumentasjonen —
nettverkspolicyen i økta der dette ble skrevet blokkerte
`learn.microsoft.com`. Mekanismen er sikker; detaljene bør verifiseres. Samme
forbehold som kapittel 10.

`Mail.Send` som approlle lar appen sende som hvem som helst i tenanten, og må
derfor snevres med en **Application Access Policy** (`New-ApplicationAccessPolicy`
i Exchange Online) som binder den til én postboks. Det er en PowerShell-kommando
mot Exchange, ikke en portalknapp, så den hører hjemme i den samme samtalen med
Cyberforsvaret.

Avveiningen: e-postmaler og -formatering flytter fra Power Automate inn i kode.
Det er en fordel for sporbarhet og test, og en ulempe for den som er vant til å
endre teksten i flyten.

**Dette er IKKE kjørt.** 7.1 er målt ende til ende; 7.2 er fortsatt et
forslag, og forskjellen er verdt å holde fast ved.

Det vi har: Cyberforsvaret sier mekanismen finnes og er å foretrekke, og 8e
viste at identiteten får et token for `https://graph.microsoft.com/`.

Det vi ikke har: **et token er ikke tilgang** — det lærte vi to ganger i 8f,
først på tabellen og så på flyten. At approllen faktisk gir
`Sites.Selected`-opplasting, og at `Mail.Send` virker gjennom en Application
Access Policy, er ikke målt. Det er en egen prøve, på linje med `mi-tabell`
og `mi-blob`, og den bør kjøres i dev før noen planlegger rundt den.

---

## 8. Foreslått rekkefølge

Hvert steg er valgt slik at det kan **verifiseres før det neste begynner**.

**Omskrevet 15.10.2026.** Den opprinnelige planen la om pilot *på plass*:
steg 3 sa «les og skriv et skjema i pilot». Det er ikke lenger nødvendig, og
det var aldri ønskelig. Steg 1, 2 og 7 ble bevist på et prøveoppsett uten at
pilot merket noe, og den fremgangsmåten gjelder nå hele veien: **bygg et
komplett dev-miljø først, verifiser der ingenting står på spill, og flytt
pilot etterpå med en konfigurasjonsendring.**

Numrene 1–7 betyr det samme som før. Dev-miljøet er lagt til som **steg 0**
og pilot-overgangen som **steg 5b**, nettopp for at de rundt femti
henvisningene til «steg 3» og «steg 7» i dokumentasjonen fortsatt skal
stemme. Et stabilt nummer er mer verdt enn et pent et.

| Steg | Hva | Verifiseres ved |
|---|---|---|
| **0** | ✅ **Gjort 16.10.2026** — dev-miljøet står. Se 8i | `/api/ping` med riktig SHA, pålogging gir riktig UPN, hemmelighetene løses fra Key Vault, og begge MI-prøvene er grønne. Pilot og prod urørt |
| 1 | ✅ **Gjort 14.10.2026** — se «Utfallet av steg 1» under | `/api/ping` svarer med riktig SHA, og et endepunkt som krever innlogging gir riktig UPN. **Dette beviser at `x-ms-client-principal` følger med gjennom proxyen** — hele migreringen hviler på det |
| 2 | ✅ **Gjort 14.10.2026** — se «Utfallet av steg 2» under | `/api/system/info` viser riktig lengde og vertsnavn, ikke referansestrengen. Dette er den samme prøven som avslørte problemet 12.10.2026, bare motsatt vei |
| 3 | 🔶 **Del 1 gjort 16.10.2026** — `storage.js` og `blob.js` har begge veier, valget står i `lib/lagringsvalg.js`. Se 8j. **Del 2 gjenstår:** `backup.js` → user delegation SAS, og `kontoNavnFra()` → `STORAGE_ACCOUNT_NAME` | Hele testsuiten grønn, også uten `node_modules`. Deretter: les og skriv et skjema **i dev**. Pilot og prod er uendret fordi den nye veien er inert så lenge `STORAGE_CONNECTION_STRING` er satt |
| 4 | Flytt én cron-jobb til timer-trigger | Jobben kjører på klokke **i dev** i et døgn |
| 5 | Resten av cron-jobbene. Fjern `SCHEDULER_KEY` og de åtte workflowene | `node scripts/api-oversikt.js` viser færre anonyme endepunkter. `env-inventar.test.js` feiler hvis `SCHEDULER_KEY` henger igjen ett sted |
| **5b** | **Ta i bruk i pilot.** Sett `STORAGE_ACCOUNT_NAME`, fjern `STORAGE_CONNECTION_STRING`, tildel rollene. **Ingen kodeendring** | Et skjema leses og skrives i pilot. Går det galt, settes tilkoblingsstrengen tilbake — reversibelt på et minutt, uten deploy |
| 6 | Samme i **prod**, etter at pilot har stått i minst to uker | Alt over, i prod |
| 7 | ✅ **Bevist 15.10.2026** — se 8f. Entra-auth på flytene, `sig=` ut av trigger-URL-ene | Flyten svarer 200 på et MI-token, og URL-en har ingen signatur |

Steg 1 og 2 var de eneste som måtte gjøres i rekkefølge, og begge er gjort.

### Hvorfor steg 3 har to veier i samme kode

`storage.js` og `blob.js` velger managed identity når `STORAGE_ACCOUNT_NAME`
er satt og `STORAGE_CONNECTION_STRING` ikke er det — ellers tilkoblingsstreng,
som i dag.

Det gir tre ting:

* **`main` kan bære begge deler samtidig.** Dev kjører MI-veien mens pilot og
  prod står uendret. Ingen gren som lever sitt eget liv i ukevis.
* **Overgangen i 5b er en app-settings-endring, ikke en deploy.** Den kan
  rulles tilbake på et minutt ved å sette strengen inn igjen.
* **Koden er inert i pilot og prod** til noen setter variabelen. Et deploy med
  steg 3 i seg endrer ingen atferd der.

Prisen er en gaffel inne i koden, og den skal bort i steg 6 når prod er over.
**Valget må stå ett sted**, brukt av begge filene. To kopier av «hvilken
legitimasjon bruker vi» er nøyaktig feilklassen dette repoet lager flest av.

### Hvorfor ikke et eget repo eller en fork

Et fork isolerer kilden, mens risikoen ligger i ressursene og
konfigurasjonen. Det som deployer er workflows og Environments — ikke hvilke
filer som finnes. `deploy-pilot.yml` fyrer på push til `main`,
`deploy-prod.yml` er manuell med approval, og en `deploy-dev.yml` med bare
`workflow_dispatch` kan ikke røre noen av dem.

Det er demonstrert, ikke antatt: `deploy-funcapp-pilot.yml` og
`deploy-swa-proeve.yml` har ligget på `main` siden 14.10.2026, bygget en
komplett parallell løsning med egen SWA og egen Function App, og pilot og
prod merket ingenting.

Prisen ved et fork er derimot konkret: CLAUDE.md, 113 testfiler, `scripts/`
og hele `docs/` duplisert — og i ukene migreringen tar må hver rettelse i
løsningen som er i drift påføres to steder for hånd, uten noen test som
krever at de er enige. Det er feilklassen CLAUDE.md åpner med, gjort til
arbeidsmetode, samtidig som autentiseringsmodellen endres. En langlevd gren
er det samme med en big-bang-merge på slutten.

## 8b. Slik kjører du steg 1

> **Historikk.** Steg 1 ble gjort 14.10.2026, og prøveoppsettet er revet
> (se «Når forsøket er over» nedenfor). `deploy-swa-proeve.yml` og `proeve/`
> finnes ikke lenger. Kapitlet står igjen fordi fallgruvene i det er ekte og
> gjelder dev-miljøet også — **den levende oppskriften er 8g.**

### Hva som opprettes, og hva som allerede finnes

Fire ting lages. Tre av dem gir du et navn, og de navnene brukes om igjen
flere steder — det er de samme verdiene som står som `FUNCAPP`, `LAGRING` og
`SWA` i skriptet.

| Nytt | Hva det er | Navnet |
|---|---|---|
| **Function App** | Selve API-et, atskilt fra SWA-en. Blir `<navn>.azurewebsites.net` | `FUNCAPP` — du velger. **Globalt unikt** i hele Azure |
| **Lagringskonto** | Function App-runtime trenger sin egen til tilstand og låser. **Ikke** den som bærer dataene | `LAGRING` — du velger. Globalt unikt, 3–24 tegn, bare små bokstaver og tall |
| **Managed identity** | Opprettes på Function App-en, har ikke eget navn | — |
| **Tjenestehovedstol** | Så GitHub Actions kan deploye dit | `sp-skjema-funcapp-proeve`, eller det du vil kalle den |

I tillegg endres to ting som allerede finnes: tre rolletildelinger legges til,
og SWA-en får Function App-en lenket som backend.

Dette **finnes fra før** og skal bare pekes på:

| Finnes | Skriptets variabel | Hva du fyller inn |
|---|---|---|
| Ressursgruppa | `RG` | Den SWA-en ligger i |
| Static Web App | `SWA` | Pilot-SWA-en, eller prøve-SWA-en hvis du velger variant A |
| Key Vault | `KEYVAULT` | `kv-fhsskjema-pilot` |
| Lagringskontoen **med dataene** | `DATALAGRING` | Den `STORAGE_CONNECTION_STRING` peker på i dag |
| Region | `STED` | Samme som SWA-en |

> **`LAGRING` og `DATALAGRING` må være to forskjellige kontoer.** Setter du
> begge til den som bærer dataene, blander Function App-runtime sine egne
> køer, låser og tilstandstabeller inn blant skjemadataene — og de blir med i
> hver backup fra den dagen.

### Rekkefølgen betyr noe

> **Innholdet må på plass FØR lenkingen.** Første forsøk 14.10.2026 lenket
> backend-en til en SWA som aldri hadde hatt en vellykket deploy.
> Aktivitetsloggen bekreftet lenkingen, `backends show` viste den, og
> `/api/ping` svarte 404 — fordi en SWA uten build ikke ruter noe, heller
> ikke til en lenket backend.
>
> Oppsettet så altså riktig ut i alle kommandoene som finnes for å sjekke
> det. Det eneste som avslørte det, var `az staticwebapp environment list`:
> status `Uploading`, ikke `Ready`.

Og tjenestehovedstolen får tilgang **bare på Function App-en**, og kan derfor
ikke lages før Function App-en finnes:

Tjenestehovedstolen får tilgang **bare på Function App-en**, og den kan derfor
ikke lages før Function App-en finnes:

1. Kjør `scripts/steg1-funcapp.ps1` (steg 1–4): Function App, identitet,
   roller og prøve-SWA.
2. Lag tjenestehovedstolen, og legg utdata i GitHub-secreten
   `AZURE_FUNCAPP_CREDENTIALS`.
3. Kjør `deploy-funcapp-pilot.yml`. API-et ligger nå på Function App-en.
4. Legg innhold på SWA-en: `deploy-swa-proeve.yml`, med SWA-ens deploy-token
   i `SWA_PROEVE_TOKEN`.
5. **Bekreft at SWA-en faktisk serverer.** Rota skal vise «Prøve-SWA», ikke
   Azures standardside, og miljøet skal stå på `Ready`:
   ```
   az staticwebapp environment list --name <swa> --resource-group <rg> \
      --query "[].{Navn:name,Status:status}" -o table
   ```
   Står den på `Uploading`, er deployen ikke ferdig. Lenking hjelper ikke.
6. **Først nå:** lenk Function App-en til SWA-en.
7. Les svaret i `/api/ping`.

Skriptet stopper av seg selv mellom steg 4 og 6, med denne sjekklista.

Etter lenkingen svarer Function App-en **401 på direkte kall**. Det er riktig:
lenkingen setter Easy Auth på den, og bare trafikk proxet via SWA slipper inn.
Vil du teste den direkte, gjør det før du lenker.

### Filene

Alt som trengs ligger i repoet:

| Hva | Hvor |
|---|---|
| Oppretter ressursene | `scripts/steg1-funcapp.ps1` — tørrkjører som standard, `-Kjor` utfører |
| Legger innhold på prøve-SWA-en | `.github/workflows/deploy-swa-proeve.yml` |
| Deployer API-et dit | `.github/workflows/deploy-funcapp-pilot.yml` — kun manuell kjøring |
| Svarer på spørsmålet | `GET /api/ping`, feltet `principal` |

### Prøven

`/api/ping` svarer nå med en `principal`-blokk som sier om innloggingen nådde
fram til funksjonen:

```json
"principal": {
  "headerMottatt": true,
  "kunneLeses": true,
  "harUpn": true,
  "antallRoller": 3,
  "merknad": "innlogging mottatt og lest"
}
```

Den skiller tre tilstander som ellers ser like ut utenfra, og det er hele
poenget: et 403 kan ikke fortelle deg om headeren uteble, kom i stykker, eller
kom tom. Feltet settes alltid, med årsaken i seg.

**Endepunktet er anonymt, og svaret bærer hverken UPN eller rollenavn** — bare
om og hvor langt innloggingen kom. `api/test/ping-principal.test.js` krever
begge deler.

Slik leses svaret:

| `principal` | Betyr | Hva da |
|---|---|---|
| `headerMottatt: false` mens du er innlogget | SWA sender den ikke videre til en lenket backend | **Forslaget stopper her.** Skriv det inn i notatet med dato, og riv ned ressursene |
| `headerMottatt: true, harUpn: true` | Den kommer fram og lar seg lese | Forutsetningen holder. Gå til steg 2 |
| `headerMottatt: true, harUpn: false` | Den kommer, men er tom | Noter `merknad` og undersøk videre — dette er ikke et nei, men det er ikke et ja heller |

Sjekk først **uinnlogget**: da skal `headerMottatt` være `false`. Er den `true`
der, måler du noe annet enn du tror.

### To måter å kjøre den på

**A — egen prøve-SWA (anbefalt).** Opprett en SWA bare for forsøket, lenk
Function App-en til den, og la pilot stå urørt. Spørsmålet som skal besvares
er plattformens oppførsel, ikke pilots konfigurasjon, så en tom SWA svarer
like godt.

Ett forbehold: en lenket backend krever **Standard-planen**, så prøve-SWA-en
koster mens den står.

Innlogging trenger den ikke egen oppsett for. En SWA uten
`staticwebapp.config.json` bruker plattformens forhåndskonfigurerte
Entra-leverandør, og `/.auth/login/aad` virker uten app-registrering.
Registreringen i `staticwebapp.config.<miljø>.json` finnes for å LÅSE
innloggingen til én tenant — nødvendig i pilot og prod, unødvendig i et
forsøk som bare skal se om en header kommer fram.

Merk at en egen registrering slår av de forhåndskonfigurerte leverandørene.
Legger du inn en `auth`-blokk i prøve-SWA-en, må den være komplett.

**B — pilot-SWA-en.** Tester også at pilots egen config følger med gjennom
proxyen, som er en ting mer enn variant A svarer på.

> **Å lenke en backend ERSTATTER de managed functions SWA-en kjører i dag.**
> Fra det øyeblikket går all `/api/*`-trafikk på pilot til Function App-en.
> Det er ikke et parallellkjør.
>
> Angre: `az staticwebapp backends unlink`, og deretter en ordinær deploy fra
> `deploy-pilot.yml`.

Variant B bør derfor kjøres når ingen jobber i pilot, og med
`deploy-pilot.yml` klar til å kjøres igjen.

### Secreten deployen trenger

`deploy-funcapp-pilot.yml` logger inn med `AZURE_FUNCAPP_CREDENTIALS` i
GitHub-miljøet. For en prøve holder en tjenestehovedstol med `Contributor`
**bare på Function App-en** — ikke på ressursgruppa.

Kjøres **etter** at Function App-en er opprettet, siden omfanget peker på den.
`$FUNCAPP` og `$RG` er de samme verdiene du satte i skriptet:

```bash
SUB=$(az account show --query id -o tsv)

az ad sp create-for-rbac --name sp-skjema-funcapp-proeve \
    --role Contributor \
    --scopes "/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.Web/sites/$FUNCAPP" \
    --json-auth
```

**HELE JSON-objektet skal inn i secreten `AZURE_FUNCAPP_CREDENTIALS`** — ikke
bare `clientSecret`-verdien. `azure/login@v2` parser innholdet som JSON, og
får den noe annet, feiler den med

    Login failed with SyntaxError: Unexpected token 'R', "RB18Q~TkTU"...
    is not valid JSON

Secreten skal altså begynne med `{` og se slik ut:

```json
{
  "clientId": "<appId>",
  "clientSecret": "<passordet>",
  "subscriptionId": "<abonnements-id>",
  "tenantId": "<tenant-id>"
}
```

Passordet vises **bare én gang**. Har du mistet det, lag et nytt med
`az ad sp credential reset --id <appId>` og sett sammen JSON-en selv — den
kommandoen skriver ikke ut dette formatet, bare `appId`, `password` og
`tenant`.

Utdata er en hemmelighet: den limes rett inn i GitHub-secreten, ikke i en sak,
en e-post eller et chatvindu. Blir forslaget vedtatt, erstattes den av OIDC
federated credential (punkt 3 i kapittel 10), som ikke har en verdi som kan
lekke.

### Fallgruvene, funnet ved å kjøre det

Alle fire er funnet 14.10.2026, og alle fire ser ut som noe annet enn de er.

**1. Innholdet må på plass før lenkingen.**
En SWA uten en vellykket deploy ruter ingenting — heller ikke til en lenket
backend. Og oppsettet ser riktig ut i alt som finnes for å sjekke det:
aktivitetsloggen bekrefter `Register Static Site Build Linked Backend`,
`backends show` viser lenken, `functionapp function list` viser alle
funksjonene. `/api/ping` svarer 404 likevel.

Det eneste som avslører det:

```
az staticwebapp environment list --name <swa> --resource-group <rg> \
   --query "[].{Navn:name,Status:status}" -o table
```

`Ready` er svaret. `Uploading` eller `WaitingForDeployment` betyr at lenking
ikke vil hjelpe.

**2. Nedrigging må gjøres i rekkefølge: `unlink` FØR `delete`.**
Slettes SWA-en først, blir Easy Auth-konfigurasjonen stående igjen på Function
App-en. Neste forsøk på å lenke feiler med

    (Conflict) Cannot link backend with a preexisting Azure Static Web Apps
    configuration.

— en melding som ikke sier hvor restene ligger. `az webapp auth update -n
<funcapp> -g <rg> --enabled false` fjerner dem.

**3. 401 på direkte kall til Function App-en er riktig etter lenking.**
Lenkingen setter Easy Auth på den, og bare trafikk proxet via SWA slipper
inn. Vil du teste Function App-en direkte, gjør det FØR du lenker.

**4. Vertsnavnet er ikke `<navn>.azurewebsites.net`.**
Nye Function Apps får et regionalt navn med tilfeldig suffiks, som
`testfapp-bahdenbmgxgqbqhw.norwayeast-01.azurewebsites.net`. Hent det med
`az functionapp show --query defaultHostName -o tsv` i stedet for å gjette.

### Når forsøket er over

Uansett utfall: **skriv svaret inn i dette notatet, med dato.** Et forsøk
ingen har notert utfallet av, blir gjort på nytt om tre måneder.

**Revet 15.10.2026.** Forslaget ble vedtatt, så dette er ikke en nedrigging
av et mislykket forsøk — det er stillas som er erstattet. Hva som gikk og
hva som ble:

| Fjernet | Beholdt, og hvorfor |
|---|---|
| `proeve/swa-innhold/` | `scripts/steg1-funcapp.ps1` — bygger nå dev-miljøet (8g) |
| `.github/workflows/deploy-swa-proeve.yml` | `.github/workflows/deploy-funcapp-pilot.yml` — samme deploy-vei dev trenger |
| | `api/src/functions/mi-diagnose.js` — 8g krever at prøvene er grønne mot dev |

Hadde forslaget blitt lagt bort, skulle alle seks vært fjernet.

#### Riv ned i denne rekkefølgen

Rekkefølgen er ikke vilkårlig: det som peker på noe annet, må løsnes først,
ellers blir det liggende tildelinger og hemmeligheter som refererer til noe
som ikke finnes.

**1. Løsne det som peker på identiteten.** Den forsvinner med Function
App-en, og tildelingene blir stående som «Identity not found».

Det er ryddighet, ikke risiko: Azure gjenbruker ikke objekt-ID-er, så en
tildeling mot en slettet identitet gir ingen tilgang til noen. Grunnen til å
fjerne dem er at de gjør IAM-bildet uleselig — og «hvem har tilgang til denne
kontoen?» er et spørsmål en sikkerhetsevaluering stiller om nettopp
`stfhsskjemapilot`.

```
# Rolletildelingene på PILOT-kontoen — gitt til prøveappens identitet
az role assignment list --assignee <oid> --all \
    --query "[].{rolle:roleDefinitionName, scope:scope, id:id}" -o table

# Slett på ID, én per rad. --scope uten --role fjerner ALLE tildelinger for
# prinsipalen på det scopet, og da er det lett å ta med noe du ikke mente.
az role assignment delete --ids <id fra lista>
```

Fjern også identitetens `oid` fra testflytens liste over tillatte avsendere,
eller slett testflyten. En allow-liste med en `oid` som ikke finnes lenger,
er en rest som ser ut som en tilgang.

**2. Fjern prøvedataene i pilot-kontoen.** Tabellen `HelloTest` og
containeren `hello-test` ligger i `stfhsskjemapilot` — altså i et miljø i
drift, ikke i prøveoppsettet.

**3. Så selve ressursene:**

```
az staticwebapp backends unlink --name <swa> --resource-group <rg>
az staticwebapp delete --name <swa> --resource-group <rg> --yes
az functionapp delete --name <funcapp> --resource-group <rg>
az storage account delete --name <lagring> --resource-group <rg> --yes
```

**4. Til slutt legitimasjonen.** Dette er den viktigste, og den som lettest
blir glemt — en tjenestehovedstol ingen har bruk for, er en nøkkel ingen
passer på:

```
az ad sp delete --id <appId for sp-skjema-funcapp-proeve>
```

Og fjern GitHub-secretene `AZURE_FUNCAPP_CREDENTIALS` og `SWA_PROEVE_TOKEN`,
samt Key Vault-secreten `testflyt-flow-url` hvis den ble lagd. Dev får sine
egne; de skal ikke arve prøveoppsettets.

## 8c. Utfallet av steg 1

**Dato:** 14.10.2026
**Oppsett:** Function App `testfapp` (Node 22, Linux, Consumption, norwayeast)
lenket som backend til en egen prøve-SWA (Standard, westeurope). Uendret
API-kode fra `main`.

### Svaret er ja

`GET /api/ping` gjennom SWA-proxyen:

| | `principal` |
|---|---|
| Uinnlogget | `headerMottatt: false` |
| Etter `/.auth/login/aad` | `headerMottatt: true`, `kunneLeses: true`, `harUpn: true` |

**SWA sender `x-ms-client-principal` videre til en lenket backend.**
Forutsetningen hele forslaget hviler på, holder. `api/src/lib/auth.js` og
tilgangsmodellen trenger ingen endring for å flytte API-et ut av managed
functions.

Det var den ene tingen som kunne stoppet forslaget på et faktum. Den gjorde
det ikke.

### Hva prøven ikke svarer på

Forsøket brukte en tom prøve-SWA uten `staticwebapp.config.json`, med
plattformens forhåndskonfigurerte Entra-leverandør. Det er verifisert at
headeren kommer fram — ikke at pilots egen auth-konfigurasjon, med
tenant-låst issuer og `rolesSource`, oppfører seg likt gjennom proxyen.
Steg 2 og 3 kjøres mot pilot, og vil vise det.

### Hva det kostet

En arbeidsdag, mot anslaget «en formiddag». Tiden gikk ikke til Azure, men
til fire fallgruver som alle ser ut som noe annet enn de er (se 8b), og til
verktøyfeil rundt dem: SWA CLI-en feiler på Windows, `curl` i PowerShell er
`Invoke-WebRequest`, en `workflow_dispatch`-arbeidsflyt vises ikke i Actions
før fila ligger på standardgrenen, og en tjenestehovedstol med rolle bare på
én ressurs mister den når ressursen bygges opp igjen.

Anslaget for steg 2–6 bør justeres opp tilsvarende. Selve arbeidet er lite;
det er oppsettet rundt som tar tid første gang.

## 8d. Utfallet av steg 2

**Dato:** 14.10.2026
**Oppsett:** Samme Function App. `TEAM_SOK_EKSTERNT_FLOW_URL` satt til
`@Microsoft.KeyVault(SecretUri=https://FHSFunctionKeys.vault.azure.net/secrets/TestSecret/)`,
med appens system-assigned identity og rollen Key Vault Secrets User på
vaulten.

### Svaret er ja

Beviset ligger i lengden `/api/system/info` rapporterer:

| | `lengde` |
|---|---|
| Før | **90** — nøyaktig referansestrengen |
| Etter | **18** — innholdet i hemmeligheten |

Verdien koden leser har gått fra referansen til den løste hemmeligheten.
**En Function App løser `@Microsoft.KeyVault(...)` i app settings.** Det er
nøyaktig det SWA Managed Functions ikke gjør, prøvd i pilot 12.10.2026 med
samme variabel, der appen fikk referansestrengen på 109 tegn.

Dermed er punkt 2 i `docs/SIKKERHET-OG-ARKITEKTUR.md` kapittel 10 —
klartekst-hemmelighetene — teknisk løsbart ved å flytte API-et. Det er den
tyngste enkeltgevinsten i hele forslaget.

### To ting det kostet, som er verdt å vite

**`appsettings set` alene løser ikke referansen.** Appen må restartes, eller
referansene oppdateres eksplisitt:

```
az rest --method POST --uri "https://management.azure.com/<resourceId>/config/configreferences/appsettings/refresh?api-version=2022-03-01"
```

**Plattformen sier selv hvorfor en referanse ikke løses**, og det er en
vesentlig forskjell fra SWA. Dette endepunktet gir status og årsak per
referanse:

```
az rest --method GET --uri "https://management.azure.com/<resourceId>/config/configreferences/appsettings?api-version=2022-03-01"
```

Underveis ga den `AccessToKeyVaultDenied` med teksten «site was denied access
to Key Vault reference's vault» — årsaken var at rollen var gitt på feil
vault. På SWA fikk vi bare «uløst referanse», uten å vite hvorfor. At
feilsøkingen er mulig i det hele tatt, er et argument for forslaget i seg
selv.

### En feilmelding som nå gjetter feil

`maskFlytUrl` i `api/src/functions/system.js` sier «ikke en gyldig URL —
uløst Key Vault-referanse?» når en flyt-variabel ikke lar seg parse. På SWA
var den gjetningen nesten alltid riktig. På en Function App er den det ikke:
her kom meldingen fordi prøvehemmeligheten ikke inneholdt en URL, mens
referansen var løst helt fint.

`maskLengde`, som faktisk sjekker om verdien ER en referanse, var stille —
den sjekken er riktig og skal stå. Det er bare gjetningen i `maskFlytUrl`
som bør mykes opp hvis forslaget vedtas.

## 8e. Managed identity i koden — premisset for steg 3 og 7

**Dato:** 14.10.2026
**Hvordan:** `GET /api/diagnose/mi-token?ressurs=<audience>` på `testfapp`.

### Koden får et MI-token

| Ressurs | `ok` | `aud` i tokenet |
|---|---|---|
| `https://storage.azure.com/` | ja | `https://storage.azure.com` |
| `https://service.flow.microsoft.com/` | ja | `https://service.flow.microsoft.com` |

Samme identitet i begge: `oid` `64eac771-…`, `tid` `e4fcc393-…`.

**Dette er det SWA Managed Functions ikke kan.** Der eksponeres ingen
MI-token til funksjonskoden i det hele tatt, og det er grunnen til at
`api/src/lib/keyvault.js` er død kode og at all lagring går via
`STORAGE_CONNECTION_STRING`.

* **Storage-tokenet** er premisset for steg 3: `storage.js` og `blob.js` kan
  legges om til `DefaultAzureCredential`, og kontostrengen kan forsvinne.
* **Flow-tokenet** er premisset for steg 7: en managed identity *kan* få et
  token for Power Automate. Kildene beskrev bare app-registrering med client
  credentials, aldri MI — det var den åpne antagelsen, og den holdt.

### Hva dette IKKE beviser

**Et token er ikke tilgang.** Prøven viser at identitetsendepunktet virker i
koden og at audiencen godtas av Entra. Den sier ingenting om hvorvidt
rolletildelingene faktisk gir lese- og skrivetilgang til tabellene, eller om
en flyt godtar tokenet.

De to neste prøvene er derfor — **begge er kjørt, se 8f**:

* **Steg 3:** les og skriv en tabell med `DefaultAzureCredential` mot
  datalagringskontoen. Først da er kontostrengen beviselig overflødig.
* **Steg 7:** sett én dev-flyts trigger til «Specific users in my tenant»
  med `oid` fra tokenet, se at `sig=` forsvinner fra trigger-URL-en, og kall
  den med MI-tokenet.

`oid` i tokenet er verdien Power Automate vil ha i allow-lista. Den skal være
den samme som
`az functionapp identity show --query principalId`.

### Forbehold om tenant

Flytene finnes også på dev-tenanten, så ende-til-ende-prøven er mulig — men
bare hvis Function App-en ligger i **samme tenant** som dev-flytene. En
managed identity kan ikke stå i en allow-liste i en annen tenant; det er
samme begrensning som gjør at `TODO_STORAGE_CONNECTION_STRING` må være en
delt nøkkel.

## 8f. Utfallet av de to tilgangsprøvene — steg 3 og 7

**Hvordan:** `GET /api/diagnose/mi-tabell` og `GET /api/diagnose/mi-flyt` på
`testfapp`, gjennom prøve-SWA-en.

**Kort fasit: begge stegene er bevist, i full bredde.** Tabell og blob leses
og skrives med managed identity uten tilkoblingsstreng, en SAS laget med
user delegation key henter blobben, og en flyt uten SAS-signatur i URL-en
svarer 200 på et MI-token.

Premissene forslaget hviler på er dermed målt, ikke antatt. Det som
gjenstår i steg 3 er å skrive om koden — ikke å finne ut om det går.

Veien dit er verdt å lese, for begge stegene begynte med en 403 som så ut
som et nei og ikke var det. En avvisning fra *autorisasjons*-leddet betyr at
tokenet kom fram og ble godtatt som legitimasjon — det er et helt annet svar
enn at det ble avvist. Hver 403 under sier hvilket ledd den kom fra, og det
er den forskjellen som flyttet saken videre hver gang.

### Tabellen — tokenet slipper inn, rollen mangler (steg 3)

> Dette var første forsøk. Se også «Fellen i steg 3» nederst: andre forsøk
> ga `Contributor`, som er feil rolle på en måte det er verdt å kjenne.

**Dato:** 14.10.2026, 19:33 UTC (klokkeslettet står i feilmeldingen fra
Table Storage).
**Kall:** `?konto=stfhsskjemapilot&tabell=HelloTest`

| Felt | Verdi |
|---|---|
| `lese.ok` | nei |
| `lese.statuskode` | 403 |
| feilkode | `AuthorizationPermissionMismatch` |

**Hva dette fastslår:** autentiseringen gikk gjennom hele veien fra managed
identity til `storage.azure.com`. `AuthorizationPermissionMismatch` er
dataplanets *autorisasjons*-avvisning. Var tokenet ugyldig, utløpt eller
utstedt for en annen audience, ville svaret vært `AuthenticationFailed` med
401 — en annen feilkode, fra et annet ledd.

**Hva som gjenstår:** rolletildelingen. Identiteten `64eac771-…` har ingen av
`Storage Table Data`-rollene på `stfhsskjemapilot`.

Fellen her er verdt å skrive ned, for den koster alltid en runde:
**kontrollplan er ikke dataplan.** `Reader`, `Contributor` og `Owner` på
storage-kontoen gir *ingen* lese- eller skrivetilgang til tabellrader. Bare
`Storage Table Data Reader` og `Storage Table Data Contributor` gjør det, og
en tildeling som ser riktig ut i portalen gir samme 403 hvis den er av feil
type.

I portalen går den korteste veien fra identiteten, ikke fra kontoen:
**Function App → Identity → System assigned → Azure role assignments**. Der
er prinsipalen forvalgt. Fra kontoens IAM-fane må man velge **Managed
identity** som medlemstype — under *User, group, or service principal* er
managed identities ofte ikke søkbare på navn, og det er der folk konkluderer
feil.

### Flyten, første forsøk — signaturen er borte, claims avvist (steg 7)

**Dato:** 15.10.2026
**Kall:** `?envVar=TESTFLYT_FLOW_URL`

| Felt | Verdi |
|---|---|
| `url.harSignatur` | **nei** |
| `url.vertsnavn` | `…environment.api.powerplatform.com` |
| `url.antallParametere` | 1 |
| `token.ok` | ja |
| `token.claims.aud` | `https://service.flow.microsoft.com` |
| `token.claims.appid` | `3be2b536-…` |
| `token.claims.oid` | `64eac771-…` |
| `token.claims.tid` | `e4fcc393-…` |
| `kall.statuskode` | 403 |
| feilkode | `MisMatchingOAuthClaims` |

**`harSignatur: false` er hovedfunnet.** Trigger-URL-en bærer ikke lenger
`sig=`. Det var den åpne antagelsen bak hele steg 7, og den holder: en
Power Automate-flyt *kan* settes til å kreve Entra i stedet for en
SAS-signatur i query-strengen. Verten skifter samtidig fra Logic
Apps-formen til `environment.api.powerplatform.com`, som er OAuth-formen av
invoke-endepunktet.

Dermed er svakhet 9.1 i `docs/SIKKERHET-OG-ARKITEKTUR.md` — «lenken *er*
nøkkelen» — i prinsippet lukkbar. Ikke lukket, men ikke lenger en antagelse.

**Hva 403-en betyr:** flyten tok imot bearer-legitimasjonen, leste claims ut
av den og sammenlignet dem mot en tilgangspolicy. Den fant ikke avsenderen i
lista. `MisMatchingOAuthClaims` er policy-sammenligningens feilkode, ikke
tokenets: et ugyldig eller feil signert token gir 401 `Unauthorized`, uten
noen claims-vurdering.

Tre av fire ledd står altså:

1. URL-en kan kvitte seg med signaturen. **Vist.**
2. Koden får et token for Flow-audiencen. **Vist** (8e, bekreftet her).
3. Flyten godtar formen og evaluerer claims. **Vist.**
4. Policyen tillater nettopp denne avsenderen. **Åpent** — løst nedenfor.

### Punkt 4: skråstreken

Begge varianter av allow-lista — `oid` og `appid` — ble prøvd 15.10.2026, og
begge ga samme `MisMatchingOAuthClaims`. Da er ikke lista forklaringen.

Microsofts dokumentasjon for HTTP-triggeren sier hvilke claims som kreves, og
én setning avgjør saken:

> Audience values must be an exact match, **including trailing slashes**.
>
> | Cloud | Audience |
> |---|---|
> | Public cloud | `https://service.flow.microsoft.com/` |

Tokenet vårt bærer `aud: "https://service.flow.microsoft.com"` — **uten**
skråstrek. Det er en bokstavelig strengsammenligning, og den feiler på ett
tegn.

**Og årsaken ligger i vårt eget lag, ikke i Entra.** `DefaultAzureCredential`
tar et *scope* (`<ressurs>/.default`). På App Service oversetter SDK-en det
til plattformens `resource`-parameter ved å klippe av `/.default`, og da
forsvinner en avsluttende skråstrek i ressursen underveis. Vi har aldri bedt
om audiencen dokumentasjonen beskriver.

Plattformens eget identity-endepunkt tar `resource` ordrett. `mi-flyt` og
`mi-token` fikk derfor en `tokenkilde`-parameter:

```
/api/diagnose/mi-flyt?envVar=TESTFLYT_FLOW_URL&tokenkilde=plattform
/api/diagnose/mi-token?ressurs=https://service.flow.microsoft.com/&tokenkilde=plattform
```

| `tokenkilde` | Hvordan | `ressursSomBleSpurtOm` |
|---|---|---|
| `sdk` (standard) | `getToken('<ressurs>/.default')` | skråstreken klippes av |
| `plattform` | `IDENTITY_ENDPOINT?resource=<ressurs>` | ordrett |

Svaret bærer `ressursSomBleSpurtOm` nettopp for at det skal være **synlig**
hvilken streng som faktisk gikk ut. Uten det feltet ville forskjellen mellom
de to veiene vært usynlig i diagnosen, og det er hele forskjellen.

`IDENTITY_HEADER` er legitimasjon på linje med tokenet: den leses, går i
`X-IDENTITY-HEADER`, og kommer aldri ut i et svar eller en feilmelding.

### Steg 7 er bevist

**Dato:** 15.10.2026
**Kall:** `?envVar=TESTFLYT_FLOW_URL&tokenkilde=plattform`, med `oid` lagt inn
i triggerens liste over tillatte avsendere.

| Felt | Verdi |
|---|---|
| `url.harSignatur` | **nei** |
| `tokenkilde` | `plattform` |
| `ressursSomBleSpurtOm` | `https://service.flow.microsoft.com/` |
| `token.claims.aud` | `https://service.flow.microsoft.com/` |
| `kall.statuskode` | **200** |

Skråstreken var hele forskjellen. `ressursSomBleSpurtOm` og `aud` viser at
den gikk ut og kom tilbake, og flyten svarte 200.

**Det grunnleggende spørsmålet er dermed besvart: Power Automate godtar en
tjenestehovedstol som avsender.** Den må stå i triggerens liste med `oid` —
ikke `appid`, som ble prøvd og avvist.

Dette er hele steg 7, kjørt ende til ende:

* en flyt kan kreve Entra i stedet for en SAS-signatur,
* trigger-URL-en slutter da å være en hemmelighet,
* en managed identity kan kalle den,
* og tilgangen kan trekkes tilbake ved å fjerne `oid` fra lista — uten å
  rotere noen nøkkel, og uten å oppdatere noen app setting.

Det siste punktet er den egentlige gevinsten. En SAS-signatur som er kommet
på avveie må byttes, og alle som bruker den må få den nye. En `oid` som skal
ut av lista, fjernes.

### Status for de to stegene

| Steg | Status | Hva som mangler |
|---|---|---|
| 3 — storage uten delt nøkkel | **Bevist 15.10.2026** — tabell og blob, SAS inkludert | ingenting |
| 7 — flyt uten SAS-signatur | **Bevist 15.10.2026** | ingenting |

### Steg 3 er bevist for tabell

**Dato:** 15.10.2026
**Kall:** `?konto=stfhsskjemapilot&tabell=HelloTest&skriv=ja`, med
`Storage Table Data Contributor` på kontoen.

| Felt | Verdi |
|---|---|
| `lese.ok` | ja, `antallLest: 3` |
| `skrive.ok` | ja |
| `rydding.ok` | ja |

Lesing, skriving og opprydding med `DefaultAzureCredential`, uten
tilkoblingsstreng. `STORAGE_CONNECTION_STRING` er dermed beviselig
overflødig for tabellbruk.

### Fellen i steg 3: `Contributor` er ikke en datarolle

Første forsøk på å gi tilgang ga `Contributor` på storage-kontoen. Det er en
**kontrollplan**-rolle: den gir rett til å forvalte kontoen, ikke til å lese
en tabellrad. Samme `AuthorizationPermissionMismatch` som før.

Og den er verre enn bare utilstrekkelig: `Contributor` på en storage-konto gir
rett til å **liste kontonøklene**. Identiteten får dermed full datatilgang
likevel, gjennom en sidedør, med den delte nøkkelen vi holder på å fjerne.
Rollen skal fjernes, ikke suppleres.

Riktig rolle er `Storage Table Data Contributor` (eller `…Data Reader` for
bare lesing).

### Hva steg 3 krever i den ekte appen

Rollene:

| Rolle | Hvorfor |
|---|---|
| `Storage Table Data Contributor` | `lib/storage.js` — all tabellbruk |
| `Storage Blob Data Contributor` | `lib/blob.js` — vedlegg, logoer, backup |
| `Storage Blob Delegator` | SAS-en i `backup.js`, se under |

Kø og filshare brukes ikke, så de trenger ingen roller.

**To steder er ikke en utbytting av klient.** Resten av koden bytter
`fromConnectionString(cs)` mot `new Klient(url, legitimasjon())` og er ferdig.
Disse to er ikke det:

**1. SAS-en i `backup.js`.** `lagSasUrl()` river kontonøkkelen ut av
`STORAGE_CONNECTION_STRING` og signerer med den:

```js
const { konto, key } = hentKontoOgNokkel();   // parser AccountKey ut av strengen
const cred = new StorageSharedKeyCredential(konto, key);
```

En managed identity kan ikke bygge en `StorageSharedKeyCredential` — det
finnes ingen nøkkel å signere med. MI-veien er `getUserDelegationKey()` og
signering med den i stedet, og det er `Storage Blob Delegator` som gir rett
til å be om den. SAS-en er på 24 timer (`SAS_GYLDIG_TIMER`), og user
delegation SAS har tak på 7 døgn, så levetiden er ikke noe hinder.

Dette er det eneste stedet i `api/src` som genererer en SAS.

**2. `kontoNavnFra()`.** Koden henter kontonavnet ut av tilkoblingsstrengen
flere steder (`nokkelkalender-storage.js`, `todo-storage.js`, `backup.js`).
Uten streng finnes ikke navnet, og `STORAGE_ACCOUNT_NAME` går fra
`kun_dokumentasjon` i `config/env.*.json` til en **påkrevd** app setting.
`api/test/env-inventar.test.js` vil kreve det idet koden begynner å lese den.

Begge er små, men ingen av dem er synlige fra «bytt klientkonstruktøren».

### Blobprøven: `/api/diagnose/mi-blob`

```
GET /api/diagnose/mi-blob?konto=<navn>&container=<navn>[&skriv=ja]
```

Den måler fire ting **hver for seg**, fordi de kommer fra hver sin rolle og
kan feile uavhengig:

| Felt i svaret | Hva det svarer på | Rolle |
|---|---|---|
| `lese` | Kan identiteten liste blober? | `Storage Blob Data Reader` |
| `delegering` | Får den en user delegation key? | `Storage Blob Delegator` |
| `skrive` | Kan den laste opp? (`&skriv=ja`) | `Storage Blob Data Contributor` |
| `sasKall` | **Virker SAS-en faktisk?** (`&skriv=ja`) | begge over |

`sasKall` er den som avgjør om `backup.js` kan legges om. De tre første kan
være grønne mens den er rød — det er nettopp det `Storage Blob Delegator`
skiller. Prøven lager en SAS med delegeringsnøkkelen, henter blobben med
den, og sammenligner innholdet med det den selv skrev. `fikkRiktigInnhold`
skiller «fikk et svar» fra «fikk riktig svar».

Delegeringen prøves **uansett** hvordan lesingen gikk, siden rollene er
ulike. En grønn `delegering` med rød `lese` er et meningsfullt resultat.

Hva som ikke kommer ut av endepunktet:

* **Delegeringsnøkkelens `value`.** Den er selve signeringshemmeligheten —
  den som har den, kan lage gyldig SAS for alt identiteten rekker, til den
  utløper. Svaret har lengden og `signedObjectId` / `signedTenantId` /
  `signedExpiresOn`, som identifiserer uten å signere.
* **SAS-URL-en.** Den bygges, brukes i kallet, og forlater aldri funksjonen.
  En SAS *er* tilgangen.
* **Blobnavn.** Vedlegg er navngitt av innsendere, og et filnavn kan være en
  personopplysning i seg selv. Bare antallet leses ut. Unntaket er
  prøveblobben vi lager selv: den navngis hvis oppryddingen feiler, for da
  må noen fjerne den for hånd.

Prøveblobben heter `mi-prove-<tidsstempel>.txt` og slettes igjen. Skriving
og opprydding rapporteres hver for seg, som i tabellprøven.

#### Utfallet

**Dato:** 15.10.2026
**Kall:** `?konto=stfhsskjemapilot&container=hello-test&skriv=ja`, med
`Storage Blob Data Contributor` og `Storage Blob Delegator` på kontoen.

| Felt | Verdi |
|---|---|
| `lese.ok` | ja, `antallLest: 3` |
| `delegering.ok` | ja |
| `delegering.nokkel.signedObjectId` | `64eac771-…` — MI-ens egen `oid` |
| `delegering.nokkel.signedService` | `b` (blob) |
| `skrive.ok` | ja |
| **`sasKall.ok`** | **ja, statuskode 200** |
| **`sasKall.fikkRiktigInnhold`** | **ja** |
| `rydding.ok` | ja |

`sasKall` er den avgjørende: en SAS laget med delegeringsnøkkelen hentet
blobben, og innholdet stemte med det prøven selv skrev. **`backup.js` kan
legges om til user delegation SAS.**

`signedObjectId` bekrefter at det var riktig identitet som signerte — ikke
bare at *en* nøkkel kom tilbake.

Med dette er steg 3 komplett: tabell, blob, delegering og SAS, alle målt.

## 8g. Slik bygges dev-miljøet (steg 0)

Målet er et **komplett, uavhengig miljø i dev-tenanten** som kjører samme
kode som pilot og prod, men med managed identity hele veien. Ingenting her
rører miljøene i drift.

Rekkefølgen under er valgt slik at hvert ledd kan verifiseres før det neste,
og fellene er de vi faktisk gikk i under steg 1 og 2.

### 1. Ressursene i dev-tenanten

| Ressurs | Merknad |
|---|---|
| Ressursgruppe | Egen, så opprydding er én kommando |
| Storage-konto | **Tom.** Se «Ikke kopier data» under |
| Key Vault | Dev-tenantens egen |
| Managed identity | **User-assigned**, egen ressurs. Se under |
| Function App | Consumption eller Flex. Knyttet til identiteten over, med `AZURE_CLIENT_ID` som app setting |
| Static Web App | **Standard-plan.** Free støtter ikke linked backend |
| Entra app-registrering | Egen, med redirect URI for dev-SWA-ens vertsnavn |

`scripts/steg1-funcapp.ps1` lager identiteten, Function App-en, lagrings-
kontoen og SWA-en, og lenker dem. Den tørrkjører som standard; `-Kjor`
utfører.

#### Hvorfor user-assigned, og ikke system-assigned

En system-assigned identitet lever og dør med ressursen. Slettes Function
App-en — eller gjenskapes den, i en opprydding eller en flytting mellom
ressursgrupper — får den ny `oid` og ny `appId`. Da er **alt som er håndgitt
borte**:

| Tildeling | Hvem må gjøre den om |
|---|---|
| De tre storage-rollene | dere selv |
| `Key Vault Secrets User` | dere selv |
| Graph-approller (`Sites.Selected`, `Mail.Send`) | **Cyberforsvaret** |
| SharePoint-tilgang per site | **Cyberforsvaret** |
| Application Access Policy for `Mail.Send` | **Cyberforsvaret** |
| `oid` i Power Automate-flytenes allow-liste | den som eier flyten |

Seks manuelle tildelinger, halvparten av dem utenfor deres egen kontroll,
fordi noen slettet en app. Og `oid`-en i flyt-allow-lista er ikke en teoretisk
bekymring — 8f viste at det er nettopp `oid` Power Automate sammenligner mot.

En user-assigned identitet er en selvstendig ressurs. Den overlever at
Function App-en gjenskapes, kan knyttes til en erstatning, og beholder
`oid`-en og `appId`-en sin.

Prisen er én app setting: `DefaultAzureCredential` må få vite hvilken
identitet den skal bruke, via **`AZURE_CLIENT_ID`**. Uten den prøver den
system-assigned og feiler med en melding om at ingen identitet er
tilgjengelig — som ser ut som at managed identity ikke er slått på i det
hele tatt.

`AZURE_CLIENT_ID` må derfor inn i `config/env.dev.json` sammen med de andre
— **og `env-inventar.test.js` vil ikke fange det hvis den glemmes.** Testen
leter etter `process.env.X` i `api/src`, og denne variabelen leses av
`@azure/identity`, ikke av vår egen kode. Den er med andre ord like påkrevd
som de andre og den eneste uten et nett under seg.

#### Og én innstilling til: `keyVaultReferenceIdentity`

`AZURE_CLIENT_ID` dekker bare koden. **Key Vault-referanser løses av
plattformen, ikke av koden**, og plattformen bruker **system-assigned**
identitet med mindre den får beskjed om noe annet.

Med bare en user-assigned identitet feiler derfor hver eneste referanse,
uansett hvor riktig rolletildelingen på vaulten er:

```
Identity:      System assigned managed identity
Status:        MSINotEnabled
Error details: Reference was not able to be resolved because site
               Managed Identity not enabled.
```

Det ser ut som en manglende rettighet, og er det ikke. Prøvd 15.10.2026 på
`fa-skjema-3-dev`, med `Key Vault Secrets User` korrekt tildelt
`mi-skjema-3-dev`.

Rettes med en egenskap på selve appen — ikke en app setting:

```
$id = az identity show --name <identitet> --resource-group <rg> --query id -o tsv
az functionapp update --name <funcapp> --resource-group <rg> `
  --set keyVaultReferenceIdentity=$id --output none
```

Den tar **ressurs-ID-en**, ikke `clientId`. Restart appen etterpå.

`scripts/steg1-funcapp.ps1` setter begge to.

#### Fire GUID-er, og tre av dem hører til samme identitet

Dette kostet tre runder 15.–16.10.2026. En managed identity har **tre**
forskjellige identifikatorer, og hvert sted vil ha sin:

| Hvor | Hvilken | Hentes med |
|---|---|---|
| `AZURE_CLIENT_ID` (app setting) | MI-ens **clientId** | `az identity show … --query clientId` |
| `keyVaultReferenceIdentity` (egenskap på appen) | MI-ens **ressurs-ID** | `az identity show … --query id` |
| Rolletildelinger på storage og Key Vault | MI-ens **principalId** | `az identity show … --query principalId` |
| `AAD_CLIENT_ID` (app setting) | **app-registreringens** client-ID | Entra → App registrations |

De tre øverste er ulike verdier på samme objekt. Den nederste er en helt
annen ting: app-registreringen er brukernes innlogging, og har ingen rolle i
hva koden autentiserer seg som mot storage.

Feilmeldingene forteller hvilken som er feil, hvis man leser dem bokstavelig:

* `No User Assigned or Delegated Managed Identity found for specified
  ClientId` → `AZURE_CLIENT_ID` peker ikke på en managed identity. Enten er
  det `principalId`, eller det er app-registreringens client-ID.
* `MSINotEnabled … site Managed Identity not enabled` →
  `keyVaultReferenceIdentity` er ikke satt, så plattformen faller tilbake på
  system-assigned, som ikke finnes.
* `AuthorizationPermissionMismatch` → identiteten er riktig, rollen mangler.
  Se «Fellen i steg 3».

#### Rettighetene er ikke synlige i portalen

En app-registrering viser rettighetene sine under «API permissions». En
managed identity gjør det ikke — Graph-approller tildelt en MI er bare
synlige via et Graph-oppslag.

Det er en reell ulempe for forvaltning og for en sikkerhetsevaluering:
«hva har denne identiteten lov til?» blir et spørsmål som krever en
kommando, ikke et blikk. Den som setter dette opp, bør skrive ned hva som
ble tildelt — ellers er det usynlig for den som overtar.

### 2. Roller på Function App-ens identitet

Målt i 8f — dette er ikke en antagelse om hva som trengs:

| Rolle | På | Hvorfor |
|---|---|---|
| `Storage Table Data Contributor` | storage-kontoen | `lib/storage.js` |
| `Storage Blob Data Contributor` | storage-kontoen | `lib/blob.js` |
| `Storage Blob Delegator` | storage-kontoen | SAS-en i `backup.js` |
| `Key Vault Secrets User` | Key Vault | app settings med KV-referanser |

**`Contributor` er ikke en av dem, og skal ikke tildeles.** Den er en
kontrollplan-rolle som ikke gir tilgang til en eneste tabellrad — og den gir
rett til å liste kontonøklene, altså full datatilgang gjennom en sidedør,
med den delte nøkkelen hele øvelsen går ut på å fjerne. Se «Fellen i steg 3»
i 8f.

Tildel med `--assignee-object-id` og `--assignee-principal-type
ServicePrincipal`. Kortformen `--assignee` slår opp prinsipalen i Graph
først, og for managed identities feiler eller henger det oppslaget ofte — en
feil som ser ut som manglende rettigheter hos deg.

Regn med noen minutter før en tildeling slår inn. Samme 403 rett etterpå er
ikke et svar.

### 3. Endringene i repoet

Et tredje miljø finnes ikke i dag, og det står flere steder. Alle må med,
ellers svarer de ulikt:

| Fil | Hva |
|---|---|
| `config/env.dev.json` | Ny inventarliste |
| `staticwebapp.config.dev.json` | Ny, med auth mot dev-app-registreringen |
| `.github/workflows/deploy-dev.yml` | Ny. **`workflow_dispatch` først** |
| `scripts/build-config.js` | `dev` inn i hvitelista over gyldige navn |
| `scripts/build-config.js` | `development`-aliaset **fjernet** — se navnefellen under |
| `.github/workflows/deploy-funcapp-pilot.yml` | `miljo`-valget utvidet med `dev` |
| `api/test/env-inventar.test.js` | `MILJOER = ['pilot', 'prod']` → også `dev` |
| `api/src/functions/system.js` | `KJENTE_MILJOER` |
| `CLAUDE.md` | Sier i dag rett ut at «Det finnes ikke noe tredje miljø» |

**Navnefellen:** `development` ruter i dag til pilot som
bakoverkompatibilitet. Innføres `dev` som et ekte miljø, blir det aliaset
aktivt villedende — to navn som ligner og betyr ulike ting. **Fjern
`development`-aliaset i samme endring**; det er dokumentert som ren
bekvemmelighet for gamle kommandoer.

`production` → pilot må derimot stå foreløpig. `config/env.pilot.json` setter
`MILJO=production`, så det aliaset bærer vekt, og å endre det rører et miljø
i drift.

### 4. GitHub Environment

Et `dev`-Environment med egne hemmeligheter. **Uten approval** — poenget med
dev er rask iterasjon. `prod` beholder sin.

Tjenestehovedmannen lages med `az ad sp create-for-rbac`. Den utskriften er
en hemmelighet: den går rett inn i GitHub-hemmeligheten, ikke innom en sak,
en e-post eller et chat-vindu.

### 5. Rekkefølge ved første utrulling

Dette er leddet som kostet mest tid i steg 1, og årsaken var ikke åpenbar:

1. **Deploy innhold til SWA-en FØRST.** En SWA uten en aktiv build ruter
   ingenting — heller ikke til en lenket backend, selv om lenkingen står
   registrert. Symptomet er default-siden eller 404 på `/api/*`, og det ser
   ut som en lenkingsfeil.
2. **Lenk backend etterpå.** Lenkingen installerer Easy Auth på Function
   App-en, så direkte kall til den svarer 401 — det er riktig, ikke en feil.
   Har SWA-en allerede en auth-konfig fra før, avvises lenkingen med
   `Cannot link backend with a preexisting configuration`.
3. **Verifiser `/api/ping`.** Den bærer commit-SHA-en den kjører. Stemmer den
   ikke, feilsøker du en rettelse som ikke er ute.
4. **Logg inn, og kall `/api/ping` igjen.** `principalDiagnose` viser om
   `x-ms-client-principal` kom fram.
5. **`/api/system/info`.** Viser om hemmelighetene er satt, og om
   Key Vault-referansene ble løst — lengde og vertsnavn, ikke
   referansestrengen. Det var denne prøven som avdekket hele problemet
   12.10.2026.

En `workflow_dispatch`-workflow dukker bare opp i Actions-fanen når fila
ligger på **default-grenen**. Ligger den bare på en arbeidsgren, finnes ikke
knappen, og det ser ut som om workflowen er ødelagt.

### 6. Tre ting å la være

**Ikke kopier pilot-data til dev.** Arkiv-JSON-en skrives dekryptert og
inneholder personopplysninger i klartekst. Bruk skriptene i `testdata/` og
generer i stedet.

**Ikke gi dev cron-jobber til å begynne med.** En planlagt jobb mot et
halvferdig miljø lager varsler ingen leser — og notatet har allerede ett
eksempel på en alarm som sluttet å bli lest fordi den alltid var rød.

**Gi dev sitt eget sett med flyter — ikke pilots.**

Først hva som *ikke* er problemet: pilots flyt-URLer peker på flyter i
**utviklingstenanten**, ikke i prod. Mottakere, team og lister der er
testobjekter. Det eneste som hentes fra ekte kilder er offentlige data — FS
og postnummerregisteret. Et dev-kall mot en pilot-flyt rører altså ikke
produksjonsdata.

Merk likevel at **ingenting feiler**, og det er verdt å vite hvorfor: koden
sender **ingen `Authorization`-header** til flyter. `flyt-kaller.js`,
`sp-liste.js` og `ekstern-flyt.js` POSTer payloaden og stoler på `sig=` i
query-strengen. Det eneste stedet som sender bearer-token er
`mi-diagnose.js` — prøven, ikke appen. En gammel URL virker derfor nøyaktig
som før, uten noe signal om at den kalles fra et nytt miljø.

Det er grunnen til å skille dem likevel:

* **Kjørehistorikken blir felles.** En kjøring fra dev og en fra pilot ser
  like ut i flytens historikk. Når noe skal feilsøkes, er «hvem utløste
  denne» ikke lenger et spørsmål med svar.
* **En endring for dev treffer pilot samtidig.** Flytene er delte, og en
  flytendring er dyr å rulle ut (`docs/FLYT-DEPLOY.md`).
* **Dev-settet er uansett det som skal bygges**, med Entra-auth i stedet for
  SAS, og eksporteres til prod ved overgangen.

**La `*_FLOW_URL` stå usatt til dev har sine egne.** Koden er bygget for det:
hvert kall returnerer `{ status: 'hoppet-over' }` med årsaken i seg og logger
det, og resten av appen går videre. Hele steg 0 kan verifiseres uten at en
eneste flyt fyrer. `VARSLING_DEAKTIVERT=true` er et ekstra belte mens miljøet
bygges.

**Rekkefølgen når dev-flytene bygges med Entra-auth.** Steg 7 er bevist, men
**ikke implementert i koden** — det finnes ingen bearer-vei i
`flyt-kaller.js`, `sp-liste.js` eller `ekstern-flyt.js`. En flyt som krever
Entra er derfor umulig for appen å kalle før den veien er bygget.

Det gir en avhengighet som er verdt å planlegge rundt:

1. Bygg dev-flytene, foreløpig med `sig=`, og sett URL-ene. Da virker dev.
2. Legg bearer-veien inn i kallerne — samme mønster som `mi-flyt`-prøven:
   token fra plattformens identity-endepunkt med `resource` ORDRETT, slik at
   skråstreken i audiencen overlever.
3. Først da settes flytene til å kreve Entra, med identitetens `oid` i lista.

Gjøres 3 før 2, slutter dev å virke, og det ser ut som en feil i miljøet.

Audiencen er ikke miljøavhengig: `https://service.flow.microsoft.com/` er den
samme for alle flyter i public cloud. Det som er per flyt, er hvilke `oid`-er
som står i allow-lista — og den lista må utvides med prod-identiteten når
settet eksporteres dit.

**Prøveressursene er revet 15.10.2026** — `testfapp`, prøve-SWA-en og de to
GitHub-hemmelighetene. Dev arver ingenting av dem; den får sin egen
tjenestehovedstol og sine egne hemmeligheter. Oppskriften og rekkefølgen
står under «Når forsøket er over» i 8b.

Tre ting ble beholdt fordi de ikke er stillas: `scripts/steg1-funcapp.ps1`
bygger dev, `deploy-funcapp-pilot.yml` er deploy-veien dit, og
`mi-diagnose`-endepunktene er det «Hva steg 0 er ferdig når» under måler med.
De rives når steg 6 er i mål og prod er over — ikke før.

### Hva steg 0 er ferdig når

* `/api/ping` i dev svarer med riktig SHA
* Pålogging gir riktig UPN gjennom proxyen
* `/api/system/info` viser hemmelighetene som satt, via Key Vault-referanser
* `/api/diagnose/mi-tabell` og `/api/diagnose/mi-blob` er grønne mot
  dev-kontoen, `sasKall` inkludert
* Pilot og prod er uendret — ingen deploy, ingen app-settings rørt

Først da begynner steg 3.

## 8h. Avkryssingsliste

Kortversjonen, til å hake av i. **Hver linje peker på hvor detaljene står** —
den gjentar dem ikke. En avkryssingsliste som også forklarer, blir et andre
eksemplar av planen, og to eksemplarer svarer ulikt før eller siden.

### Steg 0 — dev-miljøet (8g)

**Ressurser i dev-tenanten** (8g.1)

- [x] Ressursgruppe: rg-skjema-3-dev
- [x] Storage-konto — **tom**, ingen kopi fra pilot: stskjema3dev
- [x] Key Vault: kv-skjema-3-dev
- [x] **User-assigned** managed identity (egen ressurs, ikke system-assigned): mi-skjema-3-dev
- [ ] `AZURE_CLIENT_ID` satt — for **koden** (clientId)
- [ ] `keyVaultReferenceIdentity` satt — for **Key Vault-referansene**
      (egen innstilling på appen, tar ressurs-ID-en). Uten den feiler hver
      referanse med `MSINotEnabled`, uansett rolletildeling
- [x] Function App, knyttet til identiteten: fa-skjema-3-dev
- [x] Static Web App — **Standard**-plan: Skjema-3-dev
- [x] Entra app-registrering: ad-skjema-3-dev, Tenant ID: e4fcc393-7190-4d3d-a38d-fa6429f870f3 Client ID: f6198f01-633e-401b-903b-ad45fa43ba9d, 

`scripts/steg1-funcapp.ps1` gjør 1–6. Tørrkjører uten `-Kjor`.

**Roller på identiteten** (8g.2) — ingen av dem heter `Contributor`

- [x] `Storage Table Data Contributor`
- [x] `Storage Blob Data Contributor`
- [x] `Storage Blob Delegator`
- [x] `Key Vault Secrets User`

**Repoet** (8g.3) — alle må med, ellers svarer de ulikt

- [ ] `config/env.dev.json`, med `AZURE_CLIENT_ID`
- [ ] `staticwebapp.config.dev.json`
- [ ] `.github/workflows/deploy-dev.yml` — `workflow_dispatch` først
- [ ] `scripts/build-config.js` — `dev` inn i hvitelista
- [ ] `scripts/build-config.js` — `development`-aliaset **fjernet**
- [ ] `api/test/env-inventar.test.js` — `MILJOER`
- [ ] `api/src/functions/system.js` — `KJENTE_MILJOER`
- [ ] `CLAUDE.md` — «det finnes ikke noe tredje miljø» stemmer ikke lenger
- [ ] `deploy-funcapp-pilot.yml` — `miljo`-valget utvidet med `dev`

**GitHub** (8g.4)

- [ ] Environment `dev`, **uten** approval
- [ ] Tjenestehovedstol + hemmelighet

**Flytene** (8g.6)

- [ ] `*_FLOW_URL` står **usatt** til dev har egne flyter
- [ ] `VARSLING_DEAKTIVERT=true` mens miljøet bygges
- [ ] Ingen dev-flyt er Entra-beskyttet (koden har ingen bearer-vei ennå)

**Første utrulling** (8g.5) — rekkefølgen er poenget

- [ ] Innhold til SWA-en **før** lenking
- [ ] Lenk backend
- [ ] `/api/ping` — riktig SHA
- [ ] Logg inn, `/api/ping` igjen — riktig UPN gjennom proxyen
- [ ] `/api/system/info` — hemmelighetene satt, Key Vault-referanser løst
- [ ] `/api/diagnose/mi-tabell` og `/api/diagnose/mi-blob` grønne, `sasKall` inkludert

- [ ] **Pilot og prod er urørt** — ingen deploy, ingen app settings rørt

### Steg 3 — storage uten delt nøkkel

Del 1 (8j):

- [x] Valg av legitimasjon, **ett sted**, brukt av `storage.js` og `blob.js`
      — `api/src/lib/lagringsvalg.js`
- [x] Testsuiten grønn, også uten `node_modules` — 113 testfiler
- [x] Pilot og prod fortsatt uendret (strengen vinner der den er satt)

Del 2:

- [ ] `backup.js` → `getUserDelegationKey()` i stedet for kontonøkkel.
      **Backup-nedlasting virker ikke i dev før dette er gjort** — se 8j
- [ ] `kontoNavnFra()` erstattet av `STORAGE_ACCOUNT_NAME` i
      `nokkelkalender-storage.js`, `todo-storage.js` og `functions/backup.js`
- [ ] `STORAGE_ACCOUNT_NAME` satt på `fa-skjema-3-dev`
- [ ] `/api/system/info` viser `lagring.maate = managed-identity` i dev
- [ ] `/api/hello-storage` grønn i dev — den går gjennom den ekte koden
- [ ] Les og skriv et skjema **i dev**

### Steg 4 — én cron-jobb

- [ ] Én jobb flyttet til timer-trigger
- [ ] Kjørt på klokke i dev i et døgn

### Steg 5 — resten av cron-jobbene

- [ ] De åtte workflowene fjernet
- [ ] `SCHEDULER_KEY` ute av koden, miljøfilene og helsesjekken
- [ ] `node scripts/api-oversikt.js` viser færre anonyme endepunkter

### Steg 5b — ta i bruk i pilot

**Ingen kodeendring.** Dette er app settings og rolletildelinger.

- [ ] Rollene tildelt pilotens identitet
- [ ] `STORAGE_ACCOUNT_NAME` og `AZURE_CLIENT_ID` satt
- [ ] `STORAGE_CONNECTION_STRING` fjernet
- [ ] Et skjema leses og skrives i pilot

Går det galt: sett tilkoblingsstrengen tilbake. Reversibelt uten deploy.

### Steg 6 — prod

- [ ] Pilot har stått i minst to uker
- [ ] Samme som 5b, i prod
- [ ] **Gaffelen i koden fjernet** — tilkoblingsstreng-veien ut av
      `storage.js` og `blob.js`
- [ ] `mi-diagnose`-endepunktene fjernet, med tester og rutedeklarasjoner
- [ ] `scripts/steg1-funcapp.ps1` og `deploy-funcapp-pilot.yml` vurdert på nytt

### Egne beslutninger, ikke en del av rekkefølgen

- [ ] **7.1** Entra-auth per flyt — bevist, men hver flyt er en egen avgjørelse
- [ ] **7.2** Graph-approller på MI-en — **ikke kjørt**, må prøves i dev først

## 8i. Utfallet av steg 0 — dev-miljøet står

**Dato:** 16.10.2026
**Oppsett:** `rg-skjema-3-dev` i dev-tenanten. SWA `Skjema-3-dev` (Standard)
med Function App `fa-skjema-3-dev` som lenket backend, user-assigned identitet
`mi-skjema-3-dev`, Key Vault `kv-skjema-3-dev`, storage `stskjema3dev`.
App-registrering i **jccodevel**, ikke i tenanten ressursene ligger i.

### Hva som er målt

| Spørsmål | Svar |
|---|---|
| Kjører riktig kode? | `/api/ping` og `/js/config.js` bærer samme SHA |
| Følger `x-ms-client-principal` med? | `headerMottatt: true`, `harUpn: true`, tre roller |
| Virker **`rolesSource`** mot en lenket backend? | **Ja.** Admin-rollen kom fra `/api/roller-swa`, kalt server-til-server av SWA |
| Løser plattformen Key Vault-referanser? | **Ja**, 21 av 22. Den siste manglet i vaulten |
| Får koden et MI-token? | Ja — `aud` `https://storage.azure.com/`, `appid` = MI-ens clientId |
| Tabell: lese, skrive, rydde? | **Grønt** |
| Blob: lese, delegering, skrive, SAS-kall? | **Grønt** |
| Er pilot og prod urørt? | Ja. Ingen deploy, ingen app settings rørt |

> Verdiene i de to siste radene er bekreftet av den som kjørte dem, ikke
> gjengitt felt for felt her. De øvrige står med eksakte verdier i avsnittene
> de hører til.

**`rolesSource`-raden er den viktigste nye.** Pilot har ingen lenket backend,
så det leddet kunne ikke prøves der. Det var ført som en åpen risiko; nå er
det målt.

### Det dev kan, og det dev ikke kan ennå

Dev kan logge inn, lese roller, løse hemmeligheter fra Key Vault, og snakke
med storage på managed identity.

Dev kan **ikke lese skjemadata**, og det er med vilje: `storage.js` krever
fortsatt `STORAGE_CONNECTION_STRING`, og dev har ingen. Appen svarer
«Kunne ikke hente skjematyper: STORAGE_CONNECTION_STRING env-var mangler».
Det er grensen mellom steg 0 og steg 3, og den er synlig i brukergrensesnittet.

Flyt-URLene står usatt (8g.6), så ingen flyt kan fyre fra dev.

### Åtte feller, i den rekkefølgen de traff

Steg 0 tok lengre tid enn det skulle, og ingen av årsakene var i selve
arkitekturen. De står her fordi de treffer hvem som helst som setter opp
det samme miljøet.

1. **Tjenestehovedstolen.** `az ad sp create-for-rbac --scopes` vil ha
   abonnementets **GUID**, ikke navnet. Og `azure/login` vil ha hele
   JSON-objektet fra `--sdk-auth`, ikke bare `clientSecret`. Sett det sammen
   for hånd, og noe er alltid i utakt — kopier hele utskriften fra den
   kjøringen som lyktes.
2. **`ID tokens`** var ikke slått på i app-registreringen. Symptomet er en
   innloggingsløkke uten feilmelding noe sted.
3. **Redirect-URI** må være `…/.auth/login/aad/callback` på en **Web**-plattform.
   Feil her gir `AADSTS50011`, og den kan ikke oppstå før alt foran virker.
4. **`keyVaultReferenceIdentity`** må settes til identitetens ressurs-ID.
   Uten den feiler hver referanse med `MSINotEnabled`, uansett rolletildeling.
5. **`AZURE_CLIENT_ID` er ikke `AAD_CLIENT_ID`.** De står rett ved siden av
   hverandre alfabetisk i app settings, og betyr helt forskjellige ting. Se
   tabellen i 8g.
6. **Plattformens identity-endepunkt krever `client_id`** når appen bare har
   user-assigned identiteter — også når den har nøyaktig én. Dette var en feil
   i diagnoseverktøyet, ikke i oppsettet, og det pekte på oppsettet mens det
   feilet på seg selv.
7. **Kontrollplan er ikke dataplan**, igjen. `Owner` på abonnementet lar deg
   opprette en tabell, men ikke skrive en rad i den.
8. **`TableNotFound` er 404, ikke 403.** Prøven oppretter ikke tabellen selv.
   Et 404 her betyr at identiteten kom inn.

Og én feil i vår egen kode: helsesjekken ga i dev rådet «lim inn verdien som
klartekst i SWA Configuration» om en uløst Key Vault-referanse. Begge
setningene er gale der. Se `LØSER_KEYVAULT_REFERANSER` i `system.js`.

### Hva som gjenstår før steg 3

* `AAD_CLIENT_ID` og `AAD_CLIENT_SECRET` fjernes fra Function App-ens app
  settings — de hører til SWA-en i dev, og en kopi kan drive.
* `todo-storage-connection-string` legges i `kv-skjema-3-dev`, eller står
  usatt til steg 3 trenger den.
* `GRAPH_TENANT_ID` sto oppført som feil fordi verdien var 8 tegn.
  **Det var vår feil, ikke miljøets:** token-endepunktet godtar et
  tenant-domenenavn like godt som en GUID, så en kort verdi er ikke i seg selv
  gal. Verdien i dev er fornuftig.
* `BACKUP_SHAREPOINT_*` står som `SETT-INN`.

Ingen av dem blokkerer steg 3.

## 8j. Utfallet av steg 3, del 1 — begge veier i koden

**16.10.2026.** `storage.js` og `blob.js` kan nå nå lagringen både med delt
nøkkel og med managed identity. Valget mellom dem står i
`api/src/lib/lagringsvalg.js`.

### Regelen

| `STORAGE_CONNECTION_STRING` | `STORAGE_ACCOUNT_NAME` | Vei |
|---|---|---|
| satt | satt eller ikke | tilkoblingsstreng |
| ikke satt | satt | managed identity |
| ikke satt | ikke satt | ukonfigurert — kaster med begge navnene i meldingen |

**Strengen vinner, og rekkefølgen er ikke tilfeldig.** Pilot og prod har
begge verdiene i inventaret. Hadde MI-veien vunnet, ville den slått inn i prod
i samme øyeblikk dette ble merget, mot en identitet som ikke finnes der.
Slik det står er endringen inert i de to miljøene som er i drift: de har en
tilkoblingsstreng, og beholder den til 5b og 6.

Overgangen i 5b er derfor å **fjerne** en app setting, ikke å sette en. Det
er den rekkefølgen som er reversibel på et minutt.

### Hva som ligger i `lagringsvalg.js`

* `lagringsvalg()` — hvilken vei, og **hvorfor**, som en setning i `grunn`.
  Tilkoblingsstrengen er ikke med i objektet; den hentes med et eget kall.
  Derfor kan valget vises rått i `/api/system/info`, og det gjør det nå under
  nøkkelen `lagring`.
* `tilkoblingsstreng()` — strengen, bak et navn som sier at verdien er en
  hemmelighet.
* `endepunkt('tabell'|'blob', konto)` — vertsnavnet. Ett sted, i stedet for
  fire steder som bygget det av samme to deler.
* `legitimasjon(klientId)` — `DefaultAzureCredential`, cachet per identitet,
  med `managedIdentityClientId` når `AZURE_CLIENT_ID` er satt. Uten den finner
  SDK-en ikke en user-assigned identitet, også når det bare finnes én.
* Kontonavn-regelen (3–24 små bokstaver og sifre), som også validerer
  `STORAGE_ACCOUNT_NAME`. Den nærliggende tastefeilen er å lime hele
  tilkoblingsstrengen inn der, og uten sjekken havner nøkkelen i et vertsnavn
  — og derfra i en feilmelding og i loggen.

`mi-diagnose.js` bruker nå de **samme** fire. Prøvene finnes for å måle den
ekte veien; bygger de sin egen URL og sin egen legitimasjon, kan de bli grønne
mens lagringen er rød.

### `*Fra`-variantene følger ikke valget

`tabellKlientFra`, `sikreTabellFra`, `serviceKlientFra` og
`containerKlientFra` tar en tilkoblingsstreng som argument og går alltid på
delt nøkkel. De peker på TODO-lista med vedlegg, som ligger i en annen tenant
der en managed identity ikke kan få rolle. Det er det ene unntaket som
overlever hele migreringen, og `api/test/env-inventar.test.js` krever at
`TODO_STORAGE_CONNECTION_STRING` fortsatt er en hemmelighet i alle tre
miljøene.

### Testen

`api/test/lagringsvalg.test.js` — 77 sjekker. Den gjør tre ting:

* leser regelen, alle utfallene;
* **kjører de ekte funksjonene i BEGGE modulene** mot stubbede SDK-er, og
  krever at `storage.tabellKlient()` og `blob.serviceKlient()` går samme vei,
  peker på samme konto og bruker samme legitimasjonsobjekt;
* krever at ingen av dem leser `STORAGE_CONNECTION_STRING` eller
  `STORAGE_ACCOUNT_NAME` selv, bygger sitt eget vertsnavn eller lager sin egen
  legitimasjon — og at kontonavn-mønsteret ikke finnes skrevet ut noe annet
  sted i `api/src`.

Sytten mutasjoner er prøvd. Den viktigste — snu rekkefølgen slik at MI vinner
over strengen — gjør tre sjekker røde, blant dem «begge satt: begge går på
delt nøkkel». En kopi av regelen lagt inn i `blob.js` med motsatt rekkefølge
gir fire røde.

To hull ble funnet ved å mutere, ikke ved å lese:

* **`endepunkt()` gjentok verdien i feilmeldingen.** Er den gale verdien en
  tilkoblingsstreng, står nøkkelen i en exception — og i loggen. Nå står bare
  lengden.
* **Scanneren i `env-inventar.test.js` leste kommentarer.** En kommentar som
  forklarte formen `env.NAVN` meldte seg selv som en app setting ved navn
  «NAVN», og krevde en oppføring i alle tre miljøfilene. Hele kommentarlinjer
  kastes nå før scanningen — bare hele linjer: et forsøk på å klippe `//` midt
  i en linje spiser `https://` og kan skjule et ekte oppslag, som er den
  farlige retningen.

### Inventaret: `STORAGE_ACCOUNT_NAME` er ikke dokumentasjon lenger

Den sto som `kun_dokumentasjon` i alle tre miljøfilene, med «API-et leser
tilkoblingsstrengen, ikke navnet» som begrunnelse. Nå leser koden den. Det er
den dyre retningen å ta feil i: den som setter opp et miljø leser «står bare
for oversiktens skyld» og hopper over en verdi appen ikke klarer seg uten.

Merkingen er fjernet i alle tre, `STORAGE_ACCOUNT_NAME` er ute av
`VIST_UTEN_AT_KODEN_LESER` i `system.js`, og `env-inventar.test.js` krever nå
at ingen nøkkel koden leser er merket `kun_dokumentasjon`.

### Hva som IKKE virker i dev før del 2

`functions/backup.js` signerer nedlastingslenken med
`StorageSharedKeyCredential`, og nøkkelen hentes ut av tilkoblingsstrengen.
Uten en streng finnes ingen nøkkel. **Backup-nedlasting i dev feiler derfor
til `getUserDelegationKey()` er på plass** — selve backupen leses gjennom
`tabellKlient`/`containerKlient` og går fint.

`kontoNavnFra(process.env.STORAGE_CONNECTION_STRING)` i
`nokkelkalender-storage.js`, `todo-storage.js` og `functions/backup.js` gir
`null` i dev. Følgen er kosmetisk — «ukjent konto» i admin-panelet — men det
er nøyaktig det feltet man leser når man vil vite hvilket lager man snakker
med, så det hører med i del 2.

Prøven `/api/diagnose/mi-blob` har allerede målt at `getUserDelegationKey()`
og SAS-signering virker med identiteten i dev. Del 2 er omskriving, ikke
utprøving.

### Slik verifiseres del 1 i dev

Sett `STORAGE_ACCOUNT_NAME=stskjema3dev` på `fa-skjema-3-dev` og kall
**`/api/hello-storage`** (innlogget). Den skriver én tabellrad og én blob og
leser radene tilbake — gjennom `tabellKlient()` og `containerKlient()`, altså
den ekte veien, ikke prøvens egen.

Det er forskjellen fra `mi-tabell` og `mi-blob`: de to tar kontoen som
parameter og svarer på om *identiteten* har tilgang. `hello-storage` svarer på
om *koden* velger riktig vei. Begge trengs — den første feilen vi gjorde i dev
var å lese et grønt prøvesvar som om det gjaldt appen.

`/api/system/info` viser samtidig valget under nøkkelen `lagring`: `maate`,
`konto`, `klientId` og `grunn`. Står det `tilkoblingsstreng` der du ventet
`managed-identity`, er strengen fortsatt satt på appen.

## 9. Risiko

| Risiko | Hvor alvorlig | Hva vi gjør |
|---|---|---|
| ~~`x-ms-client-principal` følger ikke med gjennom proxyen~~ | ~~**Stoppende**~~ | **Avklart 14.10.2026: den følger med.** Se 8c |
| Kaldstart på Consumption gir tregere første kall | Lav | Flex Consumption har kortere kaldstart. Alternativt alltid-på-instans, mot høyere pris |
| Ett ekstra deploy-steg som kan feile uavhengig | Lav | `/api/ping` bærer commit-SHA. Avvik mellom frontend og API blir synlig med én gang |
| Kostnad | Ukjent | Function App på Consumption koster lite ved dette volumet, men **prisen skal slås opp, ikke antas**. SWA-planen er uendret |
| Tre miljøer ute av synk under migreringen | Middels | Dev bærer endringene først (steg 0). Pilot tas i bruk i 5b, prod ikke før pilot har stått i to uker (steg 6) |
| Gaffelen i koden — to veier for legitimasjon — blir permanent | Middels | Den er datert og erklært, valget står **ett sted**, og den fjernes i steg 6. En gaffel ingen har satt sluttdato på, får ingen |
| Dev-miljøet blir liggende etter migreringen | Lav | Det er et miljø, ikke stillas: nye endringer skal fortsatt verifiseres et sted før pilot. Prøveressursene fra steg 1 rives derimot (8g, punkt 6) |
| Kostnad for et miljø til | Lav | Egen ressursgruppe i dev-tenanten, Consumption. **Slås opp, ikke antas** — samme forbehold som over |

## 10. Forbehold om kildene

Dette notatet er skrevet i en sesjon der nettverkspolicyen blokkerer
`learn.microsoft.com`. Påstandene om hva SWA støtter i hvilken modell, om
Standard-plankravet, om headerforwarding til en lenket backend og om Power
Automates OAuth-alternativ bygger derfor på **søkesammendrag av Microsofts
dokumentasjon**, ikke på sidene lest direkte.

Før noen forplikter seg, bør disse leses i den levende dokumentasjonen:

* sammenligningstabellen managed vs. bring-your-own functions,
* kravene og begrensningene for linked backends,
* Power Automates alternativer for hvem som kan utløse en HTTP-trigger.

Og uansett hva dokumentasjonen sier: **steg 1 og 2 i planen er de to
forsøkene som faktisk avgjør saken.** Det var et slikt forsøk som avdekket
problemet i utgangspunktet.

## 11. Henvisninger

| Tema | Fil |
|---|---|
| Hva problemet er, i detalj | `docs/SIKKERHET-OG-ARKITEKTUR.md` kapittel 7 og 10 |
| Den delte flyt-nøkkelen | samme, 9.3 |
| Hvorfor cron-jobbene ligger i GitHub Actions | samme, kapittel 2 |
| Hva en flytendring koster | `docs/FLYT-DEPLOY.md` |
| Hemmelighetene og rotasjonen deres | `config/keyvault-secrets.md` |
| Deploy slik det er i dag | `docs/DEPLOY.md` |
