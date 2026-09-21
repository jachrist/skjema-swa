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

Flyten får `FLOW_CALLBACK_KEY` som header, som de andre flytene.

`VARSLING_DEAKTIVERT=true` slår også av denne. Bryteren betyr «ikke rør noe
utenfor systemet», og en destruktiv teamoppdatering er nettopp det.

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
