# Utestående punkter skjemasystem

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
29. [ ] `env.pilot.json` og `env.production.json` deklarerer bare 2 av de 7 flyt-URL-ene koden faktisk leser. Mangler: `BACKUP_FLOW_URL`, `OTP_FLOW_URL`, `PURRE_FLOW_URL`, `TEAM_LAST_MEDLEMMER_FLOW_URL`, `TEAM_SOK_EKSTERNT_FLOW_URL`.
30. [ ] Helsesjekken i `api/src/functions/system.js` lister 4 av 7 flyt-URL-er. Utvid lista, og avklar samtidig om `AAD_CLIENT_SECRET` skal finnes i prod — den mangler der i dag, og helsesjekken skiller ikke på miljø.
31. [ ] `docs/FASE-6A-EPOST.md`, `FASE-9-EKSTERN-FLYT.md` og `FASE-10-SP-LISTE.md` viser fortsatt `logic.azure.com`-adresser i eksemplene. Riktig adresse er SWA-endepunktet med `x-flow-key`.
32. [ ] Visningsflatene slår ikke opp filtrert FasteData på nytt for eldre skjemaer, så et svar kan vises med utdatert oppslagstekst.
33. [ ] Prod-deploy gjenstår for FS-beskrivelser (LU → Markdown) og oppslags-prefill i utsendinger. Pilot er oppdatert.
34. [ ] FasteData-utvidelser: analysen ble levert 13.08.2026 og venter på kundens prioritering. Ikke start arbeidet før den foreligger.
