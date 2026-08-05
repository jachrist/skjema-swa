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

## Aksesstilgang

Appens system-assigned managed identity må ha rollen **Key Vault Secrets User**
på Key Vault-ressursen. Bruker som administrerer secrets (deg) trenger
**Key Vault Secrets Officer**.

## Rotasjon

Etter oppdatering i Key Vault vil appen automatisk plukke opp ny verdi
innen 5 minutter (cache-TTL). For umiddelbar effekt: restart function-appen.
