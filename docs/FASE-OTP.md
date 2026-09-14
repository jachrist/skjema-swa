# OTP/kontrollkode-verifisering på e-post

Infrastruktur for engangskode-verifisering av mottaker. Bygget som
PA-flyt-basert kanal for konsistens med varsling-flyten (fase 6a).

> **SMS er ikke i bruk, og er ikke planlagt.** Tjenesten ble aldri innført, og
> kanalen regnes som usikker for engangskoder.
>
> Den var likevel tilbudt i grensesnittet fram til 14.09.2026, og utfallet var
> stille: endepunktet svarer alltid `status: "ok"` for å hindre enumerasjon, så
> den som valgte SMS fikk kvittering, ventet på en kode som ikke fantes, og
> traff rate-begrensningen ved neste forsøk. `validerKanal` i
> `api/src/functions/otp.js` godtar nå bare `epost`, og widgeten tilbyr bare
> den.
>
> `kanal` står igjen i kontrakt og lagring. Feltet er generelt — RowKey er
> `hash(kanal + ':' + mottaker)` — og eldre rader kan ha andre verdier.

## Bruksscenarier

- **Ekstern innsender-verifisering:** bruker uten Entra-konto legger inn
  e-post, får kode, verifiserer, får et token som beviser eierskap ved
  påfølgende innsending
- **2FA for sensitive handlinger:** krev fersk kode-verifisering før admin-
  operasjoner
- **Generell infrastruktur** — widget kan gjenbrukes fra hvilken som helst side

## Env-vars

I SWA Configuration:

```
OTP_FLOW_URL   = <PA-flyt-URL som sender OTP via valgt kanal>
OTP_HMAC_KEY   = <tilfeldig streng, min 32 tegn>   # signerer verifikasjons-token
```

`OTP_HMAC_KEY` er ikke en delt hemmelighet — bare backend trenger den.
Ved rotasjon blir alle utestående tokens ugyldige (akseptert, siden TTL er 30 min).

## PA-flyt-kontrakt (`OTP_FLOW_URL`)

**Trigger:** "When a HTTP request is received"

**Payload som mottas:**
```json
{
  "handling": "sendOtp",
  "miljø": "pilot",
  "kanal": "epost",
  "mottaker": "ola@example.no",
  "kode": "123456",
  "gyldig_minutter": 15
}
```

**Flyten skal:** sende e-post til `mottaker` med `kode` i kroppen — Office 365
«Send an email», subject «Din kode».

`kanal` er alltid `"epost"`. Backend slipper ikke andre verdier gjennom, så
flyten trenger ingen switch.

Retur er ikke krevd; backend logger kun HTTP-status.

## Endepunkter

Begge anonym-tilgjengelige (ekstern innsender har ikke SWA-cookie).

### `POST /api/otp/be-om-kode`
```json
{ "kanal": "epost", "mottaker": "ola@example.no" }
```
**Alltid** respons `{"status": "ok"}` — anti-enumerasjon. Feil (ugyldig kanal,
ugyldig format, rate-limitert) logges internt uten å lekke til klient.

Rate-limit: 60 sekunder mellom nye koder til samme mottaker.

### `POST /api/otp/verifiser-kode`
```json
{ "kanal": "epost", "mottaker": "ola@example.no", "kode": "123456" }
```
**Suksess:**
```json
{ "status": "ok", "verifikasjonstoken": "<base64url>.<sig>", "gyldig_minutter": 30 }
```
**Feil:**
```json
{ "status": "feil-kode", "forsok_igjen": 3 }
{ "status": "utlopt" }
{ "status": "blokkert" }   // > 5 feilforsøk — kode slettes
```

## Verifikasjons-token

HMAC-SHA256-signert. Format: `<base64url(payload)>.<base64url(sig)>`

Payload:
```json
{ "k": "epost", "m": "ola@example.no", "exp": 1738240000000 }
```

Backend validerer via `require('./lib/otp-token').valider(token)` — returnerer
`{ gyldig, kanal, mottaker }`. Ingen storage-oppslag; helt selv-validerende.

**Bruk i innsending:** frontend sender med header `x-otp-token: <token>`, og
backend krysssjekker at `mottaker` matcher det som ble skrevet i skjemaet.

## Frontend-widget

`frontend/js/otp-widget.js` eksporterer `apneOtpModal(options)`:

```js
import { apneOtpModal } from './js/otp-widget.js';

const res = await apneOtpModal({
    tittel: 'Verifiser e-postadressen',
    tekst: 'Vi sender en 6-sifret kode for å bekrefte at adressen er din.',
    kanaler: ['epost']
});
if (res) {
    // res.verifikasjonstoken kan sendes med innsending
    // res.kanal, res.mottaker gir kontekst
}
```

Widget-en har to skjermer: mottaker-inntasting → kode-inntasting. Selvinjekterende
CSS så den fungerer standalone.

## Sikkerhetsmodell

- Koder lagres **kun som SHA-256(mottaker:kode)** — aldri klartekst
- **6 sifre = ~1M mulige koder**, 5 feilforsøk = 5/1M sannsynlighet for tilfeldig treff
- Kode-utstedelse og verifisering bruker **constant-time compare** (`timingSafeEqual`)
- Token er **selv-validerende (HMAC)** — ingen databasekontakt per API-kall
- **Anti-enumerasjon** på be-om-kode (alltid ok)
- Rate-limit på 60s hindrer bombing av mottakere

## Åpne punkter

- Ingen kontekstuell tilknytning ennå — token beviser bare mottaker-eierskap,
  ikke hvem som gjorde det. Ved integrasjon i innsending må skjemaet holde
  koblingen `felt-verdi (e-post) ↔ verifikasjonstoken`
- Token kan gjenbrukes innen 30 min. Vurder single-use hvis det er behov
- Ingen bruk av widget-en fra eksisterende sider ennå — infrastruktur klar
