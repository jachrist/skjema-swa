# Diagnose av skjematyper

## Problemet

En skjematype kan lagres, se helt riktig ut, og likevel være ødelagt på en
måte som først viser seg ved første innsending — hos noen andre, i en flyt,
uten at skjemaeier får vite det. Et teamnavn med skrivefeil, en bucket som
ikke finnes, en rolle ingen er medlem av.

Kjøringen blir rød i Power Automate, og det er alt som skjer.

Feilene oppstår i **skjemaeditoren**, der noen skriver inn et navn. Derfor
hører tilbakemeldingen hjemme der også — ikke i en varsling en uke senere.

## Fase 1: regelsettet (bygget)

`api/src/lib/skjematype-diagnose.js` svarer på det som kan avgjøres uten
nettverk: sammenhenger internt i definisjonen, og roller vi selv eier lista
over. Raskt nok til å kjøre ved hver lagring, og prøvbart uten hverken
lagringskonto eller flyt.

### Tre alvorsgrader

| Grad | Betyr |
|---|---|
| `feil` | Dette **vil ikke virke**. En varsling går ingen steder, en oppgave kan ikke opprettes. |
| `advarsel` | Dette virker, men gjør antakelig ikke det eieren tror. Oppsett som aldri brukes er den vanligste formen. |
| `info` | **Kan ikke sjekkes på forhånd.** Verdien er en plassholder som først får innhold ved innsending. |

Den siste er viktigere enn den ser ut. Uten den ville et helt lovlig
`Bucket: "{2-3}"` blitt meldt som feil — og skjemaeier ville jaget noe som er
riktig, og sluttet å tro på lista.

### Reglene

**SharePoint** — de tre delene må stå eller falle sammen:

| Kode | Når |
|---|---|
| `sp.mangler-listenavn` | Adresse satt, listenavn tomt |
| `sp.mangler-adresse` | Listenavn satt, adresse tom |
| `sp.felt-uten-liste` | Felter har `SPListefelt`, men lista er ikke satt opp |
| `sp.liste-uten-felt` | Lista er satt opp, men ingen felter har kolonne *(advarsel)* |

**Planner og Teams-kanal**, per behandlingssteg:

| Kode | Når |
|---|---|
| `planner.mangler-plan` | Planner slått på, `TeamOgPlan` tom — **feil**, det finnes ingen standardplan |
| `planner.mangler-bucket` | Plan satt, bucket tom *(advarsel — havner i planens felles bucket)* |
| `planner.plan-uten-plan` | `TeamOgPlan` mangler plandelen — «Automatisering» i stedet for «Automatisering:Oppgaver» |
| `planner.plan-form-ukjent` | Som over, men verdien har plassholder — kolonet kan komme fra svaret *(info)* |
| `planner.bucket-uten-plan` | Bucket satt uten plan |
| `planner.ikke-aktiv` | Oppsett finnes, men «planner» er ikke huket av *(advarsel)* |
| `teamskanal.mangler-team` / `-kanal` | Slått på, men feltet er tomt *(advarsel — flytens standardvalg)* |
| `teamskanal.ikke-aktiv` | Som over *(advarsel)* |
| `*.plassholder` | Verdien inneholder `{…}` eller `$…` *(info)* |

**Roller og behandlere:**

| Kode | Når |
|---|---|
| `steg.ingen-behandlere` | Steget har hverken personer, roller eller team |
| `rolle.tom` | Rollen gir ingen mottakere |
| `rolle.feltref-mangler` | Dynamisk rolle peker på et felt som ikke finnes |
| `rolle.dynamisk` | Rollen settes sammen av svar og kan ikke slås opp *(info)* |
| `person.feltref-mangler` | Mottakeren `{2-01}` peker på et felt som ikke finnes |
| `person.feltref-type` | Feltet finnes, men er ikke av typen E-post |
| `person.dynamisk` | Adressen hentes fra et svar ved innsending *(info)* |

Personreglene kjøres både på behandlingsstegene og på mottakerne i
`Ferdigvarsling` og `Innsenderkvittering.Kopi` — samme fallgruve begge steder.
Rollene utenfor stegene sjekkes derimot **ikke**: `rolle.tom` sier «Varsling for
dette steget går ingen steder», og det er feil ordlyd der. Skal den inn, trenger
den sin egen melding.

`rolle.tom` skiller ikke «rollen finnes ikke» fra «rollen er tom» — i denne
datamodellen *er* en rolle sine medlemsrader, så de to er samme tilstand.
Meldingen sier derfor «gir ingen mottakere», som er sant uansett.

### «Team og plan» er ett felt med to verdier

Feltets plassholder er `Automatisering:Oppgaver`, og hjelpeteksten sier «på
formen Team:Plan». Skriver man bare teamnavnet, er verdien **ikke tom** — alt
ser riktig ut, og flyten får et teamnavn der den venter et par.

Dette var det første funnet fra testkjøring (22.09.2026), og det er verdt å
merke seg hvorfor regelsettet bommet: den opprinnelige regelen spurte bare om
feltet var utfylt. «Utfylt» og «riktig» er ikke det samme, og et felt som
rommer to verdier trenger en regel om formen.

### Tomt felt: det kommer an på om flyten har et standardvalg

Editorens hjelpetekster sier at tomme felter overlates til flyten. Men om det
finnes noe å falle tilbake på, varierer — og det er domenekunnskap som ikke
står noe sted i koden. Avklart med oppdragsgiver 22.09.2026:

| Felt | Standardvalg | Nivå |
|---|---|---|
| Teams-kanal → Kanal | «Generelt» | advarsel |
| Teams-kanal → Team | flytens eget valg | advarsel |
| Planner → Team og plan | **ingen** | **feil** |
| Planner → Bucket | planens felles bucket | advarsel |

`planner.mangler-plan` er altså rød der de andre er gule: uten plan blir det
ingen oppgave, og ingen som venter på den får vite det.

`planner.bucket-uten-plan` er også rød — uten plan finnes det ingen bucket å
legge oppgaven i, og verdien er selvmotsigende.

Poenget med skillet: en rød linje på noe som fungerer er den formen for
feilmelding som gjør at folk slutter å lese lista. En gul linje på noe som
IKKE fungerer er like ille motsatt vei.

### Feltnavnene må være dem varslingen leser

Første versjon leste `steg.Teamskanal`. Editoren skriver
`steg.TeamsKanalInnlegg`, og `varsling.js:byggTeamskanal` leser det samme.
Navnet fantes ikke noe sted, så sjekken meldte begge feltene som tomme uansett
hva som sto i dem.

Testene gikk grønt fordi **testdataene brukte det oppdiktede navnet**. En test
som finner navnet i `varsling.js` og sammenligner står nå i
`skjematype-diagnose.test.js`.

### To ting som er lette å gjøre galt

**Et feilet oppslag er ikke en tom rolle.** Svarer rollelageret ikke, skal
diagnosen tie. Forskjellen er mellom «du har skrevet feil» og «vi vet ikke»,
og bare den første er noe skjemaeier kan gjøre noe med.

**Diagnosen kjøres ETTER lagring, aldri før.** Den som nettopp skrev et
teamnavn feil er også den som skal kunne lagre rettelsen — og et oppslag som
henger ville tatt den muligheten fra hen. Lagringen venter heller ikke på
svaret.

## Slik virker det i editoren

`GET /api/skjematyper/{id}/diagnose` → `{ funn: [...], sammendrag: {...} }`.
Eier eller admin; en diagnose forteller hvilke roller som er tomme og hvilke
lister som er satt opp.

Editoren kaller den to steder:

* **Rett etter lagring**, uten å vente på svaret. Finner den ingenting, vises
  ingenting — en boks som bare sier at alt er i orden, er støy.
* **«🩺 Sjekk oppsettet»-knappen**, som alltid viser resultatet, også når det
  er tomt.

## Fase 2: eksterne oppslag

Finnes teamet? Finnes kanalen i det? Finnes planen, bucketen, lista,
kolonnene? Det krever en flytrunde. **Wiringen er bygget** — flyten gjenstår.

### Oppsett

App setting **`DIAGNOSE_FLOW_URL`**. Er den ikke satt, gjøres ingen kall og
svaret ser ut som før. Flyten får `x-flow-key` (`FLOW_CALLBACK_KEY`) som de
andre.

`VARSLING_DEAKTIVERT` slår **ikke** av denne. Den bryteren betyr «ikke rør noe
utenfor systemet», og et oppslag rører ingenting — det leser. Å skru den av i
et testmiljø ville dessuten fjernet diagnosen nettopp der man prøver ut
oppsett.

### Hva som sendes

Regelsettet avgjør. En verdi sendes bare når den kan slås opp:

* **ikke tom** — en tom verdi er alt dekket av reglene i fase 1
* **uten plassholder** — `FFT:{1-1}` har ikke fått innhold ennå, og et
  oppslag ville svart «finnes ikke» på noe som er helt riktig
* **med kontekst** — en plan hører til et team, en kanal til et team, en
  kolonne til en liste. En plan uten team sendes ikke; Planner-planer er ikke
  globalt unike

Har skjematypen ingen slike referanser, kalles flyten ikke.

```json
{
  "Handling": "sjekkReferanser",
  "Skjematype_id": "128",
  "Skjema_navn": "Diagnosetest",
  "Miljo": "pilot",
  "Tidspunkt": "2026-09-22T09:14:00.000Z",
  "Referanser": [
    { "Id": "steg1.plan",     "Type": "plan",       "Team": "Automatisering", "Plan": "Oppgaver",
      "Sted": "Steg 1 «Godkjenning» · Planner" },
    { "Id": "steg1.bucket",   "Type": "bucket",     "Team": "Automatisering", "Plan": "Oppgaver",
      "Bucket": "Til godkjenning", "Sted": "Steg 1 «Godkjenning» · Planner" },
    { "Id": "steg1.team",     "Type": "team",       "Team": "FHS test",
      "Sted": "Steg 1 «Godkjenning» · Teams-kanal" },
    { "Id": "steg1.kanal",    "Type": "kanal",      "Team": "FHS test", "Kanal": "Generelt",
      "Sted": "Steg 1 «Godkjenning» · Teams-kanal" },
    { "Id": "sp.liste",       "Type": "sp-liste",   "Adresse": "https://…/sites/y", "Liste": "Saker",
      "Sted": "SharePoint-liste" },
    { "Id": "sp.kolonne.1-1", "Type": "sp-kolonne", "Adresse": "https://…/sites/y", "Liste": "Saker",
      "Kolonne": "Tittel", "Avhenger": "sp.liste", "Sted": "SharePoint-liste · felt 1-1" }
  ]
}
```

| Type | Felter | Slå opp |
|---|---|---|
| `team` | `Team` | Finnes teamet? |
| `kanal` | `Team`, `Kanal` | Finnes kanalen i det teamet? |
| `plan` | `Team`, `Plan` | Finnes planen i det teamet? |
| `bucket` | `Team`, `Plan`, `Bucket` | Finnes bucketen i den planen? |
| `sp-liste` | `Adresse`, `Liste` | Finnes lista på den sida? |
| `sp-kolonne` | `Adresse`, `Liste`, `Kolonne` | Finnes kolonnen i den lista? |

`Id` er stabil og unik. Bruk den til å koble svaret tilbake — **ikke
rekkefølgen**. `Sted` er til visning hos oss og trenger ikke sendes tilbake.

### `Avhenger`

En bucket ligger i en plan, en kanal i et team, en kolonne i en liste. Barnet
peker på forelderen sin med `Avhenger`:

| Type | Avhenger av |
|---|---|
| `bucket` | `stegN.plan` |
| `kanal` | `stegN.team` |
| `sp-kolonne` | `sp.liste` |

**Flyten kan bruke den til å hoppe over oppslag**: finner den ikke lista,
trenger den ikke slå opp de tjue kolonnene. Svar gjerne `kan-ikke-sjekkes`
på dem, eller la dem stå — vi undertrykker dem uansett (se under).

Feltet er valgfritt å bruke. Ignorerer flyten det, virker alt som før.

### Hva flyten skal svare

```json
{
  "Referanser": [
    { "Id": "steg1.plan",   "Status": "finnes" },
    { "Id": "steg1.bucket", "Status": "finnes-ikke", "Melding": "Planen har ingen bucket med det navnet." },
    { "Id": "steg1.team",   "Status": "ingen-tilgang" },
    { "Id": "sp.liste",     "Status": "kan-ikke-sjekkes" }
  ]
}
```

| Status | Blir til | Hvorfor |
|---|---|---|
| `finnes` | ingenting | |
| `finnes-ikke` | **feil** | Navnet peker ingen steder |
| `ingen-tilgang` | advarsel | Flyten kjører som sin egen tilkobling. At den ikke ser noe, betyr ikke at det ikke finnes |
| `kan-ikke-sjekkes` | info | Flyten klarte ikke å avgjøre det |

**`finnes-ikke` og `ingen-tilgang` må holdes fra hverandre.** Slås de sammen,
ender skjemaeier med å jage et navn som er helt riktig, fordi tilkoblingen
mangler tilgang.

`Melding` er valgfri og legges til i vår egen tekst. Hold den kort og konkret.

### Én årsak gir én linje

Svarer flyten at en forelder ikke finnes, meldes ikke barna hver for seg —
vi vet allerede hvorfor de ikke finnes. I stedet står det på forelderens
linje:

> Lista «Saker» finnes ikke. De 20 underliggende referansene er derfor ikke
> sjekket.

Uten dette ville ett feilstavet listenavn på et skjema med tjue mappede
kolonner gitt **tjueén røde linjer for én skrivefeil**.

To presiseringer:

* `ingen-tilgang` undertrykker også — ser ikke flyten lista, ser den ikke
  kolonnene heller.
* Et **ubesvart** foreldre undertrykker ikke. Da vet vi ingenting om årsaken,
  og barnas egne svar kan fortsatt være verdt å lese.

### Mens flyten bygges

Svarer flyten **200 uten innhold**, blir det én info-linje:

> Flyten svarte, men sa ingenting om de 6 referansene som ble sendt. De er
> ikke sjekket.

Én linje, ikke én per referanse — et halvferdig endepunkt skal ikke fylle
skjermen. Svarer den om noen av dem, nevnes de som mangler hver for seg; da
vet vi at endepunktet virker og at akkurat disse falt ut.

### Tid

Kallet har **ti sekunders tidsavbrudd**. Går det over, meldes det som info
(«ble ikke sjekket»), ikke som en feil ved skjematypen — og lista fra fase 1
vises som vanlig.

Editoren viser kostnaden i overskriften: `6 oppslag, 840 ms`. Diagnosen kjøres
etter lagring og blokkerer den ikke, men tallet er der for å se hva runden
koster.

`?flyt=0` på endepunktet hopper over runden. Til feilsøking, og for å
sammenligne svartiden med og uten.

### Fortsatt igjen

Sjekk bare det som **er endret** siden forrige lagring. Editoren lagrer ofte,
og et eksternt oppslag per tastetrykk er verken raskt eller vennlig mot
Graph-strupingen. Ikke bygget — vent til vi ser hva runden faktisk koster.
