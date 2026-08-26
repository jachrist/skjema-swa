# Key Vault-secrets

Oversikt over hemmeligheter som må ligge i Key Vault (`kv-fhsskjema-pilot` for dev,
`kv-fhsskjema-pilot-prod` for prod). Referanser i `env.*.json` peker på disse.

| Secret-navn | Beskrivelse | Rotasjon |
|---|---|---|
| `fs-api-url` | Base-URL for FS-integrasjonen | Sjelden |
| `fs-api-user` | Bruker for FS-API | Ved bytte |
| `fs-api-password` | Passord for FS-API | Månedlig anbefales |
| `fs-eier-org-kode` | FHS sin eier-org-kode i FS | Sjelden |
| `epost-flow-url` | Power Automate: e-post-utsendelse | Ved regenerering av flyt |
| `varsling-flow-url` | Power Automate: varsling | Ved regenerering av flyt |
| `sp-liste-flow-url` | Power Automate: SP-liste-oppdatering | Ved regenerering av flyt |
| `device-token-secret` | HMAC-nøkkel for device-token | Sjelden — invaliderer alle tokens ved rotasjon |
| `scheduler-key` | Header-verdi som cron-workflow sender til `/api/refresh-fs` | Ved lekkasje |
| `todo-storage-connection-string` | Connection string til dev-tenantens lagringskonto, for den delte oppgavelista | Ved lekkasje — se under |

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
| Allowed services | **Table** (bare den) |
| Allowed resource types | **Container** og **Object** |
| Allowed permissions | Read, Write, Delete, List, Add, Create, Update, Process |

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

Appens system-assigned managed identity må ha rollen **Key Vault Secrets User**
på Key Vault-ressursen. Bruker som administrerer secrets (deg) trenger
**Key Vault Secrets Officer**.

## Rotasjon

Etter oppdatering i Key Vault vil appen automatisk plukke opp ny verdi
innen 5 minutter (cache-TTL). For umiddelbar effekt: restart function-appen.
