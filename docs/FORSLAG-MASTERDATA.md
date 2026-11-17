# Forslag: én standard for masterdata

**Status: forslag.** Ingenting er besluttet, og ingen kode er endret.
Skrevet 09.11.2026, da FHS fikk tilgang til organisasjonsdata for ansatte og
studenter fra HR-systemet. Notatet bygger videre på `VURDERING-ROLLER.md`
(masterdata som egen klasse, og et JSON-felt med punktnotasjon) og
`FORSLAG-ROLLER-FRA-FS.md`.

Les «Slik er det i dag» først. Den er lest ut av koden, og den forklarer
hvorfor HR-dataene ikke bør bli kilde nummer fire på samme måte som de tre
første.

---

## Hva masterdata er her

Data som eies av et annet system, kopieres hit med en planlagt jobb, og
brukes av skjemaer uten at skjemaskaperen vedlikeholder dem selv:

| Kilde | Eier | Innhold |
|---|---|---|
| **HR** (kommer) | HR-systemet, via API | ansatte, studenter, organisasjonsenheter |
| **FS** | Felles studentsystem | emner, studenter, klasser, kull, studieprogrammer, lærere |
| **Postnummer** | Bring | postnummer, poststed, kommune |

Team, roller og oppslagslister (svar fra innsendte skjemaer) brukes på samme
måte i skjemaene, men eies av oss. De tas med i standarden for **tilgang**,
men er ikke masterdata i betydningen over.

---

## Slik er det i dag

### Hver kilde har sin egen vei inn

| | FS | Postnummer | Team |
|---|---|---|---|
| Henting | `fs-client.js`, `refresh-fs-jobb.js` | `bring-postnummer.js`, `postnummer-jobb.js` | flyt via Graph, `team-synk-jobb.js` |
| Lagring | `Emner`, `EmneStudenter`, `FilterStudent`, `CacheMetadata` | `Postnumre` | `Teammedlemskap` |
| Status | `/api/refresh-fs/status` | `/api/postnumre/status` | `/api/team-synk` (GET) |

Jobbene bokføres likt (`lib/jobber.js`), men utover det er hver kilde skrevet
for seg.

### Og sju veier ut

Det er her standarden mangler mest. Samme data leses på sju forskjellige
måter:

| # | Vei | Hvor | Hva den kan |
|---|---|---|---|
| 1 | **FasteData** — nedtrekk på et felt | `lib/faste-data.js` → `lib/oppslag.js` (`switch` med elleve kilder) | Tekst + Verdi, filtre per kilde |
| 2 | **Dynamisk nedtrekk** når et annet felt endres | `POST /api/oppslag` | Samme som 1, med feltverdier |
| 3 | **Egen felttype** | `Postnummer`, med `/api/postnumre/sok` | Søk, validering, poststed |
| 4 | **Forhåndsutfylling** i utsendinger | `lib/utsending-prefill.js`, `OPPSLAGSTYPER = ['emnebeskrivelse']` | Én hardkodet oppslagstype |
| 5 | **Dynamisk rolleomfang** | `lib/omfang.js`, `{2-01}` i behandlingssteg | Klassenavn ↔ klassekode ↔ FS-nøkkel |
| 6 | **Person fra et felt** | `lib/feltperson.js` | Kilder der Verdi er en UPN |
| 7 | **Katalogen i editoren** | `DATAKILDER` i `frontend/editor.html` | Navn, beskrivelse, filtre — en kopi av backend, holdt lik av `datakilder-paritet.test.js` |

### Hva det koster

**En ny kilde må skrives fem steder.** En `case` i dispatcheren, en
oppføring i editorens katalog, filterlogikk i kildens egen funksjon, en jobb
og et statusendepunkt. HR-dataene ville blitt det samme en gang til.

**Filtrene er tekst som tolkes per kilde.** `Kolonne: "Emne"` betyr noe
bestemt i `_hentStudenter` og ingenting andre steder. Og dispatcheren får én
betingelse om gangen: `hentForOgGruppe` kaller oppslaget én gang per
betingelse i en OG-gruppe og snitter på `Verdi`. En kilde som trenger to
filtre samtidig, får dem i to kall og gir et tomt snitt uten feilmelding
(«En felle i filtermekanismen» i `OPPSLAGSLISTER.md`).

**En post har ingen felter, bare Tekst og Verdi.** Et skjema kan velge en
student, men ikke vise studentens klasse ved siden av. Det er derfor
utsendinger har én hardkodet oppslagstype (`emnebeskrivelse`), og derfor
punktnotasjonen fra `VURDERING-ROLLER.md` ikke har noe å slå opp i.

**Tilgangen er ikke definert per kilde.** Den følger av hvilken rute som
løser oppslaget, og rutene er ulike:

> **Funn 09.11.2026:** `GET /api/publikum-skjematype/{id}` er anonym, og løser
> FasteData uten bruker (`hentOgSettFasteData(..., null)` i
> `functions/skjematyper.js`). En skjematype med ekstern tilgang og et
> nedtrekk fra `Studenter` eller `Personer` gir dermed **navn og e-post for
> hele utvalget** til hvem som helst med lenka. Det er ikke en teoretisk
> sårbarhet, men slik koden virker i dag. Med HR-data blir det samme
> nedtrekket et personregister ut av huset. Se steg 0 under.

---

## Målbildet: én kildekontrakt, én lesevei

### 1. Hver kilde beskrives ett sted

En kilde er én modul i `api/src/lib/masterdata/` som oppfyller samme
kontrakt:

```js
module.exports = {
    navn: 'Ansatte',
    beskrivelse: 'Ansatte i FHS, fra HR-systemet',
    eier: 'HR',

    // Feltene en post har. Alt som kan vises, filtreres på eller
    // refereres, står her — og ingenting annet lagres.
    felter: [
        { navn: 'upn',     type: 'epost', nokkel: true, persondata: true },
        { navn: 'navn',    type: 'tekst', persondata: true },
        { navn: 'enhet',   type: 'tekst' },
        { navn: 'stilling', type: 'tekst' }
    ],
    tekst: (p) => `${p.navn} (${p.enhet})`,   // det nedtrekket viser
    verdi: (p) => p.upn,                       // det som lagres i svaret

    // Hvem får lese — se 4.
    tilgang: { anonym: false, felter: { upn: 'innlogget', navn: 'innlogget' } },

    // Henting: en jobb som ERSTATTER hele datasettet.
    hent: async (log) => [ /* poster fra kildesystemet */ ],
    plan: { timer: '0 30 2 * * *', maksAlderTimer: 30 }
};
```

Det som i dag står fem steder, står ett sted. Editorens katalog hentes fra
`GET /api/masterdata/kilder`, som leser kontrakten. `DATAKILDER` i
`editor.html` og paritetstesten kan fjernes.

### 2. Én lesevei for alle sju bruksmåtene

```js
masterdata.finn('Ansatte', { OgAv: [{ felt: 'enhet', op: '=', verdi: 'ILS' }] }, { bruker })
```

* Hele OG-gruppen sendes i **ett** kall. Snittfella forsvinner, fordi kilden
  ser alle betingelsene samtidig.
* Filtrene er feltene i kontrakten. Det trengs ingen tolkning per kilde.
* `bruker` følger alltid med, og tilgangen avgjøres her, ikke i ruten (se 4).

FasteData, `/api/oppslag`, forhåndsutfylling, rolleomfang, person fra felt og
postnummersøket blir tynne lag over `finn`. Postnummer beholder felttypen sin;
det er visningen, ikke kilden.

### 3. Referanser til felt: punktnotasjon

Når en post har felter, kan et skjema referere dem:

| Hvor | Eksempel | Erstatter |
|---|---|---|
| Informasjonsfelt | `{2-01}.enhet` — enheten til personen valgt i 2-01 | ingenting i dag |
| Forhåndsutfylling | `{ "Emner": "26H\|CBU1503-1", "felt": "beskrivelse" }` | den hardkodede `emnebeskrivelse` |
| Rolleomfang | `Klassesjef({2-01}.klasse)` | aliasene i `omfang.js` |

Dette er punktnotasjonen fra `VURDERING-ROLLER.md`, men på kilden i stedet
for på rollen. Det er samme behov, og et bedre sted for det: det er HR og FS
som eier feltene, ikke rollemodellen.

### 4. Tilgang og persondata per kilde og per felt

Med HR-data er dette den viktigste delen. Reglene bor i kontrakten, og `finn`
håndhever dem:

* **Anonym tilgang er av som standard.** En kilde med persondata gir ingen
  poster til en anonym forespørsel, uansett rute. Funnet over blir da umulig
  for alle kilder, ikke bare rettet for to.
* **Felt med `persondata: true`** følger bare med når brukeren har lov. Ellers
  kommer posten uten feltet, eller ikke i det hele tatt hvis feltet er
  nøkkelen.
* **Dataminimering ved import:** jobben lagrer bare feltene i kontrakten. Det
  HR-API-et leverer i tillegg, kastes før det skrives. Kontrakten er da også
  dokumentasjonen av hvilke opplysninger vi behandler.
* **Logging:** antall, tid og status. Aldri innholdet.

### 5. Lagring og drift likt for alle

* **Full erstatning, og sletting som del av jobben.** Poster som ikke lenger
  finnes i kilden, slettes ved neste kjøring. Det er sletteplikten for
  persondata. FS gjør dette allerede: nye rader skrives først, og det gamle
  ryddes etterpå, så cachen aldri står tom («Retention» i
  `FASE-5B-FS-INTEGRASJON.md`). Det mønsteret blir standarden, ikke noe hver
  kilde finner opp selv.
* **Én statusside** under Administrasjon: kilde, sist oppdatert, antall
  poster, alder, siste feil. `maksAlderTimer` gir advarsel når en kilde er
  gammel. Nøkkelkalenderen tar legitimasjonen til kildesystemet, som i dag.
* **Aldri live-oppslag mot kildesystemet.** Skjemaene leser kopien. Er
  HR-API-et nede, virker skjemaene med gårsdagens data, og kildesystemet ser
  én henting i døgnet, ikke ett kall per skjema som åpnes.

### 6. Fysisk lagring: én tabell, kilden som partisjon

Lagt til 17.11.2026. Kontrakten og leseveien over sier ikke hvor postene
ligger. Forslaget er én tabell, `Masterdata`, for alle kilder:

| | Verdi | Eksempel |
|---|---|---|
| `PartitionKey` | kilden | `Ansatte`, `Enheter`, `Emner`, `Postnumre` |
| `RowKey` | postens nøkkel fra kontrakten | ansattnummer, `objid`, emnekode, postnummer |
| Egenskaper | bare feltene i kontrakten | lister, som `overordnedeOrgLedd`, lagres som JSON-tekst |
| `Generasjon` | ID-en til importen som skrev raden | brukes ved erstatning, se under |

Ansatte og enheter er to kilder, i hver sin partisjon, koblet med `objid`
slik HR-filene er.

**Hvorfor én tabell og ikke én per kilde:**

* **Én implementasjon av det kjedelige.** Skriving, sletting, status og alder
  skrives én gang. Med én tabell per kilde får hver kilde sin egen variant
  igjen, og det er det forslaget skal fjerne.
* **Erstatning per partisjon.** Jobben skriver alle radene med ny
  `Generasjon`, og sletter så radene med gammel. Cachen står aldri tom
  underveis. Det er FS-mønsteret, gjort felles.
* **Små mengder.** 2300 personer og 190 enheter. `finn` leser hele
  partisjonen og holder den i minnet i noen minutter, og filtrerer i koden.
  Table Storage filtrerer bare effektivt på nøklene, og det trengs ikke her.

**Det man må vite:**

* **Lagringen er ikke tilgangsgrensen.** All kode bruker samme lagringskonto,
  så persondata i en egen tabell gir ingen ekstra beskyttelse. Beskyttelsen er
  `finn` og kontrakten (punkt 4). Blir fødselsnummer godkjent (spørsmål 10),
  krypteres det på feltnivå.
* **Grensene i Table Storage:** 252 egenskaper og 1 MB per rad. HR-postene
  har rundt 20 felt etter klassifiseringen.
* **FS måles før flytting.** `EmneStudenter` (student × emne) er den eneste
  kilden som kan bli stor. Titusener av rader i én partisjon er greit, men
  tallet bør være kjent.

**Postnummer passer også**: ikke persondata, tydelig nøkkel, erstattes av en
jobb. Grunnen til å vente er bare at det virker i dag. Postnummer og FS flyttes
når de likevel endres (steg 6). HR starter rett i tabellen.

**Ikke masterdata, og blir der de er:** roller og oppslagslister er Skjemas
egne data, eid av skjemaeierne, ikke en kopi fra et kildesystem. Team hentes
fra Graph med egen cache (`docs/TEAM-CACHE-KONTRAKT.md`). Alle tre leses
gjennom `finn`, men lagres som i dag.

---

## Rekkefølge

Hvert steg kan merges for seg, og ingen eksisterende skjematype skal måtte
endres. Datakildenavnene i lagrede definisjoner (`Studenter`, `Emner`, …)
blir stående.

| Steg | Hva | Endrer for brukerne |
|---|---|---|
| **0** | **Stopp persondata på den anonyme ruten.** Kilder med persondata løses ikke i `/api/publikum-skjematype`. Kan gjøres i dag, uavhengig av resten | Eksterne ser ikke personnedtrekk — de har ikke sett noe de skulle ha sett |
| 1 | Kontrakten og `finn`. FS-, postnummer-, team-, rolle- og listekildene pakkes inn som de er, bak kontrakten | Ingenting |
| 2 | Editoren leser katalogen fra API-et. `DATAKILDER` fjernes | Ingenting |
| 3 | FasteData, `/api/oppslag`, forhåndsutfylling og person fra felt går via `finn`. Hele OG-gruppen i ett kall | Filtre som før ga tomt snitt, virker |
| 4 | **HR som første kilde skrevet rett mot kontrakten**, med feltklassifisering og sletting | Ansatte og enheter i nedtrekk |
| 5 | Punktnotasjon i informasjonsfelt og forhåndsutfylling | `{2-01}.enhet` |
| 6 | FS og postnummer flyttes til samme lagringsform når de likevel endres | Ingenting |

Steg 4 avhenger av svarene fra HR-leverandøren (autentisering, se dialogen om
endepunktene) og av feltlista. Steg 1–3 kan gjøres før det.

---

## HR-formatet

Lest 17.11.2026 fra to eksempelfiler, med `scripts/hr-skjema.js`. Ingen
verdier er delt, bare struktur og tellinger:

| Fil | Rader | Felt |
|---|---|---|
| Persondata (utdrag) | 9 av rundt 2300 | 96, av dem 4 nøstede lederobjekter |
| Strukturdata (`ORG_FHS_<dato>_<tid>.json`) | 190 | 36, av dem 4 adresselister og 4 lederobjekter |

Begge er JSON-lister, UTF-8, ett fullt uttrekk per fil. Feltnavnene (`objid`,
`otype`, `begda`, `endda`, `infotype…`) er SAP HCM sine.

### Slik henger filene sammen

- **Enheten:** `objid` er nøkkelen, unik i alle 190 radene. `kortBetegnelse`
  er **ikke** unik (155 distinkte), så den kan ikke brukes som nøkkel eller
  alene i et nedtrekk. `konkatenertNavnLang` er unik.
- **Hierarkiet:** `overordnedeOrgLedd` er lista over alle overordnede `objid`,
  så hele treet kan leses uten rekursjon. `enhet`, `dif` og `bra` sier hvilket
  nivå en rad er på, og `objidEnhet`, `objidDif` og `objidBra` peker oppover
  direkte.
- **Personen:** `ansattnummer` er unik i utdraget. Personen peker på
  strukturen med `objidAvdeling`, `objidEnhet`, `objidDif` og `objidBra`.
  `objidSko` og `objidStgr` peker på stillingskode og stillingsgruppe, ikke på
  en enhet.
- **Lederne:** `linjeLeder`, `autoriserendeLeder`, `avdSeksjonsLeder` og
  `sikkerhetsLeder` er `{ ansattnummer }`. De står både på personen og på
  enheten. Det svarer på spørsmål 3 under: HR **kan** være kilde til
  lederroller, og til «send til nærmeste leder» uten at skjemaeier vedlikeholder
  en rolle.
- **Navn på enheter:** personraden bærer også avdelings-, enhets- og
  bransjenavn (`avdelingLangBetegnelse` osv.). De leses ikke derfra. Navnet
  hentes fra strukturfila via `objid`, ellers har vi samme navn i to
  eksemplarer som kan bli ulike.

### Klassifisering

Svarene på spørsmål 6–9 kom 17.11.2026 og er innarbeidet her.

**Tas inn** (persondata, behandles etter spørsmål 2):

| Felt | Til |
|---|---|
| `ansattnummer` | Nøkkel, og kobling til lederne |
| `epostArbeid` | Kobling til innloggingen. Den er UPN-en, men Entra kan skrive domenet med store bokstaver (`MIL.NO`). Begge sider sammenlignes derfor med små bokstaver — samme regel som `hentInnloggetUpn` i `api/src/lib/auth.js` bruker, ikke en egen |
| `telefonMobil` | Tjenestetelefon, administrert av Forsvaret |
| `fornavn`, `etternavn`, `navn` | Visning |
| `tittelKort/LangBetegnelse`, `gradKort/LangBetegnelse`, `stillingKort/LangBetegnelse` | Visning, og filtre i nedtrekk |
| `objidAvdeling`, `objidEnhet`, `objidDif`, `objidBra` | Kobling til strukturen |
| `tjenestested`, `ansattMil`, `ansattSiv` | Filtre |
| `linjeLeder`, `autoriserendeLeder`, `avdSeksjonsLeder`, `sikkerhetsLeder` | Roller og ruting |
| `begda`, `endda` | Hvem som er aktiv |

**Skjerming skjer hos HR, ikke hos oss.** Skjermede personer overføres ikke,
og alle radene har `skjermet: false`. Feltet lagres ikke. Importen sjekker det
likevel som en del av kontrakten: har én rad `skjermet: true`, er
leveransen endret uten at vi er varslet, og hele fila avvises. Det er en
sjekk av avtalen, ikke en filtrering vi er avhengige av.

**Venter på avklaring** (spørsmål 10): `fnr`, `epostPrivat`, `telefonPrivat`.
Til den er gitt, kastes de.

**Kastes før lagring:**

| Felt | Hvorfor |
|---|---|
| `fnr`, `epostPrivat`, `telefonPrivat` | Til spørsmål 10 er besvart |
| `nasjonalitet`, `nasjonalitet2` | Ingen funksjon i Skjema |
| `dsf*` (folkeregisterstatus), `skjermet`, `anonymisert` | Ingen funksjon i Skjema. Skjermingen er gjort før overføringen |
| `mg*`, `mug*`, `po*`, `pdo*`, `tilsVilkar*`, `deltype*`, `infotype*`, `teknisk*`, `struktur*`, `ansattStatus*`, `auto*`, `otype*` | HR-interne koder |
| Enhetsnavn på personraden | Hentes fra strukturfila |

**Strukturdata** er ikke persondata, bortsett fra lederfeltene, som peker på
personer. Adressene er enhetenes, ikke personers. `stillinger` var tom i alle
radene.

### Mengde og oppdatering

2300 personer og 190 enheter er lite. Et fullt uttrekk i døgnet leses og
skrives på sekunder. Uttrekket er fullt, ikke endringer, så importen er:

1. les begge filene
2. valider mot kontrakten, og stopp hvis noe kreves og mangler
3. skriv det som er nytt eller endret
4. slett det som ikke lenger finnes

Sletting er et krav, ikke en opprydding: en person som har sluttet, skal ut av
nedtrekkene neste natt.

Fil eller REST endrer ikke dette, siden innholdet er det samme. REST er
enklest for oss: jobben henter selv, med identitet eller sertifikat. Med fil
trengs i tillegg en container med tilgangsstyring, der fila slettes etter
innlesing.

---

## Det som må besluttes

1. **Feltene fra HR.** Hvilke felt trenger Skjema, og til hva? Lista blir
   kontrakten, og den avgjør hva vi behandler.

   Feltene i eksempelfilene hentes ut med `scripts/hr-skjema.js`, uten at
   filene deles. Verktøyet skriver et JSON-skjema med feltnavn, typer og
   tellinger, men aldri en verdi. Felt som ser ut som fødselsnummer, navn,
   e-post eller telefon får `x-mistanke`, og felt der hver verdi er ulik får
   `unik: true`. Det er kandidatene til nøkler, og det som kobler person til
   enhet. Det kjører lokalt, uten nettverk og uten `npm install`, og nekter å
   lese en fil som ligger inni et git-repo:

   ```
   node scripts/hr-skjema.js C:\HR\person.csv --ut C:\HR\person.schema.json
   node scripts/hr-skjema.js C:\HR\struktur.json --ut C:\HR\struktur.schema.json
   ```

   Les skjemaet før det deles. Feltnavn kan i seg selv si noe, og
   `x-statistikk` sier hvor mange rader fila har.
2. **Hvem kan se persondata i et nedtrekk?** Forslaget: innloggede kan se navn
   og e-post, ingen anonyme. Flere felt (stilling, enhet for studenter) krever
   en beslutning per felt.
3. **Er HR kilden til roller?** Ansatte med enhet og stilling kan gi roller
   automatisk (`Leder(ILS)`), slik `FORSLAG-ROLLER-FRA-FS.md` foreslår for FS.
   Det henger sammen med klassifiseringen i `VURDERING-ROLLER.md`.
4. **Studenter fra HR eller FS?** Begge leverer studenter. Én av dem bør være
   kilden. Det ligger nærmest å la FS eie studentene og HR eie ansatte og
   enheter.
5. **Steg 0 nå, eller sammen med resten?** Det er en liten endring, og jeg vil
   anbefale å ta den nå.
6. ~~Er `epostArbeid` lik UPN-en?~~ **Ja** (17.11.2026), men domenet kan stå
   med store bokstaver i Entra. Sammenlignes med små bokstaver.
7. ~~Skjermede personer?~~ **Overføres ikke** (17.11.2026). `skjermet` er
   `false` på alle, og lagres ikke.
8. ~~Er `telefonMobil` jobbtelefonen?~~ **Ja**, administrert av Forsvaret
   (17.11.2026). Tas inn.
9. ~~Er `ansattnummer` unik?~~ **Ja**, på øverste nivå i personfila
   (17.11.2026). Inne i lederobjektene er det en referanse, og gjentar seg med
   vilje.
10. **Fødselsnummer, privat e-post og privat telefon.** FHS har som
    arbeidsgiver rett til å behandle dem, men det avgjør ikke om Skjema skal.
    Spørsmålet er hvilken funksjon i Skjema som trenger dem. Tas de inn,
    foreslås disse vilkårene:
    - **Bare om personen selv.** Feltet kan forhåndsutfylles i et skjema
      den innloggede sender om seg selv, men vises aldri i et nedtrekk, et
      oppslag eller et søk på andre.
    - **Kryptert ved lagring**, som skjemasvar i dag (`docs/FASE-KRYPTERING.md`).
    - **Ikke i logg eller hendelser**, heller ikke maskert.
    - **Et eget ja per felt.** Fødselsnummeret er den sterkeste
      identifikatoren vi ville hatt, og bør ikke følge med fordi de to andre
      gjør det.

---

## Ikke med

* Skriving tilbake til kildesystemene. Masterdata leses her, og endres der de
  eies.
* Historikk over masterdata. Et svar fryser verdien det ble sendt inn med
  (som oppslagslistene). Det er nok til å forklare et gammelt skjema.
