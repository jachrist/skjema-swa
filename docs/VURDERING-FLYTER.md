# Vurdering: Power Automate-flytene videre

Skrevet 17.11.2026. Spørsmålet var om de sentrale flytene skal legges inn i
API-et, eller flyttes til Logic Apps. Svaret er API-et, i faser, med e-post
først. Fase 1 er beskrevet som plan nederst.

Logic Apps ble prøvd 18.11.2026 og lagt bort — se «Forsøket 18.11.2026» under
vei 2. Til fasene er gjennomført, går flytene i Power Automate som før.

Hva flytene gjør i dag, og hvilken nyttelast hver av dem får, står i
`docs/FLYTER.md`. Dette notatet gjentar det ikke.

## Utgangspunktet

Backupen gikk fra PA-flyt til Graph i oktober 2026 (`lib/graph-opplast.js`,
`docs/BACKUP-SHAREPOINT.md`). Mønsteret derfra virker:

- en egen app-registrering med én smal tillatelse (`Sites.Selected` på ett
  område)
- sertifikat i Key Vault, ikke klienthemmelighet
- PA-flyten står igjen som reservevei til Graph-veien er satt opp

Resten av flytene er i hovedsak det samme: et Graph-kall vi allerede har alle
verdiene til. Flytene gjør ingen oppslag og ingen fletting. All tekst er
ferdig oppløst før kallet (`lib/flyt-kaller.js`, toppen av fila).

## Vei 1: logikken inn i API-et

### Hva hver flyt krever

Alle tillatelser er *application permissions* i Microsoft Graph.

| Funksjon i dag | Tillatelse | Vurdering |
|---|---|---|
| E-post: kvittering, varsling, utsending, purring, engangskode | `Mail.Send`, låst til én postboks med Exchange *RBAC for Applications* | **Lett.** Mest volum, og løser `kopi[]` i samme slag (se under) |
| Engangskode på SMS | Ingen — Graph sender ikke SMS | Blir i OTP-flyten, eller går til en SMS-leverandør. Brukes bare av skjematyper med `EksternTilgang` |
| Planner-oppgave | `Tasks.ReadWrite.All` | **Middels.** Detaljene skrives med eget kall og ETag, slik flyten gjør |
| SharePoint-liste per skjematype | `Sites.Selected` (skriv) per område, eller `Lists.SelectedOperations.Selected` per liste | **Lett i koden.** Hvert nytt område en skjematype peker på, trenger en tildeling fra admin |
| Teamsøk, medlemsliste | `Team.ReadBasic.All`, `GroupMember.Read.All` | **Lett** |
| Team-synk (melder inn og ut) | `GroupMember.ReadWrite.All` | **Lett i koden, tyngst i tilgang.** Tillatelsen gjelder alle grupper i tenanten |
| Diagnose | `Team.ReadBasic.All`, `Channel.ReadBasic.All`, `Tasks.Read.All`, `Sites.Selected` (les) | **Lett** |
| Backup | `Sites.Selected` | Gjort |
| Teams-chat til en bruker | Ingen. Graph lar ikke en app sende vanlige chatmeldinger; `Teamwork.Migrate.All` er bare for migrering | **Tung.** Krever en bot (Azure Bot og en Teams-app installert for brukerne), eller aktivitetsvarsel med `TeamsActivity.Send`, som også krever en installert Teams-app |
| Melding i Teams-kanal | Som over | **Tung.** Bot. Innkommende webhooks er på vei ut, og erstatningen er Workflows — altså PA igjen |
| Stegflyter (`Flyt_url` per steg) | — | Ikke vårt å flytte. De er skjemaeiers utvidelsespunkt |

### App-registreringene

Delt etter hva som går tapt om én av dem misbrukes, ikke samlet i én:

| App | Tillatelser | Hvorfor egen |
|---|---|---|
| Backup (finnes) | `Sites.Selected` på backupområdet | Uendret |
| Varsling | `Mail.Send` (via Exchange, låst til én postboks), senere `Tasks.ReadWrite.All` og `Sites.Selected` for SP-listene | Det meste av trafikken |
| Team | `GroupMember.ReadWrite.All` og lesetillatelsene | Den sterkeste tillatelsen. Kan trekkes uten at e-posten stopper |
| Bot | Teams-appen | Bare hvis Teams-kanalene skal over |

### Identiteten — avklares før fase 1

I v3 har Function App-en en user-assigned identitet. Den kan få Graph-roller
direkte, uten sertifikat eller hemmelighet. Det virker bare hvis Microsoft 365
og Azure-abonnementet ligger i **samme tenant**. Identiteten kan ikke få token
i en annen tenant.

`GRAPH_TENANT_ID` finnes fordi backupen kan peke et annet sted. Gjør den det i
prod, er valget:

- app-registrering med sertifikat, som backupen har i dag, eller
- en multi-tenant-app med identiteten som federert legitimasjon, samtykket i
  M365-tenanten. Ingen hemmelighet å rotere, men nyere og mindre prøvd her.

Pilot og v2-prod har ingen identitet (CLAUDE.md), men de rives, og trenger
ikke Graph-veien.

### Det PA gir gratis, og vi må bygge

- **Struping.** Exchange Online tillater rundt 30 meldinger i minuttet og
  10 000 mottakere i døgnet per postboks. Det gjelder flyten også, men der
  sprer PA kallene selv. Masseutsending må gå gjennom en kø.
- **Nye forsøk.** En Graph-feil 429 eller 503 skal prøves igjen med
  `Retry-After`. PA gjør det uten at noen ser det.
- **Kjørehistorikk.** Erstattes av hendelsesloggen, som allerede logger hver
  varsling.

### Gevinsten

- ALM-runden i fire steg mellom tenantene forsvinner (`docs/FLYT-DEPLOY.md`)
- tjenestekontoene bak connectorene forsvinner, og med dem tilkoblinger som
  ryker når en konto deaktiveres
- `FLOW_CALLBACK_KEY` blir igjen bare for stegflytene
- reglene testes med `npm test` i stedet for i flytdesigneren

## Vei 2: Logic Apps

- **Eksport.** Power Automate har hatt *Export → Logic Apps template (.json)*,
  men bare for flyter som **ikke** ligger i en løsning. Våre ligger i
  løsninger, og må først kopieres ut med *Save As*. Sjekk om valget fortsatt
  finnes før det planlegges ut fra det.
- **Det som ikke følger med:** tilkoblingsreferanser, miljøvariabler
  (`SwaBaseUrl`, `SkjemaMiljo`) og PA-spesifikke handlinger. Tilkoblingene
  lages på nytt, variablene blir parametere. I praksis gjennomgås hver flyt for
  hånd.
- **Tjenestekontoene blir.** Office 365-, Teams- og Planner-connectorene er
  delegerte i Logic Apps også.
- **Det man vinner:** flytene ligger i Azure ved siden av Function App-en,
  deployes med Bicep, logger til Log Analytics, og hoppet mellom tenantene
  forsvinner. Entra på triggeren støttes i Consumption med en OAuth-policy.
  Kallene beholder formen; bare audiencen er en annen.

### Forsøket 18.11.2026, og beslutningen

**Logic Apps er lagt bort.** Flytene blir i Power Automate som de er, til
logikken flyttes inn i API-et (fasene under).

Varslingsflyten ble bygget på nytt som Logic App for å se hvor mye arbeid en
overføring er. Det var mer enn antatt:

- **Ingenting kunne kopieres.** Handlingene måtte legges inn på nytt fra
  designeren, og den første lagringen feilet likevel med «The API connection
  name must be provided». I Standard peker `referenceName` på en nøkkel i
  appens `connections.json`, og den må finnes under nøyaktig det navnet.
- **Plantypen avgjør tilgangsstyringen.** Autorisasjonspolicyen som binder
  appen til Function App-ens identitet, finnes bare i Consumption. Prøve-appen
  var Standard, og der må det gjøres med App Service-autentisering.
- **Nyttelasten har to former** (`docs/FLYTER.md`), og uttrykkene fra
  varslingen virker ikke på utsendingen: der heter adressen `mottaker`, hver
  mottaker har sin egen `url`, og `kanal` kan være `sms`.
- **Tilkoblingene må byttes til tjenestebruker én for én.** I Power Automate
  skjer det i ett steg, ved import av løsningen.

Det siste veide tyngst. Logic Apps flytter flytene til Azure, men tar ikke
bort det som er tungt i dag — delegerte tilkoblinger og manuell feilsøking —
og legger til en omskriving av hver flyt.

`FLYT_RESSURS` (audiencen som app setting) ble laget for forsøket, og tatt ut
igjen før merge. Den ligger i commit `c3c3e41` om den skulle trengs.

## Rekkefølge

| Fase | Hva | Flyt som faller bort |
|---|---|---|
| **1** | E-post og engangskode på e-post | Det meste av `VARSLING_FLOW_URL`, e-postgrenen i `OTP_FLOW_URL` |
| 2 | Teamsøk, medlemmer, diagnose, SP-liste | `TEAM_SOK_EKSTERNT_FLOW_URL`, `TEAM_LAST_MEDLEMMER_FLOW_URL`, `DIAGNOSE_FLOW_URL`, `SP_LISTE_FLOW_URL` |
| 3 | Team-synk, med egen app | `TEAM_FLOW_URL` |
| 4 | Planner | Planner-grenen i varslingsflyten |
| 5 | Teams-chat og -kanal | Valg mellom bot og én liten gjenværende flyt |

`BACKUP_FLOW_URL` står ikke i lista: backupen går allerede på Graph i v3-prod,
og reserveveien rives med v2 (sjekklista H4).

## Fase 1: e-post via Graph — plan

### Status 19.11.2026: all e-post bygget, prøves i dev

Bygget: e-posten i **varslingene** — kvittering, behandlervarsel, beslutning,
ferdig, samtale og nøkkelkalenderens påminnelser — via Graph når
`EPOST_VEI=graph`. Teams, Planner og Teams-kanal går fortsatt til flyten,
med «epost» tatt ut av kanalene. Kvitteringen med kopi blir én e-post med Cc.

Bygget i andre runde, samme dag:

- **Engangskoden** på e-post. SMS går fortsatt til OTP-flyten.
- **Utsending og purring.** Teksten bygges i API-et (`lib/epost-maler.js`),
  med skjemabeskrivelsen som Markdown når skjematypen sier det
  (`lib/markdown.js`, tvilling av frontendens `parseMarkdown`). Hver
  kjøring sender **høyst 25** e-poster — Exchange tillater rundt 30 i
  minuttet — og markerer hver mottaker for seg. Resten tas av neste kjøring.

Ikke bygget ennå: sertifikatveien for en annen tenant. Pilot og prod er
uendret: uten `EPOST_VEI` går alt til flytene som før.

**Tekstene i utsending, purring og engangskode er nye.** Flyten satte dem
sammen selv, og repoet hadde dem ikke. De står i `lib/epost-maler.js` og
bør leses før de går til eksterne:

| E-post | Emne | Innhold |
|---|---|---|
| Utsending | «Skjema til utfylling: *navn*» | Hei, du er bedt om å fylle ut «*navn*» · skjemabeskrivelsen · Åpne skjemaet · Svarfrist · Lenken er personlig |
| Purring | «Påminnelse: *navn*» | Hei · skjemaeierens purretekst, eller «Vi har ennå ikke fått svaret ditt på *navn*» · Åpne skjemaet · Svarfrist · Lenken er personlig |
| Engangskode | «Engangskode til FHS Skjema» | Koden · gyldig i *n* minutter · se bort fra den om du ikke ba om den |

| Hva | Hvor |
|---|---|
| Veien, mottakerfordelingen og sendingen | `api/src/lib/graph-epost.js` |
| Valget mellom Graph og flyt | `sendVarslerViaFlyt` i `api/src/lib/flyt-kaller.js` |
| Prøve: én e-post til admin selv | `POST /api/varsling/graph-test` |
| Veien vises | `GET /api/varsling/diag` (`epost`) og `GET /api/system/info` (`epostVei`) |
| Tekstene i utsending, purring og engangskode | `api/src/lib/epost-maler.js` |
| Grensen per kjøring og markeringen | `kjorViaGraph` i `api/src/lib/utsending-jobb.js` |
| Tester | `api/test/graph-epost.test.js`, `graph-utsending.test.js`, `markdown-tvilling.test.js` |

#### Oppsett i dev-tenanten

Tokenet hentes med Function App-ens identitet (`AZURE_CLIENT_ID`). Det virker
bare når Microsoft 365 ligger i samme tenant som identiteten.

1. **Postboksen.** I Exchange Online PowerShell:

   ```powershell
   Connect-ExchangeOnline
   New-Mailbox -Shared -Name "FHS Skjema" -PrimarySmtpAddress skjema@<dev-domene>
   ```

2. **Tillatelsen.** En managed identity har ingen *API permissions*-side i
   portalen; rollen gis med Microsoft Graph PowerShell. Dette gir `Mail.Send`
   for **hele tenanten**, og er greit i dev — ikke i prod:

   ```powershell
   Connect-MgGraph -Scopes "AppRoleAssignment.ReadWrite.All","Application.Read.All"
   $mi = Get-MgServicePrincipal -Filter "appId eq '<AZURE_CLIENT_ID>'"
   $graph = Get-MgServicePrincipal -Filter "appId eq '00000003-0000-0000-c000-000000000000'"
   $rolle = $graph.AppRoles | Where-Object { $_.Value -eq 'Mail.Send' -and $_.AllowedMemberTypes -contains 'Application' }
   New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $mi.Id -PrincipalId $mi.Id -ResourceId $graph.Id -AppRoleId $rolle.Id
   ```

   Vil du prøve innskrenkingen til én postboks også, er det *RBAC for
   Applications* (`New-ServicePrincipal`, `New-ManagementScope`,
   `New-ManagementRoleAssignment -Role "Application Mail.Send"`) — og da skal
   rollen over IKKE gis, for de to legges sammen. Om Exchange godtar en
   managed identity der, er en del av det som skal prøves.

3. **App settings på dev-Function App-en:** `EPOST_AVSENDER=skjema@<dev-domene>`.
   La `EPOST_VEI` stå usatt foreløpig.

4. **Prøv tilgangen:** `POST /api/varsling/graph-test` som admin. Den sender
   én e-post til deg, også før `EPOST_VEI` er satt. Svaret har `token.ok` og
   `sending.status`. `403 ErrorAccessDenied` betyr at rollen mangler eller
   ikke er lest ennå: plattformen kan holde på et token uten den nye rollen en
   god stund, så vent og prøv igjen før du leter etter feil.

5. **Slå på:** `EPOST_VEI=graph`. Send inn en sak med kopimottaker, og en med
   Teams eller Planner på et steg. E-posten skal komme fra postboksen, og
   Teams-meldingen fortsatt fra flyten.

6. **Utsending og purring:** med 25 per kjøring tar en utsending til 200
   mottakere åtte kjøringer. Sett kjøreplanen tettere i dev, for eksempel
   `SEND_UTSENDINGER_SCHEDULE=0 */10 5-7 * * *` og
   `PURRE_UTSENDINGER_SCHEDULE=0 */10 6-8 * * *` (hvert tiende minutt i et
   vindu). Planen leses ved oppstart, så Function App-en må startes på nytt.
   En kjøring uten noe å gjøre koster ingenting.

7. **Tilbake:** fjern `EPOST_VEI`, eller sett den til `flyt`.

> Med Graph-veien på sender dev ekte e-post. Har testdataene adresser utenfor
> dev-tenanten, får de e-post.


### Mål

All e-post Skjema sender, går fra én felles postboks via Graph. Varslingsflyten
får bare Teams- og Planner-kanalene. Vi kan gå tilbake til flyten med én app
setting.

### Forutsetninger (utenfor koden)

1. **Tenant-spørsmålet over er besvart.** Det avgjør om token hentes med
   identiteten eller med sertifikat.
2. **En felles postboks**, for eksempel `skjema@…`. En shared mailbox trenger
   ingen lisens.
3. **Tilgangen gis i Exchange, ikke i Entra.** Med *RBAC for Applications*
   tildeles rollen `Application Mail.Send` med et omfang som bare dekker
   postboksen. `Mail.Send` skal **ikke** samtidig gis under *API permissions* i
   Entra: der gjelder den hele tenanten, og de to legges sammen.
   Kommandoene i Exchange Online PowerShell er `New-ServicePrincipal`,
   `New-ManagementScope` og `New-ManagementRoleAssignment` med
   `-Role "Application Mail.Send"` og `-CustomResourceScope`. Kontroll:
   `Test-ServicePrincipalAuthorization` skal si ja for postboksen og nei for en
   vilkårlig annen.

### Konfigurasjon

| App setting | Verdi | Merknad |
|---|---|---|
| `EPOST_VEI` | `flyt` (standard) eller `graph` | Et eksplisitt valg, ikke utledet av hva som er satt. Tilbakevei er å sette `flyt` |
| `EPOST_AVSENDER` | postboksens adresse | Ikke hemmelig, `settes_direkte` |
| `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_CERT_PEM` | som backupen, men varslingsappens | Bare hvis identiteten ikke kan brukes. Egen app betyr egne variabelnavn — de skal ikke dele med backupen |

Alle tre inn i `config/env.*.json`, ellers stopper `env-inventar.test.js`
deployen. Nøkkelkalenderen får en rad for sertifikatet hvis det blir sertifikat.

### Koden

1. **Tokenet ut av `graph-opplast.js`.** Klientassertion, tokenkropp og cache
   flyttes til `lib/graph-token.js`, parametrisert på app. Backup og e-post
   bruker samme kode — ellers har vi to tokenveier som svarer ulikt neste gang
   Entra endrer noe. Identitetsveien går gjennom `lib/plattform-token.js`, som
   finnes.
2. **`lib/graph-epost.js`** med én funksjon: `sendEpost({ til, kopi, emne, html })`
   → `POST /users/{EPOST_AVSENDER}/sendMail`. Prøver igjen på 429/503 med
   `Retry-After`, høyst tre ganger. Returnerer samme utfallsform som
   flytkallene (`ok`, `feil`, `hoppet-over`, `deaktivert`), slik at kallerne og
   `/api/varsling/diag` ikke ser forskjell.
3. **Valget står ett sted:** `sendVarslerViaFlyt()` i `lib/flyt-kaller.js`.
   - `EPOST_VEI=graph` og `epost` i `varslinger`: e-posten sendes via Graph, og
     flyten kalles med resten av kanalene. Er `epost` eneste kanal, kalles
     flyten ikke.
   - Én e-post per mottaker, som flyten gjør i dag.
   - **Kvitteringen med kopi:** én e-post til `mottakere[0]` med `kopi` i
     Cc-feltet. Det er formen `docs/FLYTER.md` beskriver under «`kopi[]` —
     VENTER PÅ FLYTEN». Den blir ferdig her, uten en ALM-runde.
4. **Utsending og purring** (`kallUtsendingsflyt` i `lib/utsending-jobb.js`)
   går samme vei. Mottakerne bærer hver sin `url`, så teksten bygges per
   mottaker. Etter maks 25 sendinger per minutt stopper kjøringen, og resten tas
   neste kjøring. Det krever at utsendingen bokføres per mottaker, ikke per
   kjøring. Sjekk `utsending-storage.js` før dette bygges.
5. **Engangskoden** (`sendOtpViaFlyt`): `kanal=epost` via Graph, `kanal=sms`
   fortsatt via flyten.
6. **`VARSLING_DEAKTIVERT`** gjelder Graph-veien på samme måte. Regelen leses
   fra `varslingAv()`, ikke på nytt.
7. **Systemsiden** viser `EPOST_VEI` og avsenderen, og om Graph-tokenet lar seg
   hente (uten å sende noe).

### Tester

- `graph-epost` mot en stubbet `fetch`: riktig adresse, Cc bare når `kopi` er
  satt, `Retry-After` respektert, utfallsformen lik flytkallets.
- Én test som kjører samme varsling gjennom begge veier og krever samme
  mottakere, emne og HTML. Det er regelen «én regel, ett sted» for de to
  veiene.
- Mutasjon: bytt Cc til To, fjern `epost` fra kanalene uten å sende, glem
  `varslingAv()`. Hver skal gi en rød test.

### Utrulling

1. **v3-dev:** `EPOST_VEI=graph`. Send en sak gjennom med kopimottaker og
   samtale, og kjør en utsending til fem testmottakere.
2. **v3-prod:** samme, etter at postboksen og Exchange-omfanget er på plass.
   Første døgn: sammenlign antall sendte i hendelsesloggen med dagen før.
3. **Etter en uke uten feil:** ta e-postgrenen ut av varslingsflyten, og fjern
   `kopi[]`-overgangen (adressene står i dag i både `mottakere` og `kopi`).

### Åpne spørsmål

1. Ligger M365 og Azure-abonnementet for prod i samme tenant?
2. Hvilken adresse skal postboksen ha? Den blir avsender for alt, også
   engangskoder til eksterne.
3. Brukes SMS-engangskode i noen skjematype i prod? Hvis ikke, kan
   OTP-flyten rives helt i fase 1.
