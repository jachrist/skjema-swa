# Utestående punkter skjemasystem

> **Frosset — lista har flyttet inn i appen.**
>
> Punktene vedlikeholdes nå under **Administrasjon → ✅ Oppgaver**, med lagring i
> Table Storage på dev-tenanten, slik at pilot og prod ser samme liste.
>
> Denne fila står igjen som kilde for engangsimporten: åpne Oppgaver-fanen,
> velg *Importer fra Markdown*, lim inn alt under streken og trykk Importer.
> Importen hopper over numre som allerede finnes, så den kan trygt kjøres om
> igjen. **Når importen er bekreftet, tøm alt under streken** — da finnes lista
> bare ett sted.
>
> Trenger du en Markdown-kopi senere (til deling eller et referat), bruk
> *Kopier som Markdown* eller *Last ned .md* i samme fane.

---

Kryss av med `[x]` når et punkt er levert. Ferdige punkter blir stående, og nye
legges til nederst — da holder numrene seg stabile, slik at «punkt 17» betyr det
samme i dag og om en måned.

1. [ ] Sjekk om det kan være flere behandlere ved flere valg i nedtrekksmeny
2. [ ] Varsling ved ferdig behandling - dynamisk rolle basert på felt
3. [ ] Dynamisk filter i rapport basert på innlogget brukers rolle
4. [ ] Import av liste for roller / omfang / innehavere
5. [ ] Datauttrekk - informasjon om utfall av behandling (Metadata, svarene, behandlingsdata)
6. [x] Prosess og Gevinstseksjon i skjemaeditor (skala baseline og erfaringsdata)
7. [ ] Kort undertekst til hver designseksjon - hva gjør man i den enkelte seksjon
8. [x] lysere bakgrunn på ikonene i Mørk modus + noe hvit tekst mot hvit bakgrunn (rapportgenerator).
9. [ ] Mørk tekst på tekster i mørk modus...
10. [ ] Mulighet for å sette på daglig automatisk oppdatering av powerBI-rapporter.
11. [x] Backup og restore-funksjoner (servicebruker onedrive)
12. [ ] Dokumentasjon av løsning (løsningsbeskrivelse, brukerdokumentasjon, forvaltningsdokumentasjon)
13. [x] Ugradert merking på forsiden av løsningen + Overskrift "Adm.skjema" på rapportene.
14. [ ] Avsnittene har lys grå bakgrunn i lys modus (Lys/mørk-knapp tilgjengelig på åpnet skjema også)
15. [ ] Mulighet for Klasser som publikum eventuelt som et filter under "personer".
16. [ ] Cheat-sheet og brukerhistorieorientert dokumentasjon i systemet med spørsmålstegn for aksess.
17. [ ] Flytt ID-nummer foran overskriften på skjematypen og gjør den søkbar i søkefeltet (ord i tittel + ID-nr).
18. [ ] Kopier-knapp URL direkte til dette skjema.
19. [ ] Bedre plassering og størrelse for valgt skjemaIkon for skjematypen (topp venstre før skjematittel).
20. [ ] mangler "Tilbake til skjemaoversikt-knapp" etter å ha åpnet et skjema (funker riktig i Rediger-skjema-modus)
21. [ ] Mobil: Responsiv visning har noen bugs - Pålogget bruker ligger utenfor rammen og opptar halve bredden i mobilvisning. Velger du "Informasjon" så holder ikke overskriften seg innenfor sin egen boks (Bryt tekst virker ikke).
22. [x] Editor: endrer man en feltkategori eller legger til et felt ekspanderes alle seksjoner og bildet hopper. det gjør det nesten umulig å vite hvor man var.
23. [ ] Utfylling: Når man trykker på Fyll ut skjema, bør seksjonene være lukket. da får brukeren rask overikt over seksjonsoverskriften og hva som skal fylles ut. Dersom seksjonene inneholder ett eller flere obligatorisk spørsmål, bør seksjonen også ha en rød stjerne etter tittelen.
24. [ ] Teksten i skjemaforklaring er midtstilt, fremstår rotete og bør være venstrestilt.
25. [ ] Editor: Autolagring/sist lagret virker å være borte.

## Teknisk gjeld notert underveis

Punktene under er ikke meldt inn av brukere, men funnet under arbeid i koden.

26. [ ] Ytelse: `/api/mine-behandlinger` bruker ~1,7 s fordi den skanner alle skjemaer med status 2 og avgjør behandler-tilhørighet i etterkant. Indekser tilhørigheten ved innsending i stedet.
27. [ ] `utsendingPurre` skriver rad for rad mot Table Storage. Legg om til batch-transaksjoner — SWA kutter kallet etter 45 sekunder, og en stor purrerunde henger stille.
28. [ ] `EPOST_FLOW_URL` er deklarert i alle tre `config/env.*.json`, men brukes ikke i koden. Fjern den.
29. [ ] `config/env.*.json` er ikke lenger en trofast oversikt. De aktive filene er `env.pilot.json` og `env.prod.json` (`env.production.json` er arv fra foer dual-tenant og leses bare via bakoverkompatibilitet i `build-config.js`). Bare `public: true`-verdiene brukes til noe — resten er dokumentasjon, og de faktiske innstillingene ligger i SWA Configuration. I dag deklarerer filene 2-3 av de 7 flyt-URL-ene koden leser, og `env.prod.json` har fortsatt plassholdere som `<sett-naar-prod-storage-opprettes>` selv om prod er i drift. Avgjoer om filene skal gjoeres autoritative (et skript som setter app settings) eller merkes tydelig som ren inventarliste.
30. [ ] Helsesjekken i `api/src/functions/system.js` lister 4 av 7 flyt-URL-er. Utvid lista, og avklar samtidig om `AAD_CLIENT_SECRET` skal finnes i prod — den mangler der i dag, og helsesjekken skiller ikke på miljø.
31. [ ] `docs/FASE-6A-EPOST.md`, `FASE-9-EKSTERN-FLYT.md` og `FASE-10-SP-LISTE.md` viser fortsatt `logic.azure.com`-adresser i eksemplene. Riktig adresse er SWA-endepunktet med `x-flow-key`.
32. [ ] Visningsflatene slår ikke opp filtrert FasteData på nytt for eldre skjemaer, så et svar kan vises med utdatert oppslagstekst.
33. [x] Prod-deploy for FS-beskrivelser (LU → Markdown) og oppslags-prefill i utsendinger — deployet 24.08.2026 (43972d1).
34. [ ] FasteData-utvidelser: analysen ble levert 13.08.2026 og venter på kundens prioritering. Ikke start arbeidet før den foreligger.
35. [ ] `api/package-lock.json` er ikke i takt med `package.json` — `jszip` manglet i laasefila. `npm ci` feiler dermed, og CI-jobben ville stoppet paa foerste PR. Deployen merket det ikke fordi Oryx kjoerer `npm install`. Fikset for jszip 25.08.2026; vurder en CI-sjekk som kjoerer `npm ci` paa main-push, ikke bare paa PR.
36. [ ] `npm test` i `api/package.json` er fortsatt `echo "No tests yet"`. CI-steget "Kjoer tester" gjoer altsaa ingenting. Testene som er skrevet underveis ligger i scratchpad og kjoeres manuelt — flytt dem inn i repoet og koble dem paa.
37. [ ] Backup kjoeres bare naar noen trykker paa knappen. Vurder en cron-workflow mot `/api/backup/kjor` med `x-scheduler-key`, paa linje med `refresh-fs.yml` og `purre-utsendinger.yml`.
38. [ ] Backupfila passerte 100 MB i prod 25.08.2026. `byggBackup` holder alle blobbene, zipen og den krypterte kopien i minnet samtidig — grovt regnet tre ganger datamengden. Legg om til streaming mot midlertidig blob, slik toppkommentaren i `api/src/lib/backup.js` forutsetter for stoerre datamengder.
