# Sikkerhet

> Denne fila er repo- og driftsnær: branch protection, deploy-identitet,
> nøkkelkalender, rotasjon. **Overleveringsdokumentet til
> sikkerhetsevalueringen er `docs/SIKKERHET-OG-ARKITEKTUR.md`**, og det er den
> som gjelder der de to overlapper.

## Repo-nivå

- **Branch protection** på `main`:
  - Krev PR med minst 1 review (2 for større endringer)
  - Krev signerte commits
  - Blokker force-push og sletting
  - "Include administrators"
  - Påkrevde CI-checks: `test`
- **CODEOWNERS** på `.github/`, `config/`, `staticwebapp.config.*.json`, `api/local.settings.example.json`.
- **Secret scanning** + **push protection**: aktiver i GitHub repo-innstillinger.
- **Dependabot**: ukentlige oppdateringer for `npm` og `github-actions`.

## Deploy-identitet

**Nåværende (pilot):** SWA deployment token i GitHub secret `AZURE_STATIC_WEB_APPS_API_TOKEN`.

**Mål (før produksjon):** OIDC federated credential.
- Opprett Entra-app-registrering for GitHub Actions
- Legg til federated credential med subject `repo:jachrist/skjema-swa:environment:production`
- Gi den `Contributor` kun på selve SWA-ressursen (ikke ressursgruppa)
- Bytt `Azure/static-web-apps-deploy@v1` med `azure/login@v2` + `az staticwebapp` CLI-kall
- Slett deployment token

## Managed Identity

- SWA har system-assigned managed identity slått på
- **Prod** trenger bare `Key Vault Secrets User` og `Key Vault Certificate
  User` på `fhs-kv-01` — det er auth-sertifikatet plattformen henter. Ingen
  storage-roller
- **Pilot** har i tillegg `Storage Table Data Contributor` og `Storage Blob
  Data Contributor`. De er levninger fra det opprinnelige designet, har ingen
  praktisk effekt, og skal ikke kopieres til nye miljøer

**Merk: MI-en brukes ikke til app settings i det hele tatt.**

Her sto det tidligere at hosten løser `@Microsoft.KeyVault(...)`-referanser ved
oppstart. Det er feil, og feilen var dyr: den motsa
`config/keyvault-secrets.md`, og den fikk det til å se ut som hemmelighetene
bare ligger som pekere i SWA Configuration. De ligger i klartekst.

Prøvd i pilot 12.10.2026: `TEAM_SOK_EKSTERNT_FLOW_URL` ble satt til en
`@Microsoft.KeyVault(SecretUri=…)`-referanse, og `/api/system/info` meldte
«ikke en gyldig URL» med lengde 109 — altså selve referansestrengen. SWA
Managed Functions løser dem ikke, uansett rolletildeling.

To ting følger, og de blandes lett:

- **Koden** kan ikke hente token fra MI — identity-endepunktet eksponeres ikke
  til funksjonskoden. Derfor går all lagring via connection string, og
  `api/src/lib/keyvault.js` er ubrukt.
- **Hosten** løser ikke referanser i app settings. Verdien må limes inn som
  klartekst.

Begge delene følger av at API-et kjører som *managed functions*. En egen
Function App lenket til SWA-en støtter begge — se
`docs/BESLUTNING-EGEN-FUNCTION-APP.md`.

Den ene MI-bruken som faktisk virker, er auth-sertifikatet i
`staticwebapp.config.prod.json` — den leses av SWA-plattformens
auth-komponent, ikke av app-settings-laget.

### Konsekvens som må være kjent

Hemmelighetene står i klartekst i SWA Configuration. Den som kan **lese app
settings** på SWA-ressursen, ser dem — inkludert `sig=`-signaturene i
flyt-URLene og `STORAGE_CONNECTION_STRING`.

Å liste app settings er en privilegert ARM-operasjon
(`Microsoft.Web/staticSites/listAppSettings/action`); en ren *Reader* får dem
ikke. Eksponeringen går altså til dem som allerede kan endre appen. Det er
likevel svakere enn en ekte referanse, og det er **plattformvalget** som
bestemmer det — ikke en beslutning vi har tatt. Blir SWA Managed Functions
en dag i stand til å løse referanser, er dette første sted å se igjen.

Appen lekker dem ikke selv: `/api/system/info` viser bare lengde, og for
flyt-URLer bare vertsnavn og sti — aldri query-strengen der signaturen ligger.

## Key Vault

- Alle hemmeligheter i `kv-fhsskjema-pilot` (pilot) / `fhs-kv-01` (prod)
  — navnene er lest ut av pilots `KEYVAULT_NAME` og av
  `staticwebapp.config.prod.json`, ikke av hukommelsen
- Se `config/keyvault-secrets.md` for oversikt og rotasjonspolicy
- **Verdiene når IKKE appen via Key Vault-referanser.** Det sto her til
  13.10.2026, og motsa seksjonen rett over i samme fil. Referansene løses ikke
  (se Managed Identity), så verdien må limes inn i SWA Configuration som
  klartekst. En rotert hemmelighet får effekt når den er limt inn og appen har
  restartet.

## Nøkkelkalender

Hemmeligheter som utløper er den vanligste kilden til plutselig driftsstans, og
den vanskeligste å oppdage på forhånd. Admin-panelet har derfor fanen
**🗓 Nøkkelkalender** (`/admin.html#nokkelkalender`), som fører opp hver
hemmelighet med:

- **utløpsdato** og hvor mange dager det er igjen,
- **hvor den ligger** (Key Vault, SWA Configuration, GitHub Secrets),
- **konsekvens ved utløp** — hva som slutter å virke, og for hvem,
- **rotasjonsprosedyre** — steg for steg, skrevet for en som ikke bygde løsningen.

`.github/workflows/sjekk-nokler.yml` kaller `POST /api/nokkelkalender/sjekk`
daglig kl. 07:00 UTC. Endepunktet varsler `ADMIN_UPNS` på e-post når en
hemmelighet passerer et nytt trinn — først på radens egen varslingsfrist,
deretter 14, 7, 3 og 1 dag før, og så daglig etter utløp. Ett samlet brev per
kjøring, ikke ett per hemmelighet.

Praktiske detaljer:

- **Utløpsdatoer fylles inn manuelt.** Appen kan ikke spørre Key Vault (se
  Managed Identity over). Unntaket er SAS-strenger: de bærer utløpet i seg selv
  (`se=`), og leses direkte fra env-varen — merk raden med feltet **EnvVar**.
- **Hvert miljø eier sine egne rader**, så pilot og prod varsler ikke dobbelt.
  Trykk «Legg inn standardinventaret» én gang per miljø for å få inn de kjente
  hemmelighetene fra koden; datoene må fylles inn etterpå.
- **`HASH_SALT` er merket «skal ikke roteres».** Saltet gir deterministisk
  pseudonymisering av innsendere (`api/src/lib/kryptering.js`). Et bytte gir nye
  pseudonymer for framtidige innsendinger mens de historiske beholder de gamle,
  og koblingen kan ikke gjenskapes — e-postadressen den ble beregnet fra er slettet.
- «Test varsling» i panelet tørrkjører sjekken og viser hva som ville blitt sendt,
  uten å sende noe.

## Auth-modell

- SWA gjør Entra ID-innlogging via `/.auth/login/aad`
- `/api/*` krever `authenticated` som siste regel, men **39 endepunkter er
  anonyme i gatewayen** — scheduler-jobber, flyt-callbacks, OTP og
  utsendingslenker kan ikke ha en Entra-identitet. Her sto det tidligere at
  bare `/api/ping` og `/api/refresh-fs` var unntatt. Den fullstendige og
  genererte lista er `docs/API-OVERSIKT.md`; alle unntatt fem har en vakt i
  handleren, og `api/test/api-oversikt.test.js` feiler på et sjette
- Fininnstilt admin-sjekk i handler via `erAdmin(upn)` mot `ADMIN_UPNS`-env-var
- `admin.html` krever `admin`-rolle på ruten. Nøkkel- og rolleadministrasjon er
  faner i den (`#nokler`, `#roller`) — `nokkeladmin.html` og `rolleadmin.html`
  finnes ikke lenger som egne sider. `/migrer.html` har fortsatt en ruteregel,
  men fila er borte

## Roller i SWA

SWA-roller settes via "Manage user roles" i portalen eller via API. Standard-roller er
`anonymous` og `authenticated`. Egendefinerte roller (som `admin`) må tildeles per bruker.

Alternativ: sett rollen basert på Entra-gruppe med `rolesSource` i `staticwebapp.config.json`.
Krever SWA Standard-plan.

## Trussel-modell

Se `docs/ARCHITECTURE.md` for komponenter. Hovedangrepsflater:

- **Deploy-pipeline**: kompromittert GitHub-konto → uautorisert deploy. Mitigert av branch protection, review-krav, OIDC (planlagt).
- **Storage**: tilgang skjer med `STORAGE_CONNECTION_STRING`, ikke med MI. Den som har strengen, har både krypterte skjemaer og krypteringsnøklene — de ligger i samme konto. Strengen er den mest verdifulle enkeltverdien i løsningen.
- **App settings**: hemmelighetene står i klartekst. Å liste dem er en privilegert ARM-operasjon, så eksponeringen går til dem som alt kan endre appen. Se Managed Identity over.
- **Ondsinnet skjemadefinisjon**: en admin eller skjemaeier kan i teorien lagre HTML som injiseres hos utfylleren. Gjennomgått 13.10.2026: escape-funksjonene er samlet i `frontend/js/escape.js` (åtte kopier under fire navn før det, og én av dem hadde et hull som lot seg utnytte), seks uescapede verdier er rettet, og en `Content-Security-Policy` er innført. `script-src` har fortsatt `'unsafe-inline'` på grunn av 275 inline event-handlere. Se `docs/SIKKERHET-OG-ARKITEKTUR.md` 6.4 og punkt 11.
- **`FLOW_CALLBACK_KEY` er én delt verdi for fem inngangspunkter.** Se under.

## Teknisk gjeld: nøkkelen stegflytene bærer

Ikke en feil i dagens design, men en enkelhet som blir trangere etter hvert som
kretsen vokser. Skrevet ned 14.09.2026.

Behandlingssteg med `Flyt_url` kalles av `lib/ekstern-flyt.js`, som sender med
en `callbackUrl` slik at flyten kan fullføre steget. Selve nøkkelen må
skjemaeier ha fått og lagt inn i flyten sin.

Den nøkkelen er den samme for alt. En skjemaeier som bygger en stegflyt får
dermed også en verdi som åpner:

| Endepunkt | Hva den kan gjøre med nøkkelen |
|---|---|
| `POST /api/utsending` | opprette engangslenker for **hvilken som helst** skjematype |
| `POST /api/cache/teammedlemskap` | erstatte teamcachen, som tilgangssjekken leser |
| `GET /api/cache/teammedlemskap/team-navn` | lese team-navnene |
| `POST /api/skjemaer/…/beslutning` | fullføre steg på **andre** skjemaer med `Flyt_url` |
| `POST /api/hendelser/logg` | skrive i revisjonssporet |

Utsendingsraden er den tyngste: den utsteder lenker som gir tilgang uten
Entra-pålogging.

Per-steg-flytene er skjemaeiers ansvar og ligger utenfor løsningspakka med de
seks sentrale flytene. Kretsen som holder nøkkelen er altså større enn kretsen
som forvalter systemet.

### To veier å snevre det inn

**Egen nøkkel for stegflyter.** En `STEG_CALLBACK_KEY` som bare
`/beslutning` godtar, adskilt fra den de sentrale flytene bruker. Da kan en
stegflyt fullføre steg, men ikke opprette utsendinger eller røre teamcachen.
Enkleste inngrep, og dekker det meste.

**Bind callbacken til steget.** `callbackUrl` inneholder allerede skjematype
og skjema-id. Et HMAC-signert engangstoken i URL-en — samme mekanisme som
`lib/utsending-token.js` bruker — ville gjort at en stegflyt bare kunne
fullføre *det* steget den ble kalt for. Strammere, og fjerner behovet for at
skjemaeier håndterer en delt hemmelighet i det hele tatt.

Begge krever at eksisterende stegflyter legges om samtidig, så dette er ikke
noe som gjøres i forbifarten.
