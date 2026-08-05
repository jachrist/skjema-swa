# skjema-swa — pilot

SWA-basert reimplementasjon av FHS Skjema-appen. Se `docs/ARCHITECTURE.md` for helhet.

## Kjør lokalt

Krever Node 22 (`nvm use`), Azure Functions Core Tools v4, og [SWA CLI](https://azure.github.io/static-web-apps-cli/).

```powershell
# 1. Installer avhengigheter for API-laget
cd api
npm install
cd ..

# 2. Generer frontend/js/config.js for lokal utvikling
node scripts/build-config.js development

# 3. Kopier local.settings.example.json → local.settings.json og fyll inn
copy api\local.settings.example.json api\local.settings.json

# 4. Start både frontend og API med SWA CLI
swa start frontend --api-location api
```

Nettleseren peker på `http://localhost:4280` (SWA-emulator).

## Deploy

Push til `main` → deploy til `production` (krever review). PR mot `main` → deploy til `development`.
Se `docs/DEPLOY.md` for engangsoppsett av Azure-ressursene.

## Struktur

```
frontend/   Statiske filer (HTML/JS/CSS)
api/        Azure Functions (HTTP-triggere)
config/     Miljøvariabler + Key Vault-referanser (ikke-hemmelige)
scripts/    Build- og hjelpescripts
docs/       Arkitektur, sikkerhet, deploy, datamodell
.github/    Workflows (CI + deploy + cron)
```
