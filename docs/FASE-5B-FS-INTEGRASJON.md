# Fase 5b: FS-integrasjon

Henter Emner + EmneStudenter fra Felles Studentsystem (FS) via GraphQL og cacher
i Table Storage. Kjøres daglig via GitHub Actions cron (SWA Managed Functions
har ikke timer-triggere).

## Kildene

| Datakilde | Filtre | Kommer fra |
|-----------|--------|------------|
| Emner | Termin, Campus | FS undervisningsenheter |
| Studenter | Emne | FS undervisningsenheter → studieretter |
| Studieprogrammer | (uten filter) | Utledet fra Emner |
| Personer | EmneLarere, EmneHovedlarere, EmneStudenter | FS personroller |

Filternavnene brukes i DNF-editor når man setter opp FasteData-oppslag.

## Tabeller

- **Emner** — PK=TerminKort (f.eks. "26H"), RK="{EK}-{VK}"  
  Egenskaper: EK, VK, EN, SK, SN, C, Larere (JSON), Hovedlarere (JSON), LU
- **EmneStudenter** — PK="{TerminKort}|{EK}-{VK}", RK=upn (lowercase)  
  Egenskaper: EP, FN, EN
- **CacheMetadata** — PK="Meta", RK="FS-Emner"/"FS-Studenter" — sist-kjørt-info

## Env-vars som må settes i SWA

I Azure Portal → SWA → Configuration:

```
FS_API_URL           https://api.fellesstudentsystem.no/graphql/
FS_API_USER          <FS-brukernavn>
FS_API_PASSWORD      <FS-passord>   (evt. via @Microsoft.KeyVault(...))
FS_EIER_ORG_KODE     1627            (FHS)
SCHEDULER_KEY        <tilfeldig streng — minst 32 tegn>
```

`SCHEDULER_KEY` skal ALDRI committes — genereres én gang og settes både i SWA
Configuration og i GitHub Actions secret.

## GitHub-oppsett

I repo → Settings → Secrets and variables → Actions:

- **Variable** `SWA_URL` = f.eks. `https://swa-fhsskjema-pilot.azurestaticapps.net`
- **Secret** `SCHEDULER_KEY` = samme verdi som i SWA Configuration

Workflow: `.github/workflows/refresh-fs.yml` — kjører 04:00 UTC daglig,
kan trigges manuelt fra Actions-fanen.

## Endepunkter

- `POST /api/refresh-fs` — kjør refresh. Krever admin (SWA-cookie) ELLER
  `x-scheduler-key`-header som matcher `SCHEDULER_KEY`.  
  Returnerer `{ status, terminer, antallEmner, antallStudenter, varighetSekunder }`.
- `GET /api/refresh-fs/status` — sist-kjørt-info. Krever innlogget bruker.  
  Returnerer `{ "FS-Emner": {...}, "FS-Studenter": {...} }`.

## Manuell test

```bash
curl -X POST https://<swa-url>/api/refresh-fs \
  -H "x-scheduler-key: <SCHEDULER_KEY>" \
  -H "Content-Type: application/json"
```

Første full-refresh mot FS tar typisk 30–90 sekunder (~500–1500 undervisningsenheter,
paginert 200 om gangen). Etterfølgende refresh er like tunge (full erstatning av
aktive partisjoner), men trafikken mot FS er beskjeden.

## Retention

For hver refresh:
- Slett alle rader i de tre aktive terminene, skriv nye
- Slett hele partisjoner som IKKE lenger er blant de tre aktive

Ryddingen skjer først etter at nye rader er skrevet, så det finnes aldri et
vindu med tom cache.

## Aktive terminer

Beregnes ut fra dagens dato i `api/src/lib/terminer.js`:
- **Forrige** — foregående halvår
- **Inneværende** — VÅR (jan–jun) / HØST (jul–des)
- **Neste** — kommende halvår

Ved semester-skift roterer settet automatisk uten manuell intervensjon —
alt som forsvinner av gamle terminer blir liggende inntil neste kjøring
rydder det.

## LU (læringsutbytte)

Læringsutbytte-teksten hentes fra `beskrivelsesavsnitt` med tekstkategori
`E-FHSLUB`, filtrert mot den SISTE aktive terminen. Det gir mest oppdatert
versjon. HTML-tags fra FS (`<list>`/`<listItem>`) normaliseres til standard
`<ul>`/`<ol>`/`<li>` i `refresh-fs.js` sin `normaliserLuHtml()`.

## Feilhåndtering

Hvis refresh feiler, skrives `Status: 'feil'` og `SistFeil: <melding>` til
CacheMetadata så admin ser hva som skjedde. GitHub Actions logger full
respons og feiler jobben på non-200.

## Neste steg

- Fase 5c: Editor-utvidelse for rolle/team i Publikum/Eiere/Behandlere
- Team-oppslag venter på Graph API (fase 8) eller BYOF
