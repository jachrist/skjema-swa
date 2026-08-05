# skjema-swa

SWA-basert reimplementasjon av FHS Skjema-løsningen.
Språk: **norsk** i kode, kommentarer, API-feltnavn og brukergrensesnitt.

## Arkitektur

- **Frontend:** ren HTML/CSS/JS med ES-moduler i `frontend/`. Ingen byggsteg (bortsett fra config.js-generering).
- **Backend:** Azure Functions v4 i `api/`, kun HTTP-triggere.
- **Datalagring:** Azure Table Storage + Blob Storage via Managed Identity (`DefaultAzureCredential`).
- **Hemmeligheter:** Azure Key Vault, aksessert via Managed Identity.
- **Auth:** Static Web Apps innebygd Entra ID — UPN leses fra `x-ms-client-principal`-header via `api/src/lib/auth.js`.
- **Deploy:** GitHub Actions → SWA, med Environments (`development`, `production`).

## Viktige konvensjoner

- Ingen hemmeligheter i kode eller i env-JSON. Kun Key Vault-referanser (`{"keyvault": "secret-navn"}`) eller ikke-sensitive verdier (`{"value": "...", "public": true|false}`).
- Ikke-hemmelige verdier med `"public": true` eksponeres til frontend via `frontend/js/config.js` (bygget av `scripts/build-config.js`).
- Timer-triggere støttes ikke i SWA Managed Functions — bruk GitHub Actions cron mot HTTP-endepunkter (`.github/workflows/refresh-fs.yml`).
- Autorisasjon på ruter håndteres primært deklarativt i `staticwebapp.config.json`. Fininnstilt admin-sjekk gjøres i handler via `erAdmin(upn)`.
- HTML-filene har inline CSS/JS — samme mønster som referanse-appen. Ikke trekk ut felles CSS uten eksplisitt avtale.

## Miljøer

- **development** — SWA i egen tenant, `env.development.json` + Key Vault `kv-fhsskjema-pilot`.
- **production** — samme SWA under pilot, senere separert. Deploy krever Environment approval.

## Referanse-app

Den opprinnelige Function App-versjonen ligger i en separat mappe utenfor dette repoet.
Mønstre gjenbrukes (dispatcher, DNF-vilkår, kompakt format), men koden reimplementeres for SWA-arkitektur.
Rør ikke referanse-appen fra dette repoet.
