# Vurdering: tilgang til kildekoden

**Status: diskusjon.** Ingenting er besluttet. Notatet er skrevet 30.10.2026
som grunnlag for sikkerhetsdiskusjonen. To alternativer har vært diskutert
uten at diskusjonen ble skrevet ned: å gjøre repoet privat, eller å flytte
koden til et nytt, privat repo som FHS eier.

Fakta under er **målt 30.10.2026**, ikke antatt, med mindre noe annet står.
Det som gjelder GitHub sine planer, er lest i GitHub sin dokumentasjon samme
dag — se kildene nederst — og bør bekreftes mot planen FHS faktisk har.

---

## Slik er det i dag

| | |
|---|---|
| Repo | `jachrist/skjema-swa`, på en **personlig** GitHub-konto |
| Synlighet | **Offentlig** siden opprettelsen 05.08.2026 |
| Historikk | 803 commits, 0 forks |
| Hemmeligheter | **Ingen** — se under |

### Hva som IKKE ligger der

Ingen nøkler, passord, tilkoblingsstrenger eller flyt-URL-er med signatur.
Det er ikke bare en påstand:

- `api/test/env-inventar.test.js` feiler på `sig=`, `AccountKey=`,
  flyt-adresser og private nøkler i inventaret, og testene kjører før hver
  deploy.
- Historikken ble søkt gjennom 30.10.2026 etter de samme mønstrene pluss
  `sk-ant-`, `clientSecret` og SAS-strenger. Eneste treff med ekte form var
  en SAS i en test — uten `sig=`, og derfor ubrukelig.
- Hemmelighetene bor i Key Vault, i app settings og i GitHub Actions
  secrets. Ingen av delene er en del av repoet.

**Det er ingenting å rotere fordi repoet har vært offentlig.**

### Hva som LIGGER der

Ikke hemmelig, men nyttig for den som kartlegger løsningen:

- **Tenant-ID-ene**, i `openIdIssuer` i `staticwebapp.config.*.json`.
- **Ressursnavn**: Key Vault (`fhs-kv-01`, `kv-fhsskjema-pilot`),
  lagringskonto, ressursgruppe, Function App og SWA-adressene.
- **Hele arkitekturen og sikkerhetsmodellen**: `SIKKERHET-OG-ARKITEKTUR.md`,
  `SECURITY.md`, og kokeboka med roller, vakter og hvilke kall som krever
  hva.
- Testdata med oppdiktede adresser (`a@mil.no`). Ingen ekte personer.

Ingenting av dette gir tilgang alene — innlogging går gjennom Entra, og
API-et krever det. Men det senker terskelen for et målrettet forsøk.

### Det som ikke kan gjøres om

**Å gjøre repoet privat nå trekker ikke tilbake det som har vært offentlig i
tre måneder.** Det kan være klonet, indeksert eller arkivert. Beslutningen
handler derfor om hva som skal være offentlig FRAMOVER, og om eierskap — ikke
om å lukke en lekkasje.

---

## To ting GitHub-planen avgjør

Dette er det viktigste funnet, og det gjelder begge alternativene.

**1. Godkjenning før prod-deploy.** «Deploy prod eller pilot» og «Deploy API
til Function App» kjører i GitHub-miljøet `prod`, som krever godkjenning.
Ifølge GitHub sin dokumentasjon er **required reviewers bare tilgjengelig for
offentlige repoer på planene Free, Pro og Team**. Et privat repo på en av de
planene mister godkjenningssteget — deployen går rett ut. Enterprise er den
planen som ser ut til å ha det for private repoer, men det står ikke
eksplisitt i kildene og må bekreftes.

**2. Hemmeligheter per miljø.** `AZURE_FUNCAPP_CREDENTIALS` ligger i
GitHub-miljøet `prod`, ikke som repo-hemmelighet (kokeboka, kapittel 8).
Miljøhemmeligheter i private repoer krever Pro, Team eller Enterprise. **Et
privat repo på Free bryter deployen av API-et.**

I tillegg: Actions-minutter er gratis for offentlige repoer, men trekkes fra
planens kvote for private. De åtte cron-jobbene kjører daglig mot to miljøer
til v2 er revet.

### Hvilken plan, og hva den koster

| Plan | Miljøhemmeligheter, privat | Godkjenning før deploy, privat | Listepris (ikke fra GitHub selv) |
|---|---|---|---|
| Free | Nei | Nei | 0 |
| Team | **Ja** | **Nei** | ca. 4 USD per bruker per måned |
| Enterprise (Cloud) | Ja | **Ja** | ca. 21 USD per bruker per måned |

**Enterprise er den eneste planen som dekker begge punktene for et privat
repo.** GitHub sin egen dokumentasjon sier at required reviewers bare finnes
for offentlige repoer på Free, Pro og Team, og en diskusjon i GitHub
Community bekrefter at Team-planen ikke har det for private repoer.

Prisene er hentet fra tredjepartsoversikter 30.10.2026, ikke fra GitHub sin
prisside, og skal bekreftes der. Det betales per **medlem av
organisasjonen** — de som skal se og endre koden, ikke brukerne av
løsningen. Med tre medlemmer gir det i størrelsesorden 750 USD i året for
Enterprise og 150 USD for Team. Enterprise kan i tillegg kreve avtale eller
et minste antall lisenser; det er ikke undersøkt.

**Sjekk først om Forsvaret allerede har GitHub Enterprise.** Store
virksomheter har det ofte, og da er spørsmålet om FHS kan få en organisasjon
under den eksisterende avtalen — ikke hva en ny plan koster. Det avklares med
IT, ikke med GitHub.

**Team uten godkjenning før deploy** er et mulig kompromiss, med to
innstillinger som Team har for private repoer:

1. **Påkrevd gjennomgang før endringer flettes inn i `main`.**
2. **Miljøet `prod` begrenset til grenen `main`** («deployment branches»).
   Det er IKKE satt i dag: deploy-workflowene kan startes fra hvilken som
   helst gren (målt 30.10.2026), så uten denne innstillingen kan kode som
   aldri er gjennomgått, rulles ut.

Da sjekker en annen person KODEN, men ikke tidspunktet den rulles ut. Alle
med skrivetilgang kan starte en deploy, så antallet med skrivetilgang må
holdes lite. Innstilling 2 er verdt å sette uansett plan.

---

## Alternativene

### A. Gjør dagens repo privat

| For | Mot |
|---|---|
| Én innstilling, ingen flytting | Repoet blir fortsatt eid av én person |
| Ingenting som er bundet til navnet, endres | Personlig konto: hvilken plan? Se de to punktene over |

### B. Flytt til en FHS-eid organisasjon, privat

To måter: **overføring** av dagens repo, eller et **nytt** repo med koden
skjøvet inn.

| | Overføring | Nytt repo |
|---|---|---|
| Historikk, PR-er, issues | Følger med | Bare git-historikken, ikke PR-er og issues |
| Gamle lenker | Omdirigeres | Brytes |
| Actions secrets, variables, miljøer | **Uklart** for github.com — dokumentasjonen lister dem ikke. Planlegg for å legge dem inn på nytt, og verifiser | Må legges inn på nytt |
| Repoets offentlige historikk | Den samme | Kan starte rent — men det som har vært offentlig, er det fortsatt |

PR-numrene brukes i dokumentasjonen og i commit-meldingene («PR #188»). Ved
overføring fortsetter de å peke riktig; i et nytt repo gjør de ikke det.

| For B | Mot B |
|---|---|
| FHS eier koden. Tilgang, revisjonslogg og avslutning når noen slutter, styres av organisasjonen — ikke av én persons konto | Mer arbeid, og alt som er bundet til navnet må oppdateres |
| Planen er FHS sin, og kan være Enterprise | Krever at FHS har, eller oppretter, en organisasjon |

**Det som er bundet til `jachrist/skjema-swa`**, og som må følge med:

| Hva | Hvor |
|---|---|
| SWA-ressursenes kobling til repoet | Hver SWA i portalen (`DEPLOY.md`: «Deployment source»). Deploy-tokenene virker uansett repo |
| Actions secrets og variables | `AZURE_FUNCAPP_CREDENTIALS`, `AZURE_FUNCAPP_PUBLISH_PROFILE`, `SCHEDULER_KEY`, SWA-tokenene, `SWA_URL`, `SWA_URL_PROD` |
| GitHub-miljøene `dev`, `pilot`, `prod` med godkjenning | Repo-innstillinger |
| Planlagt OIDC-pålogging fra GitHub til Azure | `SECURITY.md`: subject `repo:jachrist/skjema-swa:…`. Ikke i bruk ennå, men skal skrives med det nye navnet |
| Claude-integrasjonen | GitHub-appen må installeres i FHS-organisasjonen |
| Lenkene i dokumentasjonen | `DEPLOY.md`, `SECURITY.md` |

---

## Anbefaling

**B, men ikke før cutover.** Eierskapet er det sterkeste argumentet — en
løsning i drift for FHS skal ikke ligge på én persons konto. Synligheten er
et mindre argument, siden det som er lest, er lest.

Tidspunktet: **etter cutover og etter at v2 er revet.** Da er cron-jobbene
borte, de tre deploy-workflowene kan være slått sammen til én (ryddelista i
kapittel 13 i kokeboka), og det er langt færre hemmeligheter og miljøer å
flytte. Å flytte nå betyr å flytte alt to ganger.

**Forutsetning:** FHS-organisasjonen må ha en plan med godkjenning og
miljøhemmeligheter for private repoer. Har den ikke det, er valget mellom et
offentlig repo med godkjenning og et privat repo uten — og da bør
godkjenningen flyttes et annet sted før repoet gjøres privat, ikke etterpå.

---

## Spørsmål til møtet

1. **Har Forsvaret eller FHS GitHub Enterprise allerede?** Avgjør om
   godkjenningssteget og miljøhemmelighetene overlever et privat repo, og om
   det koster noe.
2. **Skal repoet være privat, eller holder det at FHS eier det?** Koden er
   ikke hemmelig; tenant-ID-er og ressursnavn er det heller ikke, men de er
   nyttige for kartlegging.
3. **Overføring eller nytt repo?** Overføring beholder PR-historikken som
   dokumentasjonen viser til.
4. **Hvem skal ha tilgang**, og hvem eier organisasjonen når prosjektet går
   over i forvaltning?
5. **Skal noe gjøres med det som har vært offentlig?** Det finnes ingen
   hemmeligheter å rotere. Om tenant-ID-er og ressursnavn regnes som
   sensitive, kan de ikke gjøres usynlige i ettertid — bare endres.

---

## Kilder

- GitHub Docs, «About environments» — required reviewers og
  miljøhemmeligheter per plan:
  <https://docs.github.com/actions/reference/environments>
- GitHub Docs, «Managing environments for deployment»:
  <https://docs.github.com/actions/managing-workflow-runs-and-deployments/managing-deployments/managing-environments-for-deployment>
- GitHub Community, diskusjon 170307 — Team-plan uten required reviewers på
  private repoer: <https://github.com/orgs/community/discussions/170307>
- Priser, tredjepart (ikke GitHub): Capterra,
  <https://www.capterra.com/p/129067/GitHub/pricing/>, og costbench,
  <https://costbench.com/software/developer-tools/github/>. Bekreft mot
  <https://github.com/pricing>.
- GitHub Community, diskusjon 202852 — required reviewers i private repoer
  krever Enterprise: <https://github.com/orgs/community/discussions/202852>
- GitHub Docs, «Transferring a repository» — hva som følger med:
  <https://docs.github.com/en/enterprise-cloud@latest/repositories/creating-and-managing-repositories/transferring-a-repository>
