# Slå utsendingsflyten sammen med varslingsflyten

Status: **påbegynt.** Kravet om `EksternTilgang` ved opprettelse er levert.
Resten venter på ett driftsspørsmål — se «Blokkeren» nedenfor.

## Utgangspunkt

`UTSENDING_FLOW_URL` er ikke satt i noe miljø, og `PURRE_FLOW_URL` peker på en
flyt som ikke finnes. Utsending og purring er altså ute av funksjon overalt.

Det har ikke blitt oppdaget fordi `send-forfalte` returnerer 200 med
`antallSendt: 0` før flyten kalles når det ikke finnes forfalte utsendinger.
Alle 14 cron-kjøringene er grønne uten at adressen noen gang er truffet.

Spørsmålet er derfor ikke «hvordan reparerer vi flyten», men «trenger vi den».

## De to kontraktene

De gjør i kjernen samme jobb: send en e-post med en tekst og en lenke til en
liste mottakere. Forskjellen er hvem som skriver meldinga.

| | Varsling | Utsending |
|---|---|---|
| Sender | ferdig `emne` + `html` | råvarer |
| Flytens jobb | putt HTML i en e-post | *komponer* teksten |
| Lenke | `lenker: [{epost, url}]` | `mottakere[].url` |

Utsending sender `skjemanavn`, `skjemabeskrivelse` + format, `purretekst`,
`dagerSiden` og `avslutningsdato`, og lar flyten sette det sammen.

**Lenke per mottaker er allerede i varslingskontrakten.** `flyt-kaller.js`
bygger `lenker` som `[{ epost, url }]` — én rad per mottaker. Varsling bruker
den i dag bare til å gi alle samme adresse, men strukturen bærer ulike. Det er
nøyaktig det utsending trenger for engangs-tokenene sine.

## Avklart: lenkegenereringen skal ikke splittes

Spørsmålet som reiste seg var om interne og eksterne mottakere måtte ha ulike
lenker — OTP-basert for eksterne, ID-basert for interne. Det trengs ikke, og
premisset stemmer ikke med koden:

**Utsendingslenka er ikke OTP-basert.** `lib/utsending-token.js` utsteder et
HMAC-signert token bundet til (batch, mottaker, skjematype), med 90 dagers
levetid. Det krever ingen innlogging og ingen kode på SMS.

`frontend/index.html` har tre atskilte moduser:

| URL | Modus |
|---|---|
| `?utsending=<token>` | tokenet er legitimasjonen — ingen innlogging |
| `?ekstern=1` | anonymt + OTP-verifisering, krever `EksternTilgang=true` |
| `?skjematype_id=…` | SWA Entra-innlogging |

OTP hører til den midterste. Utsending går aldri innom den.

**Tokenet skiller ikke på intern og ekstern, og trenger ikke det.**
`utsending/for-meg` utsteder allerede et slikt token for en innlogget UPN — så
interne på tokenveien er et eksisterende, bevisst mønster. En blandet batch —
forelesere der noen er ansatte og noen ikke — virker i dag uten at noe koder
opp forskjellen.

Tokenet er heller ikke en naken bærerlenke: `lagreSkjema` slår opp raden i
`Utsendinger` og avviser hvis `Jti` er rotert eller `SvarSkjemaId` allerede er
satt. Det gjør lenka engangs og tilbakekallbar.

### Om `@mil.no` som test

Ikke bruk den. To grunner, den første avgjørende:

1. **Dev er en egen tenant.** Domenet er ikke det samme i alle miljøer, så en
   hardkodet streng er feil i minst ett av dem.
2. Domene er ikke identitet. En innleid konsulent med FHS-konto har ikke
   nødvendigvis domenet, og en adresse med domenet har ikke nødvendigvis en
   konto.

### Om «personer-tabellen»

Den finnes ikke. `_hentPersoner` i `lib/oppslag.js` leser `Teammedlemskap` —
og uten filter unionen av alle team, der ett team («Ansatte og studenter ved
FHS») er dynamisk og dekker samtlige interne.

Skulle en splitt likevel bli nødvendig senere, er *det* den ærlige kilden:
oppslag i teamcachen, ikke strengsammenligning på domene. Men den er en cache,
ikke en sannhet — en fersk ansatt kan mangle til neste refresh, og da ville en
splitt gitt vedkommende feil lenketype. Enda et argument for å la være.

## Blokkeren

Purringer går til både interne og eksterne, ofte i samme batch — et
spørreskjema til forelesere treffer gjerne begge deler.

### Avklart: når det er lov (levert)

Skjematypen må ha `EksternTilgang`. Samme flagg som styrer OTP-flyten, fordi
det er den samme tilliten: tilgang uten Entra-pålogging.

Sjekken ligger ved **opprettelsen** av batchen — `POST /api/utsending` avviser
en skjematype uten flagget med «Denne skjematypen er ikke tilgjengelig for
ekstern utsendelse». Der er det én skjematype å ta stilling til, og svaret
gjelder hele batchen. Ved utsendingen ville hver mottaker måttet klassifiseres
som intern eller ekstern, og det spørsmålet har ikke noe ærlig svar.

Konsekvensen er det som gjør sammenslåingen mulig: **finnes batchen, har
skjematypen tillatt ekstern innsending.** Utsendings- og purreflyten kan
derfor alltid sende ut av organisasjonen uten å spørre om noe mer, og trenger
ingen logikk for å skille mottakere.

`utsending/for-meg` er ikke omfattet — der utsteder en innlogget bruker en
lenke til seg selv.

### Gjenstår: får koblingen sende eksternt?

Policyen er avklart, men ikke evnen. Om e-postkoblingen i varslingsflyten
faktisk *kan* sende ut av organisasjonen, er et driftsspørsmål som må hentes
fra Power Automate / tenant-oppsettet før koden legges om.

Er svaret nei, faller sammenslåingen — da trengs en egen flyt med en kobling
som får sende eksternt, og arbeidet blir å opprette den etter kontrakten i
`docs/FLYTER.md`.

## Hva som må flyttes

Komposisjonen av meldinga inn i API-et. Det er samme retning kodebasen
allerede går — `flyt-kaller.js` sier det om kanaloppsettet: «Feltene er ferdig
oppløst — flyten skal ikke kunne noe om plassholdere, rollemodellen vår eller
hvordan en frist skal regnes ut.» Utsending er det siste stedet flyten fortsatt
må kunne noe.

Tre ting krever en avgjørelse underveis:

**Markdown.** `skjemabeskrivelseFormat` kan være `Markdown`, og flyten rendrer
den i dag. Backend har ingen Markdown→HTML-renderer — `parseMarkdown` i
`todo-storage.js` er en TODO-listeparser, ikke det. Komposisjon i API-et betyr
å skrive en, og den må gi samme resultat som `parseMarkdown` i
`frontend/js/felt-render.js`. Samme mønster som forhåndsvisningen av
Planner-notatet: to implementasjoner, én test som holder dem sammen.

**`dagerSiden` er per mottaker, `html` er felles.** I praksis deler radene i en
batch dato, men ikke garantert. Skal «det er 12 dager siden» stå i teksten, må
den enten ut av teksten, eller mottakerne grupperes per verdi, eller
kontrakten utvides med per-mottaker-tekst. Enkleste vei: ut av teksten —
`avslutningsdato` sier det som betyr noe for mottakeren.

**`KanalHint`** er død vekt. Den lagres i `Utsendinger` og vises i admin, men
ingenting i API-et forgrener på den. Ta den med i ryddingen, ikke i
sammenslåingen.

## Steg

1. ~~**Krav om `EksternTilgang` ved opprettelse.**~~ Levert.
2. **Avklar om koblingen får sende eksternt.** Ingenting under her er verdt å
   begynne på først.
3. **Markdown→HTML i backend.** Ny `lib/markdown.js`, med en test som kjører
   den og `parseMarkdown` fra `felt-render.js` mot de samme tekstene.
4. **Maler for utsending og purring** i `lib/varsling.js`, ved siden av de
   eksisterende. Emne og HTML bygges av `skjemanavn`, `skjemabeskrivelse` og
   `purretekst`, med lenka per mottaker gjennom `lenker`.
5. **Bytt kallet.** `kallUtsendingsflyt()` erstattes av
   `sendVarslerViaFlyt()` med `handling: 'sendUtsendinger'` /
   `'purreUtsendinger'` og `lenker` fylt fra `byggUtsendingsposter`.
6. ~~**Rydd.**~~ Levert som trinn 1 (se under). `flytUrlFor()` er borte, og
   begge adressene er ute av `HEMMELIGE_ENV` i `functions/system.js` — da
   forsvant også den stående, ubesvarte alarmen om at `UTSENDING_FLOW_URL`
   mangler.
7. **Oppdater `docs/FLYTER.md`.** Åtte adresser blir seks.

## Trinn 1: én adresse (levert 10.09.2026)

`kallUtsendingsflyt()` leser `VARSLING_FLOW_URL`. `UTSENDING_FLOW_URL` og
`PURRE_FLOW_URL` er borte fra koden og fra helsesjekken.

Dette er en adresseendring, ikke en kontraktsendring. Nyttelasten er den samme
som før, så flyten ser nå **to former på samme trigger**, skilt på `handling`.
Utsendingspayloaden har ingen `epost_og_teams` — en flyt som ikke forgrener
sender derfor en tom e-post til eksterne mottakere.

**Rekkefølgen er derfor ikke likegyldig:** flyten må forgrene på `handling`
før dette deployes. Vinduet var trygt da endringen ble gjort — det fantes
ingen forfalte eller ubesvarte utsendinger i noe miljø, så ingen av
cron-jobbene nådde fram til flyten i det hele tatt.

Trinn 2 (steg 3–5 over) fjerner den doble formen.

## Purringen markerer ikke lenger noe som ikke ble sendt (levert 10.09.2026)

`functions/utsending.js` markerte alle kandidater som purret også når flyten
feilet, «så vi ikke spammer neste kjøring», og svarte 200. Cron-jobben ble
grønn. Med en død adresse betydde det at purringen ble brukt opp i stillhet.

Skillet ligger nå i `lib/flyt-utfall.js`, og går på om flyten ble **utført**,
ikke om det gikk bra:

| Utfall | Markeres? |
|---|---|
| 401, 403, 404, 410 — avvist før flyten kjørte | nei, 502 og ny runde neste døgn |
| nettverksfeil, ingen adresse satt | nei, 502 |
| 500 og annet fra en flyt som svarte | ja, som før |
| vår egen 35-sekunders tidsavbrytelse | ja — flyten kan holde på å sende |

Timeouten er det ene bevisste unntaket: `AbortController` stopper kallet på vår
side, ikke flytens. Regnet vi det som «ikke sendt», ville en treg flyt gitt
doble purringer hver gang.

Dry-run-meldinga «Ingen flyt-URL satt» er borte fra svaret. Den grenen kan ikke
nås lenger: mangler adressen, kom kallet ikke fram.
