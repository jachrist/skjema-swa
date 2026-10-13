# Plan for dokumentasjon

Oppdragsgiver vil fokusere på sikkerhetstesting og på opplærings- og
informasjonsmateriale. Dette er en plan for hvordan dokumentasjonen bør
organiseres og gjøres tilgjengelig.

## Utgangspunktet, målt

| | |
|---|---|
| Filer i `docs/` | 30 |
| Linjer til sammen | 6 315 |
| Av dem `FASE-*` | 13 filer |
| API-endepunkter i koden | 133 |
| Endepunkter med en samlet oversikt | alle |
| Frontend-sider | 13 |
| Sider med brukerrettet beskrivelse | 0 |

De to siste radene er oppdatert 13.10.2026: oversikten finnes nå, generert av
`scripts/api-oversikt.js`. 111 var dessuten for lavt — tre endepunkter i
`samtale.js` ble ikke funnet før parseren også leste `route`-verdier satt fra
en konstant.

Mengden er ikke problemet. **Sjangeren er det.**

## Diagnosen: dette er ingeniørnotater, ikke leveransedokumentasjon

Dokumentene er skrevet underveis, av og for dem som bygget løsningen. De er
gode på nettopp det som ellers går tapt — hvorfor et valg ble tatt, hvilken
feil som førte til regelen, hva som ble prøvd og forkastet. `FASE-*`-filene er
endringsnotater: «slik bygget vi dette, og hvorfor».

Det er en reell verdi, og den skal ikke kastes. Men:

* Det finnes **ingen inngang**. En som åpner `docs/` møter 30 filer i alfabetisk
  rekkefølge, og må vite hva hen leter etter for å finne det.
* Det finnes **ingen referanselag**. 111 endepunkter og 13 sider er ikke
  beskrevet noe sted samlet.
* Det er **skrevet for én målgruppe**. En sikkerhetsevaluator som får 6 315
  linjer ingeniørnotater, drukner — og konkluderer på det hen rakk å lese.

Å publisere det som finnes som en nettside ville derfor gjøre situasjonen
verre, ikke bedre. Søk i feil innhold er fortsatt feil innhold.

## Steg 1: skill på målgruppe

Fem målgrupper, med helt ulike behov:

| Målgruppe | Trenger | Form |
|---|---|---|
| **Sikkerhetsevaluator** | Fullstendighet, avgrensning, etterprøvbarhet | Ett dokument, datert og versjonert, som kan overleveres |
| **Forvalter / admin** | Oppsett, drift, feilsøking | Søkbare nettsider |
| **Skjemaeier** | Editoren, felttyper, notasjoner | Veiledninger + referanse |
| **Sluttbruker** | «Hvordan gjør jeg X» | Kort, oppgavebasert — helst i appen |
| **Utvikler** | Hvorfor det er slik | Det som finnes i dag |

De seks temaene oppdragsgiver nevner fordeler seg slik:

| Tema | Primær målgruppe |
|---|---|
| Arkitektur | Evaluator, utvikler |
| Formater og notasjoner (DNF, feltreferanser) | Skjemaeier |
| API-oversikt | Utvikler, integratør |
| Frontend / GUI | Skjemaeier, sluttbruker |
| Datasikring | Evaluator |
| Tilgangsstyring | Evaluator, forvalter |

**Halvparten av det oppdragsgiver ber om, er til evaluatoren.** Det bør styre
rekkefølgen.

## Steg 2: hvor det skal ligge — et sikkerhetsvalg, ikke et verktøyvalg

Arkitektur, datasikring og tilgangsstyring beskriver nøyaktig det en angriper
vil vite: hvilke mekanismer som finnes, hvor de ikke finnes, og hvilke
antagelser de hviler på.

**Det skal derfor ikke på GitHub Pages eller noe annet åpent sted.**

Anbefaling: dokumentasjonen bygges til statiske filer og serveres fra **SWA-en
selv**, bak Entra-innloggingen som allerede står der. En rute-regel i
`staticwebapp.config.json` setter kravet:

```jsonc
{ "route": "/dokumentasjon/*", "allowedRoles": ["authenticated"] }
```

Det gir søk og navigasjon uten å utvide angrepsflaten, og uten en ny tjeneste
å forvalte. Skal evaluatoren ha et eksemplar utenfor, får hen PDF-en —
overlevert, ikke publisert.

Sluttbrukerveiledning kan ligge åpnere, fordi den ikke beskriver mekanismer.
Det er en egen vurdering per dokument, ikke én knapp for alt.

## Steg 3: verktøykjede — én kilde, to utganger

Prinsippet som må holde: **PDF-en vedlikeholdes aldri for seg.** To kopier av
samme innhold svarer ulikt innen et kvartal; det har skjedd i dette repoet
flere ganger, senest med `FLYTER.md` og med env-filene.

```
docs/*.md  ──┬──► MkDocs Material ──► statiske sider ──► SWA /dokumentasjon/*
             └──► pandoc + Chromium ──► PDF ──────────► overleveres
```

**MkDocs Material** for nettsidene: Markdown inn, statiske filer ut, innebygd
klientside-søk, navigasjon, ingen server. Alternativet `mdBook` er lettere
(én binærfil, ingen Python) og holder også — valget er ikke kritisk.

**pandoc + Chromium** for PDF. Ikke en MkDocs-plugin: pandoc-veien er allerede
prøvd i dette miljøet og virker, og en plugin til er en avhengighet til som kan
brekke. Chromium ligger ferdig installert.

Begge kjøres av én GitHub Actions-jobb, fra samme `.md`-filer.

> Dette innfører et byggsteg, og CLAUDE.md sier «ingen byggsteg». Regelen
> gjelder frontend-appen, og dette rører ikke den — dokumentasjonen bygges til
> egne filer under `/dokumentasjon/`. Men unntaket bør avtales eksplisitt, ikke
> snikes inn.

## Steg 4: hva som kan genereres, og hva som må skrives

Det som genereres, drifter ikke. Det som skrives for hånd, gjør det.

**Kan genereres fra koden:**

| Hva | Kilde |
|---|---|
| API-oversikt: 111 endepunkter med metode, rute, auth | `app.http(...)` i `api/src/functions/` |
| Felttyper | `felt-render.js` |
| Datakilder for `FasteData` og filtrene deres | `oppslag.js` + `DATAKILDER` i `editor.html` |
| Env-variabler per miljø | `config/env.*.json` (alt holdt komplett av test) |
| Flyt-kontraktene og `handling`-verdiene | `flyt-kaller.js` (alt holdt i synk av test) |
| Sidene i GUI-et | `frontend/*.html` |

**Må skrives:**

* Arkitekturoversikt med komponenter og kommunikasjon — og en figur. `ARCHITECTURE.md`
  er 146 linjer og har ingen.
* Datasikring samlet: anonymisering, skjemakryptering, backup-kryptering.
  Finnes spredt i `FASE-KRYPTERING.md`, `BACKUP-SHAREPOINT.md`, `SECURITY.md`.
* Tilgangsstyring samlet: Entra, team, roller, aktører.
* Notasjonene: DNF, feltreferanser, `FasteData`-syntaks. Finnes bare som
  hjelpetekster i editoren i dag.
* Alt brukerrettet.

**Og: generering alene er ikke nok.** En generert liste over 111 endepunkter
uten beskrivelse er en tabell, ikke dokumentasjon. Mønsteret som har virket her
er at koden bærer beskrivelsen og en test krever at den finnes — som
`env-inventar.test.js` og `flyt-handlinger.test.js`. Da kan et udokumentert
endepunkt ikke merges.

## Steg 5: rekkefølge

Sikkerhetsevalueringen er førsteprioritet, så den styrer.

**Runde 1 — det evalueringen trenger** — *punkt 1–3 ferdig 13.10.2026*

1. ✅ `SIKKERHET-OG-ARKITEKTUR.md` — ett dokument som samler arkitektur,
   datasikring og tilgangsstyring, med avgrensning, datastrømmer og en
   komponentfigur. Dette er overleveringsdokumentet.
2. ✅ Generert API-oversikt, med auth-krav per endepunkt. Evaluatoren vil spørre
   «hva er eksponert, og hvem slipper til» — og det svaret må være komplett,
   ikke representativt.
3. ✅ Kjente begrensninger samlet ett sted — kapittel 10 i overleveringsdokumentet, 19 punkter. `ARCHITECTURE.md` har alt «siste
   skriving vinner»; klartekst-hemmelighetene i SWA Configuration hører også
   hjemme der. **En evaluator som finner noe vi ikke har nevnt, leser alt
   annet med nye øyne.**

**Runde 2 — verktøykjeden**

4. MkDocs + pandoc i CI, utgivelse til `/dokumentasjon/*` bak Entra.
5. Forside og navigasjon ordnet etter målgruppe, ikke etter filnavn.

**Runde 3 — skjemaeier og sluttbruker**

6. Notasjonsreferanse (DNF, feltreferanser, FasteData).
7. Veiledning for skjemaeiere, med editoren som utgangspunkt.
8. Brukerveiledning — vurder i appen framfor på en egen nettside.

**Løpende**

9. `FASE-*`-filene flyttes til et eget «bakgrunn og beslutninger»-område. De
   skal ikke slettes og ikke være førsteinntrykket.

## Det jeg mener er den største risikoen

Ikke at dokumentasjonen blir for liten, men at den blir **to sannheter**.

Repoet har tre ganger denne uka hatt samme regel i to filer som svarte ulikt —
datakildene, `handling`-verdiene, env-inventaret. Alle tre ble funnet først da
noen skrev en test som leste begge. En dokumentasjonsside som beskriver
systemet, er den fjerde kopien.

Derfor: generer det som kan genereres, og la en test eie koblingen for resten.
