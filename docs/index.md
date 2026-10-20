# FHS Skjema — dokumentasjon

Skjemaløsningen er en Azure Static Web App med et API i Azure Functions, data
i Table og Blob Storage, innlogging med Entra ID og integrasjoner mot FS,
SharePoint, Teams og Power BI.

Denne siden serveres fra løsningen selv, **bak samme Entra-innlogging som
appen**. Det er et bevisst valg: arkitektur, datasikring og tilgangsstyring
beskriver nøyaktig det en angriper vil vite — hvilke mekanismer som finnes,
hvor de ikke finnes, og hvilke antagelser de hviler på.

## Finn fram etter hva du skal gjøre

### Jeg skal vurdere sikkerheten i løsningen

Start med **[Sikkerhet og arkitektur](SIKKERHET-OG-ARKITEKTUR.md)**. Det er
overleveringsdokumentet: avgrensning, datastrømmer, komponentfigur,
tilgangsmodell og kjente begrensninger i ett dokument.

Kapittel 10 er det viktigste for en vurdering: **kjente begrensninger**, samlet
og med vilje. En evaluator som finner noe vi ikke har nevnt, leser alt annet
med nye øyne.

Deretter: [API-oversikt](API-OVERSIKT.md) for hva som er eksponert og hvem som
slipper til — generert fra koden, ikke skrevet av. Og
[Datamodell](DATA-MODELL.md) for hva som lagres hvor.

### Jeg skal forvalte eller drifte løsningen

Start med **[Forvaltning](FORVALTNING.md)**. Den er inngangen for den som har
ansvaret: årshjulet, hva som må gjøres når, og hvor hver oppgave er beskrevet.

De to som brukes oftest: [Deploy](DEPLOY.md) for utrulling per miljø, og
[Kokebok prod v3](KOKEBOK-PROD-V3.md) for å sette opp et miljø fra ingenting.

### Jeg skal lage eller endre et skjema

Denne delen er ikke skrevet ennå — den er runde 3 i
[dokumentasjonsplanen](DOKUMENTASJONSPLAN.md). Notasjonene (DNF,
feltreferanser, `FasteData`-syntaks) finnes i dag bare som hjelpetekster i
editoren.

### Jeg skal videreutvikle koden

`CLAUDE.md` i repoet er inngangen: arkitektur, konvensjoner og arbeidsmåte.
Derfra er **[Bakgrunn og beslutninger](BESLUTNING-EGEN-FUNCTION-APP.md)** det
som sjelden finnes andre steder — hvorfor et valg ble tatt, hva som ble prøvd
og forkastet, og hvilken feil som førte til en regel.

## Hva denne dokumentasjonen er, og ikke er

Mesteparten er skrevet underveis, av og for dem som bygget løsningen.
`FASE-*`-filene er endringsnotater: «slik bygget vi dette, og hvorfor». De er
gode på nettopp det som ellers går tapt, og de skal ikke kastes — men de er
ikke en veiledning, og de er ikke en brukermanual.

Det som **kan** genereres fra koden, blir generert: API-oversikten,
env-inventaret, flytkontraktene. Det som er skrevet for hånd, må vedlikeholdes
for hånd — og den største risikoen i hele dette arbeidet er ikke at
dokumentasjonen blir for liten, men at den blir **to sannheter**. Repoet har
hatt samme regel i to filer som svarte ulikt flere ganger, og hver gang ble
det funnet først da noen skrev en test som leste begge.

Derfor: genereres det som kan genereres, og en test eier koblingen for resten.

| | |
|---|---|
| Sist bygget | ved hver deploy, fra `main` |
| Kilden | `docs/*.md` i repoet — ingen kopi |
| PDF for overlevering | `SIKKERHET-OG-ARKITEKTUR.md`, bygget av samme jobb |
