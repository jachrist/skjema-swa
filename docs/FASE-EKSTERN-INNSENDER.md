# Ekstern innsender (OTP-basert tilgang)

Lar personer utenfor Forsvaret fylle ut skjemaer uten Entra-konto. Verifisering
via OTP-flyt (SMS eller e-post) i stedet for SWA-cookie.

## Datamodell

**Skjematype:**
```json
{
  "EksternTilgang": true
}
```

**Skjema-forekomst (innsendt av ekstern):**
```json
{
  "Innsender_Epost": "ola@example.no",     // eller "mobil:+4741234567"
  "Innsender_Kanal": "sms",                 // eller "epost"
  "EksternInnsender": true
}
```

## Aktivering

1. Åpne skjematype i editor → Tilgang-panelet
2. Kryss av **"Tillat innsending fra eksterne via engangskode"**
3. "Ekstern tilgangs-URL"-boks dukker opp — kopier og distribuer via e-post,
   SMS, nettside eller QR-kode

URL-format: `https://<swa>/index.html?skjematype_id=X&ekstern=1`

## Brukerflyt (ekstern)

1. Ekstern klikker lenken
2. `index.html` sjekker `?ekstern=1` og henter skjematype fra
   `GET /api/skjematyper/{id}/publikum` (anonymt endepunkt som kun returnerer
   skjematyper med `EksternTilgang=true`)
3. OTP-widget åpnes: bruker skriver mobilnr eller e-post → får 6-sifret kode
   → skriver kode → widget returnerer signert verifikasjonstoken
4. Frontend lagrer token som default `x-otp-token`-header via
   `api.settHeader()` — følger med alle senere API-kall
5. Skjemaet vises. Bruker fyller ut, laster opp vedlegg, sender inn eller
   mellomlagrer.
6. Ved lagring: backend validerer token, bruker mottaker som `Innsender_Epost`
   (e-post) eller `mobil:<nr>` (SMS)

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
verifisere igjen. Samme mobilnr/e-post gir tilgang til samme mellomlagrede
skjema — så det er ikke krøkkete å bli avbrutt midt i utfyllingen.

**Ekstern-lenka i seg selv er ikke hemmelig:** hvem som helst med lenken kan
åpne skjemaet, men må gjennom OTP for å faktisk sende inn. Distribusjon kan
være åpen (nettside) eller lukket (spesifikk e-post) — det er admin sitt valg.

## Distribusjonsstrategier

- **Målrettet e-post/SMS:** admin sender lenka til navngitte mottakere
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

## Kjente begrensninger

- Ekstern kan ikke laste ned PDF av eget skjema (kunne legges til)
- Ingen "gjenåpne innsendt skjema"-mulighet for ekstern (kunne legges til
  med samme mekanisme som mellomlagret)
- Innsender-varsling (kvittering) må ha e-post-mottaker — SMS-basert
  innsender får ingen kvittering per nå (kunne bruke Innsender_Kanal for
  å velge kanal)
