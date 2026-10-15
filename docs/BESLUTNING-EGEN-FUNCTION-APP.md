# Beslutningsnotat: egen Function App i stedet for SWA Managed Functions

| | |
|---|---|
| Dato | 13.10.2026 |
| Status | **Steg 1 og 2 verifisert, premisset for steg 3 og 7 bekreftet 14.10.2026. Forslaget står — ikke besluttet** |
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
2. **System-assigned managed identity** på hver av dem.
3. **Rolletildelinger** på lagringskontoen i samme miljø:
   `Storage Table Data Contributor` og `Storage Blob Data Contributor`.
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

Delvis ja, og delene er ulikt sikre. Dette er en **egen beslutning per flyt**,
ikke en del av migreringen over. En flytendring er dyr: utrulling er en
fire-stegs prosess på tvers av tenanter (`docs/FLYT-DEPLOY.md`).

### 7.1 Entra-auth på HTTP-triggeren

Power Automates «when an HTTP request is received»-trigger kan kreve Entra i
stedet for SAS. Settes «hvem kan utløse flyten» til **Any user in my tenant**
eller **Specific users in my tenant**, forsvinner `sig=`-parameteren fra
URL-en, og kalleren må sende et bearer-token.

Det ville fjernet hele «lenken er en hemmelighet»-kategorien for flytene
(9.1 i overleveringsdokumentet), og gjort flyt-URLene til ordinære,
ikke-sensitive konfigurasjonsverdier.

Microsofts Power Platform-blogg oppgir at allow-lista kan inneholde
**objekt-ID-er for tjenestehovedstoler**, ikke bare brukere — og en managed
identity *er* en tjenestehovedstol. Da ville Function App-ens MI kunne kalle
flyten direkte.

**To forbehold, begge reelle:**

* **Flyten ser ikke hvem som kalte.** Tokenet og claimene er ikke tilgjengelige
  inne i flyten. Revisjonssporet flytter til Entras pålogningslogger. For
  backup-kvitteringer betyr det lite; for noe som utløser en masseutsending
  betyr det mer.
* **At en MI faktisk får et token med Flow-tjenestens audience, må prøves.**
  Kildene beskriver gjennomgående en app-registrering med client credentials,
  ikke en managed identity. Det er plausibelt at MI virker — en MI kan be om
  hvilken som helst audience — men dette er akkurat den typen påstand dette
  repoet har brent seg på å tro på uten å kjøre den. **Prøv med én flyt i
  pilot før noen planlegger rundt det.**

### 7.2 Det som kanskje er bedre: fjern flyten

For noen av flytene er svaret ikke å autentisere bedre, men å ikke ha dem.

Løsningen bruker allerede Microsoft Graph mot SharePoint, i dag med
`GRAPH_CLIENT_SECRET`. Med en Function App kan Graph-approller tildeles
**direkte til MI-ens tjenestehovedstol** — `Mail.Send` for e-post,
`Sites.Selected` for backup-opplasting. Da er det ingen hemmelighet igjen å
rotere: hverken flyt-URL eller client secret.

`Mail.Send` som approlle lar appen sende som hvem som helst i tenanten, og må
derfor snevres med en **Application Access Policy** (`New-ApplicationAccessPolicy`
i Exchange Online) som binder den til én postboks. Det er en PowerShell-kommando
mot Exchange, ikke en portalknapp, så den hører hjemme i den samme samtalen med
Cyberforsvaret.

Avveiningen: e-postmaler og -formatering flytter fra Power Automate inn i kode.
Det er en fordel for sporbarhet og test, og en ulempe for den som er vant til å
endre teksten i flyten.

---

## 8. Foreslått rekkefølge

Hvert steg er valgt slik at det kan **verifiseres før det neste begynner**.

| Steg | Hva | Verifiseres ved |
|---|---|---|
| 1 | ✅ **Gjort 14.10.2026** — se «Utfallet av steg 1» under | `/api/ping` svarer med riktig SHA, og et endepunkt som krever innlogging gir riktig UPN. **Dette beviser at `x-ms-client-principal` følger med gjennom proxyen** — hele migreringen hviler på det |
| 2 | ✅ **Gjort 14.10.2026** — se «Utfallet av steg 2» under | `/api/system/info` viser riktig lengde og vertsnavn, ikke referansestrengen. Dette er den samme prøven som avslørte problemet 12.10.2026, bare motsatt vei |
| 3 | Legg om `storage.js` og `blob.js` til `DefaultAzureCredential`. `TODO_STORAGE_CONNECTION_STRING` beholdes | Hele testsuiten grønn, inkludert uten `node_modules`. Deretter: les og skriv et skjema i pilot |
| 4 | Flytt én cron-jobb til timer-trigger | Jobben kjører på klokke i pilot i et døgn |
| 5 | Resten av cron-jobbene. Fjern `SCHEDULER_KEY` og de åtte workflowene | `node scripts/api-oversikt.js` viser færre anonyme endepunkter. `env-inventar.test.js` feiler hvis `SCHEDULER_KEY` henger igjen ett sted |
| 6 | Samme i **prod**, etter at pilot har stått i minst to uker | Alt over, i prod |
| 7 | *Egen beslutning:* Entra-auth på én flyt, eller Graph-med-MI for e-post | Prøv i pilot, med én flyt |

Steg 1 og 2 er de eneste som må gjøres i rekkefølge. Feiler steg 1, stopper
hele forslaget her, og notatet har spart oss resten.

## 8b. Slik kjører du steg 1

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

Blir svaret nei, eller blir forslaget lagt bort, skal
`scripts/steg1-funcapp.ps1`, `deploy-funcapp-pilot.yml`,
`deploy-swa-proeve.yml` og `proeve/` fjernes sammen med ressursene.

**Riv ned i denne rekkefølgen**, ellers blir det liggende rester (se
fallgruve 2):

```
az staticwebapp backends unlink --name <swa> --resource-group <rg>
az staticwebapp delete --name <swa> --resource-group <rg> --yes
az functionapp delete --name <funcapp> --resource-group <rg>
az storage account delete --name <lagring> --resource-group <rg> --yes
az ad sp delete --id <appId for sp-skjema-funcapp-proeve>
```

Og fjern GitHub-secretene `AZURE_FUNCAPP_CREDENTIALS` og `SWA_PROEVE_TOKEN`. En workflow som
peker på noe som ikke finnes, er den slags rest dette repoet har brukt tid på
å rydde før.

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
`testfapp`, gjennom prøve-SWA-en. Koden som svarte bar commit `91af3e9`.

Begge prøvene endte i 403, og **begge 403-ene er positive delresultater.**
Det er verdt å si tydelig, for en rød statuskode leses lett som et nei: i
begge tilfellene ble tokenet godtatt som legitimasjon, og det som manglet var
en tildeling eller en liste på mottakersiden.

### Tabellen — tokenet slipper inn, rollen mangler (steg 3)

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

### Flyten — signaturen er borte, policyen mangler avsenderen (steg 7)

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
4. Policyen tillater nettopp denne avsenderen. **Åpent.**

### To hypoteser for punkt 4, i rekkefølge

**A — policyen lister ikke avsenderen.** Mest sannsynlig. Se hvilket valg
triggeren står på:

* Står den på **«Specific users in my tenant»**, må avsenderen legges inn.
  Prøv `oid` (`64eac771-…`) først, så `appid` (`3be2b536-…`) hvis den
  avvises. En managed identity har begge, og hvilken av dem Power Automate
  sammenligner mot er ikke avklart her.
* Står den på **«Any user in my tenant»**, stemmer `tid` allerede, og da
  peker avvisningen mot et mer grunnleggende spørsmål: **teller en
  tjenestehovedmann som «user»?** Er svaret nei, må den eksplisitte lista
  brukes, og i verste fall er MI ikke et alternativ i det hele tatt. Det
  ville være det første reelle hinderet for steg 7.

**B — audiencen er ikke den gatewayen venter.** Tokenet har
`aud = https://service.flow.microsoft.com`, som er audiencen for Power
Automate-tjenesten. Det nye `environment.api.powerplatform.com`-endepunktet
kan vente en annen. `mi-flyt` tar `&ressurs=` nettopp for dette, så
hypotesen koster ett kall og ingen deploy:

```
/api/diagnose/mi-flyt?envVar=TESTFLYT_FLOW_URL&ressurs=https://api.powerplatform.com
```

Rekkefølgen er A før B: hypotese B forklarer ingenting hvis avsenderen uansett
ikke står i lista.

### Status for de to stegene

| Steg | Status | Hva som mangler |
|---|---|---|
| 3 — storage uten delt nøkkel | Autentisering vist, autorisasjon ikke prøvd | `Storage Table Data`-rolle på `stfhsskjemapilot` |
| 7 — flyt uten SAS-signatur | Signaturen borte, token godtatt, claims avvist | Avsenderen inn i flytens tilgangspolicy |

Ingen av dem er avkreftet. Ingen av dem er bevist. Begge mangler en
tildeling, ikke en mekanisme — og det er en annen slags gjenstående arbeid
enn det vi lette etter.

## 9. Risiko

| Risiko | Hvor alvorlig | Hva vi gjør |
|---|---|---|
| ~~`x-ms-client-principal` følger ikke med gjennom proxyen~~ | ~~**Stoppende**~~ | **Avklart 14.10.2026: den følger med.** Se 8c |
| Kaldstart på Consumption gir tregere første kall | Lav | Flex Consumption har kortere kaldstart. Alternativt alltid-på-instans, mot høyere pris |
| Ett ekstra deploy-steg som kan feile uavhengig | Lav | `/api/ping` bærer commit-SHA. Avvik mellom frontend og API blir synlig med én gang |
| Kostnad | Ukjent | Function App på Consumption koster lite ved dette volumet, men **prisen skal slås opp, ikke antas**. SWA-planen er uendret |
| To miljøer ute av synk under migreringen | Middels | Prod røres ikke før pilot har stått i to uker (steg 6) |

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
