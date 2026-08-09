# Kryptering + anonymisering av skjemasvar

Portert fra legacy. Aktiveres per skjematype via `Krypteres` og
`Anonymiseres`-innstillinger i editoren.

## Datamodell

**Skjematype (nye topp-nivå-felter):**
```json
{
  "Krypteres": "Nei" | "Svar" | "Alt",
  "Anonymiseres": true | false
}
```

**Skjema-forekomst (settes ved siste ferdig-behandling):**
```json
{
  "Kryptert": true,               // Svar-mode: per-felt-svar er krypterte strenger
  "Anonymisert": true,
  "Innsender_Epost": "anonym-a1b2c3d4e5f6",   // hvis Anonymiseres=true
  "Innsender_Navn": "Anonymisert"
}
```

For **Alt-mode** beholdes kun `Skjema_id` + `Skjematype_id` + `Kryptert: "<iv:tag:ciphertext>"`.

## Algoritme

- **AES-256-GCM** (auth-tag inkludert)
- 12-byte tilfeldig IV per kryptering
- Format: `<iv-hex>:<tag-hex>:<ciphertext-base64>`
- Nøkkel: 256-bit (32 byte) generert med `crypto.randomBytes(32)`

**Svar-mode:** hver Svar-array (fullt format) eller `sva`-array (kompakt)
serialiseres til JSON og krypteres separat. Beholder skjema-struktur og
metadata i klartekst.

**Alt-mode:** hele skjema-objektet serialiseres til JSON og krypteres som
én blob. Nesten alt blir uleselig uten nøkkel.

## Env-vars i SWA Configuration

```
HASH_SALT = <tilfeldig streng>       # for anonymisering av innsender-epost
```

`HASH_SALT` beskytter mot rainbow-tabell-angrep hvis pseudonym-hashen lekker.
Uten salt: samme innsender får samme pseudonym forutsigelig.

Nøkkelen for kryptering lagres per skjematype i Kryptonokler-tabellen —
ikke en env-var.

## Flyt

**Ved siste ferdig-behandling** (`Skjema_status = 5` i POST beslutning):
1. Hvis `definisjon.Anonymiseres`: anonymiser (erstatt Innsender_*)
2. Hvis `definisjon.Krypteres === 'Svar'|'Alt'` OG nøkkel finnes i storage:
   krypter skjemaet
3. Lagre skjema

Feil i (1) eller (2) er ikke-blokkerende: skjemaet lagres uansett (i klartekst
hvis kryptering feilet). Logg-melding skrives til Application Insights.

**Ved lesing (auto-dekryptering):**
- **PDF-generering** (`/api/skjemaer/.../pdf`): henter nøkkel automatisk fra
  Kryptonokler og dekrypterer før rendering
- **Power BI-feed** (`/api/power-bi`): samme — auto-henter og dekrypterer
- **Datauttrekk** (`/api/datauttrekk`): brukers manuelt oppgitte `Nokkel`-input
  har prioritet, ellers auto-hent. Uten nøkkel: kolonner viser `[Kryptert]`
- **Register/evaluering:** ingen auto-dekryptering (viser rå kryptert-streng
  som `[Kryptert]` — bevisst valg så nøkkel ikke lekker via mange endepunkter)

## Endepunkter (nøkkeladministrasjon)

Alle krever eier eller admin på skjematypen.

- `GET  /api/nokkel/{skjematypeId}` — returnerer `{finnes, nokkel?}`
- `POST /api/nokkel/{skjematypeId}/generer` — kun hvis ingen finnes
- `POST /api/nokkel/{skjematypeId}/rekrypter` — Body: `{gammelNokkel}`.
  Dekrypterer alle krypterte skjemaer med gammel nøkkel, krypterer med ny.
  `gammelNokkel` må matche lagret verdi (hindrer at feil nøkkel gjør skade).

## nokkeladmin.html

Ny frontend-side under `/nokkeladmin.html` (authenticated):
- Velg skjematype (må være eier)
- Vis nåværende nøkkel-status + Krypteres/Anonymiseres-konfig
- Generer ny nøkkel (kun hvis ingen finnes)
- Bytt nøkkel (med bekreftelse av nåværende + advarsel)

Auto-åpner en spesifikk skjematype via `?skjematype_id=X` (linkes fra editor).

## Sikkerhetsvurderinger

**Klartekst-metadata i Svar-mode:**
- `Skjema_id`, `Skjematype_id`, `Behandling[]`, `Dialog[]`, `Sist_endret`,
  `Skjema_status`, felt-struktur (spm-tekst) — ALT dette er lesbart uten nøkkel
- Kun `Svar`-verdiene krypteres
- Vurder Alt-mode for høyt sensitive skjematyper

**Nøkkelen er den eneste kopien:**
- Ingen backup, ingen restore, ingen re-generering fra secret store
- Admin/eier må selv lagre en kopi utenfor systemet (f.eks. i Key Vault i
  egen prosess). Nøkkeladmin-siden viser nøkkelen så den KAN kopieres.

**Anonymisering er pseudonym, ikke ekte anonymitet:**
- SHA-256(salt + epost) er deterministisk → samme innsender = samme pseudonym
- 12-hex-suffix = ~64 bits — brute-force mulig hvis salt lekker
- Full anonymitet krever fjerning av alle IP/tid-korrelerte metadata (ikke gjort)

**Nøkkelrotasjon:**
- Rekryptering dekrypterer og krypterer på nytt in-place per skjema
- Feiler et skjema: logges + hoppes over. Ny nøkkel skrives uansett etterpå
  → skjemaer som feilet kan ikke lenger leses (mister gammel nøkkel).
  Vurder å ta backup før rekryptering hvis kritisk

## Bruk

1. Åpne editor for skjematype → sett `Krypteres: Svar` og evt. `Anonymiseres: true`
2. Klikk "Administrer nøkkel" → Nokkeladmin åpnes
3. Generer ny nøkkel → kopier og lagre trygt eksternt
4. Send inn/behandle skjemaer — kryptering skjer automatisk ved siste ferdig
5. Ved uttrekk: nøkkel hentes automatisk (eller lim inn manuelt i datauttrekk)
