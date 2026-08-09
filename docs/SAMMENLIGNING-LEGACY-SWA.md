# Sammenligning: Legacy vs SWA-pilot

Punktvis oppsummering av vesentlige forskjeller mellom legacy-implementeringen
(Azure Functions med HTML-servering) og SWA-pilotens arkitektur.

## Sikkerhet

**Authentisering**
- **Legacy:** Custom Easy Auth + funksjonsnøkler i URL (`?code=...`) for
  API-kall. Egne token-typer for hver situasjon (opprett-token, engangskode,
  device-token, single-use vs 90-dagers). Sensitivitetsnivå per skjematype
  styrte om lenker krevde Power App eller OTP.
- **SWA:** Én uniform mekanisme: SWA Managed AAD. Cookie settes automatisk
  ved innlogging, `x-ms-client-principal`-header injiseres på request.
  Ingen funksjonsnøkler i URL-er. OTP kun for én tydelig avgrenset
  brukssituasjon (ekstern innsender).

**Tokens som fortsatt finnes**
- SCHEDULER_KEY (FS-refresh cron), FLOW_CALLBACK_KEY (PA-flyt-steg),
  OTP_HMAC_KEY (ekstern-verifisering), PB-token per skjematype. Alle
  har klart definert bruk, ingen overlapper.

**Kryptering**
- Samme AES-256-GCM per skjematype-nøkkel. Nokkeladmin-siden bevart.
- **Ny:** kryptering skjer via server-side hentet nøkkel — bruker slipper
  å oppgi nøkkel manuelt ved lesing (PDF, PB, register). Datauttrekk har
  fortsatt input-felt for override.

**Angrepsflate**
- **Legacy:** stor angrepsflate — HTML serveres fra backend med
  placeholder-erstatning som kunne påvirkes av upålitelig data.
  Funksjonsnøkler i lenker som ble delt via e-post.
- **SWA:** frontend serveres statisk fra CDN (ingen kode-injeksjon-vei).
  CSP + strict security headers via `staticwebapp.config.json`.
  Auth-cookies settes med samme-domenerestriksjoner av SWA.

**Rolle-modell**
- **Legacy:** Rollemedlemskap i SharePoint-liste synkronisert via PA.
- **SWA:** Egen Rollemedlemskap-tabell + native adminside. Rolle-tilgang
  brukes i backend uten mellomledd.

## Brukervennlighet

**Enhetsstøtte**
- **Legacy:** Power App fra PC (kompleks setup). Mobil krevde OTP-flyt
  eller offentlig lenke basert på sensitivitetsnivå — inkonsistent
  brukeropplevelse.
- **SWA:** Én URL fungerer likt på PC og mobil. Ingen Power App.
  Sensitivitetsnivå ikke lenger relevant.

**Innlogging**
- **Legacy:** Custom login-side + tokens injisert i URL.
- **SWA:** Standard Entra-login via `.auth/login/aad`. Naturlig SSO for
  Forsvarets brukere.

**GUI-modernisering**
- Modulær CSS med både lys og mørk modus (auto-detect + toggle)
- Filter-dropdown med kun forekommende verdier (ikke lange
  Valg-lister)
- Rich-text WYSIWYG-editor for meldinger med plassholder-chips
- Chip-basert tilgang-editor (Personer/Roller/Team)
- Kollapsbare seksjoner/felter i editor
- Modal-bekreftelser i stedet for `alert()`
- Vis alle / Skjul alle-knapper konsekvent

**Ekstern innsender-flyt**
- **Legacy:** Ikke støttet direkte — krevde token utstedt av admin.
- **SWA:** Én URL delbar via hvilken som helst kanal. Ekstern verifiserer
  seg med SMS eller e-post, kan mellomlagre og komme tilbake senere.

**Feiltoleranse**
- Auto-dekryptering ved lesing i stedet for manuell nøkkel-input.
- Bakoverkompatibel prop-lesing (f.eks. `Filtrerbar` vs
  `Filtrerbar_i_register`) — gammel data virker uten migrering.
- Fire-and-forget for alle sideeffekter (varsling, SP-liste, ekstern flyt).
  Feil i én integrasjon feiler ikke hovedhandlingen.

## Utviklingsprosess og vedlikehold

**Kodestruktur**
- **Legacy:** `index.js` på ~5000 linjer med alle endepunkter blandet.
  Vanskelig å navigere og teste isolert.
- **SWA:** Én fil per endepunkt-gruppe under `api/src/functions/`
  (skjemaer.js, skjematyper.js, roller.js, varsling.js, nokkel.js osv.).
  Delt logikk i `api/src/lib/` (kryptering, otp, placeholder, oppslag ...).
  Frontend-moduler under `frontend/js/` med ES-modul-imports.

**Antall PA-flyter**
- **Legacy:** Mange flyter for hver oppgave (EPOST, VARSLING, SP-LISTE,
  ENGANGSKODE, SAMMENDRAG, UTSENDELSE, TOKEN, POWER-BI, LAZY-TEAM, ...).
- **SWA:** Fire aktive: VARSLING_FLOW_URL, OTP_FLOW_URL, SP_LISTE_FLOW_URL,
  BACKUP_UPLOAD_FLOW_URL (planlagt). All logikk som ikke krever MS-native
  konnektorer er portert til backend-kode.

**HTML-servering**
- **Legacy:** Backend fyllte `{{PLACEHOLDER}}`-markører i HTML før servering.
  Tett kobling mellom frontend og backend — vanskelig å versjonere separat.
- **SWA:** Frontend som ren statisk. `CONFIG`-objekt bygges én gang av
  `scripts/build-config.js` i deploy. Backend har ingen HTML-avhengighet.

**Deploy**
- **Legacy:** `bash deploy.sh` — pakker og pusher via Azure Functions Core Tools.
- **SWA:** `git push origin main` → GitHub Actions bygger og deployer
  automatisk. Preview per PR.

**Testing/utvikling**
- Lokal utvikling via `swa start` (frontend på 4280 + backend på 7071).
- Fast iterasjon: endring → commit → deploy → lever på 1-2 minutter.

**Datamodell**
- Skjematype-JSON splittes over flere Table Storage-properties (JSON,
  JSON2 ... JSON8) siden Azure har 32K-tegn per property. Legacy hadde
  samme grense men uten split — begrenset skjema-størrelse.

**Skala og ressursbruk**
- **Legacy:** Én Function App (Consumption plan).
- **SWA:** Static Web App Standard-plan (~$9/mnd) med Managed Functions.
  Auto-skalering, mindre kaldstart-effekt.

## Åpne løse ender / gjeld

- **Managed Identity for storage:** SWA managed functions støtter ikke MI
  i koden. Bruker connection string i env. Ved BYOF (Bring Your Own
  Functions) kan MI aktiveres.
- **Application Insights:** SWA managed functions logger ikke automatisk
  til AI — vi bruker `context.log` som er tilgjengelig i Log Stream i
  portalen, ikke i AI. Ved feilsøking av produksjonsproblemer må diag-
  endepunkter lages for hver komponent.
- **Backup:** ikke implementert (planlagt neste fase).
- **Graph API:** Team-medlemskap er stub inntil Graph er koblet på.
- **Sensitivitetsnivå:** droppet — ikke lenger relevant siden mobilen
  bruker samme sterke auth som PC.

## Modul-oppsummering

| Modul | Legacy | SWA-pilot |
|-------|--------|-----------|
| Kjerne (CRUD) | `index.js` (5000+ linjer) | Delt i `api/src/functions/*.js` |
| Kryptering | `src/kryptering.js` | `api/src/lib/kryptering.js` (portert) |
| Varsling | PA-flyter | PA-flyter (samme kontrakt) |
| OTP | `sendEngangskode` (kun epost) | Modul-basert (SMS + epost) |
| PDF | `src/pdf-generator.js` | `api/src/lib/pdf-generator.js` (portert) |
| Datauttrekk | HTML-serverside | Egen SPA-side |
| FS-integrasjon | PA-flyt daglig | GitHub Actions cron → API |
| Rolleadmin | SharePoint-liste + PA | Egen tabell + adminside |
| Deploy | bash-script | GitHub Actions |

## Konklusjon

Piloten leverer funksjonell paritet med legacy, med tydelige forbedringer
langs alle tre akser:

- **Sikkerhet:** færre tokens, mer standardisert auth, mindre angrepsflate.
- **Brukervennlighet:** konsistent på tvers av enheter, moderne UI, bedre
  feiltoleranse.
- **Vedlikehold:** modulær kode, GitOps-deploy, egen komponent-testing,
  mindre avhengighet av PA-flyter.

Hovedfordelen ved SWA-arkitekturen er at det er *færre bevegelige deler*
å holde synkronisert — men samtidig fortsatt fleksibel nok til å benytte
Microsoft-økosystemet der det gir verdi.
