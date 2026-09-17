# Key Vault-secrets

Hemmeligheter som hører hjemme i Key Vault (`kv-fhsskjema-pilot-prod` for pilot,
prod-tenantens vault for prod). `config/env.*.json` viser hvilken secret hver
app-setting henter verdien sin fra.

> **Key Vault er kilden og rotasjonspunktet — ikke en referanse appen følger.**
> Verdien må limes inn som klartekst i SWA Configuration. Se «Rotasjon» nederst;
> dette er det punktet som oftest misforstås.

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

Den ene managed identityen som faktisk brukes ligger på SWA-ressursen i prod og
slås opp av **plattformen**: auth-sertifikatet hentes via
`clientSecretCertificateKeyVaultReference` i `staticwebapp.config.prod.json`.
Den identiteten trenger **Key Vault Secrets User** og **Key Vault Certificate
User** på `fhs-kv-01` — ingen storage-roller.

Du som forvalter secretsene trenger **Key Vault Secrets Officer**.

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
