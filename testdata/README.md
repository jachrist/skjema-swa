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
| `opprett-testbrukere.ps1` | PowerShell mot Microsoft Graph | Oppretter brukerne i Entra ID |
| `last-inn-team.ps1` | PowerShell mot SWA-en | Sender `team.json` inn i team-cachen |

Brukernavnene følger samme mønster som i produksjon — forbokstav pluss
etternavn, `bjohansen@` — slik at testdataene ligner det de erstatter. Ved
navnekollisjon utvides forbokstaven, som i virkeligheten.

## Opprette brukerne i tenanten

```powershell
Install-Module Microsoft.Graph -Scope CurrentUser    # én gang
.\testdata\opprett-testbrukere.ps1 -Torrkjor        # vis hva som skjer
.\testdata\opprett-testbrukere.ps1                  # opprett
.\testdata\opprett-testbrukere.ps1 -Fjern           # rydd opp
```

Skriptet er idempotent, spør om det felles passordet uten å vise det, og
legger alle brukerne i sikkerhetsgruppa `FHS-Testbrukere`.

Gruppa finnes fordi **MFA ikke kan slås av per bruker** — kravet styres av
Security Defaults eller en betinget tilgang-policy for hele tenanten. Med en
gruppe blir unntaket én operasjon i stedet for femti, og opprydding likeså.

Brukerne får ingen lisens og ingen roller i tenanten. De skal befolke roller
og team-cachen i skjemaløsningen, ikke brukes i Teams eller e-post.

## De fem å registrere MFA for

De 50 brukerne finnes for å **befolke roller og team-cachen**. Det er data, og
leses fra tabellene våre — ikke fra en innlogget sesjon. De aller fleste trenger
derfor aldri å logge inn.

Skal du se løsningen *som* en bestemt bruker, holder det med disse fem. De er
valgt for å dekke hver sin tilgangssituasjon:

| Bruker | Navn | Dekker |
|---|---|---|
| `hjoergensen@jcconsulting.no` | Henrik Jørgensen | **Sjef** (Cyberingeniørskolen) + **Skjemaskaper** — rolletilgang uten teammedlemskap. Skjemaskaper gir også rapporter og AI-import |
| `blund@jcconsulting.no` | Berit Lund | **To roller** — administrativ godkjenner (Fagstab) og personellansvarlig. Tester overlapp |
| `oloeken@jcconsulting.no` | Øyvind Løken | **Rolle og team** — administrativ godkjenner (Fellesadministrasjonen), medlem i Fagstab utdanning |
| `afoss@jcconsulting.no` | Anders Foss | **Bare team** — Anskaffelser og Personell og HR, ingen roller |
| `msolberg@jcconsulting.no` | Maja Solberg | **Verken rolle eller team** — skal se minst mulig. Den beste testen på at tilgangskontrollen faktisk stenger |

Microsoft Authenticator tar mange kontoer i samme app, så alle fem kan
registreres på én telefon.

Den siste er lett å hoppe over, men er den viktigste: det er enklere å teste at
noe vises enn at noe ikke vises.

## Team

```powershell
.\testdata\last-inn-team.ps1 -Url https://<miljøet> -Torrkjor   # vis hva som sendes
.\testdata\last-inn-team.ps1 -Url https://<miljøet>             # send
```

Skriptet spør om `FLOW_CALLBACK_KEY` uten å vise den, og kan kjøres om igjen —
endepunktet erstatter medlemslista per team i stedet for å legge til.

`team.json` er allerede i det formatet cache-endepunktet forventer, så skriptet
gjør lite annet enn å sende den. Manuelt blir det:

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

Rollene kan ikke lastes fra et skript slik teamene kan: rolle-endepunktene
godtar ikke `x-flow-key`, bare en innlogget administrator. To veier inn:

- **Admin-panelet → 👥 Roller → 📥 Importer**, med `roller.csv`. Én operasjon
  for hele lista. Importen eier bare rader med `Kilde='import'`, så manuelt
  innlagte innehavere står urørt, og den kan trygt kjøres om igjen.
- **`POST /api/roller/leggtil`** med ett objekt om gangen, fra en innlogget
  sesjon. Passer for en flyt som går gjennom lista.

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
