# Sikkerhet og arkitektur

**Overleveringsdokument til sikkerhetstesting og -evaluering.**

| | |
|---|---|
| Versjon | 1.1 |
| Dato | 13.10.2026 |
| Løsning | FHS Skjema, Azure Static Web Apps-versjonen (`skjema-swa`) |
| Miljøer dokumentet dekker | `pilot` og `prod` |
| Forfatter | Utviklingen av løsningen |

Dette dokumentet er skrevet for å bli lest av noen som ikke har bygget
løsningen, og som skal vurdere om den er trygg nok å drifte med ekte data om
ekte personer. Det er derfor skrevet med én regel: **det som er svakt, står
her.** Et dokument som bare beskriver mekanismene som finnes, og lar
evaluatoren finne hullene selv, gjør at alt det andre også må etterprøves.
Kapittel 10 er listen over kjente begrensninger, og den er ment å være
fullstendig.

---

## 1. Avgrensning

### Dette dokumentet dekker

* Løsningen i dette repoet: frontend, API, lagring, og de integrasjonene koden
  selv kaller.
* Tilgangsstyring og autentisering, inkludert de fire veiene inn som **ikke**
  går via Entra-innlogging.
* Datasikring: anonymisering, kryptering av skjemasvar, kryptering av backup.
* Hemmelighetsforvaltning, slik den faktisk virker på denne plattformen.

### Dette dokumentet dekker ikke

* **Power Automate-flytene.** Løsningen kaller seks sentrale flyter over HTTP,
  og flytene ligger i en annen tenant med egne eiere. Kontrakten mot dem er
  dokumentert (`docs/FLYTER.md`), men innholdet i dem er ikke vårt. En
  flyt-URL er i praksis en hemmelighet — den bærer en SAS-signatur i
  query-strengen, og den som har URL-en kan kalle flyten.
* **Per-steg-flyter som skjemaeiere lager selv.** De er utenfor
  løsningspakka. Se 9.3 — de deler en nøkkel med mer rekkevidde enn de
  trenger, og det er den tyngste kjente svakheten i designet.
* **FS API** (Felles Studentsystem). Vi er konsument, med egne
  tjenestebrukerkredentialer.
* **Referanse-appen**, den opprinnelige Function App-versjonen. Den kjører
  ikke i disse miljøene.
* **Plattformen selv** — Azure Static Web Apps, Table Storage, Entra ID. Vi
  dokumenterer hva vi forutsetter av den, ikke hva den gjør.

### Hvordan tallene i dokumentet er framstilt

De tallene som kan genereres, genereres. Nøkkeltallsblokka under og hele
`docs/API-OVERSIKT.md` skrives av `scripts/api-oversikt.js`, og
`api/test/api-oversikt.test.js` feiler hvis filene ikke er oppdatert mot
koden. Det er med vilje: et overleveringsdokument med håndskrevne tall er
utdatert før det er lest, og en evaluator som finner ett endepunkt vi ikke har
nevnt, leser resten med nye øyne.

---

## 2. Hva løsningen er

Et system for å definere, fylle ut, behandle og rapportere på skjemaer ved
Forsvarets høgskole. En skjematype defineres i en editor i appen — felter,
behandlingssteg, tilgang, varsling — og fylles ut av interne (pålogget) eller
eksterne (engangskode eller lenke). Skjemaet går gjennom et antall
behandlingssteg med beslutninger, og kan hentes ut som PDF, datauttrekk,
rapport eller Power BI-feed.

**Dataene er personopplysninger.** Skjemaene handler i hovedsak om studenter
og ansatte: navn, e-postadresse, studieprogram, og svarene i skjemaet, som kan
være sensitive avhengig av skjematypen. Oppslagslister fra FS inneholder
student- og emnedata.

### Komponenter

```
                  ┌──────────────────────────────────────┐
                  │  Nettleser                           │
                  │  13 HTML-sider, ES-moduler,          │
                  │  ingen rammeverk, intet byggsteg     │
                  └───────────────┬──────────────────────┘
                                  │ HTTPS
                  ┌───────────────▼──────────────────────┐
                  │  Azure Static Web Apps               │
                  │                                      │
                  │  /.auth/*   Entra ID-innlogging      │
                  │             (egen app-registrering,  │
                  │              tenant-låst issuer)     │
                  │                                      │
                  │  /*         statiske filer via CDN   │
                  │                                      │
                  │  /api/*     ruteregler: hvem slipper │
                  │             fram  ──────┐            │
                  └─────────────────────────┼────────────┘
                                            │
                  ┌─────────────────────────▼────────────┐
                  │  Managed Functions (Azure Functions  │
                  │  v4, Node 22, kun HTTP-triggere)     │
                  │                                      │
                  │  Hvert endepunkt unntatt fem har en  │
                  │  vakt i handleren i tillegg.         │
                  │  Full liste: docs/API-OVERSIKT.md    │
                  └──┬──────────────────┬────────────────┘
                     │                  │
     STORAGE_CONNECTION_STRING          │ utgående HTTPS
                     │                  │
      ┌──────────────▼──────┐   ┌───────▼──────────────────────────┐
      │  Table Storage      │   │  FS API            (studentdata) │
      │  20 tabeller        │   │  Power Automate    (6 flyter)    │
      │  Blob Storage       │   │  Microsoft Graph   (SharePoint-  │
      │  (vedlegg, logo,    │   │                     opplasting)  │
      │   backup, arkiv)    │   │  Bring             (postnumre)   │
      └─────────────────────┘   │  Anthropic API     (skjematolk)  │
                                └──────────────────────────────────┘
                     ▲
                     │ HTTP, med delt nøkkel i header
      ┌──────────────┴───────────────┐
      │  GitHub Actions — 8 jobber   │
      │  på klokke. SWA Managed      │
      │  Functions støtter ikke      │
      │  timer-triggere.             │
      └──────────────────────────────┘
```

### Hvorfor jobbene ligger i GitHub Actions

SWA Managed Functions støtter bare HTTP-triggere. Alt som skal skje på klokke
må derfor utløses utenfra, og det gjøres av GitHub Actions som kaller et
HTTP-endepunkt med `x-scheduler-key` i headeren. Konsekvensen for
sikkerhetsbildet er at de endepunktene **må** være anonyme i gatewayen (en
GitHub-runner har ingen Entra-identitet), og at vakten deres er en delt nøkkel
i et GitHub-secret. De står i tabellen i kapittel 5.

De to diagnosejobbene (`refresh-fs-diag*.yml`) har bare `workflow_dispatch` —
de kjøres for hånd.

| Jobb | Tid (UTC) | Endepunkt |
|---|---|---|
| Backup — full | søndag 02:00 | `POST /api/backup/kjor` |
| Backup — delta | man–lør 02:00 | `POST /api/backup/kjor` |
| Refresh FS-data | 04:00 daglig | `POST /api/refresh-fs` |
| Team-synk fra roller | 04:30 daglig | `POST /api/team-synk` |
| Refresh postnumre (Bring) | 15. jan og 15. jul, 04:30 | `POST /api/postnumre/refresh-bring` |
| Send planlagte utsendinger | 05:00 daglig | `POST /api/utsending/send-forfalte` |
| Oppdater oppslagslister | 05:30 daglig | `POST /api/oppslaglister/oppdater` |
| Purre utsendinger | 06:00 daglig | `POST /api/utsending/purre` |
| Sjekk nøkkelkalender | 07:00 daglig | `POST /api/nokkelkalender/sjekk` |

---

## 3. Datastrømmer

### Inn i løsningen

| Kilde | Hva | Vei inn | Autentisering |
|---|---|---|---|
| Intern bruker | Skjemasvar, beslutninger, definisjoner | Nettleser → `/api/*` | Entra ID via SWA |
| Ekstern innsender | Skjemasvar | Nettleser → `/api/*` | Engangskode på e-post (OTP), eller HMAC-signert lenke |
| FS API | Studenter, emner, klasser, kull | Nattjobb → `/api/refresh-fs` → FS API | Tjenestebruker (`FS_API_USER`/`FS_API_PASSWORD`) |
| Bring | Postnummerregister | Halvårlig jobb | Åpent API |
| Power Automate | Teammedlemskap, flyt-utfall, backup-kvitteringer | Flyt → `/api/*` | `x-flow-key` (`FLOW_CALLBACK_KEY`) |
| GitHub Actions | Utløser for jobbene på klokke | Runner → `/api/*` | `x-scheduler-key` (`SCHEDULER_KEY`) |

### Ut av løsningen

| Mål | Hva | Merk |
|---|---|---|
| Power Automate → e-post | Varsler, kvitteringer, engangskoder, utsendingslenker | Innholdet kan inneholde personopplysninger og skjemadata |
| SharePoint (via Graph) | Backup-filer | Kryptert før opplasting, se 7.3 |
| SharePoint-liste (via flyt) | Utvalgte skjemasvar | Per skjematype |
| Power BI | Skjemasvar for én skjematype | Dekryptert. Se 9.1 — URL-en er en hemmelighet |
| Nedlasting i nettleseren | PDF, datauttrekk (CSV/Excel), arkiv-JSON | Dekryptert. Arkiv-JSON er klartekst, se 10 |
| Anthropic API | Bilde eller PDF av et papirskjema, for å foreslå en skjemadefinisjon | `POST /api/ai/analyser-skjema`, admin eller Skjemaskaper. **Filen forlater løsningen.** Se under |

#### Skjematolken sender en fil ut av løsningen

`POST /api/ai/analyser-skjema` tar et bilde eller en PDF av et papirskjema og
sender det til Anthropics API, som returnerer et forslag til
skjemadefinisjon. Det er et nyttig verktøy, og det er den eneste
funksjonen i løsningen som sender innhold til en tredjepart utenfor
Forsvarets kontroll.

Vakten er admin eller rollen Skjemaskaper, maks 20 MB. Men **ingenting hindrer
at den opplastede filen inneholder personopplysninger** — et utfylt papirskjema
gjør det typisk. Det er en bruksrisiko, ikke en teknisk feil, og den hører i
kapittel 10.

### Logging

Alt går til Application Insights. **Det finnes ingen Log stream** på SWA
Managed Functions — det bladet finnes bare på en ordinær Function App, og at
det mangler leses lett som at ingenting logges. `Logs` i Application Insights
er presist i etterkant; sampling er på for `traces`, av for `requests`. Se
`docs/LOGGING.md`.

Revisjonssporet er Hendelser-tabellen, skrevet via `POST /api/hendelser/logg`.
Merk at det endepunktet også kan skrives til med `FLOW_CALLBACK_KEY` — se 9.3.

---

## 4. Autentisering

### 4.1 Interne brukere: Entra ID via SWA

SWA gjør innloggingen. Appen ser aldri et token: plattformen validerer det og
sender `x-ms-client-principal` som en base64-JSON-header til funksjonen.
`api/src/lib/auth.js` leser `userDetails` ut av den som UPN.

To egenskaper er vesentlige:

* **Issueren er tenant-låst.** `openIdIssuer` peker på én konkret tenant-GUID,
  ikke `/common/` og ikke `/organizations/`. Settes den til `/common/`, godtas
  konti fra enhver Entra-tenant i verden; det er en reell feil som er lett å
  gjøre, og `api/test/swa-config.test.js` feiler på den.
* **Prod bruker sertifikat, ikke client secret.** `staticwebapp.config.prod.json`
  bruker `clientSecretCertificateKeyVaultReference` mot Key Vault. Dette er den
  ene Key Vault-referansen i løsningen som faktisk virker, fordi den løses av
  SWA-plattformens auth-komponent og ikke av app-settings-laget. Pilot bruker
  client secret.

**Appen stoler fullt på headeren.** Den forutsetter at SWA fjerner en
innkommende `x-ms-client-principal` fra klienten og setter sin egen. Det er
plattformens dokumenterte oppførsel, men vi har ikke verifisert det selv, og
hele autentiseringen hviler på det. Forutsetningen står i kapittel 10, og vi
ber om at den testes.

En begrensning som påvirker datakvalitet, ikke sikkerhet: **SWA sender ikke
claims videre til managed functions** (verifisert 16.09.2026). Navnet på den
innloggede må derfor hentes fra en egen tabell, ikke fra tokenet.

### 4.2 Eksterne innsendere: engangskode (OTP)

En ekstern som skal fylle ut et skjema oppgir e-postadressen sin, får en
6-sifret kode, og bytter den i et HMAC-signert token.

| | |
|---|---|
| Kodens levetid | 15 minutter |
| Maks feilforsøk | 5, deretter slettes raden |
| Rate-limit per mottaker | 60 sekunder mellom nye koder |
| Lagring av koden | Kun som `SHA-256(mottaker + ':' + kode)` — aldri klartekst |
| Tokenets levetid | 30 minutter |
| Signering | HMAC med `OTP_HMAC_KEY` |

`POST /api/otp/be-om-kode` og `/verifiser-kode` **må** være anonyme — det er
der en ekstern ber om tilgang i det hele tatt. Koden sendes bare til adressen
som oppgis, og feil kode gir ingen opplysning om hvorvidt adressen finnes.

Hvilke skjematyper en ekstern kan åpne, styres av `EksternTilgang` på
skjematypen. `GET /api/publikum-skjematype/{id}` returnerer bare typer der den
er satt, og bare definisjonen — aldri svar.

### 4.3 Masseutsending: signert lenke

Ved masseutsending får hver mottaker en lenke med et HMAC-signert token bundet
til **(batch, mottaker, skjematype)**, med 90 dagers levetid som standard.
Signeringsnøkkelen er `OTP_HMAC_KEY`, gjenbrukt. Tokenet bærer ingen
forhåndsutfylte data; de ligger i Utsendinger-tabellen.

En slik lenke gir tilgang **uten Entra-pålogging**. Den som har lenken, er
mottakeren. 90 dager er lenge, og valget er bevisst (studenter skal ha tid),
men det er en avveining en evaluator bør se på.

### 4.4 Maskin-til-maskin: tre delte nøkler

| Nøkkel | Header | Brukes av |
|---|---|---|
| `SCHEDULER_KEY` | `x-scheduler-key` | GitHub Actions-jobbene |
| `FLOW_CALLBACK_KEY` | `x-flow-key` | Power Automate-flytene, inkludert skjemaeieres per-steg-flyter |
| Power BI-token | i query-strengen | Power BI-feeden. `?skjematype_id=…&guid=…&upn=…` — **URL-en er legitimasjonen**, ingen cookie kreves. GUID-en er bundet til UPN, skjematype og utløp i Tilgangskontroll-tabellen |

`FLOW_CALLBACK_KEY` er den som bærer mest, og den er delt med flest. Se 9.3.

---

## 5. Autorisasjon

### 5.1 To lag, og hvorfor begge må finnes

```
    Forespørsel
         │
         ▼
 ┌───────────────────────────────┐
 │ Lag 1: SWA-gatewayen          │   staticwebapp.config.<miljø>.json
 │ allowedRoles per rute         │   «anonymous» = hvem som helst
 │ FØRSTE treff gjelder          │   «/api/*» = authenticated, nederst
 └───────────────┬───────────────┘
                 ▼
 ┌───────────────────────────────┐
 │ Lag 2: vakten i handleren     │   erAdmin, hentInnloggetUpn,
 │ erAdmin / eier / rolle /      │   harEierTilgang, erSkjemaskaper,
 │ token / delt nøkkel           │   OTP, utsendingstoken, delte nøkler
 └───────────────┬───────────────┘
                 ▼
            Handleren
```

Lag 1 alene er ikke nok, av en konkret grunn: **SWA forkaster hele
konfigurasjonsfila hvis én rute er ugyldig.** Da forsvinner ruteregler,
headere, 401-overriden og auth-blokka samtidig. Det skjedde 02.09.2026, med et
jokertegn midt i en rute. Feilen vises bare som én rød linje i en byggelogg
som ellers går grønt.

Derfor er regelen i denne løsningen at **lag 2 nesten alltid finnes**: hvert
endepunkt unntatt fem har en vakt i handleren i tillegg til gatewayregelen. De
fem som ikke har det, er erklært med begrunnelse i koden, og
`api/test/api-oversikt.test.js` krever at det ikke finnes et sjette.

### 5.2 Nøkkeltall

<!-- GENERERT:api-nøkkeltall -->
| | |
|---|---|
| Endepunkter i alt | 140 |
| Anonyme i SWA-gatewayen | 39 |
| — av dem med vakt i handleren | 34 |
| — av dem åpne med vilje, erklært og begrunnet | 5 |
| — av dem åpne UTEN forklaring | 0 |
| Endepunkter uten noen vakt i handleren | 5 — alle erklærte |
<!-- /GENERERT:api-nøkkeltall -->

Den fullstendige tabellen — hvert endepunkt, metode, gatewayregel og vakt —
står i **`docs/API-OVERSIKT.md`**. Den er generert, ikke skrevet.

At så mange er anonyme i gatewayen ser verre ut enn det er: de fleste av dem
har en vakt i handleren som gatewayen ikke kan uttrykke — en delt nøkkel, et
OTP-token, en signert lenke. De fem uten vakt er:

| Rute | Hvorfor |
|---|---|
| `GET /api/ping` | Helsesjekk. Svarer med commit-SHA, miljø, og om innloggingen nådde fram til funksjonen — ikke hvem som er innlogget. SHA-en er nødvendig for å avgjøre om en rettelse faktisk er deployet |
| `GET /api/logo/{filnavn}` | Bilde-bytes. Vises i skjema-headere, også for eksterne som ikke er pålogget |
| `GET /api/systemlogo` | Systemets logo og tittel. Vises før innlogging |
| `POST /api/otp/be-om-kode` | Her ber en ekstern om tilgang. Rate-limitet |
| `POST /api/otp/verifiser-kode` | Samme grunn |

### 5.3 Hvem får se hva

| Nivå | Hvordan avgjort | Hvor |
|---|---|---|
| **Admin** | UPN står i `ADMIN_UPNS` | `erAdmin(upn)` |
| **SWA-rollen `admin`** | Tildelt per bruker, hentes via `rolesSource: /api/roller-swa` | Gatewayen, for `/admin.html` |
| **Skjemaskaper** | Medlem av rollen «Skjemaskaper» | `erSkjemaskaper(upn)` |
| **Eier av en skjematype** | Oppført i Eiere — direkte UPN, rolle eller team | `harEierTilgang(...)` |
| **Publikum for en skjematype** | Oppført i Publikum — direkte UPN, rolle eller team | `filtrerTyperPåTilgang(...)` |
| **Behandler på et steg** | Oppført på steget — UPN, rolle, team eller feltreferanse | `brukerErBehandlerAsync(...)` |
| **Innsender** | UPN-match, eller eierskap til et gyldig OTP-/utsendingstoken | per endepunkt |

Rolle- og teammedlemskap slås opp i Table Storage. Rolleoppslag **feiler
lukket**: kaster oppslaget, gis ikke tilgang. Teammedlemskap leses fra en
cache som fylles av en Power Automate-flyt (`Teammedlemskap`-tabellen) — se
9.3, for den cachen kan skrives med `FLOW_CALLBACK_KEY`.

Innenfor én forespørsel memoiseres oppslagene (`lagTilgangsCache()`). Ingen
tilstand overlever forespørselen, så tilgang kan ikke bli utdatert mellom
kall.

### 5.4 HTML-sidene er åpne; dataene er ikke

To av de tretten sidene har en ruteregel: `/admin.html` krever rollen `admin`,
`/editor.html` krever innlogging. (En tredje regel krever `admin` for
`/migrer.html`, men den fila finnes ikke lenger.) De elleve andre HTML-filene
serveres til hvem som helst.

Det er bevisst, og det er ufarlig så lenge det holder at **sidene ikke
inneholder data** — de er tomme skall som henter alt fra `/api/*`, der
`/api/*`-regelen krever `authenticated`. En uinnlogget besøkende får et tomt
skall og blir sendt til innlogging ved første API-kall (401 → 302 til
`/.auth/login/aad`).

Forutsetningen «sidene inneholder ingen data» er ikke testet maskinelt. Den
står i kapittel 10.

---

## 6. Datasikring i hvile

### 6.1 Anonymisering av innsender

Settes per skjematype (`Anonymiseres: true`). Ved siste ferdigbehandling
erstattes `Innsender_Epost` med `anonym-<12 hex>` og `Innsender_Navn` med
«Anonymisert».

Pseudonymet er `SHA-256(HASH_SALT + normalisert epost)`, trunkert til 12
hex-tegn.

**Det er pseudonymisering, ikke anonymitet**, og det sies her fordi navnet på
innstillingen antyder noe annet:

* Hashen er deterministisk. Samme innsender gir samme pseudonym på tvers av
  skjemaer, så innsendinger kan kobles til hverandre.
* 12 hex-tegn er ~48 bits. Saltet er det som hindrer at en kjent
  e-postadresse kan bekreftes ved utregning; lekker `HASH_SALT`, kan hvem som
  helst med en liste over studentadresser knytte pseudonym til person.
* Metadata som korrelerer — tidspunkt, behandlingssteg, hvilke felt som er
  besvart — er ikke fjernet.

`HASH_SALT` er derfor merket **skal ikke roteres** i nøkkelkalenderen: et
bytte gir nye pseudonymer for nye innsendinger mens de gamle beholder sine, og
koblingen kan ikke gjenskapes — adressen den ble beregnet fra er slettet.

### 6.2 Kryptering av skjemasvar

Settes per skjematype: `Krypteres: "Nei" | "Svar" | "Alt"`.

| | |
|---|---|
| Algoritme | AES-256-GCM, med auth-tag |
| IV | 12 tilfeldige byte per kryptering |
| Format | `<iv-hex>:<tag-hex>:<ciphertext-base64>` |
| Nøkkel | 256 bit, `crypto.randomBytes(32)`, lagret per skjematype i Kryptonokler-tabellen |
| Når | Ved siste ferdigbehandling (`Skjema_status = 5`) |

**`Svar`-modus krypterer bare svarverdiene.** Dette er klartekst og lesbart
uten nøkkel: `Skjema_id`, `Skjematype_id`, hele `Behandling[]`, hele
`Dialog[]`, `Sist_endret`, `Skjema_status`, og feltstrukturen med
spørsmålstekstene. For en skjematype der spørsmålet i seg selv er sensitivt,
holder ikke `Svar` — da må `Alt` brukes, og da beholdes bare id-ene.

**Nøkkelen er den eneste kopien.** Ingen backup, ingen restore, ingen
regenerering. Fanen **🔑 Nøkler** i admin-panelet viser nøkkelen nettopp for
at eier skal kunne ta en kopi ut av systemet. Mistes den, er dataene borte.

**Krypteringsnøkkelen ligger i samme storage-konto som dataene.** Den som har
`STORAGE_CONNECTION_STRING`, har både ciphertext og nøkkel. Krypteringen
beskytter altså mot lekkasje gjennom appens egne endepunkter og mot en som
leser én tabell — ikke mot en som har kontostrengen. Det er en reell
avgrensning av hva kontrollen gir.

**Feil ved kryptering er ikke-blokkerende.** Feiler krypteringen, lagres
skjemaet likevel — i klartekst — og det logges til Application Insights.
Valget er at et skjema ikke skal gå tapt; prisen er at «kryptert» er noe som
må verifiseres, ikke antas.

Dekryptering skjer automatisk ved PDF-generering, Power BI-feed og datauttrekk
(der manuelt oppgitt nøkkel har prioritet). Register og evaluering
dekrypterer **ikke** — de viser `[Kryptert]`. Det er et bevisst valg for at
nøkkelen ikke skal leke ut via mange endepunkter.

### 6.3 Kryptering av backup

| | |
|---|---|
| Algoritme | AES-256-GCM |
| Nøkkelutledning | PBKDF2-SHA256, 200 000 iterasjoner, 16 byte salt |
| Passord | `BACKUP_PASSPHRASE`, minimum 16 tegn (håndhevet i koden) |
| Hvor | Kryptert *før* opplasting til SharePoint |

Backupen krypteres altså før den forlater løsningen, og passordet ligger ikke
hos mottakeren av filen. Gjenopprettingsprosedyren står i
`docs/BACKUP-SHAREPOINT.md`.

**Prod-backup er ikke satt opp ennå** (per 13.10.2026). Backup kjøres manuelt
fra pilot. App-registreringen for prod-opplasting mot SharePoint er under
avklaring med Cyberforsvarets Azure-administratorer. Dette er den mest
alvorlige åpne posten i drift, og den står først i kapittel 10.

### 6.4 Transport og headere

HTTPS gjennom hele veien; SWA terminerer og tvinger det.

Globale svarheadere:

| Header | Verdi |
|---|---|
| `Cache-Control` | `no-store, must-revalidate` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |

### Content-Security-Policy

Innført 13.10.2026. Fram til da fantes den ikke, samtidig som
`docs/SECURITY.md` påsto at den gjorde det og at den var tiltaket mot en
ondsinnet skjemadefinisjon.

```
default-src 'self'; script-src 'self' 'unsafe-inline';
style-src 'self' 'unsafe-inline'; img-src 'self' blob:;
font-src 'self'; connect-src 'self'; object-src 'none';
base-uri 'self'; form-action 'self'; frame-ancestors 'none'
```

Verifisert i Chromium mot de ekte svarheaderne: `eval()`, et skript fra et
annet opphav, `<object>` og `<base href>` mot et fremmed domene blir alle
blokkert, mens alt appen selv gjør — inline `<script>`, ES-moduler, inline
event-handlere, inline `style`, `blob:`-bilder og `fetch` mot eget opphav —
fortsatt virker.

**`script-src` har fortsatt `'unsafe-inline'`.** Det er ikke en forglemmelse.
Sidene har 275 inline event-handlere (`onclick`, `onchange`, `oninput`) og 13
inline `<style>`-blokker, etter samme mønster som referanse-appen. Hverken
nonce eller hash dekker inline event-handlere, og å fjerne dem er en
omskriving av alle 13 sidene.

Det CSP-en gir likevel, og som ikke fantes før:

| Blokkert nå | Hva det stopper |
|---|---|
| `script-src 'self'` | Et injisert `<script src="https://…">`. Den vanligste nyttelasten |
| ingen `'unsafe-eval'` | `eval()` og `new Function()` fra injisert kode. Appen bruker ingen av delene |
| `connect-src 'self'` | Utsending av data til en annen vert — selve gevinsten i et XSS-angrep |
| `object-src 'none'` | Plugin-innhold |
| `base-uri 'self'` | En injisert `<base>` som omdirigerer alle relative URLer |
| `form-action 'self'` | Et injisert skjema som poster til en annen vert |
| `frame-ancestors 'none'` | Clickjacking. Erstatter `X-Frame-Options` i moderne nettlesere |

`api/test/escaping.test.js` krever at CSP-en finnes i begge miljøene, at de er
like, og at frontend ikke laster noe fra et annet opphav — for da ville
`default-src 'self'` sluttet å stemme, og det skal oppdages her og ikke i en
nettleser hos en bruker.

---

## 7. Hemmelighetsforvaltning

Dette kapitlet beskriver noe som ikke virker slik man ville anta, og som er
avgjørende å forstå riktig.

### 7.1 Koden kan ikke bruke Managed Identity

SWA Managed Functions eksponerer **ingen** managed-identity-token til
funksjonskoden. `DefaultAzureCredential` har ingenting å hente.
`api/src/lib/keyvault.js` er død kode og importeres ingen steder. I pilot og
prod går derfor all lagring via `STORAGE_CONNECTION_STRING`.

> **Dette er en begrensning i vertsmodellen, ikke i Azure.** 16.10.2026 ble
> det målt i et dev-miljø der API-et kjører som en frittstående Function App
> lenket til SWA-en: koden får et MI-token, og leser og skriver både tabeller
> og blober uten tilkoblingsstreng. Se 8i i
> `docs/BESLUTNING-EGEN-FUNCTION-APP.md`.
>
> **Koden bærer nå begge veier** (16.10.2026). `api/src/lib/lagringsvalg.js`
> velger managed identity når `STORAGE_ACCOUNT_NAME` er satt og
> `STORAGE_CONNECTION_STRING` ikke er det — ellers tilkoblingsstreng, som før.
> Valget står ett sted og brukes av både `storage.js` og `blob.js`. Det gjelder
> også SAS-signeringen av backup-lenkene, som på identitetsveien går via
> `getUserDelegationKey()` i stedet for kontonøkkelen. Se 8j og 8k.
>
> **Pilot og prod er uendret.** Begge har en tilkoblingsstreng, og den vinner
> over kontonavnet nettopp for at utrullingen av den nye veien skal være
> virkningsløs der. Omleggingen er steg 5b og 6 i den planen, og den gjøres
> ved å FJERNE tilkoblingsstrengen — ikke ved å deploye.

### 7.2 Hosten løser ikke Key Vault-referanser

> Samme forbehold som 7.1: dette gjelder SWA Managed Functions. En
> frittstående Function App løser dem — 16.10.2026 ble 21 ekte hemmeligheter
> hentet som `@Microsoft.KeyVault(SecretUri=…)` i dev-miljøet, uten klartekst
> noe sted utenfor Key Vault. Det krever at `keyVaultReferenceIdentity` peker
> på identitetens ressurs-ID. Se 8i.

Dette er det viktige punktet, og det er fastslått ved forsøk, ikke antatt.

**Prøvd i pilot 12.10.2026:** `TEAM_SOK_EKSTERNT_FLOW_URL` ble satt til en
`@Microsoft.KeyVault(SecretUri=…)`-referanse. `/api/system/info` meldte
«ikke en gyldig URL», med lengde 109 — altså selve referansestrengen, uløst.
SWA Managed Functions løser dem ikke, uansett rolletildeling på identiteten.

**Konsekvensen: hemmelighetene står i klartekst i SWA Configuration.** Det
gjelder `STORAGE_CONNECTION_STRING`, alle flyt-URLene med `sig=`-signaturen
sin, `OTP_HMAC_KEY`, `HASH_SALT`, `BACKUP_PASSPHRASE`, `FS_API_PASSWORD`,
`SCHEDULER_KEY`, `FLOW_CALLBACK_KEY`, Graph-hemmeligheten og
`ANTHROPIC_API_KEY`.

Den som kan **lese app settings** på SWA-ressursen, ser dem alle. Å liste app
settings er en privilegert ARM-operasjon
(`Microsoft.Web/staticSites/listAppSettings/action`) — en ren *Reader* får dem
ikke, så eksponeringen går til dem som allerede kan endre appen. Det er
likevel svakere enn en ekte referanse, og det er **plattformvalget** som
bestemmer det, ikke en beslutning vi har tatt.

Appen lekker dem ikke selv: `/api/system/info` viser bare lengde, og for
flyt-URLer bare vertsnavn og sti — aldri query-strengen der signaturen ligger.

### 7.3 Hva Key Vault da er til

Den har fortsatt en jobb, og den er en annen enn man skulle tro:

* **Arkiv og gjenopprettingspunkt.** Verdiene ligger der, og kan hentes om
  app settings blir ødelagt eller en ressurs må bygges opp igjen.
* **Rotasjonspunkt.** Ny verdi lages og lagres der, og limes deretter inn i
  SWA Configuration.
* **Auth-sertifikatet i prod**, som er den ene referansen plattformen faktisk
  løser — fra `staticwebapp.config.prod.json`, av auth-komponenten.

Vaultene er `kv-fhsskjema-pilot` (pilot) og `fhs-kv-01` (prod). Å hente en
verdi ut av vaulten krever **Key Vault Secrets Officer**; det er en smalere
krets enn den som kan lese app settings, og det er hele poenget med å ha
kopien der. Se `config/keyvault-secrets.md`.

Identiteten på prod-SWA-en trenger bare **Key Vault Secrets User** og **Key
Vault Certificate User** på `fhs-kv-01` — ingen storage-roller.
Pilot-SWA-ens identitet har storage-roller; de er levninger fra det
opprinnelige designet, har ingen praktisk effekt, og skal ikke kopieres til
nye miljøer.

### 7.4 Env-inventaret

`config/env.pilot.json` og `config/env.prod.json` er en **inventarliste**,
ikke en kilde: ingenting der settes automatisk. Hemmelige verdier limes
manuelt inn i SWA Configuration.

`api/test/env-inventar.test.js` krever at hver `process.env`-variabel i
`api/src` står i begge filene. Uten den driver lista, og en oversikt som ser
komplett ut og ikke er det, er verre enn ingen.

### 7.5 Nøkkelkalender

Hemmeligheter som utløper er den vanligste kilden til plutselig driftsstans.
Admin-panelet har fanen **🗓 Nøkkelkalender**, med utløpsdato, hvor
hemmeligheten ligger, konsekvens ved utløp, og rotasjonsprosedyre skrevet for
en som ikke bygde løsningen. `POST /api/nokkelkalender/sjekk` kjøres daglig kl.
07:00 UTC og varsler `ADMIN_UPNS` på trinn 14, 7, 3 og 1 dag før, og daglig
etter utløp.

Utløpsdatoer fylles inn **manuelt** — appen kan ikke spørre Key Vault (7.1).
Unntaket er SAS-strenger, som bærer utløpet i seg selv (`se=`).

---

## 8. Angrepsflate

| Flate | Hva en angriper ville prøve | Hva som står imot |
|---|---|---|
| **Anonyme endepunkter** | Finne ett uten vakt | De anonyme er listet i `docs/API-OVERSIKT.md`; alle unntatt fem har vakt i handleren. De fem er erklært og begrunnet. Test feiler på et sjette |
| **Delte nøkler** | Få tak i `FLOW_CALLBACK_KEY` eller `SCHEDULER_KEY` | Klartekst i app settings (7.2). `FLOW_CALLBACK_KEY` er delt med skjemaeiere — se 9.3 |
| **Utsendingslenker** | Gjette eller gjenbruke en lenke | HMAC-signert, bundet til batch + mottaker + skjematype. 90 dagers levetid |
| **OTP** | Brute-force en kode | 6 sifre, 5 forsøk, 15 min, 60 s rate-limit, kode lagret kun som hash |
| **Rolle- og eiertilgang** | Lese en skjematype man ikke eier | Vakt i handleren på alle endepunkter som leverer data; rolleoppslag feiler lukket |
| **Teamcachen** | Skrive seg inn i et team | `POST /api/cache/teammedlemskap` tar `FLOW_CALLBACK_KEY`. Se 9.3 |
| **Ondsinnet skjemadefinisjon** | Lagre HTML/JS som kjører hos utfylleren | Gjennomgått 13.10.2026: 301 HTML-sinker lest, 6 uescapede verdier fra skjematype-definisjonen rettet, escape-funksjonen samlet ett sted og et hull i den tettet. CSP innført. `scripts/html-injeksjon.js` + test holder det (6.4 og 10) |
| **Deploy-pipeline** | Kompromittert GitHub-konto → egen kode i prod | Branch protection på `main`: PR, 1+ review, signerte commits, «include administrators». CODEOWNERS på `.github/`, `config/`, `staticwebapp.config.*`. Secret scanning og push protection. Prod-deploy krever Environment approval |
| **Storage** | Få kontostrengen | Da er alt tapt, inkludert krypteringsnøklene (6.2). Dette er den mest verdifulle enkeltverdien i løsningen |
| **Power BI-feeden** | Få URL-en | GUID bundet til UPN, skjematype og utløp — men den som har URL-en, har hvert svar på skjematypen i klartekst. Se 9.1 |

---

## 9. Tre svakheter vi ber om at blir sett særskilt på

Disse er ikke feil som har oppstått. De er avveininger som er tatt bevisst, og
som vi mener fortjener et blikk utenfra.

### 9.1 Lenker som er hemmeligheter

Tre ting i løsningen er «hemmelig fordi den som har URL-en, kommer inn»:

* **Power BI-feed-URL-en.** Den som har den, har hvert svar på skjematypen,
  dekryptert, inkludert personopplysninger i klartekst. Den skal ikke i
  e-post, Teams eller en sak.
* **Power Automate trigger-URL-ene.** `sig=`-parameteren er signaturen.
  Dette gjelder slik løsningen står i dag, og det er dagens tilstand som
  skal evalueres.

  **Men svakheten er ikke iboende.** 15.10.2026 ble det kjørt ende til ende
  på prøveoppsettet: en flyt satt til å kreve Entra mister `sig=` helt, og
  en managed identity kaller den med 200 tilbake når identitetens `oid` står
  i triggerens liste. Da er lenken ikke lenger en hemmelighet, og tilgang
  trekkes tilbake ved å fjerne en `oid` — ikke ved å rotere en nøkkel og
  distribuere den på nytt. Se 8f i `docs/BESLUTNING-EGEN-FUNCTION-APP.md`.

  Forutsetningen er at koden får et MI-token, og det gjør den ikke i SWA
  Managed Functions. Omleggingen henger derfor sammen med beslutningen om
  egen Function App.

  **Koden kan det fra 16.10.2026, og det er målt.** `FLYT_AUTH=entra` får
  `flytHeadere()` til å legge på `Authorization: Bearer`, hentet med Function
  App-ens managed identity. Samme dag kom varslingene fram i dev gjennom en
  flyt uten `sig=` i adressen — kvittering og behandlervarsling på en
  innsending. For de flytene er lenken ikke lenger en hemmelighet. Se 8l.

  **Ingen flyt i pilot eller prod er lagt om**, og `FLYT_AUTH` står usatt
  begge steder — de har ingen identitet å hente et token med. Kallene der går
  nøyaktig som før.
* **Utsendingslenkene.** Gir tilgang uten pålogging i 90 dager.

Alle tre er riktige mekanismer for formålet, og alle tre feiler på samme måte:
videresendt lenke = gitt tilgang, uten spor. Det er en brukerrisiko mer enn en
teknisk, men den er reell.

### 9.2 Arkivet er klartekst

Arkiv-JSON-en skrives **dekryptert** og inneholder personopplysninger i
klartekst. Den som kan laste ned et arkiv, får alt — også fra skjematyper som
er krypterte i hvile. Det er med vilje (et arkiv skal kunne leses om 10 år,
uten en nøkkel noen har mistet), men det betyr at arkivendepunktets
tilgangskontroll er like viktig som krypteringen ellers.

### 9.3 Én nøkkel for fem inngangspunkter

Behandlingssteg kan ha en `Flyt_url` — en flyt skjemaeieren selv bygger.
Løsningen kaller den med en `callbackUrl` så flyten kan fullføre steget, og
skjemaeieren må ha `FLOW_CALLBACK_KEY` for å kunne kalle tilbake.

Den nøkkelen er den samme for alt. En skjemaeier som bygger en stegflyt får
dermed også en verdi som åpner:

| Endepunkt | Hva nøkkelen gir |
|---|---|
| `POST /api/utsending` | opprette engangslenker for **hvilken som helst** skjematype |
| `POST /api/cache/teammedlemskap` | erstatte teamcachen, som tilgangssjekken leser |
| `GET /api/cache/teammedlemskap/team-navn` | lese team-navnene |
| `POST /api/skjemaer/…/beslutning` | fullføre steg på **andre** skjemaer med `Flyt_url` |
| `POST /api/hendelser/logg` | skrive i revisjonssporet |

Utsendingsraden er tyngst: den utsteder lenker som gir tilgang uten
Entra-pålogging. Teamcache-raden er nest tyngst: den endrer grunnlaget for
tilgangssjekken.

Kretsen som holder nøkkelen er altså større enn kretsen som forvalter
systemet.

**To veier å snevre det inn**, begge skissert og ingen gjennomført:

* En egen `STEG_CALLBACK_KEY` som bare `/beslutning` godtar. Enkleste
  inngrep, dekker det meste.
* Bind callbacken til steget: et HMAC-signert engangstoken i `callbackUrl`,
  samme mekanisme som `lib/utsending-token.js` alt bruker. Strammere, og
  fjerner behovet for at skjemaeier håndterer en delt hemmelighet i det hele
  tatt.

Begge krever at eksisterende stegflyter legges om samtidig, og en
flytendring er dyr: utrulling av en flyt er en fire-stegs prosess på tvers av
tenanter (`docs/FLYT-DEPLOY.md`).

---

## 10. Kjente begrensninger

Samlet, og ment å være fullstendig. Rekkefølgen er etter hvor alvorlig vi selv
vurderer dem.

### Drift

1. **Prod-backup er ikke satt opp.** Backup kjøres manuelt fra pilot.
   App-registreringen for SharePoint-opplasting i prod er under avklaring med
   Cyberforsvarets Azure-administratorer. Inntil den er på plass, finnes det
   ingen automatisk, verifisert backup av produksjonsdata.
2. **Hemmelighetene står i klartekst i SWA Configuration** (7.2). Det er et
   plattformvalg, ikke vårt, men konsekvensen er vår. Det finnes en vei ut
   som ikke krever at plattformen endrer seg — en egen Function App lenket
   til SWA-en støtter både managed identity og Key Vault-referanser. Vurdert
   i `docs/BESLUTNING-EGEN-FUNCTION-APP.md`. **Steg 1 og 2 er verifisert
   14.10.2026: `x-ms-client-principal` følger med gjennom proxyen, så
   tilgangsmodellen overlever flyttingen — og en Function App løser
   `@Microsoft.KeyVault(...)` i app settings, så klarteksten kan bort.**
   Fortsatt ikke besluttet.
3. **Deploy skjer med et SWA deployment token** i GitHub-secret
   `AZURE_STATIC_WEB_APPS_API_TOKEN`. Målet er OIDC federated credential med
   `Contributor` bare på SWA-ressursen. Ikke gjennomført.

### Datasikring

4. **`Krypteres: "Svar"` lar behandlingshistorikk, dialog, status og
   spørsmålstekster stå i klartekst** (6.2). For en skjematype der spørsmålet
   er sensitivt, er `Svar` ikke nok.
5. **Krypteringsnøklene ligger i samme storage-konto som dataene** (6.2).
   Kontostrengen gir begge.
6. **Kryptering som feiler, blokkerer ikke lagring.** Skjemaet lagres i
   klartekst, og det logges. «Kryptert» må verifiseres, ikke antas.
7. **Anonymisering er pseudonymisering** (6.1), og `HASH_SALT` er det eneste
   som skiller pseudonymet fra en utregnelig hash. **Mangler `HASH_SALT`,
   hashes adressen usaltet** — `pseudonymFor` faller tilbake til bare
   adressen i stedet for å feile, og utslaget er et pseudonym hvem som helst
   kan regne ut fra en e-postliste. Ingenting varsler om det.
8. **Arkiv-JSON er klartekst** (9.2).
9. **`dekrypterFulltSvar` kaster ikke på feil nøkkel.** Den lar ciphertext
   stå i feltene, men sletter likevel `Kryptert`-flagget — så skjemaet kommer
   ut og *ser* dekryptert ut, med `fa04…:d2c9…:q8Hq…` i hver celle.
   `kryptering.dekrypterAlle` logger nå tilfellet via `serKryptertUt()`, men
   selve oppførselen er ikke rettet. Funnet 12.10.2026.
10. **Rekryptering ved nøkkelbytte hopper over skjemaer som feiler**, og
    skriver den nye nøkkelen likevel. De skjemaene kan ikke lenger leses.
    Ta backup før nøkkelbytte.

### Applikasjon

11. **XSS-gjennomgangen er gjort, men `script-src` har fortsatt
    `'unsafe-inline'`** (6.4). Gjennomgangen 13.10.2026 leste alle 301
    HTML-sinker i frontend. Den fant og rettet:

    * **Et hull i escapingen av verdier som går inn i en `onclick`.**
      Funksjonen escapet `'` men ikke `\`, så `\');angrep();//` brøt ut av
      JS-strengen og kjørte. Åtte filer hadde hver sin kopi av funksjonen
      under fire ulike navn, og kopiene svarte ikke likt. Det er nå én
      funksjon (`frontend/js/escape.js`), og `escaping.test.js` kjører det
      gamle angrepet mot både den gamle og den nye for å vise forskjellen.
    * **Seks verdier fra skjematype-definisjonen som gikk uescapet til HTML**
      — blant dem `steg.Steg`, som en skjemaeier setter og som rendres hos
      hver som åpner registeret eller evalueringen.
    * **To verdier fra Bring-registeret** i postnummer-nedtrekket.

    Det som står igjen: `'unsafe-inline'` i `script-src`, fordi sidene har
    275 inline event-handlere og hverken nonce eller hash dekker dem. En
    injeksjon som slipper gjennom escapingen kan derfor fortsatt kjøre kode,
    men ikke laste den utenfra og ikke sende noe ut (`connect-src 'self'`).
    Å fjerne `'unsafe-inline'` krever at alle 13 sidene legges om fra
    `onclick`-attributter til `addEventListener`, og det bør være en egen,
    avtalt runde.

    `scripts/html-injeksjon.js` holder gjennomgangen ved like: hver uescapet
    verdi må enten escapes eller stå på en erklært liste med begrunnelse, og
    testen feiler på den første som ikke gjør det.
12. **Siste skriving vinner.** Skriving til Table Storage skjer uten
    samtidighetskontroll; verken `lagreSkjematype` (`Replace`) eller
    `lagreSkjema` (`Merge`) sjekker ETag. To som lagrer samme rad etter
    hverandre gir at den siste overskriver den første, uten at noen får vite
    det. Observert 06.10.2026: en eier hadde samme skjematype åpen i to
    faner, rettet i den ene, og lagret den urettede tilbake fra den andre.
    Rettelsen var borte, og grensesnittet sa ingenting.
    `lagreBeslutning` leser hele skjemaet, endrer og skriver tilbake — to
    behandlere som avgjør samtidig på et «alle må avgjøre»-steg kan i
    prinsippet miste den ene beslutningen. Vinduet er smalt og det er ikke
    observert, men mekanismen er den samme og konsekvensen større.
    Rettelsen er optimistisk samtidighetskontroll med ETag, samme mønster som
    `lib/skjema-id.js` alt bruker. Bevisst utsatt 06.10.2026.
13. **`FLOW_CALLBACK_KEY` er én verdi for fem inngangspunkter** (9.3).
14. **Utsendingslenker varer 90 dager** og gir tilgang uten pålogging (4.3).
15. **Skjematolken sender filen ut av løsningen** (kapittel 3). Et utfylt
    papirskjema som lastes opp for analyse, sendes til Anthropics API. Vakten
    er admin eller Skjemaskaper, men ingenting i løsningen hindrer eller
    advarer mot at filen inneholder personopplysninger.
16. **`/migrer.html` har en ruteregel, men fila finnes ikke.** Død
    konfigurasjon, ikke et hull — men den slags rest er verdt å rydde, og
    `swa-config.test.js` sjekker i dag bare at `rewrite`-mål finnes, ikke at
    `route`-mål gjør det.

### Forutsetninger vi ikke selv har verifisert

Disse er riktige så langt vi vet, og de bærer hele tilgangsmodellen. Vi ber om
at de testes framfor å tas på ord.

17. **At SWA fjerner en innkommende `x-ms-client-principal` fra klienten** og
    setter sin egen. Appen stoler fullt på headeren (4.1). Går den gjennom
    fra en klient, er hele autentiseringen omgått.
18. **At de elleve HTML-sidene uten ruteregel ikke inneholder data** (5.4). De er
    ment å være tomme skall. Ingen test håndhever det.
19. **At Power Automate-flytene ikke lekker hemmeligheter videre.** De er
    utenfor dette dokumentet (kapittel 1), men de får sendt skjemadata og
    e-postadresser.

---

## 11. Hva som holder dokumentet sant

Erfaringen i dette prosjektet er at den vanligste feilen ikke er en manglende
kontroll, men **samme regel i to eksemplarer som svarer ulikt**. Det har
skjedd med datakildene (editor mot API), `handling`-verdiene (kode mot
dokumentasjon), env-inventaret (tre lister, alle uenige), cron-tidene (tre
kopier), og med Key Vault-rådet (tre dokumenter). Alle ble funnet først da
noen skrev en test som leste begge kildene.

Et dokument som beskriver systemet, er en ny kopi av den samme regelen.
Derfor:

| Hva | Hvordan det holdes sant |
|---|---|
| Nøkkeltallsblokka i 5.2 og hele `docs/API-OVERSIKT.md` | Generert av `scripts/api-oversikt.js --skriv`. `api/test/api-oversikt.test.js` feiler hvis filene er utdaterte |
| «Ingen anonym, ubevoktet og uerklært rute» | Samme test, i begge miljøer |
| «Hvert endepunkt har en vakt i handleren, eller står på den erklærte unntakslista» | Samme test |
| Pilot og prod har samme api-ruteregler, i samme rekkefølge | Samme test |
| Env-inventaret | `api/test/env-inventar.test.js` |
| `handling`-verdiene mot `docs/FLYTER.md` | `api/test/flyt-handlinger.test.js` |
| Datakildene i editoren mot dispatcheren | `api/test/datakilder-paritet.test.js` |
| Gyldig SWA-config, tenant-låst issuer, ingen jokertegn inni ruter | `api/test/swa-config.test.js` |

Testsuiten er over hundre filer og kjøres av `npm test` fra `api/`. Deploy
kjører den først og stopper på rødt.

Det som **ikke** er dekket av en test, er kapittel 6, 7, 8 og 10 i dette
dokumentet. De er skrevet for hånd og kan drifte. Datoen øverst er derfor en
del av innholdet.

---

## 12. Videre lesning

| Tema | Fil |
|---|---|
| Fullstendig endepunktsoversikt (generert) | `docs/API-OVERSIKT.md` |
| Escaping, og hullet som ble tettet | `frontend/js/escape.js` |
| Gjennomgangen av HTML-sinker | `scripts/html-injeksjon.js` |
| Arkitektur i detalj, ytelsesvalg | `docs/ARCHITECTURE.md` |
| Repo- og pipelinesikkerhet, nøkkelkalender | `docs/SECURITY.md` |
| Datamodell, tabeller og felter | `docs/DATA-MODELL.md` |
| Kryptering og anonymisering i detalj | `docs/FASE-KRYPTERING.md` |
| Backup, gjenoppretting, prod-sjekkliste | `docs/BACKUP-SHAREPOINT.md` |
| Hemmeligheter, vaultnavn, rotasjon | `config/keyvault-secrets.md` |
| Flytkontrakter og `handling`-verdier | `docs/FLYTER.md` |
| Utrulling av en flyt på tvers av tenanter | `docs/FLYT-DEPLOY.md` |
| Logging og hva som er verdt å kjenne igjen | `docs/LOGGING.md` |
| Power BI-feeden | `docs/POWER-BI.md` |
| Forslag: egen Function App i stedet for managed functions | `docs/BESLUTNING-EGEN-FUNCTION-APP.md` |
| Plan for resten av dokumentasjonen | `docs/DOKUMENTASJONSPLAN.md` |
