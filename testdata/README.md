# Syntetiske testdata for dev-tenanten

Rolle- og teamlogikken kan ikke testes skikkelig med én bruker, og
produksjonsdata hører ikke hjemme i dev. Disse filene gir et sett brukere, team
og roller som ser ekte nok ut til å avsløre feil, uten å være noen.

Alt er generert av `generer.js` og er deterministisk: samme seed gir samme
personer. Et testtilfelle som viser til `mhaugen@jcconsulting.no` fortsetter
derfor å gjelde etter en regenerering.

```bash
node testdata/generer.js             # skriver filene på nytt
node testdata/generer.js --seed 42   # et helt annet utvalg
```

## Filene

| Fil | Innhold | Brukes til |
|---|---|---|
| `brukere.json` | 50 personer med UPN, for- og etternavn | Kilde når du oppretter testbrukerne i tenanten |
| `team.json` | 8 team med 3–6 medlemmer hver | Klar payload til `POST /api/cache/teammedlemskap` |
| `roller.json` | 24 rolletildelinger | Kilde for en PA-flyt, eller for `POST /api/roller/leggtil` én om gangen |
| `roller.csv` | Samme rader, semikolonseparert | Import i admin-panelet under **Roller** |

Brukernavnene følger samme mønster som i produksjon — forbokstav pluss
etternavn, `bjohansen@` — slik at testdataene ligner det de erstatter. Ved
navnekollisjon utvides forbokstaven, som i virkeligheten.

## Team

`team.json` er allerede i det formatet cache-endepunktet forventer, så den kan
sendes rett inn:

```
POST /api/cache/teammedlemskap
x-flow-key: <FLOW_CALLBACK_KEY>
Content-Type: application/json

<innholdet i team.json>
```

Endepunktet godtar også en bar array av `{ Team, Medlemmer }`, og et enkelt
`{ Team, Medlemmer }`-objekt. Hvert medlem har `EP`, `FN`, `EN` og `Navn` —
samme felter som PA-flyten normaliserer til.

`Beskrivelse` er med for lesbarhet og ignoreres av endepunktet.

## Roller

`roller.json` har `Rolle`, `Omfang`, `UPN`, `FN`, `EN` og `Rollebeskrivelse`.
Tomt `Omfang` betyr at rollen gjelder uten avgrensning.

Det finnes ikke noe endepunkt som tar imot hele lista i én JSON. To veier inn:

- **Admin-panelet → Roller → Importer**, med `roller.csv`. Importen eier bare
  rader med `Kilde='import'`, så manuelt innlagte innehavere står urørt.
- **`POST /api/roller/leggtil`** med ett objekt om gangen. Passer for en flyt
  som går gjennom lista.

### Hvorfor ingen FS-roller her

Emneansvarlig og de klassebaserte rollene genereres av FS-synkroniseringen
hver natt. Lager vi dem her også, tester vi mot data som blir overskrevet før
neste arbeidsdag. Rollene i denne fila er bare de som ikke kommer fra FS.

## Ting som er lagt inn med vilje

Noen personer har **flere roller** (Berit Lund er både administrativ godkjenner
og personellansvarlig), noen er **medlem i flere team**, og noen har **verken
rolle eller team**. Alle tre tilfellene finnes i produksjon, og alle tre har
avslørt feil før.

`Sjef` og `Verneombud` finnes med **samme rollenavn på ulikt omfang**. Det er
den kombinasjonen som skiller en riktig rolleoppslag fra en som bare matcher på
navn.
