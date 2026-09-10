# Power Automate-flyter og periodiske jobber

Hvilke flyter løsningen faktisk trenger, hva som utløser hver av dem, og hva
som kjører på klokke.

Skrevet fordi svaret bare fantes i en samtale. `scripts/migrer/flyt-bruk.js`
avsluttet med «se oversikten i samtalen» — og den samtalen var borte da
spørsmålet kom opp igjen. Denne fila er den oversikten.

> **Repoet sier hvilke flyter som trengs, ikke hvilken versjon som er koblet
> opp.** Adressene ligger i SWA Configuration, ikke her. Har du flere versjoner
> av samme flyt, er `GET /api/system/info` som admin den raskeste veien til å
> se hvilken som faktisk er i bruk i et miljø — den lister alle åtte
> flyt-adressene maskert, med vertsnavn.
>
> `config/env.*.json` svarer ikke på dette. Filene deklarerer 2–3 av de åtte,
> og er ikke autoritative (backlog 29).

## Flyter vi kaller ut til

### Alltid i bruk

| App setting | Kalt fra | Utløses av |
|---|---|---|
| `VARSLING_FLOW_URL` | `lib/flyt-kaller.js` | all varsling |
| `UTSENDING_FLOW_URL` | `functions/utsending.js` | cron 05:00 daglig |
| `PURRE_FLOW_URL` | `functions/utsending.js` | cron 06:00 daglig |
| `BACKUP_FLOW_URL` | `functions/backup.js` | hver backup-kjøring |
| `TEAM_SOK_EKSTERNT_FLOW_URL` | `functions/team.js` | admin søker etter team |
| `TEAM_LAST_MEDLEMMER_FLOW_URL` | `functions/team.js` | admin laster teammedlemmer |

`VARSLING_DEAKTIVERT=true` skrur av utgående kall for både varsling og OTP —
de logges i stedet. Nyttig i et testmiljø, og verdt å sjekke først når «flyten
trigges ikke».

### Betinget — koden leser dem, men bare hvis dataene ber om det

Å lese koden svarer derfor ikke på om flyten kan fjernes. Det er disse
`scripts/migrer/flyt-bruk.js` teller, ved å gå gjennom Skjemadefinisjoner:

| App setting | Utløses av |
|---|---|
| `SP_LISTE_FLOW_URL` | skjematyper med **både** `SPListeadresse` og `SPListenavn` |
| `OTP_FLOW_URL` | skjematyper med `EksternTilgang=true` |
| `Flyt_url` per steg | ikke en app setting — adressen ligger på behandlingssteget i skjemadefinisjonen |

```
node scripts/migrer/flyt-bruk.js --conn "<connection string>"
```

Skriptet endrer ingenting og skriver bare vertsnavn, ikke hele adresser med
signatur, så utskriften kan limes inn i en sak.

### To ting som reduserer antallet flyter

**Varslingsflyten er en dispatcher.** Den tar fire `handling`-verdier, så det
er én flyt — ikke fire:

| `handling` | Sendes fra |
|---|---|
| `sendInnsenderKvittering` | `sendInnsenderKvittering()` |
| `sendBehandlingsVarsling` | `sendBehandlerVarsling()` |
| `sendBeslutningVarsling` | `sendBeslutningVarsling()` |
| `sendFerdigVarsling` | `sendFerdigVarsling()` |

**Utsending og purring kan være samme flyt.** `flytUrlFor()` i
`functions/utsending.js` faller tilbake på den andre når bare én er satt, og de
to skilles på `handling` (`sendUtsendinger` / `purreUtsendinger`). To app
settings kan altså peke på samme adresse.

De to team-flytene sender ingen `handling` — de har hvert sitt endepunkt og
hver sin nyttelast.

### Tidsgrenser

SWA-gatewayen kutter et kall etter ~45 sekunder. Kallene har egne grenser under
det, så en treg flyt ikke kveler kjøringen og feilen kommer som en naken 502:

| Kaller | Grense |
|---|---|
| `functions/utsending.js` | 35 s |
| `functions/team.js` | 35 s |
| `functions/backup.js` | 4 min — går mot en egen jobb, ikke et brukerkall |

## Flyter som kaller inn til oss

Autentiseres med `x-flow-key`, som må matche `FLOW_CALLBACK_KEY`:

- `functions/skjemaer.js` — fullfører et behandlingssteg. Callbacken får bare
  fullføre steg som faktisk har `Flyt_url`; uten den begrensningen ville
  nøkkelen gitt tilgang til å avgjøre hvilket som helst steg.
- `functions/backup.js` — flyten melder tilbake om fila landet i OneDrive.
- `functions/team.js`, `functions/utsending.js` — samme nøkkel.

## Det som kjører regelmessig er ikke flyter

Timer-triggere finnes ikke i SWA Managed Functions. Alt periodisk er derfor
GitHub Actions-cron mot HTTP-endepunkter, autentisert med `x-scheduler-key`
mot `SCHEDULER_KEY`:

| Workflow | Plan (UTC) | Endepunkt |
|---|---|---|
| `backup.yml` | 02:00 — søndag full, man–lør delta | `/api/backup/kjor` |
| `refresh-fs.yml` | 04:00 daglig | `/api/refresh-fs` |
| `send-utsendinger.yml` | 05:00 daglig | `/api/utsending/send-forfalte` |
| `purre-utsendinger.yml` | 06:00 daglig | `/api/utsending/purre` |
| `sjekk-nokler.yml` | 07:00 daglig | `/api/nokkelkalender/sjekk` |
| `refresh-postnumre.yml` | 04:30 den 15. i januar og juli | `/api/postnumre/refresh-bring` |

Rekkefølgen 05:00 → 06:00 er ikke tilfeldig: utsendingene skal være sendt før
purringen ser etter hvem som ikke har svart.

Kun manuelle (`workflow_dispatch`): `refresh-fs-diag.yml`,
`refresh-fs-diag-lu.yml`, `deploy-prod.yml`.

## Når en flyt ikke ser ut til å bli kalt

1. `GET /api/system/info` som admin — er adressen i det hele tatt satt i dette
   miljøet, og peker den dit du tror?
2. `VARSLING_DEAKTIVERT` — står den på `true`, logges kallet i stedet for å
   sendes.
3. `GET /api/varsling/diag/{skjematypeId}/{skjemaId}` som admin — tørrkjører
   varslingen for ett skjema og sier hvorfor den eventuelt hoppes over.
   Mottakerkravet gjelder **alle** kanaler, også Planner alene: en oppgave uten
   ansvarlig lager vi ikke. Det er den vanligste grunnen til at en
   Planner-oppgave uteblir.
4. For de betingede: `scripts/migrer/flyt-bruk.js` — er det noen data som
   utløser flyten?
