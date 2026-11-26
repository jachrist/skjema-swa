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
| `steg.avhengig-mangler` | `AvhengigAv` peker på et steg som ikke finnes — steget blir aldri aktivt |
| `steg.avhengig-seg-selv` | Steget venter på seg selv |
| `steg.avhengig-senere` | Venter på et steg med høyere nummer *(advarsel)* |
| `steg.vilkar-uten-avhengighet` | Vilkåret ser på et annet stegs beslutning, men steget venter ikke på det — direkte eller gjennom kjeden av `AvhengigAv`. Vilkåret vurderes da ved innsending, og steget hoppes over *(advarsel — et steg som selv hoppes over ved innsending ER avgjort, og et vilkår på det kan være meningen)* |
| `steg.vilkar-seg-selv` | Vilkåret ser på stegets egen beslutning |
| `steg.vilkar-steg-mangler` | Vilkåret ser på et steg som ikke finnes |
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
| `ikke-medlem` | **feil** | Teamet eller området finnes, men tjenestebrukeren er ikke medlem. Flyten som skriver dit, vil feile |
| `ingen-tilgang` | advarsel | Flyten kjører som sin egen tilkobling. At den ikke ser noe, betyr ikke at det ikke finnes |
| `kan-ikke-sjekkes` | info | Flyten klarte ikke å avgjøre det |

**`finnes-ikke` og `ingen-tilgang` må holdes fra hverandre.** Slås de sammen,
ender skjemaeier med å jage et navn som er helt riktig, fordi tilkoblingen
mangler tilgang.

**`ikke-medlem` og `ingen-tilgang` må også holdes fra hverandre** (lagt til
24.11.2026). `ikke-medlem` er et sikkert svar: flyten har sett at teamet
finnes, og at tjenestebrukeren ikke står blant medlemmene. Da vet vi at
Planner-oppgaven, kanalinnlegget eller listeoppdateringen vil feile, og det er
en feil ved oppsettet. Teksten sier hvem som kan rette den, nemlig teameieren:

> Tjenestebrukeren er ikke medlem av teamet «FHS test», og flyten kan ikke
> skrive dit. Be en eier av teamet legge den til som medlem.

`ingen-tilgang` er for det flyten ikke klarer å forklare, og blir fortsatt en
advarsel med «navnet kan være riktig».

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

* `ingen-tilgang` og `ikke-medlem` undertrykker også — ser ikke flyten
  lista, ser den ikke kolonnene heller.
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

### Byggebeskrivelse for flyten

Skrevet 24.11.2026. Flyten er ikke bygget ennå, og stegene under er ikke
prøvd i en ekte flyt. Det som står om API-ets side, er testet. Kontrollér
Graph-kallene ett og ett før resten bygges (punkt 8).

#### Hvorfor flyten må kjøre som tjenestebrukeren

Spørsmålet er ikke bare «finnes teamet?», men «kan flytene som skriver dit,
skrive dit?». De kjører som tjenestebrukeren. **Alle tilkoblingene i denne
flyten skal derfor også være tjenestebrukerens**, ellers sjekkes noen andres
tilgang.

#### Feilstavet og ikke-medlem ser like ut

Ser flyten bare i «mine team», er et feilstavet team og et team uten
tjenestebrukeren begge usynlige. Derfor går hver referanse med team i to
trinn:

1. **Finnes teamet?** Søk i katalogen. Vanlige brukere kan lese grupper
   uten å være medlem. Ingen treff gir `finnes-ikke`.
2. **Er tjenestebrukeren medlem?** Se etter teamet i tjenestebrukerens egne
   team. Står det ikke der, svar `ikke-medlem`.

Først når begge er ja, gir det mening å lete etter kanalen, planen eller
bucketen. Uten medlemskap ser ikke flyten dem.

#### Stegene

**1. Trigger: «When a HTTP request is received».** Bruk samme oppsett som de
andre flytene i miljøet. I v3-prod betyr det samme autentisering
(`FLYT_AUTH=entra`, se `docs/FLYTER.md`). JSON-skjema for kroppen:

```json
{
  "type": "object",
  "properties": {
    "Handling": { "type": "string" },
    "Skjematype_id": { "type": "string" },
    "Miljo": { "type": "string" },
    "Referanser": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "Id": { "type": "string" }, "Type": { "type": "string" },
          "Team": { "type": "string" }, "Kanal": { "type": "string" },
          "Plan": { "type": "string" }, "Bucket": { "type": "string" },
          "Adresse": { "type": "string" }, "Liste": { "type": "string" },
          "Kolonne": { "type": "string" }, "Avhenger": { "type": "string" }
        }
      }
    }
  }
}
```

**2. Sjekk `x-flow-key`** som første steg, som i de andre flytene: en
betingelse på `triggerOutputs()?['headers']?['x-flow-key']` mot
miljøvariabelen med nøkkelen. Feil nøkkel gir Response 401 og Terminate.

**3. «Initialize variable» `Svar`**, type Array, tom (`[]`).

**4. «Apply to each» over `Referanser`.** Slå på **Concurrency control** med
for eksempel 10 parallelle. API-et venter bare i **ti sekunder** (se «Tid»
over), og et skjema med tjue SharePoint-kolonner gir tjue oppslag.

Hver gren er selvstendig: en kanal slår selv opp teamet sitt i stedet for å
lese svaret fra team-referansen. Det gir noen ekstra kall, men ingen
avhengighet av rekkefølgen, og gjør den parallelle løkka trygg.

Inne i løkka: **«Switch» på `items('Apply_to_each')?['Type']`**, med én gren
per type (tabellen under). Hver gren slutter med **«Append to array
variable»** `Svar`:

```json
{ "Id": "@{items('Apply_to_each')?['Id']}", "Status": "<status>", "Melding": "<valgfri>" }
```

**Default-grenen** (ukjent type) svarer `kan-ikke-sjekkes`. Da vet API-et at
flyten fikk referansen, men ikke forsto den.

**5. Grenene.** «Team-oppslaget» under er trinn 1 og 2 over, og brukes i fire
av grenene:

| Type | Kall | Svar |
|---|---|---|
| `team` | Team-oppslaget | `finnes` / `finnes-ikke` / `ikke-medlem` |
| `kanal` | Team-oppslaget, så **Teams → «List channels»** (team-ID) og let etter `displayName` lik `Kanal` | ingen kanal gir `finnes-ikke`, ellers `finnes` |
| `plan` | Team-oppslaget, så **Planner → «List plans»** (gruppe-ID = team-ID) og let etter `title` lik `Plan` | ingen plan gir `finnes-ikke`, ellers `finnes` |
| `bucket` | Som `plan`, så **Planner → «List buckets»** (plan-ID) og let etter `name` lik `Bucket` | ingen plan eller bucket gir `finnes-ikke` (si hvilken i `Melding`), ellers `finnes` |
| `sp-liste` | **SharePoint → «Send an HTTP request to SharePoint»**, Site Address = `Adresse`, GET `_api/web/lists/getbytitle('<Liste>')?$select=Id` | 200 gir `finnes`, 404 gir `finnes-ikke`, 401/403 gir `ikke-medlem` |
| `sp-kolonne` | Samme handling: GET `_api/web/lists/getbytitle('<Liste>')/fields/getbyinternalnameortitle('<Kolonne>')?$select=InternalName` | som over |

Henter Team-oppslaget `ikke-medlem` eller `finnes-ikke` i en `kanal`-, `plan`-
eller `bucket`-gren, svar med den statusen og gå ikke videre. API-et viser én
linje for årsaken (se «Én årsak gir én linje»).

**Team-oppslaget:**

- **Trinn 1, finnes teamet:** Office 365 Groups → **«Send an HTTP request»**,
  GET
  `https://graph.microsoft.com/v1.0/groups?$filter=displayName eq '<Team>'&$select=id,displayName,resourceProvisioningOptions`.
  Behold treffene der `resourceProvisioningOptions` inneholder `Team`. Ingen
  treff gir `finnes-ikke`. Mer enn ett treff gir `kan-ikke-sjekkes`, med
  `Melding: "Flere team heter dette."`. Da vet ikke flyten hvilket av dem
  skjemaet mener.
- **Trinn 2, er tjenestebrukeren medlem:** **Teams → «List joined teams»**
  (tjenestebrukerens egne team). Står ikke team-ID-en fra trinn 1 der, er
  svaret `ikke-medlem`.

**Store og små bokstaver.** Teams, Planner og SharePoint skiller ikke mellom
dem i navn. Sammenlign derfor med `toLower()` på begge sider i alle
filtreringer. `$filter=displayName eq` i Graph skiller heller ikke.

**Apostrof i navn.** Både OData-filteret og `getbytitle('…')` brytes av `'`.
Doble den: `replace(<navn>, '''', '''''')`.

**6. Feil i et kall skal ikke velte løkka.** Legg hver gren i en **«Scope»**.
Etter den kommer en handling med *Configure run after* = «has failed» /
«has timed out», som legger til `kan-ikke-sjekkes` med statuskoden i
`Melding`. For SharePoint-kallene leses statuskoden ut med
`outputs('<handling>')?['statusCode']`: 404 og 403 er svar, ikke feil.

**7. Response** etter løkka: status 200, header
`Content-Type: application/json`, kropp

```json
{ "Referanser": @{variables('Svar')} }
```

Sett inn `Svar` uten anførselstegn rundt. Står det `"@{variables('Svar')}"`,
blir lista en tekst. Det samme gjelder verdien i «Append to array variable»:
skriv den som et objekt, ikke som tekst.

API-et tåler begge feilene (sjekket 26.11.2026), men de er lette å rette her.
Forstår API-et likevel ikke svaret, sier editoren hva det fikk, for eksempel
«Svaret hadde ikke «Referanser», bare: body» eller «Svaret var ikke JSON:
«…»». Det er det første du ser på når en flyt som virker i flytloggen,
gir «sa ingenting om referansene» i editoren.

**8. Prøv Graph-kallene før resten bygges.** Kjør trinn 1 med et team du vet
finnes, og ett du vet ikke finnes. Kjør «List joined teams» og se at teamene
tjenestebrukeren er med i, kommer ut. Feiler katalogsøket med 403, har
tenanten begrenset hva vanlige brukere kan lese. Da kan ikke flyten skille
feilstavet fra ikke-medlem, og `team`-grenen må svare `kan-ikke-sjekkes`
når teamet ikke er blant de tjenestebrukeren er med i.

#### Slå den på

1. Kopiér trigger-URL-en til app setting **`DIAGNOSE_FLOW_URL`** på
   API-et. Den bærer ingen `sig=` når flytene krever Entra-token, og settes
   rett i app settings som de andre flyt-URL-ene (se `config/env.prod.json`).
2. Åpne en skjematype med Teams-kanal, Planner eller SharePoint-liste i
   editoren, og trykk **Sjekk oppsettet**. Overskriften viser antall oppslag
   og tiden. Finner du ikke noe, prøv med et team tjenestebrukeren ikke er
   med i. Da skal det komme en rød linje om medlemskapet.
3. `GET /api/skjematyper/{id}/diagnose?flyt=0` viser svaret uten flyten,
   til sammenligning.

### Fortsatt igjen

Sjekk bare det som **er endret** siden forrige lagring. Editoren lagrer ofte,
og et eksternt oppslag per tastetrykk er verken raskt eller vennlig mot
Graph-strupingen. Ikke bygget — vent til vi ser hva runden faktisk koster.
