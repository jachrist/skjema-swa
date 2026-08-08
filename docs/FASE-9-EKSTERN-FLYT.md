# Fase 9 — Ekstern-flyt-steg

Behandlingssteg som kaller en Power Automate-flyt i stedet for å vente på
en menneskelig beslutning. Steget "henger" i aktiv-tilstand inntil PA-flyten
poster tilbake til beslutning-endepunktet.

## Datamodell (per behandlingssteg)

```json
{
  "Steg": 2,
  "Stegnavn": "Auto-godkjenn små beløp",
  "Flyt_url": "https://prod-XX.westeurope.logic.azure.com/workflows/...",
  "Flyt_parametere": "Kaller Godkjenn-flyt, forventer POST beslutning tilbake",
  "Beslutningsvalg": [{"Nummer": 1, "Tekst": "Godkjent"}]
}
```

- **`Flyt_url`** — full PA-trigger-URL (typisk med sig-query-param)
- **`Flyt_parametere`** — kun for admin-notat i editor. **Sendes ikke** noe sted.

Når `Flyt_url` er satt, dimmes alle vanlige felter (behandlere, varsling,
melding-editorer) i editoren — steget er fullstendig delegert til PA.

## Backend-flyt

1. Ved innsending eller etter beslutning: `beregnAktiveSteg()` finner nye aktive steg.
2. For steg med `Flyt_url` satt:
   - Kaller `kallEksternFlyt(url, skjemaData)` — POST med hele skjemaData som body.
   - Skipper varsling for dette steget (behandlere er ikke relevant).
3. PA-flyten prosesserer og poster beslutning tilbake til:
   ```
   POST https://<swa>/api/skjemaer/{skjematype_id}/{skjema_id}/beslutning
   Headers: x-flow-key: <FLOW_CALLBACK_KEY>
   Body: { "steg": 2, "beslutning": 1 }
   ```
4. Callback-endepunktet aksepterer nøkkelen kun for steg som har `Flyt_url` satt
   (kan ikke misbrukes til å avgjøre menneske-behandlede steg).

## Env-vars som må settes i SWA

```
FLOW_CALLBACK_KEY = <tilfeldig streng — min 32 tegn>
```

Genereres én gang, settes både i SWA Configuration og i hver PA-flyt som
skal kalle beslutning-endepunktet.

## PA-flyt-oppsett (skisse)

Én HTTP-request-triggeret PA-flyt:
1. **Trigger:** "When a HTTP request is received" — payload er hele `skjemaData`
2. **Prosessér** — logikk basert på svar (approver-oppslag, terskler, osv.)
3. **HTTP POST** tilbake til callback-URL med `x-flow-key`-header og
   `{ steg, beslutning }`-body

`Beslutning`-nummer må matche et av `Beslutningsvalg[].Nummer` på steget.

## Sikkerhet

- `FLOW_CALLBACK_KEY` er en delt hemmelighet mellom SWA og PA-flyt. Lagre i KV.
- Callback aksepteres kun for steg med `Flyt_url` satt — beskytter menneske-steg.
- Ingen brukerkontekst i callback — `BehandletAv` settes til `'ekstern-flyt'`.
- Payload til PA inneholder hele skjemaData (alle svar). Vurder klassifisering.

## Testing

Sett `VARSLING_DEAKTIVERT=true` for å skru av alle utgående kall (både varsling,
ekstern-flyt og SP-liste). Loggen viser `ekstern-flyt DRY-RUN: ...`-melding.
