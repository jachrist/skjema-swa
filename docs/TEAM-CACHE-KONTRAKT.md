# Team-cache — kontrakt mot Power Automate

Teammedlemskap ligger i Table Storage og oppdateres av PA-flyter som leser fra
Microsoft Graph. Dette dokumentet beskriver hva flyten skal sende.

**Endret 2026-08-18:** medlemmer kan nå sendes med navn. Tidligere lagret vi
bare UPN, og dropdowns med datakilde `Personer` viste derfor bare
e-postadresser. Backend godtar fortsatt det gamle formatet — flyten kan
oppdateres når det passer.

---

## POST /api/cache/teammedlemskap

Erstatter medlemslista for ett eller flere team.

**Headers**

| Header | Verdi |
|---|---|
| `Content-Type` | `application/json` |
| `x-flow-key` | verdien av app-settingen `FLOW_CALLBACK_KEY` |

Alternativt kan en innlogget admin kalle endepunktet uten `x-flow-key`.

**Body — ett team**

```json
{
  "Team": "FHS Alle ansatte",
  "append": false,
  "Medlemmer": [
    {
      "userPrincipalName": "ola.nordmann@fhs.mil.no",
      "givenName": "Ola",
      "surname": "Nordmann",
      "displayName": "Ola Nordmann"
    }
  ]
}
```

**Body — flere team**

Enten en ren array av slike objekter, eller `{ "grupper": [ … ] }`.

### Feltene

| Felt | Påkrevd | Merknad |
|---|---|---|
| `Team` | ja | Team-navnet. Blir PartitionKey, og er det navnet skjemadefinisjoner refererer til. Case-sensitivt. |
| `Medlemmer` | ja | Array. Tom array sletter alle medlemmer i teamet (med `append: false`). |
| `append` | nei | `false` (standard) sletter eksisterende rader for teamet først. `true` beholder dem — bruk når ei stor liste sendes i flere kall. |

### Medlemsobjektet

Backend godtar flere skrivemåter per felt, så du kan sende Graph-objektet
videre uten en mellomliggende `Select`. Første ikke-tomme verdi vinner.

| Vi lagrer | Godtatte feltnavn |
|---|---|
| **UPN** (påkrevd) | `userPrincipalName`, `Upn`, `upn`, `UPN`, `EP`, `mail`, `email` |
| **Fornavn** | `givenName`, `FN`, `Fornavn` |
| **Etternavn** | `surname`, `EN`, `Etternavn` |
| **Visningsnavn** | `displayName`, `Navn` |

Medlemmer uten UPN hoppes over — nestede grupper og andre objekter uten
brukerprinsipal forsvinner altså av seg selv. UPN lagres i små bokstaver.

**Ekstra felt ignoreres.** Resultatet fra PA-connectoren (eller et rått
Graph-svar) kan sendes videre uendret, med `id`, `jobTitle`, `@odata.type` og
alt annet med. `Medlemmer` kan også være selve connector-outputen med
innpakning — `{ "value": [ ... ] }` og `{ "Medlemmer": [ ... ] }` pakkes ut
automatisk.

Står både `userPrincipalName` og `mail` i objektet, vinner `userPrincipalName`.

En ren streng godtas fortsatt som medlem og tolkes som UPN uten navn:

```json
{ "Team": "SKSK Stab", "Medlemmer": ["ola.nordmann@fhs.mil.no"] }
```

### Anbefaling: send `givenName` og `surname`

Visningsnavn brukes bare når for- og etternavn mangler, og lagres som det er —
vi utleder ikke navnedeler fra det, siden både «Ola Nordmann» og «Nordmann,
Ola» forekommer i Entra.

Konsekvensen er sorteringen i dropdownen. Med for- og etternavn vises
«Nordmann, Ola» og lista sorteres på etternavn. Med bare visningsnavn vises
«Ola Nordmann», som sorteres på fornavn — og en liste der begge deler
forekommer får en rekkefølge som ser tilfeldig ut.

**Graph-spørringen bør derfor ha med:**

```
$select=userPrincipalName,givenName,surname,displayName
```

### Svar

```json
{
  "status": "ok",
  "antallTeam": 1,
  "resultater": [
    { "Team": "FHS Alle ansatte", "modus": "erstatt", "antallMedlemmer": 842, "antallMedNavn": 842, "antallNavnBeholdt": 0 }
  ]
}
```

`antallMedNavn` teller medlemmer der navn kom med i denne forespørselen, og er
kontrollen etter at en flyt er lagt om: er den 0 mens `antallMedlemmer` er høy,
kommer navnene ikke gjennom.

`antallNavnBeholdt` teller medlemmer som kom inn uten navn, men der vi beholdt
navnet som allerede lå lagret — se neste avsnitt.

---

## Begge skrivende flyter må legges om

To flyter skriver til denne tabellen:

| Flyt | Vei inn |
|---|---|
| Periodisk refresh | POSTer til `/api/cache/teammedlemskap` |
| Lazy-load fra editoren | API-et kaller `TEAM_LAST_MEDLEMMER_FLOW_URL`, og cacher svaret |

Begge går gjennom den samme erstatt-logikken med `append: false`, så begge må
sende navn for at alle medlemmer skal få det.

Rekkefølgen spiller likevel ingen rolle: kommer et medlem inn uten navn, og det
allerede ligger et navn lagret på samme UPN i samme team, beholdes det gamle
navnet (`antallNavnBeholdt`). En flyt som ennå ikke er lagt om sletter derfor
ikke navn den andre har lagt inn. Navn som faktisk sendes overskriver alltid det
lagrede, så navneendringer i Entra slår gjennom.

Det som mangler til begge er lagt om, er navn på personer som *bare* den ikke-
oppdaterte flyten har sett — nye medlemmer lastet via lazy-load, for eksempel.

---

## Hvordan navn brukes

Datakilden `Personer` viser «Etternavn, Fornavn (e-post)». Rekkefølgen på
kildene er:

1. For- og etternavn fra teamcachen
2. Visningsnavn fra teamcachen
3. Navn fra `Rollemedlemskap`, for personer som har en rolle — dette er
   fallbacken som dekker rader lagret før flyten ble utvidet
4. UPN alene

Oppslag som ikke går via team (`Personer{Rolle=…}`, `{EmneLarere}`,
`{EmneStudenter}`) er uendret og har navn fra sine egne kilder.

---

## Øvrige endepunkter

| Endepunkt | Tilgang | Merknad |
|---|---|---|
| `GET /api/cache/teammedlemskap/team-navn` | innlogget | Alle kjente team-navn |
| `GET /api/cache/teammedlemskap/{team}/medlemmer` | innlogget | Array av UPN-strenger. Formatet er uendret. |
| `DELETE /api/cache/teammedlemskap/{team}` | admin | Sletter hele teamet |

`POST /api/team/last-medlemmer` går motsatt vei: API-et kaller
`TEAM_LAST_MEDLEMMER_FLOW_URL` og cacher svaret. Flyten svarer med
`{ "Medlemmer": [ … ] }` eller en ren array, og medlemsobjektene følger samme
regler som over — så også den får navn med når flyten oppdateres.
