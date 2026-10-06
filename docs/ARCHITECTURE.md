# Arkitektur

## Overordnet

```
[Nettleser]
    │
    │ HTTPS
    ▼
[Static Web App]  ←— CDN for statiske filer
    │
    ├─ /                 → frontend/*  (statisk)
    ├─ /.auth/*          → SWA innebygd Entra ID
    └─ /api/*            → Managed Functions (api/)
                              │
                              │ STORAGE_CONNECTION_STRING
                              ▼
                    ┌─────────────────────────┐
                    │  Table Storage          │
                    │  Blob Storage           │
                    └─────────────────────────┘
                              │
                              │ HTTP (utgående)
                              ▼
                    ┌─────────────────────────┐
                    │  FS API                 │
                    │  Power Automate-flyter  │
                    │    (e-post, varsling,   │
                    │     SP-liste)           │
                    └─────────────────────────┘
```

Hvilke Power Automate-flyter løsningen faktisk trenger, hva som utløser hver
av dem, og hva som kjører på klokke: `docs/FLYTER.md`.

Koden snakker ikke med Key Vault. Hemmelighetene når appen som app settings,
der SWA-hosten har løst `@Microsoft.KeyVault(...)`-referansene ved oppstart —
`STORAGE_CONNECTION_STRING` er en av dem. SWA Managed Functions eksponerer
ingen MI-token til koden, så `DefaultAzureCredential` har ingenting å hente;
`api/src/lib/keyvault.js` er død kode og importeres ingen steder. Se
`docs/SECURITY.md` for hvilken identitet som faktisk brukes, og til hva.

## Frontend

- Ren HTML/CSS/JS med ES-moduler. Ingen rammeverk, intet byggsteg utover config.js-generering.
- `frontend/js/config.js` genereres av `scripts/build-config.js` fra `config/env.<miljø>.json` under deploy.
- Auth via SWA's `/.auth/*`-endepunkter. `hentInnloggetBruker()` returnerer `clientPrincipal` fra `.auth/me`.
- Alle API-kall går gjennom `api-client.js` som sentral fetch-wrapper.
- HTML-filer har inline styling (`<style>`) og logikk (`<script type="module">`). Delt JS ligger i `frontend/js/`.

## API-lag

- Azure Functions v4 (programmatic model), Node 22. Kun HTTP-triggere.
- Hver funksjon er en modul i `api/src/functions/` som kaller `app.http()` ved require.
- `api/src/index.js` samler require-kallene.
- Delt logikk i `api/src/lib/` — storage, blob, auth, tilgang, vilkår, etc.
- Auth: SWA leverer verifisert `x-ms-client-principal`-header. `hentInnloggetUpn()` parser og returnerer UPN.
- Storage nås med `STORAGE_CONNECTION_STRING` fra app settings. Ikke Managed Identity — se over.

### Unngåtte rundturer mot Table Storage

Table Storage-kall dominerer svartiden. Tre mekanismer holder antallet nede —
alle er gjennomsiktige for kallerne:

- **`sikreTabell(navn)`** i `lib/storage.js` gjenbruker `TableClient` og kjører
  `createTable()` maks én gang per tabell per prosess. Før dette kostet hvert
  lille oppslag en ekstra rundtur som alltid feilet med 409.
- **`lagTilgangsCache()`** i `lib/tilgang.js` er en memo som lever gjennom
  én forespørsel. Send samme cache til `filtrerTyperPåTilgang()` (både Eiere og
  Publikum) og til `brukerErBehandlerAsync()` når mange skjemaer sjekkes —
  da slås hver (rolle, bruker) opp én gang i stedet for én gang per skjema.
  Ingen tilstand overlever forespørselen, så tilgang kan ikke bli utdatert.
- **Lese-cache på FilterStudent** i `lib/emner-storage.js`, 60 sekunder.
  Klasse-, kull- og studentlister er store og skrives bare av FS-nattjobben.
  `upsertBatch()` tømmer cachen, så en oppfriskning slår gjennom umiddelbart.

`sikrFulltFormat(skjema, defCache)` tar en valgfri `Map` for løkker som
ekspanderer mange skjemaer av samme type (se `mine-behandlinger`).

### Kjent begrensning: siste skriving vinner

Skriving til Table Storage skjer uten samtidighetskontroll. `lagreSkjematype`
kjører `upsertEntity(entity, 'Replace')` og `lagreSkjema` `upsertEntity(entity,
'Merge')` — ingen av dem sjekker ETag. To som lagrer samme rad etter hverandre
gir derfor at den siste overskriver den første, uten at noen får vite det.

Det er ikke teoretisk. 06.10.2026 hadde en eier samme skjematype åpen i to
faner, rettet og lagret i den ene, og lagret deretter den urettede tilbake fra
den andre. Rettelsen var borte, og ingenting i grensesnittet sa fra. To ulike
eiere som redigerer samtidig gir samme utfall — og da er det ikke engang den
samme personen som kan oppdage det.

Editorens `beforeunload`-vakt dekker ikke dette: den kjenner bare dine egne
ulagrede endringer, ikke at raden er endret under beina på deg.

Verdt å merke seg særskilt: `lagreBeslutning` leser hele skjemaet, endrer det
og skriver det tilbake. To behandlere som avgjør samtidig på et «alle må
avgjøre»-steg kan i prinsippet miste den ene beslutningen. Vinduet er smalt, og
det er ikke observert — men mekanismen er den samme, og konsekvensen større enn
en tapt skjemadefinisjon.

Rettelsen er optimistisk samtidighetskontroll med ETag, samme mønster som
`lib/skjema-id.js` alt bruker mot Teller-tabellen: `hentSkjematype` returnerer
raden sin ETag, klienten sender den tilbake, `updateEntity` med `ifMatch` gir
412 på en endret rad, og API-et svarer 409 så grensesnittet kan si «noen har
lagret denne siden du åpnet den». Bevisst utsatt 06.10.2026.

## Konfigurasjon

- `config/env.development.json` og `config/env.production.json` er sannhetskilden.
- Hver oppføring er enten:
  - `{ "value": "...", "public": true|false }` — direkte verdi
  - `{ "keyvault": "secret-navn" }` — referanse til Key Vault
- Ikke-hemmelige `public: true`-verdier eksponeres til frontend via `config.js`.
- Ikke-hemmelige `public: false`-verdier settes som App Settings på SWA under deploy.
- `keyvault`-referanser settes som app settings på SWA med `@Microsoft.KeyVault(...)`-syntaks, og løses av hosten ved oppstart. Koden leser dem som vanlige env-vars, og en rotert hemmelighet får derfor effekt først ved restart.

## CI/CD

- **CI (`ci.yml`)**: kjører på PR mot `main`. `npm ci` + `npm test` + `build-config.js`.
- **Deploy (`deploy.yml`)**: kjører på push til `main`. Environment `production` → required reviewer.
- **Refresh-FS (`refresh-fs.yml`)**: schedule cron daglig 04:00 UTC → HTTP-kall mot `/api/refresh-fs`.

## Logging

Alt går til Application Insights. **SWA Managed Functions har ingen Log
stream** — det bladet finnes bare på en ordinær Function App, og at det mangler
leses lett som at ingenting logges.

Live metrics er det nærmeste en strøm; `Logs` er presist i etterkant. Sampling
er på for `traces`, ikke for `requests`. Se `docs/LOGGING.md`, som også lister
linjene det er verdt å kjenne igjen.

## Miljøer

- **development**: SWA-slot for utvikling og test. Ikke bak review, deployes automatisk fra feature-branches (planlagt utvidelse).
- **production**: Push til `main` → deploy krever manual approval av en reviewer i `production`-environment.

## Sikkerhetsprinsipper

- Hemmeligheter bare i Key Vault, aldri i kode eller env-JSON. Koden får dem som app settings, løst av SWA-hosten.
- Env-JSON committes, secrets ikke.
- Branch protection på `main`: PR påkrevd, 1+ review, signerte commits, "include administrators".
- CODEOWNERS på `.github/`, `config/`, `staticwebapp.config.*.json`.
- GitHub push protection + secret scanning slått på.
- Deploy-identitet minst-privilegert: kun deploy til én SWA.
