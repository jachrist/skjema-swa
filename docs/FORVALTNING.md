# Forvaltning

Inngangen for den som har ansvaret for løsningen i drift.

> **Status: forslag til innhold.** Dette dokumentet er skrevet som et skjelett
> med vilje. Hvert kapittel sier hva det skal inneholde, hva som finnes i dag
> og hvor, og hva som mangler. Det som kunne fylles ut fra koden og
> workflow-filene, er fylt ut. Det som krever en beslutning eller en
> prøvekjøring, står merket.
>
> Ved godkjenning fylles kapitlene ut ett for ett, i rekkefølgen under.
> Markeringene betyr: ✅ finnes og er dekkende · ⚠️ finnes, men spredt eller
> ufullstendig · ✗ mangler.

## 0. Hvem dette er skrevet for

Tre roller, som i dag ofte er samme person, men som har ulike oppgaver:

| Rolle | Ansvar | Trenger |
|---|---|---|
| **Forvalter** | At løsningen virker i morgen også | Dette dokumentet |
| **Skjemaeier** | Innholdet i sine egne skjematyper | Runde 3 i dokumentasjonsplanen |
| **Systemansvarlig / drift** | Azure-ressursene, tilganger, abonnementet | Kokeboka + kapittel 6 og 11 her |

Skillet betyr noe for overlevering: en ny forvalter trenger ikke å kunne sette
opp et miljø fra ingenting, men må vite hva som skjer hver natt og hva som
gjøres når det ikke skjedde.

---

## 1. Hva forvaltning av denne løsningen består i ⚠️

En kort, ærlig beskrivelse av arbeidsmengden: hva som går av seg selv, hva som
krever et menneske, og hvor ofte.

Det som går av seg selv: åtte planlagte jobber (kapittel 3), backup hver natt,
og team-synk mot Entra. Det som krever et menneske: utrulling, hemmeligheter
som utløper, nye skjematyper i produksjon, roller som skal oppdateres fra FS,
og alt som har med flytene i Power Automate å gjøre.

**Finnes i dag:** spredt i `STATUS-OKT-2026.md` og i jobbkommentarene i
`api/src/lib/jobber.js`.
**Mangler:** en samlet beskrivelse med tidsbruk.

---

## 2. Årshjul og faste oppgaver ✗

Det kapittelet en ny forvalter leser først. Forslag til innhold:

| Når | Oppgave | Hvorfor |
|---|---|---|
| Daglig | Se at nattens jobber gikk | Åtte jobber, og en stille feil ser ut som «ingen endringer» |
| Daglig | Nøkkelvarsler i innboksen | `sjekk-nokler` varsler 30/14/7/3/1 dager før utløp |
| Ukentlig | Se at full backup søndag natt gikk, og at fila er i SharePoint | En backup som ikke ble lastet opp, finnes ikke |
| Månedlig | Gå gjennom oppgavelista i Administrasjon → Oppgaver | Teknisk gjeld og brukerønsker samme sted |
| Per semester | FS-roller oppdatert etter opptak og klasseendringer | Rollene vedlikeholdes manuelt eller ved import (punkt 89) |
| Per semester | Tilgjengelighetsperioder på sesongskjemaer | Evalueringsskjemaer åpnes og stenges per termin |
| Årlig | Rotasjon av hemmeligheter som utløper | Se nøkkelkalenderen |
| Årlig | Gjennomgang av admin-UPN-er og roller | Folk bytter stilling |
| Ved behov | Gjenopprettingsprøve | Se kapittel 7 — **ikke gjennomført** |

**Mangler:** hele kapittelet, og en avgjørelse på hvem som eier hver linje.

---

## 3. De åtte planlagte jobbene ⚠️

Hva de gjør, når de kjører, hvordan man ser at de gikk, og hva man gjør når de
feilet. Tidspunktene er lest ut av workflow-filene:

| Jobb | Når (UTC) | Gjør |
|---|---|---|
| `refresh-fs` | 04:00 daglig | Henter emner, studenter, klasser og filterdata fra FS |
| `team-synk` | 04:30 daglig | Synkroniserer teammedlemskap fra Entra |
| `refresh-postnumre` | 04:30 den 15. i jan og jul | Postnummerregisteret fra Bring |
| `send-utsendinger` | 05:00 daglig | Sender planlagte masseutsendinger |
| `refresh-oppslagsliste` | 05:30 daglig | Oppdaterer oppslagslister fra SharePoint |
| `purre-utsendinger` | 06:00 daglig | Purrer på ubesvarte utsendinger |
| `sjekk-nokler` | 07:00 daglig | Varsler om hemmeligheter som nærmer seg utløp |
| `backup` | 02:00 — full søndag, delta mandag–lørdag | Krypterte sikkerhetskopier |

To ting som må stå i dette kapittelet, fordi de har kostet tid:

* **GitHub-cron er ikke punktlig.** Målt over åtte kjøringer ligger den 4–7
  timer etter oppgitt tidspunkt, hver dag. En jobb som «ikke har kjørt» klokka
  07 kan være helt normal. Timer-triggere i en Function App fyrer på sekundet,
  og dev kjører én av jobbene slik.
* **Hvor man ser at jobben gikk:** Administrasjon → Jobber, som leser
  statusradene jobbene selv skriver. Bokføringen ligger i jobb-libene, slik at
  både HTTP-veien og timeren skriver samme rad.

**Finnes i dag:** kommentarene i hver workflow-fil, og `jobber.js`.
**Mangler:** feilsøkingsdelen — hva man faktisk gjør når `refresh-fs` har stått
i tre dager.

---

## 4. Hemmeligheter og nøkler som utløper ✅ (mekanisme) / ⚠️ (rutine)

Mekanismen finnes og virker: **nøkkelkalenderen** i Administrasjon svarer på
fire spørsmål per hemmelighet — når den utløper, hvor den ligger, hva som skjer
når den ryker, og hvordan den fornyes. `sjekk-nokler` varsler 30, 14, 7, 3 og 1
dag før, ett varsel per trinn.

Det som må skrives:

* **Hvilke hemmeligheter som finnes per miljø**, og hvilken av dem som tar ned
  hva. En utløpt auth-sertifikat stopper all innlogging; en utløpt
  `SCHEDULER_KEY` stopper de åtte jobbene men ikke appen; en utløpt
  deployment token stopper bare utrulling.
* **At utløpsdatoene føres manuelt.** Koden kan ikke spørre Key Vault — SWA
  Managed Functions har ingen managed identity. Unntaket er SAS-strenger, som
  bærer utløpet i seg selv (`se=`) og derfor aldri kan komme ut av takt.
  **En rad som ikke er ført, varsles det ikke om.**
* Rotasjonsoppskrift per type, med `config/keyvault-secrets.md` som kilde.

---

## 5. Tilgangsstyring i drift ⚠️

Hvem som har tilgang til hva, og hvordan det endres. Fire mekanismer som
virker sammen:

1. **Entra-innlogging** på SWA-en — porten.
2. **`ADMIN_UPNS`** — administratorer, som app setting, ikke som rolle i Entra.
3. **Roller og omfang** (`Rolle(Omfang)`) — behandlere og aktører per
   skjematype og per behandlingssteg.
4. **Team** — dynamiske Entra-grupper, synkronisert nattlig, brukt som
   publikum.

**Finnes i dag:** tilgangsmodellen er beskrevet i
`SIKKERHET-OG-ARKITEKTUR.md` for en evaluator.
**Mangler:** den operative varianten — «slik gir du Kari tilgang til å behandle
søknader for Cyberingeniørutdanningen», og hvordan man ser hvem som har noe i
dag.

---

## 6. Miljøene, utrulling og godkjenning ✅

Tre miljøer, med ulik vert for API-et og ulik utrullingsvei:

| Miljø | API-vert | Utrulling |
|---|---|---|
| **dev** | Frittstående Function App | Manuelt, to jobber (frontend og API hver for seg) |
| **pilot** | SWA Managed Functions | GitHub Actions |
| **prod** | SWA Managed Functions | GitHub Actions, krever Environment approval |

To ting som hører i et forvaltningsdokument og som har kostet tid:

* **To jobber betyr to commit-SHA-er.** `/api/ping` og `/js/config.js` bærer
  hver sin. Avviker de, henger én av dem.
* **En vellykket deploy-jobb er ikke bevis på at koden er ute.** Kjøring #45
  meldte suksess 12.10.2026 uten å landet. Verifiseringssteget som leser
  `/api/ping` og sammenligner med `github.sha`, kom nettopp av det.

**Finnes i dag:** `DEPLOY.md` og `KOKEBOK-PROD-V3.md` dekker dette godt.

---

## 7. Backup og gjenoppretting ⚠️

Mekanismen finnes: krypterte `.fsbk`-filer, full backup søndag natt og delta
de øvrige nettene, lastet opp til SharePoint. Gjenoppretting er implementert i
`lib/restore.js` og er destruktiv og idempotent.

> **To kilder som ikke er enige, og det må avklares før kapittelet skrives.**
> `.github/workflows/backup.yml` kjører en matrise over **pilot og prod**.
> Prod-beinet hopper stille over seg selv — med en `::notice::`, ikke en feil —
> hvis `SWA_URL_PROD` eller `SCHEDULER_KEY_PROD` mangler. Kapittel 10 i
> `SIKKERHET-OG-ARKITEKTUR.md` sier samtidig at «prod-backup er ikke satt opp;
> backup kjøres manuelt fra pilot».
>
> Én av de to er utdatert, og fra repoet alene er det ikke mulig å se hvilken:
> svaret ligger i GitHub-variablene for miljøet. Dette er nøyaktig
> tosannhets-risikoen dokumentasjonsplanen advarer mot, og den gjelder den ene
> mekanismen man oppdager er ute av drift først når man trenger den.
> **Sjekk hvilken som stemmer, rett den andre, og la en test eie koblingen.**

**Det som må stå tydelig, og som er ubehagelig:**

* **Gjenoppretting er ikke prøvd ende til ende i noe miljø.** Koden finnes,
  den er enhetstestet (`backup-delta`, `backup-strom`, `backup-verifiser`), og
  formatet er verifisert — men det finnes ingen `restore`-test og ingen
  dokumentert prøvekjøring i repoet. Til det er gjort, er «vi har backup» en
  påstand om filer, ikke om gjenoppretting.
* **Hva en gjenoppretting krever:** `BACKUP_PASSPHRASE` fra det miljøet
  backupen ble tatt i. Uten passfrasen er fila støy.
* **Delvis feilet restore etterlater systemet inkonsistent** og må kjøres på
  nytt.
* Arkiv-JSON-en skrives **dekryptert** og inneholder personopplysninger i
  klartekst. Hvor den havner, er en vurdering hver gang.

**Mangler:** en prøvekjøring med dato, og en oppskrift skrevet etter at den er
gjort — ikke før.

---

## 8. Feilsøking: symptom → hvor man ser ⚠️

Tabellform, ordnet etter hva brukeren rapporterer. Utgangspunkt:

| Symptom | Se først | Vanlig årsak |
|---|---|---|
| «Jeg kommer ikke inn» | `/api/whoami` | Mangler rolle, eller auth-sertifikatet er utløpt |
| «Skjemaet mitt er ikke der» | Tilgjengelighetsperiode og publikum | Stengt skjema, eller team-synk som ikke gikk |
| «FS-data er gamle» | Administrasjon → Jobber, `refresh-fs` | Jobben feilet, eller FS svarte tomt |
| «Behandleren fikk ingen e-post» | Administrasjon → Jobber, og flytens historikk | En 401 fra en flyt lager **ingen** kjøring i historikken — tom historikk betyr ikke at kallet uteble |
| «Rettelsen min er ikke ute» | `/api/ping` og `/js/config.js` | Deploy som meldte suksess uten å landet |

**Finnes i dag:** `LOGGING.md` og diagnoseendepunktene.
**Mangler:** selve tabellen, og en liste over hvilke diagnoseendepunkter som
finnes og hva de svarer.

---

## 9. Integrasjonene og hvem som eier dem ⚠️

For hver integrasjon: hva den gjør, hvem som eier den, hva som skjer når den
er nede, og hvem man ringer.

| Integrasjon | Eier | Når den er nede |
|---|---|---|
| **FS** (emner, studenter, klasser) | FS-forvalter hos FHS | Gamle data vises, ingen feil i grensesnittet |
| **Power Automate-flytene** | Power Platform-miljøadministrator | E-post, Teams-varsler og SharePoint-skriving stopper |
| **Servicebrukeren** som eier connectorene | Teameier | Alle flyter som bruker connectoren stopper |
| **SharePoint** (backup, oppslagslister) | Områdeeier | Backup lastes ikke opp; oppslagslister blir gamle |
| **Power BI** | Rapporteier | Rapportene viser gamle tall |

**Det viktigste å skrive ned:** at flytene eies utenfor dette repoet. En
flytendring er ikke en kodeendring, går ikke gjennom deploy, og kan ikke rulles
tilbake av oss.

---

## 10. Endringshåndtering ⚠️

Hva man må vite før man endrer noe i produksjon.

Det ene som må stå øverst, fordi det er stille og uopprettelig:
**feltnummer tildeles etter posisjon.** Slettes eller flyttes et felt i en
skjematype som alt har innsendte svar, forskyves svarene i de gamle skjemaene
— de havner under nabospørsmålet, og det ser riktig ut. Nye skjemaer bærer
feltets Id og tåler flyttingen; eldre gjør det ikke. Editoren advarer, og
advarselen må forstås.

**Mangler:** resten av kapittelet — faser (Utkast/Produksjon), hvordan en
skjematype flyttes mellom miljøer, og hva som skjer med skjemaer under
behandling når typen endres.

---

## 11. Beredskap: hva ryker, og hva virker da ikke ✗

Et kapittel som kan leses under press. For hver komponent: hva som slutter å
virke, hva som fortsatt virker, og hva som er første handling.

Forslag til rader: lagringskontoen, Key Vault, SWA-en, Function App-en (dev),
auth-app-registreringen, flytene, servicebrukeren, FS, abonnementet.

**Mangler:** hele kapittelet. Det bør skrives etter gjenopprettingsprøven i
kapittel 7, ikke før — ellers beskriver det en reserveløsning ingen har prøvd.

---

## 12. Overlevering: dag én for en ny forvalter ✗

Sjekklista for den som overtar: hvilke tilganger som må være på plass, hvilke
fem dokumenter som skal leses i hvilken rekkefølge, hvilke varsler som skal
komme i innboksen, og de tre tingene som er ikke-åpenbare og koster en dag
hver.

**Mangler:** hele kapittelet. Det skrives sist, fordi det er et sammendrag av
de elleve over.

---

## Rekkefølge, hvis dette godkjennes

1. Kapittel 2 (årshjul) og 3 (jobbene) — det en forvalter trenger i morgen.
2. Kapittel 8 (feilsøking) — mest spart tid per side.
3. Kapittel 4 og 5 (hemmeligheter, tilgang i drift) — der feilene blir dyre.
4. Gjenopprettingsprøven, og deretter kapittel 7 og 11.
5. Kapittel 10 og 12.

Kapittel 6 er dekket av `DEPLOY.md` og kokeboka, og bør **lenke** dit framfor
å gjenta dem. To beskrivelser av samme utrulling svarer ulikt innen et kvartal.
