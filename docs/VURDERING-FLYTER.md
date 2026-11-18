# Vurdering: Power Automate-flytene videre

Skrevet 17.11.2026. Spørsmålet var om de sentrale flytene skal legges inn i
API-et, eller flyttes til Logic Apps. Svaret er API-et, i faser, med e-post
først. Fase 1 er beskrevet som plan nederst.

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

### Binde en Logic App til Function App-ens identitet

Lagt til 18.11.2026, for en prøve-app. Gjelder **Consumption**. Standard har
ikke autorisasjonspolicyen, og må bruke App Service-autentisering.

1. **Les claimene.** Som admin i v3-dev:
   `/api/diagnose/mi-token?ressurs=https://management.azure.com/&tokenkilde=plattform`.
   Svaret viser `iss`, `aud` og `appid` slik tokenet faktisk har dem.
2. **Policyen.** Logic App → *Settings → Authorization → Add policy*, type
   `AAD`: `Issuer` og `Audience` fra tokenet, og et eget claim `appid` med
   identitetens klient-ID (`AZURE_CLIENT_ID`). Alle claimene i én policy må
   stemme, og det er `appid` som binder den til vår identitet.
3. **Steng SAS-veien.** Policyen gjør ikke `sig=`-URL-en ugyldig. Sett
   `"operationOptions": "IncludeAuthorizationHeadersInOutputs"` på triggeren,
   og triggerbetingelsen
   `@startsWith(triggerOutputs()?['headers']?['Authorization'], 'Bearer')`.
4. **Audiencen hos oss.** `FLYT_RESSURS` settes til nøyaktig verdien i
   policyen, også skråstreken bakerst. Den gjelder alle flytene i miljøet,
   slik `FLYT_AUTH` gjør, så en blanding av Power Automate og Logic Apps i
   samme miljø går ikke. Usatt er Power Automate.
5. **Prøv uten å røre varslingen.** Legg URL-en uten `sp`, `sv` og `sig` i en
   app setting som slutter på `_FLOW_URL`, og kall
   `/api/diagnose/mi-flyt?envVar=<NAVN>&ressurs=https://management.azure.com/&tokenkilde=plattform`.
   Uten `ressurs=` bruker prøven `FLYT_RESSURS`, altså det kallene bruker.

Logic Apps er riktig bare hvis flytlogikken skal forbli visuell og redigeres av
andre enn utviklerne. Det løser ingen av problemene vei 1 løser.

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
