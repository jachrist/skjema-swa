# Power Automate-flyter og periodiske jobber

Hvilke flyter løsningen faktisk trenger, hva som utløser hver av dem, og hva
som kjører på klokke.

Skrevet fordi svaret bare fantes i en samtale. `scripts/migrer/flyt-bruk.js`
avsluttet med «se oversikten i samtalen» — og den samtalen var borte da
spørsmålet kom opp igjen. Denne fila er den oversikten.

> **Repoet sier hvilke flyter som trengs, ikke hvilken versjon som er koblet
> opp.** Adressene ligger i SWA Configuration, ikke her. Har du flere versjoner
> av samme flyt, er `GET /api/system/info` som admin den raskeste veien til å
> se hvilken som faktisk er i bruk i et miljø — den lister alle seks
> flyt-adressene maskert, med vertsnavn.
>
> `config/env.*.json` svarer ikke på dette. Filene deklarerer 2–3 av de åtte,
> og er ikke autoritative (backlog 29).

## Flyter vi kaller ut til

### Alltid i bruk

| App setting | Kalt fra | Utløses av |
|---|---|---|
| `VARSLING_FLOW_URL` | `lib/flyt-kaller.js`, `functions/utsending.js` | all varsling, og utsending/purring (cron 05:00 og 06:00) |
| `BACKUP_FLOW_URL` | `functions/backup.js` | hver backup-kjøring |
| `TEAM_SOK_EKSTERNT_FLOW_URL` | `functions/team.js` | admin søker etter team |
| `TEAM_LAST_MEDLEMMER_FLOW_URL` | `functions/team.js` | admin laster teammedlemmer |

Utsending og purring hadde egne adresser til 10.09.2026 —
`UTSENDING_FLOW_URL` og `PURRE_FLOW_URL`. Ingen av dem var satt i noe miljø,
og funksjonen var derfor ute av drift overalt uten at noen merket det.
Tre app settings med samme verdi er verre enn én; se
`docs/FASE-UTSENDING-SAMMENSLAING.md`.

`VARSLING_DEAKTIVERT=true` skrur av utgående kall for både varsling og OTP —
de logges i stedet. **Den gjelder ikke utsending og purring**: de går via
`kallUtsendingsflyt`, som leser adressen direkte. Nyttig i et testmiljø, og verdt å sjekke først når «flyten
trigges ikke».

### Betinget — koden leser dem, men bare hvis dataene ber om det

Å lese koden svarer derfor ikke på om flyten kan fjernes. Det er disse
`scripts/migrer/flyt-bruk.js` teller, ved å gå gjennom Skjemadefinisjoner:

| App setting | Utløses av |
|---|---|
| `SP_LISTE_FLOW_URL` | skjematyper med **både** `SPListeadresse` og `SPListenavn` |
| `OTP_FLOW_URL` | skjematyper med `EksternTilgang=true` |
| `Flyt_url` per steg | ikke en app setting — adressen ligger på behandlingssteget i skjemadefinisjonen |

```bash
cd scripts/migrer && npm install        # én gang per maskin
cd ../..
STORAGE_CONN="<connection string>" node scripts/migrer/flyt-bruk.js
```

Avhengighetene ligger i `scripts/migrer/package.json`, ikke i `api/`. Node
leter oppover fra skriptets egen mappe, så `npm ci` i `api/` gir
«Cannot find module '@azure/data-tables'». Mappa har ingen lockfil, så det må
være `npm install`.

Tilkoblingsstrengen kan også gis som `--conn`, men `STORAGE_CONN` er å
foretrekke: en kontonøkkel på kommandolinja havner i historikken, og den gir
full tilgang til alle dataene.

Skriptet endrer ingenting og skriver bare vertsnavn, ikke hele adresser med
signatur, så utskriften kan limes inn i en sak.

### To ting som reduserer antallet flyter

**Varslingsflyten er en dispatcher.** Den tar fire `handling`-verdier, så det
er én flyt — ikke fire:

| `handling` | Sendes fra |
|---|---|
| `sendInnsenderKvittering` | `sendInnsenderKvittering()` |
| `sendBehandlingsVarsling` | `sendBehandlerVarsling()` |
| `sendBeslutningVarsling` | `sendBeslutningVarsling()` |
| `sendFerdigVarsling` | `sendFerdigVarsling()` |
| `sendUtsendinger` | `functions/utsending.js` — cron 05:00 |
| `purreUtsendinger` | `functions/utsending.js` — cron 06:00 |

> De to siste sender **ikke** samme nyttelast som de fire over: de mangler
> `epost_og_teams`, og har mottakerfeltene i `mottakere[]` i stedet for
> `lenker[]`. Flyten må derfor forgrene på `handling` — gjør den ikke det,
> sender den en tom e-post til eksterne mottakere. Trinn 2 i
> `docs/FASE-UTSENDING-SAMMENSLAING.md` samler dem til én form.

**Utsending og purring ER varslingsflyten.** `kallUtsendingsflyt()` i
`functions/utsending.js` leser `VARSLING_FLOW_URL`, og de to skilles på
`handling` som resten.

De to team-flytene sender ingen `handling` — de har hvert sitt endepunkt og
hver sin nyttelast.

### Tidsgrenser

SWA-gatewayen kutter et kall etter ~45 sekunder. Kallene har egne grenser under
det, så en treg flyt ikke kveler kjøringen og feilen kommer som en naken 502:

| Kaller | Grense |
|---|---|
| `functions/utsending.js` | 35 s |
| `functions/team.js` | 35 s |
| `functions/backup.js` | 4 min — går mot en egen jobb, ikke et brukerkall |

## Miljøet står i payloaden

Alle utgående kall har `miljø` i kroppen — `"pilot"`, `"production"` eller
`"ukjent"` hvis `MILJO` ikke er satt. Én flyt kan dermed forgrene på miljø i
stedet for at det vedlikeholdes en kopi per miljø.

Adressen flyten kalles på sier ingenting om avsenderen: den er den samme
uansett hvem som kaller. `backup`-flyten har hatt feltet siden den ble laget;
fra 14.09.2026 har resten det også, med samme feltnavn.

```jsonc
{ "handling": "sendBehandlingsVarsling", "miljø": "pilot", "mottakere": [ … ] }
```

Verdien kommer fra `MILJO`, som settes i SWA Configuration per miljø.

## Flyter kan skrive i loggen

`POST /api/hendelser/logg` — for en flyt som vil si fra om hva den gjorde.
Kjørehistorikken i Power Automate viser bare flytens egen side av saken, og er
hverken søkbar sammen med resten eller synlig for den som sitter i
admin-panelet.

```http
POST https://<swa>/api/hendelser/logg
x-flow-key: <FLOW_CALLBACK_KEY>
Content-Type: application/json

{ "melding": "Sendte 42 purringer via SMTP-koblingen",
  "type": "purring",
  "objektId": "batch-1757500000000-a1b2c3",
  "detaljer": { "antall": 42, "kanal": "epost" } }
```

| Felt | |
|---|---|
| `melding` | påkrevd, kuttes ved 2000 tegn |
| `type` | valgfri. Får alltid `flyt.`-prefiks — `"purring"` blir `flyt.purring` |
| `objektId` | valgfri, for å knytte linja til en batch eller et skjema |
| `detaljer` | valgfritt objekt. `miljø` legges på automatisk |

Svar: `{ "status": "ok", "type": "flyt.purring", "tid": "…" }`.

Prefikset kan ikke omgås. En flyt skal ikke kunne skrive seg inn som
`utsending.send-forfalte` blant hendelsene appen selv skriver — da er
revisjonssporet ikke lenger til å stole på. Det gjør samtidig at alt fra en
testrunde hentes med ett filter:

```
GET /api/hendelser?type=flyt.purring     (admin)
```

Linja skrives to steder: `Hendelser`-tabellen, som er søkbar og synlig i
admin, og funksjonsloggen, som har tidsoppløsningen når noe skal spores
minutt for minutt.

Endepunktet har egen sti i stedet for `POST` på `/api/hendelser`, fordi
ruteregelen da slipper å skille på metode — se kommentaren i
`functions/hendelser.js`.

## Alle utgående kall bærer `x-flow-key`

Signaturen i flyt-URL-en (`sig=`) var eneste sperre fram til 14.09.2026. Den
som fikk tak i adressen kunne sende en hvilken som helst payload — og siden
e-postteksten bygges av felter i payloaden (`skjemanavn`,
`skjemabeskrivelse`, `epost_og_teams.html`), betyr det en melding som ser ut
til å komme fra skjemasystemet, med en lenke til hva som helst.

Derfor sender alle utgående kall nå `x-flow-key` med samme verdi flytene
allerede sender inn til oss. Symmetrisk, og uten en ny hemmelighet å
forvalte: den delte nøkkelen viser at det er oss, begge veier.

**Flyten må selv sjekke headeren** — vi kan bare sende den. Legg det som
første steg, og avvis kallet hvis den mangler eller ikke matcher.

Er `FLOW_CALLBACK_KEY` ikke satt, sendes ingen header i det hele tatt. Da
oppfører kallet seg som før, og en flyt som ennå ikke sjekker merker
ingenting — rekkefølgen ved utrulling er fri.

## Flyter som kaller inn til oss

Autentiseres med `x-flow-key`, som må matche `FLOW_CALLBACK_KEY`.

| Metode | Rute | Hva flyten gjør |
|---|---|---|
| POST | `/api/utsending` | oppretter en masseutsending, får én engangslenke per mottaker tilbake |

| POST | `/api/skjemaer/{skjematypeId}/{skjemaId}/beslutning` | melder at et behandlingssteg er fullført |
| POST | `/api/cache/teammedlemskap` | erstatter teamcachen med medlemmer hentet fra Graph |
| GET | `/api/cache/teammedlemskap/team-navn` | hvilke team er i cachen — før synking |
| POST | `/api/backup/kvittering` | bekrefter at backupfila landet i OneDrive |
| POST | `/api/hendelser/logg` | skriver en infomelding i loggen |

`/api/utsending`, `/api/cache/teammedlemskap` og `/api/cache/teammedlemskap/team-navn`
godtar også en innlogget bruker. De tre andre tar bare nøkkelen.

**`/api/utsending` er i bruk av en flyt.** Gevinst-batchene
(`gevinst-…-<skjematypeId>`) opprettes den veien. Endepunktet ble stengt for
flyt-nøkkel 14.09.2026 og reversert samme dag — frontend har ingen kaller, så
det så ubrukt ut, men `OpprettetAv` på radene i `Utsendinger` er `flyt`.
Sjekk `GET /api/hendelser?type=utsending.opprett` før noen stenger den igjen.

**Callbacken på beslutning er begrenset.** Den får bare fullføre steg som
faktisk har `Flyt_url` satt i skjemadefinisjonen. Uten den sperren ville
nøkkelen gitt tilgang til å avgjøre hvilket som helst steg, også de
menneskebehandlede. Kalles den på et vanlig steg, er svaret 403 — ikke fordi
nøkkelen er feil, men fordi steget ikke er flytens.

**`team-navn` sier hva vi HAR, ikke hva som burde finnes.** Lista er
PartitionKey-ene i `Teammedlemskap`, altså teamene som er hentet minst én
gang. Et team noen har skrevet inn i skjemaeditoren, men aldri synket, står
ikke der — og er cachen tom, er lista tom.

**Hvert av disse endepunktene trenger en egen ruteregel** med
`allowedRoles: ["anonymous"]` i `staticwebapp.config.<miljø>.json` — unntatt
beslutnings-ruta, som dekkes av den brede `/api/skjemaer/*`. Mangler regelen,
avviser plattformen kallet før `x-flow-key` leses: flyten har ingen
SWA-cookie, handleren ser aldri forsøket, og loggen vår er tom.
`api/test/swa-config.test.js` sjekker at reglene finnes.

## Det som kjører regelmessig er ikke flyter

Timer-triggere finnes ikke i SWA Managed Functions. Alt periodisk er derfor
GitHub Actions-cron mot HTTP-endepunkter, autentisert med `x-scheduler-key`
mot `SCHEDULER_KEY`:

| Workflow | Plan (UTC) | Endepunkt |
|---|---|---|
| `backup.yml` | 02:00 — søndag full, man–lør delta | `/api/backup/kjor` |
| `refresh-fs.yml` | 04:00 daglig | `/api/refresh-fs` |
| `send-utsendinger.yml` | 05:00 daglig | `/api/utsending/send-forfalte` |
| `purre-utsendinger.yml` | 06:00 daglig | `/api/utsending/purre` |
| `sjekk-nokler.yml` | 07:00 daglig | `/api/nokkelkalender/sjekk` |
| `refresh-postnumre.yml` | 04:30 den 15. i januar og juli | `/api/postnumre/refresh-bring` |

Rekkefølgen 05:00 → 06:00 er ikke tilfeldig: utsendingene skal være sendt før
purringen ser etter hvem som ikke har svart.

Kun manuelle (`workflow_dispatch`): `refresh-fs-diag.yml`,
`refresh-fs-diag-lu.yml`, `deploy-prod.yml`.

## Når en flyt ikke ser ut til å bli kalt

1. `GET /api/system/info` som admin — er adressen i det hele tatt satt i dette
   miljøet, og peker den dit du tror?
2. `VARSLING_DEAKTIVERT` — står den på `true`, logges kallet i stedet for å
   sendes.
3. `GET /api/varsling/diag/{skjematypeId}/{skjemaId}` som admin — tørrkjører
   varslingen for ett skjema og sier hvorfor den eventuelt hoppes over.
   Mottakerkravet gjelder **alle** kanaler, også Planner alene: en oppgave uten
   ansvarlig lager vi ikke. Det er den vanligste grunnen til at en
   Planner-oppgave uteblir.
4. For de betingede: `scripts/migrer/flyt-bruk.js` — er det noen data som
   utløser flyten?
