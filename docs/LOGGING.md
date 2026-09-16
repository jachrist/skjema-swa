# Hvor loggene er

**SWA Managed Functions har ingen Log stream.** Det bladet finnes bare på en
ordinær Function App. Leter du etter det i SWA-ressursen, finner du ingenting —
og det er lett å lese som at ingenting logges.

Alt går til **Application Insights** (`ai-fhsskjema-pilot` / `ai-fhsskjema-prod`).
Derfra er det to veier inn, og de svarer på hvert sitt spørsmål.

## Live: mens noe skjer

Application Insights → **Live metrics**.

Panelet **Sample telemetry** nederst til høyre ruller meldinger etter hvert som
de kommer, med rundt ett sekunds forsinkelse. Det er dette som ligner en
logg-strøm, og det er det du vil ha åpent mens du kjører en test.

Merk at panelet viser et *utvalg* når det er mye trafikk. På dev er det sjelden
et problem.

## Etterpå: når du vil ha det skriftlig

Application Insights → **Logs**. Forsinkelsen er 1–3 minutter, så den er
ubrukelig til å følge med live — og presis i etterkant.

Appens egne linjer:

```kusto
traces
| where timestamp > ago(15m)
| where message has_any ("varsling:", "roller-swa:", "flyt", "backup:")
| project timestamp, message
| order by timestamp asc
```

Kom kallet fram i det hele tatt:

```kusto
requests
| where timestamp > ago(15m)
| project timestamp, name, url, resultCode, duration, success
| order by timestamp desc
```

## Sampling: en linje som mangler beviser ingenting

`api/host.json` har sampling slått på. Application Insights kan da droppe
enkeltmeldinger under last — og når du jakter på én bestemt hendelse, er det
akkurat den som kan mangle.

```json
"samplingSettings": { "isEnabled": true, "excludedTypes": "Request" }
```

`excludedTypes: "Request"` gjør at **HTTP-forespørslene alltid kommer med**.
Det er `traces` — våre `context.log`-linjer — som kan bli borte.

Praktisk konsekvens: er spørsmålet «kom kallet fram», er `requests` det
pålitelige svaret. `traces` sier hva koden mente om det, når linja rakk fram.

## Linjer det er verdt å kjenne igjen

| Linje | Hva den betyr |
|---|---|
| `roller-swa: <upn> → admin` | rollekallet svarte, brukeren fikk admin ved innlogging |
| `roller-swa: <upn> → ingen roller` | kallet kom fram, men UPN-en står ikke i `ADMIN_UPNS` |
| *(ingen `roller-swa`-linje under en innlogging)* | kallet nådde aldri fram — typisk kaldstart etter en restart |
| `varsling: steg N har ingen mottakere — hopper over` | Personer, Roller og Team løste seg opp til tomt |
| `varsling: steg N har ingen aktive kanaler — hopper over` | ingen kanal er huket av på steget |
| `flyt DRY-RUN: …` | `VARSLING_DEAKTIVERT=true` — payloaden bygges, men sendes aldri |
| `<navn>: PA-flyt (<vertsnavn>) svarte HTTP <kode>` | vi nådde flyten; den svarte med den koden |
| `<navn>: TIMEOUT mot PA-flyt (<vertsnavn>)` | flyten svarte ikke innen 35 sekunder |
| `backup: TODO_STORAGE_CONNECTION_STRING ikke satt — delte tabeller hoppes over` | backupen tar ikke med `TodoPunkter` og `Nokkelkalender` |

Vertsnavnet i flyt-linjene står der med vilje: det skiller en flyt i riktig
miljø fra en som fortsatt peker på dev. Signaturen i query-strengen logges
aldri.

## Det loggen ikke kan svare på

Er `VARSLING_DEAKTIVERT` på, ser en tørrkjørt varsling ut som en vellykket
sending overalt bortsett fra i den ene `DRY-RUN`-linja. Admin-grensesnittet har
derfor et banner øverst når miljøet ikke sender — se `frontend/admin.html`.

`GET /api/varsling/diag` (admin) svarer på det samme uten å lete i loggen:
`varsling_av`, `sender_ikke`, `VARSLING_FLOW_URL_satt` og `base_url_utledet`,
slik den kjørende appen ser dem.
