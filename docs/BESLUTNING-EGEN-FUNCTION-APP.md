# Beslutningsnotat: egen Function App i stedet for SWA Managed Functions

| | |
|---|---|
| Dato | 13.10.2026 |
| Status | **Forslag — ikke besluttet** |
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
| 1 | Opprett Function App i **pilot**, lenk den til pilot-SWA-en, deploy uendret kode | `/api/ping` svarer med riktig SHA, og et endepunkt som krever innlogging gir riktig UPN. **Dette beviser at `x-ms-client-principal` følger med gjennom proxyen** — hele migreringen hviler på det |
| 2 | Legg inn én Key Vault-referanse i Function App-ens app settings | `/api/system/info` viser riktig lengde og vertsnavn, ikke referansestrengen. Dette er den samme prøven som avslørte problemet 12.10.2026, bare motsatt vei |
| 3 | Legg om `storage.js` og `blob.js` til `DefaultAzureCredential`. `TODO_STORAGE_CONNECTION_STRING` beholdes | Hele testsuiten grønn, inkludert uten `node_modules`. Deretter: les og skriv et skjema i pilot |
| 4 | Flytt én cron-jobb til timer-trigger | Jobben kjører på klokke i pilot i et døgn |
| 5 | Resten av cron-jobbene. Fjern `SCHEDULER_KEY` og de åtte workflowene | `node scripts/api-oversikt.js` viser færre anonyme endepunkter. `env-inventar.test.js` feiler hvis `SCHEDULER_KEY` henger igjen ett sted |
| 6 | Samme i **prod**, etter at pilot har stått i minst to uker | Alt over, i prod |
| 7 | *Egen beslutning:* Entra-auth på én flyt, eller Graph-med-MI for e-post | Prøv i pilot, med én flyt |

Steg 1 og 2 er de eneste som må gjøres i rekkefølge. Feiler steg 1, stopper
hele forslaget her, og notatet har spart oss resten.

## 9. Risiko

| Risiko | Hvor alvorlig | Hva vi gjør |
|---|---|---|
| `x-ms-client-principal` følger ikke med gjennom proxyen | **Stoppende** | Steg 1 avgjør det før noe annet gjøres |
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
