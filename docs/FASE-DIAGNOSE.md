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
| `planner.mangler-plan` | Planner slått på, `TeamOgPlan` tom |
| `planner.plan-uten-plan` | `TeamOgPlan` mangler plandelen — «Automatisering» i stedet for «Automatisering:Oppgaver» |
| `planner.plan-form-ukjent` | Som over, men verdien har plassholder — kolonet kan komme fra svaret *(info)* |
| `planner.bucket-uten-plan` | Bucket satt uten plan |
| `planner.ikke-aktiv` | Oppsett finnes, men «planner» er ikke huket av *(advarsel)* |
| `teamskanal.mangler-team` / `-kanal` | Slått på, men feltet er tomt |
| `teamskanal.ikke-aktiv` | Som over *(advarsel)* |
| `*.plassholder` | Verdien inneholder `{…}` eller `$…` *(info)* |

**Roller og behandlere:**

| Kode | Når |
|---|---|
| `steg.ingen-behandlere` | Steget har hverken personer, roller eller team |
| `rolle.tom` | Rollen gir ingen mottakere |
| `rolle.feltref-mangler` | Dynamisk rolle peker på et felt som ikke finnes |
| `rolle.dynamisk` | Rollen settes sammen av svar og kan ikke slås opp *(info)* |

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

## Fase 2: eksterne oppslag (ikke bygget)

Finnes teamet? Finnes kanalen i det? Finnes planen, bucketen, SP-sida, lista,
kolonnene? Det krever en flytrunde, og den plugges inn samme sted: regelsettet
avgjør om det er noe å spørre om, og flyten svarer per referanse.

Foreslått svarform per referanse:

```
finnes | finnes-ikke | ingen-tilgang | kan-ikke-sjekkes
```

**`finnes-ikke` og `ingen-tilgang` må skilles.** Flyten kjører som sin egen
tilkobling. Finner den ikke teamet, kan det være fordi navnet er feil *eller*
fordi tilkoblingen mangler tilgang. Slås de sammen, jager skjemaeier et navn
som er korrekt.

Og: sjekk bare det som **er endret** siden forrige lagring. Editoren lagrer
ofte, og et eksternt oppslag per tastetrykk er verken raskt eller vennlig mot
Graph-strupingen.
