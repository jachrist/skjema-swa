# Key Vault-secrets

Hemmeligheter som hører hjemme i Key Vault: **`kv-skjema-3-dev`** for dev,
**`kv-fhsskjema-pilot`** for pilot, **`fhs-kv-01`** for prod.
`config/env.*.json` viser hvilken secret hver app-setting henter verdien sin
fra.

> **Dev er annerledes, og det er poenget med miljøet.** Der er API-et en
> frittstående Function App, og den LØSER `@Microsoft.KeyVault(...)`-referanser
> (prøvd 14.10.2026, se 8d i `docs/BESLUTNING-EGEN-FUNCTION-APP.md`). I dev
> settes app settingen derfor til
> `@Microsoft.KeyVault(SecretUri=https://kv-skjema-3-dev.vault.azure.net/secrets/<navn>/)`,
> og hemmeligheten finnes aldri i klartekst noe sted utenfor Key Vault.
>
> Alt som står under om klartekst og rotasjon gjelder **pilot og prod**, som
> kjører på SWA Managed Functions. Blandes de to oppskriftene, ender dev med
> klartekst det ikke trenger — eller pilot med en referansestreng den ikke kan
> løse, som er nøyaktig feilen 12.10.2026.

> Navnene sto feil her og i `docs/SECURITY.md` til 12.10.2026 («-prod»-suffiks
> på pilot). De er nå lest ut av pilots levende `KEYVAULT_NAME` og av
> `staticwebapp.config.prod.json`.

> **Key Vault er kilden og rotasjonspunktet — ikke en referanse appen følger.**
> Verdien må limes inn som klartekst i SWA Configuration. Se «Rotasjon» nederst;
> dette er det punktet som oftest misforstås.
>
> **Prøvd og avgjort 12.10.2026.** `TEAM_SOK_EKSTERNT_FLOW_URL` ble satt i
> pilot til `@Microsoft.KeyVault(SecretUri=…)`. `/api/system/info` svarte
> «ikke en gyldig URL» med lengde 109 — altså selve referansestrengen. SWA
> Managed Functions løser dem ikke, uansett rolletildeling på SWA-ens managed
> identity. `docs/SECURITY.md` påsto det motsatte fram til da.
>
> Konsekvensen må være kjent: hemmelighetene står i KLARTEKST i SWA
> Configuration, og den som kan lese app settings ser dem — inkludert
> `sig=`-signaturene. Å liste dem er en privilegert ARM-operasjon, så en ren
> *Reader* får dem ikke; eksponeringen går til dem som allerede kan endre
> appen. Det er plattformvalget som bestemmer dette, ikke en beslutning vi har
> tatt. Blir SWA en dag i stand til å løse referanser, er dette første sted å
> se igjen — testen over tar ti minutter og reverseres ved å lime tilbake
> verdien.

## Hemmeligheter

| Secret-navn | App-setting | Beskrivelse | Rotasjon |
|---|---|---|---|
| `storage-connection-string` | `STORAGE_CONNECTION_STRING` | Full tilgang til miljøets lagringskonto | Ved lekkasje |
| `todo-storage-connection-string` | `TODO_STORAGE_CONNECTION_STRING` | Dev-tenantens konto, for den delte oppgavelista | Ved lekkasje — se under |
| `fs-api-url` | `FS_API_URL` | Base-URL for FS-integrasjonen | Sjelden |
| `fs-api-user` | `FS_API_USER` | Bruker for FS-API | Ved bytte |
| `fs-api-password` | `FS_API_PASSWORD` | Passord for FS-API | Månedlig anbefales |
| `fs-eier-org-kode` | `FS_EIER_ORG_KODE` | FHS sin eier-org-kode i FS | Sjelden |
| `hash-salt` | `HASH_SALT` | Salt for pseudonymisering — lekker det, kan hashene reverseres | Aldri uten migrering |
| `otp-hmac-key` | `OTP_HMAC_KEY` | Signerer engangskoder til eksterne innsendere | Ved lekkasje — invaliderer aktive koder |
| `flow-callback-key` | `FLOW_CALLBACK_KEY` | Eneste sperre foran de skrivende flyt-endepunktene | Ved lekkasje — husk å oppdatere flytene samtidig |
| `scheduler-key` | `SCHEDULER_KEY` | Eneste sperre foran cron-endepunktene | Ved lekkasje — husk repo-secreten `SCHEDULER_KEY(_PROD)` samtidig |
| `backup-passphrase` | `BACKUP_PASSPHRASE` | Dekrypterer backupene | **Aldri** uten å ta vare på den gamle — eldre backuper blir ulesbare |
| `anthropic-api-key` | `ANTHROPIC_API_KEY` | Fakturerbar API-nøkkel for AI-import | Ved lekkasje |
| `aad-client-secret` | `AAD_CLIENT_SECRET` | Kun pilot. Prod bruker sertifikat, se under | Ved utløp |
| `graph-client-secret` | `GRAPH_CLIENT_SECRET` | Graph-app for direkte SharePoint-opplasting av backup | Ved utløp |

| `diagnose-flow-url` | `DIAGNOSE_FLOW_URL` | Slår opp eksterne referanser for varslingsdiagnosen | Ved lekkasje |
| `team-flow-url` | `TEAM_FLOW_URL` | Team-oppslag mot Graph | Ved lekkasje |

### Flyt-URLer er også hemmeligheter

Signaturen ligger i query-strengen, så URL-en **er** legitimasjonen: hvem som
helst med den kan kalle flyten. Derfor hører de hjemme her, ikke som klartekst
i en app-setting noen deler i en skjermdump.

| Secret-navn | App-setting |
|---|---|
| `varsling-flow-url` | `VARSLING_FLOW_URL` |
| `otp-flow-url` | `OTP_FLOW_URL` |
| `sp-liste-flow-url` | `SP_LISTE_FLOW_URL` |
| `backup-flow-url` | `BACKUP_FLOW_URL` |
| `team-last-medlemmer-flow-url` | `TEAM_LAST_MEDLEMMER_FLOW_URL` |
| `team-sok-eksternt-flow-url` | `TEAM_SOK_EKSTERNT_FLOW_URL` |

`/api/system/info` viser bare vertsnavnet og stien for disse, aldri
query-strengen (`maskFlytUrl` i `api/src/functions/system.js`).

### Ikke hemmeligheter

Disse settes som vanlige app settings, uten Key Vault: `MILJO`, `APP_TITTEL`,
`STORAGE_ACCOUNT_NAME`, `KEYVAULT_NAME`, `SWA_URL`, `ADMIN_UPNS`,
`AAD_CLIENT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_TENANT_ID`, `ANTHROPIC_MODELL`,
`BACKUP_SHAREPOINT_SITE`, `BACKUP_SHAREPOINT_BIBLIOTEK`,
`BACKUP_SHAREPOINT_MAPPE`, `BACKUP_DEL_MAKS_MB`, `PURRE_MAKS_DAGER`,
`PURRE_MIN_DAGER_MELLOM`, `VARSLING_DEAKTIVERT`.

Client-ID og tenant-ID er identifikatorer, ikke hemmeligheter. `system.js`
maskerer dem likevel i diagnostikken, av forsiktighet.

## Delt oppgaveliste på tvers av tenanter

`todo-storage-connection-string` er den ene secreten som med vilje har **samme
verdi i begge Key Vaults**, og som peker på en lagringskonto i den andre
tenanten. Grunnen er at oppgavelista skal finnes i én versjon: både pilot og
prod leser og skriver til `TodoPunkter`-tabellen på dev-kontoen.

Managed Identity kan ikke brukes til dette — MI er tenant-bundet, og prod-appens
identitet finnes ikke i dev-tenanten. Derfor delt nøkkel.

Anbefalt: bruk en **SAS på kontonivå** som bare gir tilgang til Table-tjenesten
i stedet for kontonøkkelen, så en lekkasje ikke gir tilgang til blobene.

I portalen (Storage account → Shared access signature):

| Felt | Verdi |
|---|---|
| Allowed services | **Table** og **Blob** |
| Allowed resource types | **Container** og **Object** |
| Allowed permissions | Read, Write, Delete, List, Add, Create, Update, Process |

**Blob er ikke valgfritt hvis TODO-punktene skal ha vedlegg.** De lagres som
blobber på samme konto. En SAS med bare Table gir en oppgaveliste som virker
helt til noen laster opp en fil, og da kommer feilen som «not authorized …
using this service» — en annen dialogboks i portalen enn den man leter i.

**Add og Update er heller ikke valgfrie.** Read og Write dekker ikke skriving
av rader i Table Storage: innsetting krever Add, oppdatering krever Update, og
en upsert krever begge. Mangler de, kommer feilen som
`AuthorizationPermissionMismatch` — som leses som «feil nøkkel», men betyr
«riktig nøkkel, for få rettigheter».

**Container-typen er ikke valgfri.** «Table» som ressurs er en *container* i SAS-
terminologien, mens radene er *objects*. Med bare Object får appen lest og
skrevet rader i en tabell som finnes, men den får ikke opprette `TodoPunkter`
første gang — og feilen kommer da som `TableNotFound`, ikke som en
tilgangsfeil. Alternativet er å opprette tabellen manuelt én gang og la SAS-en
stå på Object alene.

Connection stringen blir på formen:

```
TableEndpoint=https://<konto>.table.core.windows.net/;SharedAccessSignature=<sas-uten-ledende-spørsmålstegn>
```

Husk å sette en utløpsdato du faktisk følger opp — når SAS-en utløper slutter
oppgavefanen å svare, i begge miljøer samtidig. Er dev-kontoen bak brannmur, må
prod-SWAens utgående IP-er slippes inn.

## Aksesstilgang

**Appens kode slår ikke opp i Key Vault.** SWA Managed Functions eksponerer
ingen MI-token, så `DefaultAzureCredential` får ikke tak i noe —
`api/src/lib/keyvault.js` er død kode og importeres ingen steder. En
`@Microsoft.KeyVault(SecretUri=…)` i en app-setting blir derfor stående uløst,
og koden får referansestrengen som verdi. `maskLengde()` i
`api/src/functions/system.js` kjenner igjen det tilfellet og sier fra.

> **Dette gjelder pilot og prod.** Dev-miljøet kjører API-et som en
> frittstående Function App: der LØSER plattformen referansene, og lagringen
> går på en managed identity i stedet for tilkoblingsstreng (16.10.2026). Rådet
> i helsesjekken er derfor miljøavhengig — se `LØSER_KEYVAULT_REFERANSER` i
> `system.js` og 8j i `docs/BESLUTNING-EGEN-FUNCTION-APP.md`.

Den ene managed identityen som faktisk brukes ligger på SWA-ressursen i prod og
slås opp av **plattformen**: auth-sertifikatet hentes via
`clientSecretCertificateKeyVaultReference` i `staticwebapp.config.prod.json`.
Den identiteten trenger **Key Vault Secrets User** og **Key Vault Certificate
User** på `fhs-kv-01` — ingen storage-roller.

Du som forvalter secretsene trenger **Key Vault Secrets Officer**.

> **Legg rollen på en gruppe med minst to personer, ikke på en enkeltbruker.**
> Vaulten er den eneste kopien av verdiene (se under). Har bare én person
> rollen, er backupen uopprettelig den dagen vedkommende ikke er tilgjengelig
> — og det er nettopp slike dager man trenger den.

## Hvorfor vaulten fortsatt har en jobb

Spørsmålet kommer før eller siden, og det er et godt et: når verdiene uansett
står i klartekst i SWA Configuration, og ingenting i koden leser Key Vault, er
ikke vaulten da bare en ekstra kopi?

**Den gir ikke konfidensialitet.** Det skal sies rett ut. Den som har
Contributor på SWA-ressursen ser alle verdiene i Configuration, med eller uten
kopi i vaulten. Vaulten låser ingenting.

Den har fire jobber likevel:

**1. Gjenoppretting.** SWA Configuration er ett enkelt punkt. Blir ressursen
slettet, gjenskapt eller feilkonfigurert, er verdiene borte. Vaulten er da den
eneste kopien.

**2. Versjonshistorikk — den viktigste.** Tabellen over sier om
`backup-passphrase`: «Aldri [roter] uten å ta vare på den gamle — eldre
backuper blir ulesbare.» Backupene krypteres med AES-256-GCM og en nøkkel
utledet med PBKDF2 fra nettopp den verdien (`lib/backup-krypto.js`).
Overskriver du den i SWA Configuration, er den gamle borte for alltid, og hver
backup eldre enn byttet kan ikke åpnes igjen. Key Vault tar vare på gamle
versjoner av seg selv. Det ER «ta vare på den gamle», mekanisk. Samme gjelder
`hash-salt`: uten den gamle kan ingen eldre pseudonymer kobles.

**3. Revisjon.** Key Vault logger hvert oppslag, per secret. Azure Activity Log
sier bare at noen listet *alle* app settings — ikke hvem som hentet
backup-passordet.

**4. Skille mellom roller.** Den autoritative kopien ligger bak en annen
tildeling enn den som trengs for å rulle ut. Det reduserer ikke eksponeringen i
Configuration, men «hvem eier sannheten» og «hvem kan deploye» blir ikke samme
svar.

### Risikoen ved en kopi ingen leser

Siden ingenting leser vaulten under drift, er det **ingenting som oppdager at
kopien har drevet**. Endrer noen en verdi direkte i Configuration uten å
oppdatere vaulten, er backupen stille feil — og det oppdages den dagen den
trengs.

To ting demper det:

**Rekkefølgen er en regel:** ny verdi i Key Vault FØRST, så lim inn i SWA
Configuration. Aldri motsatt. Se «Rotasjon» under.

**Lengdesjekk uten å eksponere noe.** `/api/system/info` rapporterer lengden på
hver hemmelighet (`maskLengde()` i `api/src/functions/system.js`):

```jsonc
"STORAGE_CONNECTION_STRING": { "satt": true, "lengde": 191 },
"HASH_SALT":                 { "satt": true, "lengde": 14 }
```

Key Vault viser lengden til den som har Secrets Officer. Stemmer ikke
lengdene, har kopiene drevet. Du har da sammenlignet uten å hente fram en
eneste verdi — og uten å lime noe inn i en logg, en e-post eller et
chatvindu.

Lengde er ikke et sterkt bevis: to ulike verdier kan være like lange. Den
fanger det som faktisk skjer i praksis — en verdi som ble byttet ett sted og
ikke det andre — ikke en målrettet forfalskning.

## Rotasjon

**En ny verdi i Key Vault slår ikke gjennom av seg selv.** Det finnes ingen
cache som utløper og ingen referanse som følges — verdien i SWA Configuration
er en kopi, tatt for hånd.

Rotasjon er derfor to steg:

1. Ny versjon av secreten i Key Vault.
2. Kopier verdien inn i app-settingen i SWA Configuration, i **hvert** miljø
   som bruker den, og la deployen eller en restart plukke den opp.

Hopper du over steg 2, kjører appen videre på den gamle verdien — og oppdager
det først når den gamle deaktiveres. `/api/system/info` viser hvilke som er
satt, men ikke om de er *ferske*; det må følges i nøkkelkalenderen
(`/api/nokkelkalender`), som varsler `ADMIN_UPNS` før utløp.

Unntaket er auth-sertifikatet i prod, som plattformen henter direkte fra Key
Vault. Der er én rotasjon nok.

## Gjenoppretting av et miljø

Blir app settings i SWA Configuration slettet eller overskrevet, er
gjenopprettingen:

1. `config/env.<miljø>.json` sier hvilke nøkler som skal finnes, og hvor hver
   verdi kommer fra. `api/test/env-inventar.test.js` holder den lista
   fullstendig, så den kan brukes som sjekkliste.
2. Hemmelige verdier hentes fra Key Vault (`kv-fhsskjema-pilot` for pilot,
   `fhs-kv-01` for prod) og limes inn som klartekst.
3. `{"value"}`-verdiene står i inventarfila.
4. `{"settes_i_swa"}`-verdiene er miljøspesifikke og står hverken her eller i
   Key Vault — de må leses av miljøet selv (lagringskonto-navn, admin-UPN-er,
   SWA-URL).

### Et øyeblikksbilde av hele konfigurasjonen

Vil du ha SWA-ens egen JSON som ett gjenopprettbart objekt — altså punkt 3 og
4 dekket også — hører det **i Key Vault**, ikke i repoet:

```bash
az staticwebapp appsettings list --name <swa-navn> --resource-group <rg> -o json > /tmp/appsettings.json
az keyvault secret set --vault-name <vault> --name swa-appsettings-<miljø> --file /tmp/appsettings.json
shred -u /tmp/appsettings.json
```

Key Vault tar 25 KB per secret, og gir versjonshistorikk, tilgangsstyring og
revisjonslogg på kjøpet. Gjenta etter hver endring i Configuration.

> **Den utdataen skal aldri innom et commit, en e-post, en sak eller et
> chatvindu.** Den inneholder flyt-URLer med SAS-signatur,
> `STORAGE_CONNECTION_STRING` med full tilgang til lagringskontoen,
> `backup-passphrase` som låser opp alle backupene, og `hash-salt` som
> reverserer pseudonymene.
>
> Et privat repo er ikke kryptering — det er færre øyne. Git-historikk er
> permanent, og den klones til CI-runnere og hver utviklermaskin. Lekker noe
> dit, er rotasjon av ALT som lå der eneste utvei.
>
> `api/test/env-inventar.test.js` blir rød hvis en SAS-signatur, en
> `AccountKey=`, en `logic.azure.com`-adresse eller en privat nøkkel havner i
> en inventarfil.
