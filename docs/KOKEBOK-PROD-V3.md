# Kokebok: opprett prod v3

**Formål:** sette opp en ny, parallell produksjonsstakk i prod-tenanten —
samme arkitektur som dev — mot en **blank lagringskonto**, slik at den kan
testes ved siden av dagens prod (v2) før en cutover.

Skrevet for å kjøres i ett arbeidsmøte sammen med admin fra Cyberforsvaret.
Hver kommando står i dokumentet; ingen skriptkjøringer skal bestilles.

> **Dette dokumentet er speilet av dev.** Oppsettet er målt der (8g–8p i
> `BESLUTNING-EGEN-FUNCTION-APP.md`), og navnene er dev-navnene med `dev`
> byttet ut med `prod`. Det som IKKE er målt, er prod-tenantens egne
> rammer: policyer, tillatte regioner, navnekrav og hvem som har hvilke
> roller. Derfor skal en admin med rettigheter sitte i rommet — ikke fordi
> kommandoene er usikre, men fordi svarene deres er det.

---

## 0. Før møtet

| Avklart? | Hva | Hvorfor det må være avklart først |
|---|---|---|
| ☐ | Abonnement og ressursgruppe | Alle kommandoene under peker på dem |
| ☐ | Hvem som kan tildele RBAC-roller | `Owner` eller `User Access Administrator`. Uten dette stopper trinn 2 |
| ☐ | Key Vault: gjenbruk `fhs-kv-01` eller ny `kv-skjema-3-prod`? | Se 3.1 — valget avgjør én kommando |
| ☐ | Flytene er kopiert til prod-tenanten med **Entra-autentisering** | Se trinn 7. Uten dette sender v3 ingenting |
| ☐ | Domene/subdomene bestemt | Se 9. Ikke nødvendig for oppsettet, men avgjør cutover |

**Logg inn og velg abonnement:**

```bash
az login --tenant <prod-tenant-id>
az account set --subscription <abonnements-id>
az account show --query "{abonnement:name, id:id, tenant:tenantId}" -o table
```

---

## 1. Navn

Samme konvensjon som dev, med `dev` → `prod`.

| Rolle | dev | **prod v3** |
|---|---|---|
| Ressursgruppe | `rg-skjema-3-dev` | `rg-skjema-3-prod` |
| Function App (API) | `fa-skjema-3-dev` | `fa-skjema-3-prod` |
| Managed identity | `mi-skjema-3-dev` | `mi-skjema-3-prod` |
| Datalagring (blank!) | `stskjema3dev` | `stskjema3prod` |
| Runtime-lagring | (egen konto) | `stskjema3prodrt` |
| Static Web App | *(dev-SWA)* | `swa-skjema-3-prod` |
| Key Vault | `kv-skjema-3-dev` | `fhs-kv-01` *eller* `kv-skjema-3-prod` |
| Region | `norwayeast` | `norwayeast` (SWA: `westeurope`) |

**Lagringskontonavn tåler ikke bindestrek**, derfor `stskjema3prod`.

> **`stskjema3prod` skal være TOM.** Hele poenget med v3 er å teste uten å
> røre v2 sine data. Cutover skjer ved å peke v3 mot v2 sin konto senere —
> se 10.

```bash
# Variabler resten av dokumentet bruker. Kjør i samme skall hele veien.
RG=rg-skjema-3-prod
STED=norwayeast
FA=fa-skjema-3-prod
MI=mi-skjema-3-prod
DATA=stskjema3prod
RT=stskjema3prodrt
SWA=swa-skjema-3-prod
KV=fhs-kv-01            # eller kv-skjema-3-prod, se 3.1
SUB=$(az account show --query id -o tsv)
```

---

## 2. Ressursgruppe og lagring

```bash
az group create --name $RG --location $STED --output none

# Datalagringen — den blanke kontoen v3 skal bruke.
az storage account create --name $DATA --resource-group $RG --location $STED \
  --sku Standard_LRS --kind StorageV2 --min-tls-version TLS1_2 \
  --allow-blob-public-access false --output none

# Runtime-lagring til Function App-en (schedule, låser, logger).
# EGEN KONTO, ikke datalagringen: timer-triggere lagrer sin plassering i
# planen her, og en jobb som roter i den kontoen skal ikke kunne røre data.
az storage account create --name $RT --resource-group $RG --location $STED \
  --sku Standard_LRS --kind StorageV2 --min-tls-version TLS1_2 \
  --allow-blob-public-access false --output none
```

> **`--output none` er ikke pynt.** `az storage account ...` uten den skriver
> ut kontonøkler i klartekst. De skal aldri havne i en terminal-logg, et
> møtereferat eller en commit.

---

## 3. Function App, identitet og roller

Dette trinnet kjøres av `scripts/steg1-funcapp.ps1`, som bygde dev-miljøet.
Skriptet **tørrkjører uten `-Kjor`** — kjør alltid tørt først og les utskriften.

```powershell
# PowerShell. Tørrkjøring:
.\scripts\steg1-funcapp.ps1 -Rg rg-skjema-3-prod -FuncApp fa-skjema-3-prod `
    -Lagring stskjema3prodrt -DataLagring stskjema3prod `
    -Identitet mi-skjema-3-prod -KeyVault fhs-kv-01 `
    -Swa swa-skjema-3-prod -Trinn funcapp

# Når utskriften ser riktig ut — samme kommando med -Kjor:
.\scripts\steg1-funcapp.ps1 -Rg rg-skjema-3-prod -FuncApp fa-skjema-3-prod `
    -Lagring stskjema3prodrt -DataLagring stskjema3prod `
    -Identitet mi-skjema-3-prod -KeyVault fhs-kv-01 `
    -Swa swa-skjema-3-prod -Trinn funcapp -Kjor
```

Skriptet gjør, i denne rekkefølgen:

1. runtime-lagringskonto (hvis den ikke finnes)
2. Function App, Node 22, Linux
3. **user-assigned** managed identity, knyttet til appen, `AZURE_CLIENT_ID`
   satt og `keyVaultReferenceIdentity` pekt på den
4. tre storage-roller på datalagringen + `Key Vault Secrets User`

**Identiteten er user-assigned med vilje.** En system-assigned identitet dør
med Function App-en, og da må hver håndgitte tildeling gjøres om — rollene,
Graph-approllene, SharePoint-tilgangen per site, og `oid` i flytenes
allow-liste.

### 3.1 Hvis Key Vault ligger i en annen ressursgruppe

Skriptet bygger rolle-scopet med **samme ressursgruppe** som Function App-en.
Gjenbrukes `fhs-kv-01` og den ligger et annet sted, feiler den ene
rolletildelingen. Gjør den da manuelt:

```bash
PRINCIPAL=$(az identity show --name $MI --resource-group $RG --query principalId -o tsv)
KV_ID=$(az keyvault show --name $KV --query id -o tsv)    # full ressurs-ID, uansett RG

az role assignment create --assignee-object-id $PRINCIPAL \
  --assignee-principal-type ServicePrincipal \
  --role "Key Vault Secrets User" --scope "$KV_ID" --output none
```

**Anbefaling:** gjenbruk `fhs-kv-01`. Hemmelighetene ligger der allerede, og
en ny vault betyr at hver verdi må kopieres — altså innom noens skjerm.

### 3.2 Kontroller rollene

```bash
az role assignment list --assignee-object-id $PRINCIPAL --all \
  --query "[].{rolle:roleDefinitionName, scope:scope}" -o table
```

Forventet: `Storage Table Data Contributor`, `Storage Blob Data Contributor`
og `Storage Blob Delegator` på `stskjema3prod`, pluss `Key Vault Secrets User`
på vaulten.

**Ingen av dem heter «Contributor».** Den rollen gir ikke tilgang til en
eneste tabellrad, men gir rett til å liste kontonøklene — full datatilgang
gjennom en sidedør, med den delte nøkkelen hele øvelsen går ut på å fjerne.

---

## 4. App settings på Function App-en

Inventaret er fasiten, ikke dette dokumentet. Hent lista med navn og form:

```bash
node -e '
const d = require("./config/env.prod.json");
const grupper = { keyvault: [], value: [], settes_i_swa: [], valgfri: [], kun_dokumentasjon: [] };
for (const [k, v] of Object.entries(d)) {
  if (k.startsWith("_")) continue;
  const form = ["keyvault","value","settes_i_swa","valgfri","kun_dokumentasjon"].find(f => f in v);
  if (form) grupper[form].push(form === "keyvault" ? `${k}  ←  ${v.keyvault}` : k);
}
for (const [form, liste] of Object.entries(grupper)) {
  console.log(`\n== ${form} (${liste.length}) ==`);
  for (const n of liste.sort()) console.log("  " + n);
}'
```

Formene betyr:

| Form | Hva du gjør |
|---|---|
| `keyvault` | Sett som Key Vault-referanse (se under). Secret-navnet står i `config/keyvault-secrets.md` |
| `value` | Kopier verdien fra `config/env.prod.json`. Ikke hemmelig |
| `settes_i_swa` | Hører hjemme på SWA-ressursen, ikke her |
| `valgfri` | Trenger ingen verdi. Alle `*_SCHEDULE` er her |
| `kun_dokumentasjon` | Settes av plattformen eller står for oversiktens skyld |

**Key Vault-referanser** — og dette er forskjellen fra v2: en frittstående
Function App LØSER dem (målt 14.10.2026, 8d). SWA Managed Functions gjør det
ikke, og det er derfor v2 har klartekst.

```bash
# Én setting. Gjenta per hemmelighet, eller legg dem i en løkke.
VAULT_URL=$(az keyvault show --name $KV --query properties.vaultUri -o tsv)
az functionapp config appsettings set --name $FA --resource-group $RG \
  --settings "HASH_SALT=@Microsoft.KeyVault(SecretUri=${VAULT_URL}secrets/hash-salt/)" \
  --output none
```

```bash
# Ikke-hemmelige verdier, flere om gangen:
az functionapp config appsettings set --name $FA --resource-group $RG \
  --settings MILJO=prod FS_EIER_ORG_KODE=<kode> FLYT_AUTH=entra \
  --output none
```

**`--output none` på HVER av disse.** Uten den skriver `az` ut alle app
settings, inkludert de hemmelige, som JSON i terminalen.

### 4.1 Settings som ikke står i inventaret

```bash
# Timer-jobben refresh-fs tar 2-4 minutter, og TIMEREN VENTER på hele
# kjøringen. Standarden på Consumption er fem minutter. Denne hever grensen
# for DENNE appen alene — host.json deployes også til SWA Managed Functions
# i v2, og en verdi den verten ikke godtar tar ned appen der.
az functionapp config appsettings set --name $FA --resource-group $RG \
  --settings AzureFunctionsJobHost__functionTimeout=00:10:00 --output none
```

### 4.2 Kontroller uten å lekke

```bash
# NAVNENE, ikke verdiene. Den fulle lista hører ikke hjemme i en terminal.
az functionapp config appsettings list --name $FA --resource-group $RG \
  --query "[].name" -o tsv | sort
```

---

## 5. Static Web App, innhold og lenking

**REKKEFØLGEN ER POENGET.** Første forsøk 14.10.2026 lenket en backend til en
SWA som aldri hadde hatt en vellykket deploy. Aktivitetsloggen sa at alt var i
orden, miljøet sto på «Uploading» i timevis, og ingenting rutet. **Innholdet
må på plass FØR lenkingen.**

```powershell
# 5.1 Opprett SWA-en (Standard — lenkede backends finnes ikke på Free)
.\scripts\steg1-funcapp.ps1 -Rg rg-skjema-3-prod -Swa swa-skjema-3-prod `
    -FuncApp fa-skjema-3-prod -Trinn swa -Kjor
```

```bash
# 5.2 Deploy-token til GitHub. Skriv det ALDRI ut i terminalen.
az staticwebapp secrets list --name $SWA --resource-group $RG \
  --query "properties.apiKey" -o tsv | gh secret set AZURE_STATIC_WEB_APPS_API_TOKEN_PROD_V3
```

> Har dere ikke `gh` tilgjengelig: hent verdien i portalen og lim den rett
> inn i GitHub → Settings → Secrets. Ikke via et mellomlagringssted.

**5.3 Deploy frontend** — kjør workflowen *Deploy frontend til dev-SWA* sin
prod-v3-variant, eller midlertidig `deploy-dev.yml` med v3-tokenet.
Bekreft i nettleseren at forsiden vises før du går videre.

```powershell
# 5.4 Lenk Function App-en til SWA-en — FØRST NÅ
.\scripts\steg1-funcapp.ps1 -Rg rg-skjema-3-prod -Swa swa-skjema-3-prod `
    -FuncApp fa-skjema-3-prod -Trinn lenk -Kjor
```

```bash
# 5.5 Bekreft at lenkingen står
az staticwebapp backends show --name $SWA --resource-group $RG -o table
```

---

## 6. Innlogging (Entra)

SWA-en trenger sin egen app-registrering, eller gjenbruk av v2 sin med en ny
redirect-URI.

```bash
# Legg v3 sin URL til som redirect-URI på app-registreringen:
VERT=$(az staticwebapp show --name $SWA --resource-group $RG --query defaultHostname -o tsv)
echo "https://$VERT/.auth/login/aad/callback"
# → legges inn under Authentication på app-registreringen i Entra
```

Verdiene `AAD_CLIENT_ID` og auth-sertifikatet settes på **SWA-ressursen**,
ikke på Function App-en. I prod hentes sertifikatet fra Key Vault via
`clientSecretCertificateKeyVaultReference` i `staticwebapp.config.prod.json`
— den oppslaget gjøres av *plattformen*, med SWA-ens egen identitet, og den
trenger `Key Vault Secrets User` **og** `Key Vault Certificate User`.

> **`openIdIssuer` skal aldri settes til `/common/` eller `/organizations/`.**
> Da slipper hvilken som helst Entra-tenant inn.

---

## 7. Flytene

v3 bruker `FLYT_AUTH=entra`, som dev. Det betyr at:

1. Flytene i prod-tenanten må være de **nye versjonene** med
   `https://service.flow.microsoft.com/` som audience — **med skråstrek
   bakerst**. Uten den avvises tokenet, og en 401 fra en flyt lager **ingen
   kjøring i historikken**: tom historikk betyr ikke at kallet uteble.
2. `mi-skjema-3-prod` sin **objectId (oid)** må inn i flytenes allow-liste.

```bash
az identity show --name $MI --resource-group $RG --query principalId -o tsv
```

3. Flyt-URLene settes som app settings (`*_FLOW_URL`). Uten `sig=` i URL-en
   er de ikke hemmeligheter — men sjekk at de faktisk er Entra-beskyttet
   først.
4. **Connectorene eies av en servicebruker.** Den har ingen rettigheter ut
   over en vanlig bruker: for å opprette oppgaver eller skrive i Teams må den
   meldes eksplisitt inn som teammedlem.

**Sett `VARSLING_DEAKTIVERT=true` fra dag én i v3.** Flytene i prod-tenanten
skriver til ekte Teams og sender ekte e-post, uansett hvor blank lagringen er.

```bash
az functionapp config appsettings set --name $FA --resource-group $RG \
  --settings VARSLING_DEAKTIVERT=true --output none
```

---

## 8. Deploy av API-et

```bash
# Tjenesteprinsipal for GitHub Actions. UTSKRIFTEN ER EN HEMMELIGHET —
# den går rett inn i GitHub-secreten, ikke via en sak, e-post eller chat.
az ad sp create-for-rbac --name sp-skjema-3-prod-deploy --role contributor \
  --scopes /subscriptions/$SUB/resourceGroups/$RG --sdk-auth \
  | gh secret set AZURE_FUNCAPP_CREDENTIALS_PROD
```

Kjør så workflowen **Deploy API til Function App** med
`appnavn = fa-skjema-3-prod` og `miljo = prod`.

---

## 9. Verifikasjon — i denne rekkefølgen

| # | Sjekk | Forventet |
|---|---|---|
| 1 | `https://<vert>/api/ping` | Svarer, med **commit-SHA-en** du nettopp deployet |
| 2 | Logg inn | Du kommer inn, med din egen UPN øverst |
| 3 | **Administrasjon → ⚙️ System** | `lagring.maate` = `managed-identity`, `flytAuth` = `entra` |
| 4 | Samme side | Ingen Key Vault-referanse står uløst |
| 5 | **Administrasjon → ⏱ Jobber** | Ni timere, alle med `registrert: …` |
| 6 | **Skjematyper → 📥 Importer definisjoner** | Last inn pakken fra v2. Les forhåndsvisningen |
| 7 | Send inn et testskjema | Skrives til `stskjema3prod` |
| 8 | **Jobber → Kjør nå** på oppslagslister | Statusraden går til `ok` |

> Punkt 1 er den som sparer mest tid senere: `/api/ping` og `/js/config.js`
> bærer hver sin SHA. Avvik mellom dem betyr en halv deploy — og symptomet
> er en funksjon som «mangler», ikke en feilmelding.

---

## 10. Cutover og tilbakevei

To former, og de skal ikke blandes:

**A. Ompeking** — `STORAGE_ACCOUNT_NAME` på v3 endres fra `stskjema3prod` til
v2 sin konto. Ingen datakopi, ingen frys.

```bash
# MI-en må ha rollene på DEN kontoen også. Gjør dette FØR ompekingen.
V2_ID=$(az storage account show --name <v2-konto> --resource-group <v2-rg> --query id -o tsv)
for R in "Storage Table Data Contributor" "Storage Blob Data Contributor" "Storage Blob Delegator"; do
  az role assignment create --assignee-object-id $PRINCIPAL \
    --assignee-principal-type ServicePrincipal --role "$R" --scope "$V2_ID" --output none
done
```

**B. Full migrering** — `scripts/migrer/` kopierer tabeller og vedlegg til en
ny konto. Krever 24 timers kjørestopp for å unngå endringer underveis, men
lar v2 sine data stå helt urørt.

### Uansett form: STOPP DE DOBLE KJØRINGENE

v2 trigges av GitHub Actions-cron; v3 har timere. Peker begge på samme
lagring, kjører hver jobb **to ganger** — og fire av dem sender ut av huset.
Utsending og purring ville gått dobbelt til eksterne mottakere.

**Ta prod ut av matrisene i de åtte workflowene i samme operasjon**, ikke
etterpå. Som belte: roter `SCHEDULER_KEY` på v2, så et gjenglemt cron-kall
får 401 i stedet for å kjøre.

### Tilbakevei

Gjør cutover til et **domenebytte**, ikke en ny URL. Da er tilbakeveien én
DNS-endring. Får folk en ny adresse å bokmerke, er fallback rotete uansett
hvor ren koden er.

Med et eget domene kan versjonene adresseres hver for seg —
`fskjema.no` for gjeldende prod, `v3.fskjema.no` mens den testes,
`dev.fskjema.no` for dev. Må avtales med Cyberforsvaret.

---

## 11. Riving, hvis v3 skal bort

```bash
az staticwebapp backends unlink --name $SWA --resource-group $RG
az staticwebapp delete --name $SWA --resource-group $RG --yes
az functionapp delete --name $FA --resource-group $RG
az storage account delete --name $DATA --resource-group $RG --yes
az storage account delete --name $RT --resource-group $RG --yes
az identity delete --name $MI --resource-group $RG
# Rolletildelingene forsvinner ikke med identiteten:
az role assignment list --assignee-object-id $PRINCIPAL --all --query "[].id" -o tsv \
  | xargs -r -n1 az role assignment delete --ids
```

---

## 12. Regler som gjelder hele veien

- **`--output none` på alt som setter eller leser app settings og
  lagringsnøkler.** Utskriften inneholder hemmeligheter.
- **`az ad sp create-for-rbac`-utskriften er en hemmelighet.** Rett inn i
  GitHub-secreten.
- **Ingen hemmeligheter i `config/env.*.json`.** Bare Key Vault-referanser
  eller ikke-sensitive verdier.
- **En Power Automate-URL med `sig=` er legitimasjon.** Den som har lenken
  har tilgangen.
- **Ingen utskrift fra `az ... appsettings list` i en commit, e-post eller
  sak.** Navnene er greie; verdiene er det ikke.
