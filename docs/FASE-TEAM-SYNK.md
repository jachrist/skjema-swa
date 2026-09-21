# Team-synkronisering fra rollegrupper (TODO 71)

## Hvorfor

Forsvarets ugraderte plattform har ingen organisasjonsdata i Entra ID — bare
UPN og navn. Dynamiske team kan derfor ikke bygges på avdeling. FHS har ett
dynamisk team («Ansatte og studenter ved FHS») som hviler på akademiske
lisenser, men det kan ikke brukes av andre enheter.

Medlemslistene vedlikeholdes derfor manuelt i Excel og importeres hit som
roller — for eksempel «Publikum» med omfang «FFT» eller «FLO». Oppdragsgiver
vil bruke den samme lista til å holde et Teams-team oppdatert.

## Slik virker det

Settes feltet **Team** på en rollegruppe (Administrasjon → Roller), kalles en
Power Automate-flyt én gang i døgnet med teamet og alle UPN-ene i gruppen.
Flyten oppdaterer teamet **destruktivt**: den som ikke står på lista, meldes ut.

```
GitHub Actions (04:30 UTC)
        │  POST /api/team-synk   (x-scheduler-key)
        ▼
  team-synk.js ──► rollegruppe-storage  (hvilke grupper har Team?)
        │     └──► roller-storage       (hvem er i gruppen?)
        │
        ├─ team-synk.js: vurderSynk()   ← sperrene
        │
        ▼
  flyt-kaller.js: kallTeamSynkFlyt() ──► TEAM_FLOW_URL
```

## Sperrene

Lista kommer fra en manuell import. Går importen halvveis, er resultatet en
**kortere liste, ikke en feilmelding**. Sendes den videre, meldes folk ut som
aldri skulle vært ute — og det oppdages først når noen ikke kommer inn.

| Sperre | Regel | Kan overstyres |
|---|---|---|
| Tom liste | Sendes aldri | Nei |
| Stort fall | Gruppen beholder mindre enn halvparten siden forrige vellykkede kjøring | Ja, av admin |

Fallsperren slår først inn når forrige kjøring hadde minst 5 medlemmer — 1 av
3 er ikke et varsko, det er en liten gruppe.

Overstyring («Kjør likevel») krever en innlogget administrator og en
bekreftelse. Den daglige kjøringen kan **ikke** overstyre; sender den
`tillatFall`, ignoreres det.

`SisteAntall` — grunnlaget for fallsperren — oppdateres bare når en kjøring
gikk gjennom. Ellers ville det mistenkelige tallet blitt grunnlaget, og
sperren ville slått ut nøyaktig én gang.

## Hva flyten må gjøre

Endepunktet settes i app setting **`TEAM_FLOW_URL`**. Payload:

```json
{
  "Handling": "synkroniserTeamDestruktivt",
  "TeamId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "TeamNavn": "",
  "Rolle": "Publikum",
  "Omfang": "FFT",
  "Medlemmer": ["ola@mil.no", "kari@mil.no"],
  "Antall": 2,
  "Miljo": "pilot",
  "Tidspunkt": "2026-09-21T04:30:00.000Z"
}
```

`TeamId` og `TeamNavn` er alltid begge med, men bare én er utfylt: ser verdien
administratoren skrev ut som en GUID, sendes den som `TeamId`, ellers som
`TeamNavn`. **Bruk `TeamId` når den er satt** — to team kan hete det samme, og
da er det tilfeldig hvilket et navneoppslag treffer.

Flyten skal:

1. Slå opp teamet (`TeamId`, ellers `TeamNavn`).
2. Hente dagens medlemmer.
3. Melde inn alle i `Medlemmer` som ikke er medlem.
4. Melde ut alle medlemmer som ikke er i `Medlemmer`.
5. Ikke røre eiere av teamet — de administrerer det, og skal ikke kunne
   meldes ut av en liste de ikke står på.

Se «Slik bygger du flyten» under for hvordan punkt 2–4 gjøres uten løkke, og
for fallgruvene i Graph.

Flyten får `FLOW_CALLBACK_KEY` som header, som de andre flytene.

`VARSLING_DEAKTIVERT=true` slår også av denne. Bryteren betyr «ikke rør noe
utenfor systemet», og en destruktiv teamoppdatering er nettopp det.

## Slik bygger du flyten

### Ikke tøm og fyll på nytt

Det finnes **ikke** noe «fjern alle medlemmer»-kall i Graph, og det er like
greit — du vil ikke ha det. `Medlemmer` er en ØNSKET TILSTAND, ikke en
instruks om å nullstille. Regn ut differansen:

* Tømmer du først, får alle som skal bli i teamet «du er fjernet fra …» og
  mister tilgang i mellomtiden. Teams kan bruke lang tid på å reprovisjonere.
* En feil midt i løkka etterlater teamet halvtomt. Med differanse er verste
  utfall at noen få ikke ble oppdatert.
* På en liste med 200 der 3 har sluttet: 3 kall i stedet for 400.

### Hent dagens medlemmer — hele lista

```
GET /groups/{group-id}/members?$select=id,userPrincipalName&$top=999
GET /groups/{group-id}/owners?$select=id,userPrincipalName&$top=999
```

**Følg `@odata.nextLink` til den er borte.** Graph paginerer på 100 uten
`$top`, og et team på 200 ville da gitt en flyt som bare ser halve laget.
Feilen er stille: innmeldingene blir riktige, men de som skulle ut på side 2
blir stående.

### Differansen i to actions, uten løkke

Dette er det som avgjør om flyten tar ett sekund eller flere minutter. De
fleste skriver nøstede `Apply to each`, og det er O(n·m) med en
handlingskjøring per sammenligning. `Filter array` + `contains()` gjør hele
jobben i to steg.

Først: normaliser dagens medlemmer til en flat liste med små bokstaver.
`contains()` matcher hele elementer, ikke felter i objekter, så en `Select`
må til:

```
Select   fra: body('Hent_medlemmer')?['value']
         map: toLower(item()?['userPrincipalName'])
  → dagensUpn  (flat strengliste)
```

Gjør det samme for eierne → `eiereUpn`.

`Medlemmer` fra oss er allerede små bokstaver, uten duplikater og sortert —
det er gjort med vilje, nettopp for at denne sammenligningen skal bli enkel.

**Skal meldes inn** — filtrer vår liste:

```
Filter array   fra: triggerBody()?['Medlemmer']
               der: not(contains(variables('dagensUpn'), item()))
```

**Skal meldes ut** — filtrer *de rå medlemsobjektene*, ikke den projiserte
lista. Du trenger `id` til DELETE-kallet, og har du projisert den bort, må du
slå den opp igjen:

```
Filter array   fra: body('Hent_medlemmer')?['value']
               der: and(
                      not(contains(triggerBody()?['Medlemmer'], toLower(item()?['userPrincipalName']))),
                      not(contains(variables('eiereUpn'), toLower(item()?['userPrincipalName'])))
                    )
```

Den andre betingelsen er eier-vernet fra punkt 5. En eier er som regel også
medlem, og uten den linja kan flyten melde deg ut av ditt eget team.

Deretter én `Apply to each` over hvert resultat. De er som regel korte.

### Kallene

**Melde inn** — du trenger ikke slå opp bruker-ID først; en
directoryObjects-referanse godtar UPN i URL-en:

```
POST /groups/{group-id}/members/$ref
{ "@odata.id": "https://graph.microsoft.com/v1.0/users/@{item()}" }
```

*(Verifiser dette mot et testteam første gang. Fungerer det ikke, gjør et
`GET /users/{upn}?$select=id` først og bruk `/directoryObjects/{id}`.)*

**Melde ut:**

```
DELETE /groups/{group-id}/members/@{item()?['id']}/$ref
```

### Når kallet svarer 401

```
DirectApiAuthorizationRequired
The request must be authenticated only by Shared Access scheme
```

Denne høres ut som manglende rettigheter, men betyr nesten alltid at
**signaturen ikke var med i URL-en**. Power Automate signerer trigger-URL-en
med en SAS i spørringsstrengen (`sp`, `sv`, `sig`). Kopieres bare delen foran
`?`, er kallet usignert — og flyten svarer 401 uansett hvem som ringer.

**Den vanligste årsaken er en høne-og-egg-felle i Power Automate selv:**
signaturen finnes ikke i URL-en før flyten har kjørt minst én gang. Og flyten
kan ikke kjøre uten at noen gjør en POST mot URL-en — som altså ikke virker
ennå. Observert 21.09.2026.

Bryt sirkelen ved å utløse flyten fra Power Automate én gang («Test» →
«Manually»), lagre, og deretter hente URL-en på nytt. Den skal nå ha `sig=`.
Hent den på nytt HVER gang du har vært inne og endret triggeren.

Er URL-en komplett og kallet fortsatt 401, sjekk i denne rekkefølgen:

1. **Er hele URL-en med?** Den skal slutte på noe i retning av `&sig=...`.
   Hent den fra feltet «HTTP POST URL» øverst i Request-triggeren, ikke fra
   adressefeltet i nettleseren.
2. **Ble ampersandene HTML-kodet?** Noen grensesnitt gir `&amp;sig=` ved
   kopiering. Da havner signaturen i et parameter som heter `amp;sig`.
3. **Ble URL-en satt i riktig skall?** I `cmd.exe` og enkelte `.env`-lesere
   kuttes strengen ved første `&`. I PowerShell må den stå i anførselstegn:
   `$env:TEAM_FLOW_URL = "https://...&sig=..."`.
4. **Er «Who can trigger the flow» satt til «Anyone»?** Står den på
   «Any user in my tenant» eller «Specific users», krever flyten Entra-token
   og ikke SAS — og da virker ikke en signert URL alene.

`scripts/test-team-flyt.ps1` sjekker punkt 1 og 2 før den kaller, og retter
punkt 2 selv.

**URL-en er en hemmelighet.** Den gir hvem som helst rett til å kjøre flyten.
Den hører hjemme i app settings og i `TEAM_FLOW_URL` lokalt — ikke i en
chatlogg, et issue eller en commit.

### Fallgruver

**`/teams/{id}/members` er noe annet enn `/groups/{id}/members`.** Det første
bruker `conversationMember`-ID-er som ikke er gjenbrukbare mellom kall. For
medlemskap er gruppe-endepunktet enklere og mer forutsigbart — teamet følger
gruppen.

**Struping.** Graph struper per tenant, og `$batch` teller hver delforespørsel
for seg. Ved store endringer bør flyten håndtere 429 med `Retry-After`.
Trenger du fart, tar `POST /$batch` inntil 20 forespørsler per kall.

**`PATCH /groups/{id}` med `members@odata.bind`** skal etter sigende erstatte
hele medlemslista i ett kall. Den har uansett en grense på 20 oppføringer per
forespørsel og er derfor ubrukelig for lister av vår størrelse — og oppførselen
bør bekreftes mot et testteam før noen stoler på den. Differansen over er
tryggere og raskere.

**Arkiverte team er skrivebeskyttet.** Et kall mot et arkivert team feiler;
flyten bør si fra med en forståelig feil i stedet for å logge en rå 403.

## Endepunkter

| Metode | Rute | Tilgang |
|---|---|---|
| GET | `/api/team-synk` | admin |
| POST | `/api/team-synk` | scheduler eller admin — kjører alle |
| POST | `/api/team-synk/{rolle}` | scheduler eller admin — én gruppe, `{ omfang, tillatFall }` |
| PUT | `/api/team-synk/{rolle}` | admin — `{ omfang, team }` |

`/api/team-synk` har `allowedRoles: ["anonymous"]` i `staticwebapp.config`,
fordi den daglige kjøringen ikke har noen SWA-cookie. Nøkkelsjekken gjøres i
koden, som for backup og postnumre.

## Lagring

Ny tabell **`Rollegruppe`** — PK = Rolle, RK = Omfang (eller `*` når omfanget
er tomt, siden RowKey ikke kan være tom streng).

Innstillingen ligger ikke på medlemsradene, slik `Rollebeskrivelse` gjør.
Grunnen: da ville team-koblingen forsvunnet med siste medlem, og teamet blitt
stående med gamle medlemmer for alltid. En gruppe som går fra 40 til 0 er
nettopp tilfellet der noen må få vite det.
