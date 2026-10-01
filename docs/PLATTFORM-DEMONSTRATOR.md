# Linux-demonstrator

Mandat for en egen økt i en **klone** av dette repoet. Formålet er å bevise at
koden lar seg løsne fra Azure — ikke å lage en driftsklar Linux-versjon.

> **Dette er en demonstrator.** Den skal ikke i produksjon, ikke vedlikeholdes
> parallelt, og ikke merges tilbake som den er. Lykkes den, høstes sømmene
> tilbake hit som små, separate endringer.

## Hva som skal bevises

At forretningslogikken aldri var Microsoft-avhengig — at det bare var verten,
lagringen og innloggingen.

**Beviset er testpakken.** De 84 testfilene kjører i dag uten `node_modules` og
uten lagringskonto; de tester vilkår, dynamiske roller, feltreferanser,
steg-avhengigheter, diagnosen, arkivering og svargrenser. Kjør dem **uendret**
i demonstratoren. Går de grønt der også, er påstanden dokumentert — og det er
et skarpere poeng enn «se, det kjører».

Demonstrasjonen for øvrig: kopier inn et par skjematyper, fyll ut, behandle
gjennom to steg, se kvitteringen og e-posten.

## Kartlagt kobling (verifisert 01.10.2026)

| Lag | Kobling | Arbeid |
|---|---|---|
| HTTP-vert | 38 filer importerer **bare** `{ app }` fra `@azure/functions` | Skall over Express |
| Tabell | `lib/storage.js` | SQLite-adapter |
| Blob | `lib/blob.js` | Filsystem-adapter |
| Lekkasjer | `skjema-forekomst-storage.js` bruker `odata()` 5 steder; 2 funksjonsfiler går utenom lib | Tettes |
| Innlogging | **`lesPrincipal` i `auth.js`, linje 15** — eneste sted som leser `x-ms-client-principal` | Egen adapter |
| Varsling | `lib/flyt-kaller.js` | SMTP |
| Key Vault | `lib/keyvault.js` er død kode | Slettes |

### Det du får gratis

**Dummy-modus finnes allerede.** `VARSLING_DEAKTIVERT=true` skrur av samtlige
Power Automate-kall og logger i stedet — Teams, Planner, Teams-kanal,
SharePoint, diagnoseflyten og team-synken. Én miljøvariabel, og alt det er
dummy fra første dag.

**Innloggingen er én funksjon.** Alle andre treff på `x-ms-client-principal` i
repoet er kommentarer. `auth.js` eksponerer seks funksjoner, og bare tre av dem
rører principal-headeren; `erAdmin` leser `ADMIN_UPNS` og `harFlytNokkel` er en
delt hemmelighet — begge er plattformfrie alt.

**`app.http(...)` er bare registrering.** Et skall som tilbyr `app.http(navn,
{methods, route, handler})` og registrerer mot Express gir alle 129
endepunktene uten at én funksjonsfil røres.

## Rekkefølge — mest risikable først

**1. `app`-skallet over Express.** Make-or-break. Svarer alle 129 endepunktene?
Signaturen må etterligne nok av Azure Functions v4: `request.query.get()`,
`request.headers.get()`, `request.params`, `await request.json()`, og svar på
formen `{ status, jsonBody, body, headers }`. Lykkes dette, er resten mekanikk.

**2. Lagring.** Dette er den største reelle jobben, og den som ikke kan dummes
ut — en demonstrator må kunne ta imot et skjema. Table-modellen går rett over i
én SQLite-tabell `(pk, rk, json)`:

- `PartitionKey` + `RowKey` + frie egenskaper → `pk`, `rk`, `json`
- `getEntity`, `upsertEntity`, `updateEntity`, `deleteEntity`, `listEntities`
- `listEntities({ queryOptions: { filter } })` er det vanskeligste — `odata()`
  bygger strenger som må oversettes. Tett de fem lekkasjene i
  `skjema-forekomst-storage.js` først, så finnes filtrene ett sted.
- Transaksjoner brukes med maks 100 entiteter på samme `PartitionKey`.

Blob → filsystem. `lib/blob.js` er allerede eneste inngang.

**3. Auth-adapteren.** Gjør den **bevisst ikke-Microsoft** — å bevise frigjøring
med en Entra-pålogging er selvmotsigende. En lokal innloggingsside med signert
sesjonscookie holder; Keycloak på samme boks hvis du vil vise OIDC.

Adapteren skal svare på det samme som `lesPrincipal`: `{ userDetails, userRoles,
claims }`. Rollekilden (`/api/roller-swa`) er allerede vår egen kode og kan
gjenbrukes nesten uendret.

**4. Ruter og tilgangsregler.** `staticwebapp.config.json` har `routes` med
`allowedRoles`, `navigationFallback`, `responseOverrides` og `globalHeaders`. En
liten middleware som leser den samme fila gir deg reglene uten en ny
konfigurasjon å holde i takt.

**5. E-post.** SMTP mot **Mailpit** på boksen. For en demonstrasjon er det bedre
enn ekte utsending: Mailpit fanger all post og viser den i et web-grensesnitt,
så du kan *vise fram* e-posten som ble sendt.

**6. Planlagte jobber.** Flere av dem er funksjoner systemet trenger, ikke
deploy-plumbing: utsendinger skal sendes, purringer skal gå, FS-data og
postnumre skal oppdateres. Jobbene må altså finnes — men ikke som GitHub
Actions.

Grunnen er konkret: demonstratoren står på **lokalnettet**, og en
GitHub-runner kommer ikke dit. Workflowene ville feilet uansett hva vi gjorde
med dem.

Og de finnes bare fordi SWA Managed Functions ikke støtter timer-triggere. På
Linux faller den begrensningen bort — systemd-timere, cron eller en
timer i prosessen gjør samme nytte. Det er i seg selv et poeng verdt å vise:
plattformen krever mindre stillas, ikke mer.

Tidsplanene står i workflowene som slettes, så her er de:

| Jobb | UTC | Endepunkt | I demonstratoren |
|---|---|---|---|
| Utsendinger | `0 5 * * *` | `/api/utsending/send-forfalte` | **ja** |
| Purringer | `0 6 * * *` | `/api/utsending/purre` | **ja** |
| FS-data | `0 4 * * *` | `/api/refresh-fs` | dummy eller kopiert datasett |
| Postnumre | `30 4 15 1,7 *` | `/api/postnumre/refresh-bring` | dummy — halvårlig uansett |
| Nøkkelkalender | `0 7 * * *` | `/api/nokkelkalender/sjekk` | valgfritt |
| Team-synk | `30 4 * * *` | `/api/team-synk` | nei — Graph er dummy |
| Backup | `0 2 * * 0` | `/api/backup/kjor` | nei — SharePoint er dummy |

Nøkkelen i `x-scheduler-key` fungerer uendret, og endepunktene er de samme.
De to første er de eneste som må virke for å demonstrere en hel saksgang.

## Hva som skal være dummy

Alt som går gjennom Power Automate, pluss de eksterne datakildene. SMS ligger i
OTP- og utsendingsløypa og går gjennom samme søm — la den være dummy.

Felles Studentsystem, Bring-postnumre, Graph, SharePoint-backup og Power BI
trenger ingen reimplementasjon; kopier inn et datasett eller la endepunktene
svare tomt.

## Hva som IKKE skal gjøres

- **Ikke rør forretningslogikken.** Den er poenget som skal bevises. Må du endre
  noe i `lib/` som ikke er en søm, har du funnet noe verdt å melde tilbake.
- **Ikke gjør demonstratoren driftsklar.** Ingen HTTPS-sertifikater, ingen
  herding, ingen backup. Det er en annen jobb.
- **Ikke endre testene.** De skal gå uendret. En test som må tilpasses er et
  funn, ikke en justering.
- **Slett alle workflowene unntatt `ci.yml`.** `deploy-pilot.yml` fyrer på hver
  push, og seks andre står på cron — alle ville feilet rødt mot et miljø som
  ikke finnes, og mot en maskin GitHub ikke når. `ci.yml` blir stående: den
  kjører testpakken, og den er hele beviset. Tidsplanene over erstatter dem.

## Når demonstratoren er ferdig

Rapporter tilbake med:

1. **Testresultatet.** 84 av 84, eller hvilke som måtte vike og hvorfor.
2. **Sømmene som faktisk trengtes** — ikke de vi antok her. Den lista er
   utgangspunktet for å gjøre produksjonsversjonen konfigurerbar.
3. **Det som var vanskeligere enn ventet.** Det er den viktigste delen.
