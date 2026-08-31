# Backup til SharePoint via Microsoft Graph

Backupen lastes opp til et SharePoint-bibliotek rett fra API-et, med en Graph
*upload session*. Denne erstatter veien om Power Automate, som ikke tåler store
filer: HTTP-handlingen der leser hele svaret i minnet med et tak på 100 MiB, og
blir svaret stort nok lagres det som «partial content» som ingen uttrykk kan
røre. Slår man på chunking, overtar PA Range-headeren og kolliderer med vår egen.

Graph har ingen av delene. Vi styrer bitene selv (10 MiB), hver bit sier
eksplisitt hvilke bytes den er, og taket er 250 GB.

PA-flyten er beholdt som reservevei: er `GRAPH_*` ikke satt, kalles
`BACKUP_FLOW_URL` som før. Overgangen kan derfor tas ett miljø om gangen.

## Hvorfor SharePoint og ikke OneDrive

Et personlig OneDrive henger på én ansattkonto. Slutter vedkommende, forsvinner
backupene med kontoen. Et dokumentbibliotek på et team-område overlever
personskifter og har ryddigere tilgangsstyring.

## Hvorfor app-registreringen kan ligge i dev-tenanten

App-registreringen trenger ikke ligge i samme tenant som appen som bruker den.
SWA-en er bare en HTTP-klient med en hemmelighet, og autentiserer seg **mot
måltenanten**. Både pilot og prod kan derfor laste opp til samme bibliotek uten
multi-tenant-oppsett — og uten at noe miljø får lesetilgang til et annet miljøs
data. Hvert miljø leser fortsatt bare sine egne tabeller og blobber.

Filnavnene skiller miljøene fra hverandre: `Production-backup-…` mot
`pilot-backup-…`.

## Oppsett

### 1. Område og bibliotek

Opprett (eller velg) et SharePoint-område og et dokumentbibliotek. Noter
adressen, f.eks. `https://fhs.sharepoint.com/sites/Skjemasystem`.

> **Skript:** `scripts/opprett-graph-apper.sh` gjør steg 2 og 3 under — og
> setter samtidig opp appene for e-post og oppslag, hvis PA-flytene skal
> legges om. Kjør `--sjekk` først for å se hvilke tillatelser som i det hele
> tatt finnes som applikasjonsroller, og `--torrkjor` før du lar den endre noe.

### 2. App-registrering

Entra ID → App registrations → New registration. Ingen redirect-URI trengs.
Noter **Application (client) ID** og **Directory (tenant) ID**.

Under **Certificates & secrets**: lag et sertifikat eller en client secret.
Sertifikat er å foretrekke — samme begrunnelse som at prod bruker sertifikat mot
Entra i dag. Legg verdien i Key Vault, aldri i kode eller env-JSON.

### 3. Rettighet: `Sites.Selected`, ikke `Files.ReadWrite.All`

Under **API permissions** → Microsoft Graph → **Application permissions** →
`Sites.Selected`. Deretter **Grant admin consent**.

`Sites.Selected` gir i seg selv ingen tilgang til noe som helst. Appen må få
skrivetilgang til nøyaktig ett område, og det gjøres med et eget Graph-kall.
`Files.ReadWrite.All` ville gitt skrivetilgang til alt i tenanten, og er for
mye for denne jobben.

Slå først opp område-ID-en:

```http
GET https://graph.microsoft.com/v1.0/sites/fhs.sharepoint.com:/sites/Skjemasystem
```

Gi så appen skriverett på det området. Kallet må gjøres av noen med
`Sites.FullControl.All` — i praksis en SharePoint- eller global administrator,
f.eks. via Graph Explorer:

```http
POST https://graph.microsoft.com/v1.0/sites/{site-id}/permissions
Content-Type: application/json

{
  "roles": ["write"],
  "grantedToIdentities": [
    {
      "application": {
        "id": "<GRAPH_CLIENT_ID>",
        "displayName": "FHS Skjema — backup"
      }
    }
  ]
}
```

Nyere Graph-versjoner bruker `grantedToIdentitiesV2` i svaret; `grantedToIdentities`
godtas fortsatt ved oppretting. Verifiser med
`GET /sites/{site-id}/permissions` at oppføringen finnes.

### 4. Env-vars i hvert miljø

Settes i SWA Configuration. Hemmeligheten som Key Vault-referanse.

| Variabel | Verdi |
|---|---|
| `GRAPH_TENANT_ID` | Directory (tenant) ID for tenanten biblioteket ligger i |
| `GRAPH_CLIENT_ID` | Application (client) ID |
| `GRAPH_CLIENT_SECRET` | Key Vault-referanse til hemmeligheten |
| `BACKUP_SHAREPOINT_SITE` | `https://fhs.sharepoint.com/sites/Skjemasystem` |
| `BACKUP_SHAREPOINT_BIBLIOTEK` | Valgfritt. Bibliotekets navn, f.eks. `Backup`. Uten dette brukes områdets standardbibliotek. |
| `BACKUP_SHAREPOINT_MAPPE` | Valgfritt. Undermappe, f.eks. `Skjemasystem/Backup`. |

`BACKUP_SHAREPOINT_SITE` godtar både full URL og Graph-formen
`fhs.sharepoint.com:/sites/Skjemasystem`.

De tre `BACKUP_SHAREPOINT_*`-verdiene vises i admin-panelet under **System**,
siden feil områdeadresse er det som oftest er galt når kopien ikke dukker opp
der noen leter etter den. `GRAPH_*` vises bare som satt/ikke satt.

### 5. Nøkkelkalenderen

Legg hemmeligheten inn under **Administrasjon → 🗓 Nøkkelkalender** med
utløpsdato, konsekvens («backup-kopien til SharePoint stopper stille») og
rotasjonsprosedyre. Uten det står vi der den dagen den utløper — som er hele
poenget med kalenderen.

## Slik virker opplastingen

1. Token via client credentials mot `GRAPH_TENANT_ID`, caches til like før utløp.
2. Slå opp område og bibliotek.
3. `createUploadSession` på `{mappe}/{filnavn}`, med `conflictBehavior: replace`.
4. Les 10 MiB om gangen fra backup-blobben og PUT den til `uploadUrl` med
   `Content-Range`. Minnebruken er en konstant, ikke en funksjon av filstørrelsen.
5. Siste bit svarer 200/201 med selve fila. **Størrelsen Graph rapporterer
   sammenlignes med backupens.** Stemmer den ikke, meldes kjøringen som feil.

Punkt 5 er verdt å merke seg: nettopp den kontrollen manglet i PA-veien, og
resultatet var en fil i OneDrive på 4 bytes som så vellykket ut.

Alle biter unntatt den siste må være et multiplum av 320 KiB — det er et krav
fra Graph, og `beregnBiter` runder av deretter.

## Feilsøking

| Symptom | Årsak |
|---|---|
| `Fikk ikke token fra Entra (HTTP 401)` | Feil `GRAPH_CLIENT_SECRET`, eller utløpt hemmelighet |
| `Graph GET /sites/… feilet (HTTP 404)` | Feil `BACKUP_SHAREPOINT_SITE`, eller området finnes ikke |
| `Kunne ikke opprette opplastingssesjon (HTTP 403)` | `Sites.Selected` er gitt, men appen mangler skriverett på området — steg 3 |
| `Fant ikke biblioteket «X»` | Feil `BACKUP_SHAREPOINT_BIBLIOTEK`. Feilmeldingen lister de som finnes. |
| `Fila i SharePoint er N bytes, men backupen er M` | Ufullstendig opplasting. Kjør på nytt; `conflictBehavior: replace` overskriver. |

Status per kjøring ligger i `GET /api/backup/status` — feltet `Kanal` viser om
kopien gikk via `graph` eller `pa-flyt`.
