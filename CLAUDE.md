# skjema-swa

SWA-basert reimplementasjon av FHS Skjema-løsningen.
Språk: **norsk** i kode, kommentarer, API-feltnavn og brukergrensesnitt.

## Arkitektur

- **Frontend:** ren HTML/CSS/JS med ES-moduler i `frontend/`. Ingen byggsteg (bortsett fra config.js-generering).
- **Backend:** Azure Functions v4 i `api/`, kun HTTP-triggere.
- **Datalagring:** Azure Table Storage + Blob Storage via tilkoblingsstreng
  (`STORAGE_CONNECTION_STRING`), lest i `lib/storage.js` og `lib/blob.js`.
- **Hemmeligheter:** app settings i SWA Configuration. Verdiene hentes manuelt
  fra Key Vault når de settes — koden slår ikke opp i Key Vault selv.

> **Managed Identity er ikke tilgjengelig for koden vår.** SWA Managed
> Functions eksponerer ingen MI-token, så `DefaultAzureCredential` får ikke
> tak i noe. `lib/keyvault.js` er død kode og importeres ingen steder.
>
> Den ene MI-en som faktisk brukes, ligger på SWA-ressursen i prod og slås opp
> av *plattformen*, ikke av oss: auth-sertifikatet hentes fra Key Vault via
> `clientSecretCertificateKeyVaultReference` i `staticwebapp.config.prod.json`.
> Den identiteten trenger bare **Key Vault Secrets User** og **Key Vault
> Certificate User** på `fhs-kv-01` — ingen storage-roller.
>
> Pilot-SWA-en har storage-roller på sin MI. De er levninger fra det
> opprinnelige designet og brukes ikke; ikke kopier dem til nye miljøer.
- **Auth:** Static Web Apps innebygd Entra ID — UPN leses fra `x-ms-client-principal`-header via `api/src/lib/auth.js`.
- **Deploy:** GitHub Actions → SWA, med Environments (`development`, `production`).

## Viktige konvensjoner

- Ingen hemmeligheter i kode eller i env-JSON. Kun Key Vault-referanser (`{"keyvault": "secret-navn"}`) eller ikke-sensitive verdier (`{"value": "...", "public": true|false}`).
- Ikke-hemmelige verdier med `"public": true` eksponeres til frontend via `frontend/js/config.js` (bygget av `scripts/build-config.js`).
- Timer-triggere støttes ikke i SWA Managed Functions — bruk GitHub Actions cron mot HTTP-endepunkter (`.github/workflows/refresh-fs.yml`).
- Autorisasjon på ruter håndteres primært deklarativt i `staticwebapp.config.json`. Fininnstilt admin-sjekk gjøres i handler via `erAdmin(upn)`.
- HTML-filene har inline CSS/JS — samme mønster som referanse-appen. Ikke trekk ut felles CSS uten eksplisitt avtale.
- Tester: `npm test` fra `api/` kjører alt via `scripts/kjor-tester.js` — alle
  `*.test.js` i `api/test/` og `frontend/test/`. Testene skal kunne kjøre **uten**
  `node_modules`; derfor lastes Azure-SDK-ene lat i `storage.js` og `blob.js`.
  Frontend-tester klipper ut den aktuelle seksjonen fra HTML-fila og kjører den
  mot stubbet DOM. Deploy kjører testene før utrulling og stopper på rødt.

## Miljøer

- **development** — SWA i egen tenant, `env.development.json` + Key Vault `kv-fhsskjema-pilot`.
- **production** — samme SWA under pilot, senere separert. Deploy krever Environment approval.

## Referanse-app

Den opprinnelige Function App-versjonen ligger i en separat mappe utenfor dette repoet.
Mønstre gjenbrukes (dispatcher, DNF-vilkår, kompakt format), men koden reimplementeres for SWA-arkitektur.
Rør ikke referanse-appen fra dette repoet.

## Gjenstående arbeid

`docs/TODO.md` er den løpende lista over utestående punkter — både brukerønsker
og teknisk gjeld. Kryss av der når et punkt leveres, og legg nye punkter nederst
så numrene holder seg stabile.
