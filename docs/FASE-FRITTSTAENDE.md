# Frittstående variant på Ubuntu

Spørsmål fra 19.09.2026: hvor vanskelig er det å kjøre denne løsningen uten
Azure Static Web Apps — på en egen Ubuntu-server, uten Planner, SharePoint og
Teams, og med annen autentisering?

Dette dokumentet er **målinger og sømmer**, ikke en plan. Det finnes for at en
senere økt skal kunne starte fra tall i stedet for fra gjetting.

Tallene er fra `main` per 19.09.2026 og vil drive. Kommandoene som frambrakte
dem står under hver måling, så de kan kjøres på nytt.

## Kort svar

Vanskeligere enn det ser ut i frontend, lettere enn det ser ut i API-et.

**Lagringen er jobben.** Kjøremiljøet er nesten en ikke-sak, fordi koden
allerede er strukturert for å kunne kjøre uten Azure-SDK-ene — testene krever
det (`scripts/kjor-tester.js --uten-pakker`).

## Målinger

| Lag | Omfang | Kobling til Azure |
|---|---|---|
| `api/src/lib` | 62 filer | **4** rører SDK-en direkte |
| `api/src/functions` | 35 filer | alle bruker `app.http`, men bare 2 rører data-SDK |
| `frontend` | 13 sider, 15 moduler | 12 sider treffer `/.auth/*` |
| Ruteautorisasjon | 34 regler, 30 med `allowedRoles` | i `staticwebapp.config.json` |

```
ls api/src/lib/*.js api/src/functions/*.js frontend/*.html frontend/js/*.js | wc -l
grep -ln "@azure/data-tables\|@azure/storage-blob\|@azure/identity" api/src/**/*.js
grep -l "/\.auth/" frontend/*.html | wc -l
```

De fire filene som rører data-SDK-en er `storage.js`, `blob.js`,
`keyvault.js` (**død kode** — importeres ingen steder, se `CLAUDE.md`) og
`skjema-forekomst-storage.js`. Av funksjonene er det bare `backup.js` og
`skjemaer.js`.

## Søm 1: kjøremiljøet — lite arbeid

Alle 35 funksjonene registreres med:

```js
app.http('navn', { methods: ['GET'], authLevel: 'anonymous', route: '...', handler });
```

Handleren får en fetch-lignende request — `headers.get()`, `json()`,
`query.get()`, `params` — og returnerer `{ status, jsonBody }`, eller
`{ body, headers }` for PDF og filnedlasting.

Det er nesten standard web-API. En Express- eller Fastify-adapter som
implementerer `app.http` kan kjøre alle funksjonene **uendret**. Anslag:
hundre linjer, pluss ruteoversettelse fra `{param}` til `:param`.

`src/index.js` er allerede den eksplisitte registreringslista, og
`api/test/funksjoner-registrert.test.js` holder den i takt.

## Søm 2: lagringen — her ligger arbeidet

22 lib-filer går gjennom `storage.js` og `blob.js`, som er de eneste som
kjenner SDK-en. Sømmen er ren. Porteringen er det ikke.

**Flaten som må gjenskapes** er liten i antall funksjoner:

```
storage.js:  tabellKlient, tabellKlientFra, sikreTabell, sikreTabellFra,
             odata, glemOpprettelse, kontoNavnFra
blob.js:     serviceKlient, containerKlient, serviceKlientFra, containerKlientFra
```

**Men semantikken bak er ikke liten.** Operasjoner i bruk:

| Operasjon | Steder |
|---|---|
| `listEntities` | 44 |
| `upsertEntity` | 30 |
| `getEntity` | 26 |
| `deleteEntity` | 16 |
| `updateEntity` | 8 |
| `submitTransaction` | 8 |
| `createEntity` | 7 |
| OData-filtre (`odata\``) | 25 |

Fire ting må gjenskapes med **nøyaktig samme oppførsel**, ellers får du feil
langt unna årsaken:

- **Partisjons- og radnøkkel som datamodell.** All koden tenker
  `PartitionKey`/`RowKey`. En relasjonsmodell må enten etterligne det eller
  omskrive 22 filer.
- **Sortering på `RowKey` som streng.** `samtale-storage.js` bygger nøkkelen
  slik at kronologi følger av strengsorteringen. Går det tapt, sorteres en
  samtale feil.
- **404 som normaltilfelle.** `getEntity` kaster med `statusCode === 404`, og
  koden fanger nettopp den.
- **Transaksjoner.** 8 steder bruker `submitTransaction` — blant annet
  `team-storage.js` ved erstatning av et helt team.

16 tabeller er i bruk: `Skjemaer`, `Skjemadefinisjoner`, `Rollemedlemskap`,
`Teammedlemskap`, `Samtale`, `Hendelser`, `Utsendinger`, `Kryptonokler`,
`Tilgangskontroll`, `SystemInnstillinger`, `Teller`, `Rapporttyper`,
`Postnumre`, `Brukernavn`, `TodoPunkter`, `Nokkelkalender`.

Fem av dem vokser med bruken — `Skjemaer`, `Samtale`, `Hendelser`,
`Utsendinger`, `Tilgangskontroll`. De elleve andre er omtrent konstante.

### Hvor enkelt kan lageret være?

En tilsvarende flytting er gjort før, av korportalen: samme type lagring, og
der holdt det med noe enklere enn en full database. Spørsmålet er om det
holder her.

To målinger avgjør, og begge peker samme vei:

**33 av 43 `listEntities`-kall har ingen partisjonsfilter.** De er fullskann.

```
grep -rn "listEntities(" api/src/**/*.js | grep -v PartitionKey | wc -l   →  33
```

To av dem er merket som kjente i koden: `mine-behandlinger` skanner alle
skjemaer med status 2 ved hvert oppslag («Optimeres senere»), og
postnummersøket gjør substring-søk over hele tabellen. Med et filbasert lager
betyr hvert slikt kall at hele tabellen leses og parses. `Skjemaer` vokser
med hver innsending, for alltid.

**Samtalen er skrevet for samtidighet.** `lib/samtale-storage.js` har én rad
per innlegg nettopp fordi les-endre-skriv mister meldinger når to skriver
samtidig — og i en chat er det normalen, ikke unntaket. Et lager med én fil
per tabell gjeninnfører akkurat det problemet. Korportalen hadde etter all
sannsynlighet ingen chat.

I tillegg: 8 steder bruker `submitTransaction`. Filer gir ingenting der.

**SQLite treffer instinktet uten å koste det.** Den er enklere enn en full
database på alle måter som betyr noe i drift — én fil, ingen server, ingen
port, backup er en filkopi — og gir samtidig transaksjoner, skriving på
radnivå (WAL) og indekser.

Og skjemaet kan etterligne Azure-modellen direkte, slik at **de 22 lib-filene
ikke trenger å endres**:

```sql
CREATE TABLE entiteter (
    tabell  TEXT NOT NULL,
    pk      TEXT NOT NULL,
    rk      TEXT NOT NULL,
    data    TEXT NOT NULL,   -- JSON, som i dag
    etag    TEXT,
    PRIMARY KEY (tabell, pk, rk)
);
```

Da blir `listEntities` med partisjonsfilter et indeksoppslag, og de 33
fullskannene blir tabellskann i SQLite — fortsatt fullskann, men flere
størrelsesordener raskere enn å parse JSON.

Postgres er ikke feil, men det legger til en driftskomponent uten å løse noe
SQLite ikke løser på dette volumet. Rene filer er for lite, og det er
samtalen og de 33 fullskannene som gjør forskjellen — ikke antall tabeller.

## Søm 3: autorisasjonen — lett å undervurdere

API-siden er liten: 7 filer leser `x-ms-client-principal`, alle gjennom
`lib/auth.js`. Frontend bruker tre endepunkter:

| Endepunkt | Steder |
|---|---|
| `/.auth/login/aad` | 13 |
| `/.auth/me` | 4 |
| `/.auth/logout` | 2 |

11 sider importerer `js/auth.js`. Men sømmen er ikke samlet, og målingen er
skarpere enn den ser ut:

**`logInn()` finnes i `auth.js` og brukes av ingen.** Elleve sider har hver
sin egen redirect til `/.auth/login/aad`, ordrett den samme:

```
grep -l "logInn(" frontend/*.html | wc -l     →  0
grep -c "/\.auth/login/aad" frontend/*.html   →  11 sider, én hver
```

Det er elleve kopier av innloggingen som må endres hver for seg. `logInn()`
er allerede skrevet for jobben — den brukes bare ikke.

`ingen-tilgang.html` er den eneste siden som treffer `/.auth/` uten å
importere `auth.js` i det hele tatt.

**Den delen som er usynlig i dag:** 30 av 34 ruteregler i
`staticwebapp.config.json` har `allowedRoles`, og det er SWA-plattformen som
håndhever dem. På Ubuntu må noen gjøre den jobben — i adapteren eller i
nginx. Rollene som brukes er `anonymous`, `authenticated` og `admin`.

`admin`-rollen settes i dag av `/api/roller-swa`, som plattformen kaller ved
innlogging. Den mekanismen forsvinner, men kilden til sannhet gjør det ikke:
`ADMIN_UPNS` og `erAdmin()` er allerede der, og rollekilden speiler dem.

## Søm 4: integrasjonene — faktisk enklere

`flyt-kaller.js` er én modul, brukt av 10 filer. Den sender fire kanaler til
Power Automate: `epost`, `teams`, `planner`, `teamskanal`.

Uten Microsoft blir e-post SMTP, og de tre andre faller bort. Payloaden er
allerede ferdig oppløst før den sendes — flyten kan ingenting om plassholdere
eller rollemodellen — så en SMTP-implementasjon har alt den trenger i
`epost_og_teams.emne` og `.html`.

`sp-liste.js` og `graph-opplast.js` har én bruker hver og kan stå ubrukt.

`VARSLING_DEAKTIVERT` finnes fra før og slår av all utsending. Det gjør en
frittstående variant kjørbar uten e-postoppsett i det hele tatt, fra dag én.

## Felles kodebase eller fork?

**Felles — men bare hvis Ubuntu-varianten faktisk tas i bruk.**

For felles: de 62 lib-filene er forretningslogikken — behandling, vilkår,
DNF, plassholdere, datauttrekk, kryptering, samtale — og ingenting av det er
Azure-spesifikt. En fork ville duplisert det, og da måtte hver feilretting
gjøres to steder.

Det er ikke en teoretisk innvending. Flere av feilene som ble funnet
18.–19.09.2026 var nettopp **én regel som bare fantes ett av stedene den
gjaldt**: dialogfilteret som manglet i PDF-en, kommentaren som bare ble
lagret i én av to modi, den eksterne auth-rekkefølgen som lå i én fil. En
fork gjør den feilklassen til normaltilstanden.

Testene taler samme vei: de kjører allerede uten `node_modules` og uten
Azure, så de dekker begge varianter uendret.

**Mot felles, og det er et ekte argument:** to kjøremiljøer i ett repo koster
i hver eneste PR, og **en variant som ikke deployeres, er ikke testet.** Blir
Ubuntu-versjonen liggende urørt, er den en forpliktelse som ser ut som en
mulighet.

Anbefalingen forutsetter altså at noen faktisk kjører den.

## Det som ikke er kode

Driften. TLS-sertifikater og fornyelse, sikkerhetsoppdateringer, backup av
databasen, overvåking, tilgangsstyring på serveren, gjenoppretting etter
feil.

Ingenting av dette har med koden å gjøre, og det er ofte her en frittstående
løsning faktisk koster. SWA gjør dette i dag uten at noen tenker på det.

Backup finnes riktignok allerede som kode (`lib/backup.js`, kryptert zip), så
den delen er ikke ny — men den må peke på et annet lager.

## Rekkefølge, hvis det skal gjøres

1. **Rydd auth-sømmen i frontend** — ta i bruk `logInn()` på de elleve sidene
   som har sin egen kopi. Nyttig uansett, også for SWA-varianten, og den
   billigste av alle endringene her: funksjonen finnes allerede.
2. **Skriv `app.http`-adapteren.** Den kan testes mot de eksisterende testene
   med en gang, uten at noe annet er på plass.
3. **Port `storage.js` og `blob.js`.** Dette er hovedarbeidet. Én
   lagringsmodul om gangen, med de eksisterende testene som fasit.
4. **Autorisasjon på ruter** — oversett `staticwebapp.config.json` til
   adapterens egen håndheving, og la testen holde de to i takt.
5. **SMTP i stedet for flyt-kaller**, eller kjør med `VARSLING_DEAKTIVERT`
   til det trengs.

## Åpne spørsmål

- Hvilken autentisering? OIDC mot en egen identitetsleverandør er nærmest
  dagens modell og lar `lib/auth.js` beholde formen. Lokale brukere med
  passord er enklere å sette opp og vanskeligere å forvalte.
- Bekreft volumet før valget låses. Vurderingen over antar at `Skjemaer` og
  `Samtale` vokser jevnt og at ingen tabell blir enorm. Blir én av dem det,
  er det de 33 fullskannene som merker det først.
- Skal varianten kunne lese data fra Azure-varianten, eller er de helt
  atskilte installasjoner?
- Hvem drifter serveren, og hva er forventet oppetid?
