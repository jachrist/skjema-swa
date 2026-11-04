# Ekstern innsender (OTP-basert tilgang)

Lar personer utenfor Forsvaret fylle ut skjemaer uten Entra-konto. Verifisering
via OTP-flyt på e-post i stedet for SWA-cookie. SMS er ikke i bruk og ikke
planlagt — se `docs/FASE-OTP.md`.

## Datamodell

**Skjematype:**
```json
{
  "EksternTilgang": true
}
```

> `EksternTilgang` styrer **to** ting, ikke bare OTP-flyten:
>
> 1. Anonym utfylling via `?ekstern=1`, verifisert med OTP — beskrevet her.
> 2. Om skjematypen kan masseutsendes. `POST /api/utsending` avviser en batch
>    for en skjematype uten flagget.
>
> Felles for begge er at de gir tilgang uten Entra-pålogging, og det er det
> valget flagget representerer. Se `docs/FASE-UTSENDING-SAMMENSLAING.md`.

**Skjema-forekomst (innsendt av ekstern):**
```json
{
  "Innsender_Epost": "ola@example.no",
  "Innsender_Kanal": "epost",               // eldre rader kan ha "sms"
  "EksternInnsender": true
}
```

## Aktivering

1. Åpne skjematype i editor → Tilgang-panelet
2. Kryss av **"Tillat innsending fra eksterne via engangskode"**
3. "Ekstern tilgangs-URL"-boks dukker opp — kopier og distribuer via e-post,
   nettside eller QR-kode

URL-format: `https://<swa>/index.html?skjematype_id=X&ekstern=1`

## Brukerflyt (ekstern)

1. Ekstern klikker lenken
2. `index.html` sjekker `?ekstern=1` og henter skjematype fra
   `GET /api/skjematyper/{id}/publikum` (anonymt endepunkt som kun returnerer
   skjematyper med `EksternTilgang=true`)
3. OTP-widget åpnes: bruker skriver e-post → får 6-sifret kode
   → skriver kode → widget returnerer signert verifikasjonstoken
4. Frontend lagrer token som default `x-otp-token`-header via
   `api.settHeader()` — følger med alle senere API-kall
5. Skjemaet vises. Bruker fyller ut, laster opp vedlegg, sender inn eller
   mellomlagrer.
6. Ved lagring: backend validerer token, bruker mottaker som `Innsender_Epost`
   (e-post)

## Endepunkter (anonyme, aksepterer x-otp-token)

Alle endepunkter håndterer BÅDE SWA-cookie og OTP-token. Ingen ekstra
konfig nødvendig — auth-flowen velges basert på request-headers.

- `GET  /api/skjematyper/{id}/publikum` — kun definisjon, uten cookie/token
- `GET  /api/ny-skjema-id/{skjematypeId}` — genererer nytt Skjema_id
- `POST /api/skjemaer` — lagre/oppdater
- `GET  /api/skjemaer/{type}/{id}` — hent (kun eget skjema)
- `POST /api/vedlegg/...` — opplasting/nedlasting

## Sikkerhetsmodell

**Ekstern får IKKE:**
- Se andres skjemaer (token krysssjekkes mot Innsender_Epost)
- Endre andres skjemaer (samme sjekk ved POST)
- Behandle noe (kun innloggede brukere kan være behandlere)
- Se Behandling-info, Dialog, register, datauttrekk (kun eget innhold)

**Rate-limit på OTP:** 60s mellom nye koder til samme mottaker, 5 feilforsøk
= koden slettes.

**Token-levetid:** 30 min. Etter utløp må ekstern åpne lenken på nytt og
verifisere igjen. Samme e-post gir tilgang til samme mellomlagrede
skjema — så det er ikke krøkkete å bli avbrutt midt i utfyllingen.

**Ekstern-lenka i seg selv er ikke hemmelig:** hvem som helst med lenken kan
åpne skjemaet, men må gjennom OTP for å faktisk sende inn. Distribusjon kan
være åpen (nettside) eller lukket (spesifikk e-post) — det er admin sitt valg.

## Distribusjonsstrategier

- **Målrettet e-post:** admin sender lenka til navngitte mottakere
- **Offentlig nettside:** legg lenka på FHS-side, alle kan bruke
- **QR-kode:** trykk lenka som QR på plakat/dokument
- **Kombinasjon:** samme URL, ulike kanaler

## Testing

1. Aktiver `EksternTilgang` på en skjematype
2. Åpne lenka i inkognito-vindu (uten SWA-cookie)
3. Widget dukker opp → velg e-post, skriv egen adresse → få kode → verifisere
4. Fyll ut skjema → send inn
5. Åpne register (innlogget som eier) → sjekk at skjemaet vises med din
   e-post som Innsender

Sett `VARSLING_DEAKTIVERT=true` for dry-run: OTP-koden logges til
Application Insights i stedet for å sendes.

## Lenker i e-post til en ekstern innsender (sak-lenke)

Kvitteringen, beslutningsvarselet og samtalevarselet lenker til saken. Fram
til 04.11.2026 krevde de lenkene innlogging, og en ekstern har ingen konto:
OTP-tokenet lever i 30 minutter, og en utsendingslenke er brukt opp i det
svaret sendes inn.

Lenkene til en ekstern innsender bærer nå `&t=<sak-token>`
(`api/src/lib/sak-token.js`):

| | |
|---|---|
| Bundet til | én skjematype, ett skjema og én adresse |
| Levetid | 180 dager, regnet fra e-posten — hvert varsel utsteder et nytt |
| Gir | det innsenderen ville hatt innlogget: lese saken, samtalen og PDF-en, og rette saken når den er sendt tilbake (status 3) |
| Gir ikke | en annen sak, en ny innsending, eller endring av en sak som ikke er sendt tilbake |
| Hvem får det | innsendere merket `EksternInnsender` (OTP) eller `Utsending_BatchId` — `erEksternInnsender()` i `lib/ekstern-auth.js` |

Tokenet sjekkes mot saken på hvert kall (`autentiserSak`): er innsenderen en
annen enn tokenet ble utstedt til, avvises det. Signaturen bruker
`OTP_HMAC_KEY` med et eget domeneprefiks, så et OTP- eller utsendingstoken
kan ikke legges fram som sak-token, eller omvendt.

**Rett etter innsending** svarer lagringen med det samme tokenet
(`SakToken`), og `index.html` tar det med til kvitteringen. Kvitteringen,
samtalen og «Se skjemaet» virker dermed med én gang, ikke først når e-posten
kommer.

**Kopimottakere på kvitteringen** får en egen e-post med den vanlige lenka.
Sak-tokenet er innsenderens adgang og skal ikke ligge i en e-post andre også
leser.

Sidene leser tokenet via `frontend/js/sak-lenke.js`: `visning.html`,
`kvittering.html` og `index.html` (retting). Definisjonen hentes fra
`/api/publikum-skjematype/{id}`, fordi `/api/skjematyper/*` krever innlogging
i SWA-rutene.

## Kjente begrensninger

- **Vedlegg for eksterne.** Opplasting og nedlasting går med `fetch` uten
  token-headere, og `/api/vedlegg-fil/*` krever innlogging i SWA-rutene. En
  ekstern kan derfor ikke laste opp nye vedlegg ved retting, eller laste ned
  vedlegg fra visningen. PDF-en tar vedleggene med.

- Ingen "gjenåpne innsendt skjema"-mulighet for ekstern (kunne legges til
  med samme mekanisme som mellomlagret)
- Innsender-varsling (kvittering) forutsetter e-post-mottaker. Det er ikke
  lenger en begrensning i praksis: OTP går bare på e-post, så en verifisert
  ekstern innsender har alltid en adresse.
