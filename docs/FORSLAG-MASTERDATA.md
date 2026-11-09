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

## Det som må besluttes

1. **Feltene fra HR.** Hvilke felt trenger Skjema, og til hva? Lista blir
   kontrakten, og den avgjør hva vi behandler.
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

---

## Ikke med

* Skriving tilbake til kildesystemene. Masterdata leses her, og endres der de
  eies.
* Historikk over masterdata. Et svar fryser verdien det ble sendt inn med
  (som oppslagslistene). Det er nok til å forklare et gammelt skjema.
