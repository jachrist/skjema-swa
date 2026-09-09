# Fase 6a — E-post-varsling via Power Automate

Automatisk e-post ved innsending, behandling og videresending. Bruker eksisterende
`VARSLING_FLOW_URL` Power Automate-flyt (samme som legacy).

**Hvorfor PA-flyt og ikke SMTP:** Varslingssystemet er MS-sentrisk uansett
(Teams-varsler, Planner-oppgaver kommer senere). PA-flyten sender via M365-brukerens
egne rettigheter — ingen SMTP AUTH-oppsett, ingen app-passord, ingen KV-hemmelighet.
Ved evt. exit fra Microsoft må hele varslingslaget uansett skiftes ut, så SMTP-porting
gir ingen langsiktig gevinst.

## Env-vars som må settes i SWA

I Azure Portal → SWA → Configuration:

```
VARSLING_FLOW_URL     = https://prod-XX.northeurope.logic.azure.com/workflows/.../triggers/manual/paths/invoke?...
SWA_URL               = https://ashy-meadow-0f2a44503.7.azurestaticapps.net
VARSLING_DEAKTIVERT   = true    (valgfritt — kjør uten faktisk utsending, alt logges)
```

`VARSLING_FLOW_URL` er samme URL som legacy — kan gjenbrukes direkte fra
prod-miljøet så lenge pilot-brukerne har rett til å kalle den. For pilot i egen
tenant må enten:
- Bruke legacy-flyten (deler samme URL/nøkkel), eller
- Kopiere flyten til pilot-tenant og bruke den nye URL-en

## Payload-kontrakt (mot VARSLING_FLOW_URL)

Fase 6a sender alltid `varslinger: ['epost']`. Fase 6c/d utvider med
`'teams'`, `'planner'`, `'teamskanal'` — flyten støtter det allerede.

```json
{
  "handling": "sendBehandlingsVarsling",
  "mottakere": [{ "epost": "ola@fhs.no", "navn": "Nordmann, Ola" }],
  "varslinger": ["epost"],
  "skjema_id": "1",
  "skjematype_id": "108",
  "skjema_navn": "Test fase 5c",
  "stegnavn": "Godkjenning",
  "lenker": [{ "epost": "ola@fhs.no", "url": "https://.../evaluering.html?..." }],
  "base_url": "https://ashy-meadow-....azurestaticapps.net",
  "epost_og_teams": {
    "emne": "Skjema til behandling: \"Test fase 5c\"",
    "html": "<p>Du har fått ...</p>"
  }
}
```

Plassholdere i emne+html er ferdig-substituert av backend før kallet — flyten
gjør ingen fletting.

## Datamodell — skjematype-utvidelse

**Top-level (innsender-kvittering):**
```json
{
  "Innsenderkvittering": {
    "Aktiv": true,
    "Emne": "Kvittering: \"$skjemanavn\" er sendt inn",
    "Tekst": "<p>Vi har mottatt skjemaet \"$skjemanavn\" ($skjema_id).</p>..."
  }
}
```

**Per behandlingssteg:**
```json
{
  "Behandling": [{
    "Steg": 1,
    "Varsling": ["epost"],
    "TilBehandler": {
      "Emne": "Skjema til behandling: \"$skjemanavn\"",
      "Tekst": "<p>...</p>"
    },
    "FraBehandler": [
      { "BeslutningNr": 1, "Emne": "...", "Tekst": "..." },
      { "BeslutningNr": 2, "Emne": "...", "Tekst": "..." }
    ]
  }]
}
```

**Default-oppførsel** hvis felter mangler:
- `Innsenderkvittering.Aktiv` ikke satt → standard-mal brukes (Aktiv=true)
- `Varsling` ikke satt → e-post på (backward-kompatibelt)
- `TilBehandler`/`FraBehandler` ikke satt → standard-maler brukes

## Placeholders

Alle støttede plassholdere:

| Plassholder | Verdi |
|-------------|-------|
| `$lenke` | Lenke til skjemaet (SWA_URL + evaluering.html) |
| `$innsender` | Innsender-e-post |
| `$innsender_navn` | Innsender-navn |
| `$skjemanavn` | Skjematype-navn |
| `$skjema_id` | Skjema-ID |
| `$beslutning` | Beslutning-tekst (kun i FraBehandler) |
| `$kommentar` | Behandler-kommentar |
| `$stegnavn` | Steg-navn |
| `$rolle` | Rolle-streng |
| `$tidspunkt` | Nåværende dato/tid (Europe/Oslo) |
| `$navn` | Mottaker-navn (per-mottaker) |
| `$frist` | Frist-dato (hvis satt) |
| `$dagerTilFrist` | Antall dager |
| `{N-NN}` | Svar på felt (seksjon-felt), f.eks. `{1-02}` |
| `{UUID}` | Svar på felt via stabil Id |

## Kall-flyt

**Ved innsending** (`POST /api/skjemaer` med Skjema_status=2):
- `sendInnsenderKvittering` — kall til innsender
- `sendVarslingAktiveSteg` — kall per aktive steg (én mottaker-batch per steg)

**Ved beslutning** (`POST /api/skjemaer/.../beslutning`):
- `sendBeslutningVarsling` — kall til innsender med utfall
- `sendVarslingAktiveSteg` for nye aktive steg (etter skip-kaskade)

**Ved videresending** (`POST /api/skjemaer/.../videresend`):
- `sendBehandlerVarsling` — kun til den nye mottakeren

Alle kall er **fire-and-forget** — feil i flyten feiler ikke selve handlingen.
Feil logges i Application Insights via `context.log`.

## Test

Sett `VARSLING_DEAKTIVERT=true` for å kjøre uten faktisk kall — hvert kall
logges som `flyt DRY-RUN: ...` i Application Insights.

Full test: send inn et skjema med behandlingssteg. Sjekk at:
1. Innsender får kvittering
2. Behandler(e) får varsling
3. Ved beslutning: innsender får utfall-melding, neste steg får varsling

## Neste

Fase 6b: HTML-editor for tilpasning av melding-maler.  
Fase 6c: Teams-varsler (utvid `varslinger: ['epost','teams']`).  
Fase 6d: Planner-oppgaver (utvid med Planner-payload).

## Vedlegg på Planner-oppgaven

Fra 08.09.2026 sender varslings-payloaden skjemaets vedlegg med i
`planner`-objektet. Flyten må endres for å ta dem i bruk — uten endring
ignoreres de, og oppgaven blir som før.

```jsonc
"planner": {
  "tittel": "...", "plan": "...", "bucket": "...",
  "sjekkliste": [...], "sjekkliste_graph": { ... },

  // Lesbar form — for en flyt som vil bygge noe eget.
  // Skjemalenka ligger ALLTID først; vedleggene kommer etter.
  "vedlegg": [
    { "filnavn": "Lenke til skjemaet",
      "url": "https://<swa>/evaluering.html?skjematype_id=123&skjema_id=6",
      "type": "Other" },
    { "filnavn": "tilbud.pdf",
      "url": "https://<swa>/api/vedlegg-fil/123/6/tilbud.pdf" }
  ],

  // Klar til å sendes rett inn i details-kallet. Samme rekkefølge.
  "vedlegg_graph": {
    "https%3A//<swa>/evaluering%2Ehtml?skjematype_id=123&skjema_id=6": {
      "@odata.type": "microsoft.graph.plannerExternalReference",
      "alias": "Lenke til skjemaet",
      "type": "Other"
    },
    "https%3A//<swa>/api/vedlegg-fil/123/6/tilbud%2Epdf": {
      "@odata.type": "microsoft.graph.plannerExternalReference",
      "alias": "tilbud.pdf",
      "type": "Other"
    }
  }
}
```

### Skjemalenka er første element

Hensikten er at behandleren skal se veien til skjemaet på oppgavekortet, uten
å måtte åpne oppgaven. Lenka sendes derfor som en referanse på linje med
vedleggene, og ligger først i begge formene.

Den kommer med selv om skjemaet ikke har vedlegg. Har SWA-en ingen kjent
base-URL, kommer verken lenka eller vedleggene.

**Rekkefølgen i JSON alene er ikke nok** til at Planner viser lenka på kortet,
og kortet viste seg å være utenfor vår kontroll — se «`previewType` lar seg
ikke sette» nedenfor. `previewPriority: " !"` sendes likevel på lenka: den er
gyldig, koster ingenting, og pinner lenka øverst i vedleggslista der den
faktisk vises.

Verdien `" !"` er den Microsoft selv bruker i dokumentasjonen. Formatet er en
egen sammenligningsalgoritme, så en verdi vi finner på selv gir 400 på hele
`details`-kallet — altså ingen oppgavedetaljer i det hele tatt, ikke bare feil
rekkefølge. Vedleggene står uten hint; Planner tildeler dem sine egne.

### `type` må være en verdi Graph kjenner

Bare disse fire er gyldige:

```
Word   Excel   PowerPoint   Other
```

Alt annet gir **400 på hele `details`-kallet** — verken sjekkliste eller
referanser kommer fram, ikke bare feil ikon. Vi prøvde `"url"` på skjemalenka
09.09.2026, og flyten feilet.

`"Pdf"` ser plausibel ut, men er tatt ut av samme grunn: gevinsten er et litt
penere ikon, prisen ved å ta feil er at ingenting kommer fram. PDF-vedlegg får
derfor `Other`.

Backend håndhever dette — en ukjent verdi forkastes og erstattes med `Other`,
så en skrivefeil i oppsettet ikke kan velte kallet.

### Slik brukes de i flyten

Samme kall som sjekklista, ett felt til:

```http
PATCH https://graph.microsoft.com/v1.0/planner/tasks/{taskId}/details
If-Match: {etag}

{
  "checklist":  <sjekkliste_graph>,
  "references": <vedlegg_graph>
}
```

### To ting som er lette å gjøre feil

**Nøkkelen er adressen, ikke et løpenummer.** Graph krever at `%`, `:`, `.` og
`@` er prosentkodet i den. Derfor sendes `vedlegg_graph` ferdig kodet — bygg
den ikke om i flyten. Én feilkodet nøkkel gir 400 på hele kallet, altså ingen
oppgavedetaljer i det hele tatt, ikke bare manglende vedlegg.

**`previewPriority` settes bevisst ikke**, av samme grunn som `orderHint` på
sjekklistepunktene: formatet er en egen sammenligningsalgoritme, og en ugyldig
verdi gir 400. Uten den tildeler Planner sin egen rekkefølge.

### Tilgang

Lenkene peker på `/api/vedlegg-fil/...`, som krever innlogging og tilgang til
skjemaet — samme regel som ellers. En behandler som klikker fra Planner blir
sendt gjennom innlogging og får fila. Ingen ny tilgang åpnes; det eneste som
spares er veien om skjemavisningen.

Har SWA-en ingen kjent base-URL (`SWA_URL` ikke satt), sendes ingen vedlegg.
En halv adresse i en oppgave er verre enn ingen, og flyten kan ikke se
forskjell.

### `previewType` lar seg ikke sette — bruk beskrivelsen

Planner-kortet kan vi **ikke** styre. `previewType` er dokumentert som en
skrivbar egenskap på `plannerTask`, men Graph avviser den:

```
The request is invalid:
This field cannot be modified (Parameter 'PreviewType')
```

Prøvd 09.09.2026. Står oppgaven på `automatic`, velger Planner selv, og den
foretrekker et bilde framfor en lenke. Kortet er altså utenfor vår kontroll.

Lenka legges derfor i **beskrivelsen** i stedet, som en klikkbar `<a>`.
Payloaden har notatet i to former:

| Felt | Form | Til |
|---|---|---|
| `notat` | ren tekst | `description` (uendret oppførsel) |
| `notat_html` | HTML | `notes: { content, contentType: "html" }` på beta |

```jsonc
"notat": "Husk fristen",
"notat_html": "<p>Husk fristen</p><p><a href=\"https://<swa>/evaluering.html?...\">Åpne skjemaet</a></p>"
```

Bruk `notat_html` i det kallet flyten allerede gjør:

```http
PATCH https://graph.microsoft.com/beta/planner/tasks/{taskId}/details
{ "notes": { "content": <notat_html>, "contentType": "html" },
  "checklist": <sjekkliste_graph>,
  "references": <vedlegg_graph> }
```

**Lenka er alltid med i `notat_html`**, også når noen har skrevet sitt eget
notat. Før lå den bare i fallbacken, så den forsvant i det øyeblikket
notatfeltet ble tatt i bruk — altså akkurat når noen begynte å bruke det.

Brukerens tekst escapes før den settes inn. Notatfeltet er fritekst i
editoren, og en avbrutt tag ville ellers ødelagt resten av beskrivelsen.
Blanke linjer blir avsnitt, enkle linjeskift blir `<br>`.

### Bare skjemalenka går inn i `references`

Vedleggene lå der til å begynne med, men Planner velger selv hva kortet viser
og foretrekker et bilde. Et skjermbilde blant vedleggene kapret dermed kortet,
og lenka — det behandleren faktisk trenger — ble liggende usett.

`vedlegg_graph` inneholder derfor **bare skjemalenka**. `vedlegg` lister
fortsatt filene i lesbar form for en flyt som vil bruke dem til noe, men den
brukes ikke i dag: vedleggene nås gjennom skjemaet lenka peker til, ett klikk
unna.

### Notatet har lenka som standardinnhold

Notatfeltet i editoren er forhåndsutfylt med

```
Skjemaet finner du her: $lenke
```

— ikke som grå hjelpetekst, men som faktisk innhold. Den som setter opp steget
kan skrive rundt lenka og bestemme hvor den står. Er feltet tømt med vilje,
blir det stående tomt.

`notat_html` gjør adresser om til klikkbare `<a>`, så `$lenke` holder som ren
tekst. Det legges **ikke** på en lenke automatisk når notatet allerede peker et
sted — da ville den som plasserte den selv fått den to ganger. Unntaket er et
notat helt uten adresse: da føyes skjemalenka til, så en oppgave aldri står
uten vei tilbake.
