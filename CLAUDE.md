# skjema-swa

SWA-basert reimplementasjon av FHS Skjema-løsningen.
Språk: **norsk** i kode, kommentarer, API-feltnavn og brukergrensesnitt.

## Arkitektur

- **Frontend:** ren HTML/CSS/JS med ES-moduler i `frontend/`. Ingen byggsteg (bortsett fra config.js-generering).
- **Backend:** Azure Functions v4 i `api/`, kun HTTP-triggere.
- **Datalagring:** Azure Table Storage + Blob Storage via tilkoblingsstreng
  (`STORAGE_CONNECTION_STRING`), lest i `lib/storage.js` og `lib/blob.js`.
- **Hemmeligheter:** app settings i SWA Configuration. Verdiene hentes manuelt
  fra Key Vault når de settes — koden slår ikke opp i Key Vault selv.

> **Managed Identity er ikke tilgjengelig for koden vår.** SWA Managed
> Functions eksponerer ingen MI-token, så `DefaultAzureCredential` får ikke
> tak i noe. `lib/keyvault.js` er død kode og importeres ingen steder.
>
> Den ene MI-en som faktisk brukes, ligger på SWA-ressursen i prod og slås opp
> av *plattformen*, ikke av oss: auth-sertifikatet hentes fra Key Vault via
> `clientSecretCertificateKeyVaultReference` i `staticwebapp.config.prod.json`.
> Den identiteten trenger bare **Key Vault Secrets User** og **Key Vault
> Certificate User** på `fhs-kv-01` — ingen storage-roller.
>
> Pilot-SWA-en har storage-roller på sin MI. De er levninger fra det
> opprinnelige designet og brukes ikke; ikke kopier dem til nye miljøer.
- **Auth:** Static Web Apps innebygd Entra ID — UPN leses fra `x-ms-client-principal`-header via `api/src/lib/auth.js`.
- **Deploy:** GitHub Actions → SWA, med Environments (`development`, `production`).

## Viktige konvensjoner

- Ingen hemmeligheter i kode eller i env-JSON. Kun Key Vault-referanser (`{"keyvault": "secret-navn"}`) eller ikke-sensitive verdier (`{"value": "...", "public": true|false}`).
- Ikke-hemmelige verdier med `"public": true` eksponeres til frontend via `frontend/js/config.js` (bygget av `scripts/build-config.js`).
- Timer-triggere støttes ikke i SWA Managed Functions — bruk GitHub Actions cron mot HTTP-endepunkter (`.github/workflows/refresh-fs.yml`).
- Autorisasjon på ruter håndteres primært deklarativt i `staticwebapp.config.json`. Fininnstilt admin-sjekk gjøres i handler via `erAdmin(upn)`.
- HTML-filene har inline CSS/JS — samme mønster som referanse-appen. Ikke trekk ut felles CSS uten eksplisitt avtale.
- Tester: `npm test` fra `api/` kjører alt via `scripts/kjor-tester.js` — alle
  `*.test.js` i `api/test/` og `frontend/test/`. Testene skal kunne kjøre **uten**
  `node_modules`; derfor lastes Azure-SDK-ene lat i `storage.js` og `blob.js`.
  Frontend-tester klipper ut den aktuelle seksjonen fra HTML-fila og kjører den
  mot stubbet DOM. Deploy kjører testene før utrulling og stopper på rødt.

## Arbeidsmåte

Disse er lært av feil som faktisk har skjedd her, ikke av prinsipp.

**Én regel, ett sted.** Den tilbakevendende feilklassen i dette repoet er at
samme regel finnes i to eksemplarer som svarer ulikt. Felttypen diagnosen
godtar mot den ekspansjonen avviser. Editorens «hva er en feltreferanse» mot
API-ets. «Har steget en avhengighet» i behandlingen mot den samme i diagnosen.
Må en regel finnes to steder — frontend kan ikke `require` backend — skal en
test lese BEGGE og kreve likt svar.

**Test ved å bryte koden.** En grønn test beviser ingenting før du har sett den
bli rød. Bryt regelen med vilje, i flere retninger, og se at riktig test
feiler.

**Verifiser at mutasjonen faktisk ble påført.** `sed` med feil flagg og
python-ankre som treffer feil forekomst gir en no-op som ser ut som et hull i
testdekningen. Det har skjedd tre ganger og ført til gale konklusjoner begge
veier. Sjekk at endringen står i fila før du tolker resultatet.

**Gjenopprett fra kopi, aldri med `git checkout`.** Under mutasjonstesting er
det fristende å rulle tilbake med `git checkout -- fil`. Den kommandoen kjenner
ikke forskjell på mutasjonen og arbeidet som ikke er committet ennå, og tar
begge. Det har skjedd tre ganger i samme økt. Ta en kopi av fila FØR
mutasjonen, og legg den tilbake derfra.

**Test mot den ekte formen.** Flere feil har overlevd fordi testen brukte et
feltnavn eller en returform som ble funnet opp i testen. Les navnet ut av
modulen som produserer det, eller kjør den ekte funksjonen.

**En nøkkel som kan forsvinne kan ikke feilsøkes.** `JSON.stringify` dropper
`undefined`, og en stille `catch` gjør det samme. Da er «det gikk galt» umulig
å skille fra «koden er ikke deployet». Sett feltet alltid, med årsaken i det
når noe feilet.

**Ikke anta at deployet kode er gjeldende.** `/api/ping` og `/js/config.js`
bærer commit-SHA-en de kjører. Sjekk den før du feilsøker en rettelse du tror
er ute.

**Fjern død kode i stedet for å kommentere den.** En vakt ingen test kan skille
fra ingenting, er ingenting — med en kommentar som påstår det motsatte.

**Avslutt hver runde med én tydelig linje:** «klar til merge: PR #N», eller
«ikke ferdig ennå» med hva som gjenstår. Arbeid som ikke er i en PR når
brukeren merger, blir liggende igjen.

## Miljøer

- **development** — SWA i egen tenant, `env.development.json` + Key Vault `kv-fhsskjema-pilot`.
- **production** — samme SWA under pilot, senere separert. Deploy krever Environment approval.

## Referanse-app

Den opprinnelige Function App-versjonen ligger i en separat mappe utenfor dette repoet.
Mønstre gjenbrukes (dispatcher, DNF-vilkår, kompakt format), men koden reimplementeres for SWA-arkitektur.
Rør ikke referanse-appen fra dette repoet.

## Gjenstående arbeid

Lista over utestående punkter — brukerønsker og teknisk gjeld — ligger i appen
under **Administrasjon → ✅ Oppgaver**, ikke i repoet. `docs/TODO.md` er tømt og
peker bare dit.

Den lista er ikke lesbar herfra. Trenger du den i en økt, be om en eksport fra
*Kopier som Markdown* / *Last ned .md* i samme fane. Numrene er stabile: nye
punkter legges nederst, og «punkt 17» betyr det samme over tid.
