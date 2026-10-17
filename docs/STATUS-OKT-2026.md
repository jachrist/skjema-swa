# Status oktober 2026 — hva som er bygget, og hva som gjenstår

Skrevet som underlag for presentasjonen for oppdragsgiver.
Tekniske detaljer ligger i `BESLUTNING-EGEN-FUNCTION-APP.md`; dette er
sammendraget.

---

## Kort fortalt

Skjemaløsningen er i drift. Arbeidet denne perioden har handlet om noe som
ikke er synlig for brukerne, men som avgjør hva løsningen kan gjøre videre:
**den er flyttet ut av en innpakning som satte tre grenser vi ikke kunne leve
med.**

Flyttingen er fullført og målt i et eget utviklingsmiljø. Produksjon er
uendret og uberørt.

---

## Problemet vi løste

Løsningen kjørte som *SWA Managed Functions* — en forenklet innpakning rundt
Azure Functions. Den er billig å komme i gang med, og den sier nei til tre
ting:

| Begrensning | Hva det kostet oss |
|---|---|
| Ingen tidsstyrte jobber | De åtte nattjobbene — backup, dataimport, varsler, purringer — måtte kjøres av **GitHub** utenfra, med en delt nøkkel inn gjennom en åpen dør |
| Ingen maskinidentitet | All tilgang til lagringen gikk på en **tilkoblingsstreng**: en nøkkel som gir full tilgang til alt, og som må limes inn og roteres manuelt |
| Henter ikke hemmeligheter selv | Passord og nøkler måtte stå i **klartekst** i konfigurasjonen i stedet for å hentes fra Key Vault |

Alle tre er sikkerhetsmessig uønskede, og den første er i tillegg skjør: en
nattjobb som avhenger av at en ekstern tjeneste husker å ringe oss, feiler på
måter ingen oppdager.

---

## Hva som er gjort

**Hele API-et kjører nå som en selvstendig tjeneste med egen maskinidentitet**
i utviklingsmiljøet. Det betyr:

- **Ingen tilkoblingsstreng.** Lagringen nås med en identitet som har fått
  nøyaktig de rettighetene den trenger — lese og skrive data, ikke mer. Den
  kan ikke liste ut nøkler, og det finnes ingen nøkkel å stjele.
- **Hemmeligheter hentes fra Key Vault** av plattformen selv, ved oppstart.
- **Alle åtte nattjobbene kjører på klokke inne i løsningen** — ni
  tidsstyringer i alt, siden backup har to kadenser (full og delta). Den
  delte nøkkelen og den åpne døren kan fjernes når produksjon følger etter.

**Dette er målt, ikke antatt.** Hver jobb er observert å kjøre, med en
hendelseslogg som viser *hvem* som startet den. Det er forskjellen på «koden
er skrevet» og «jobben kjører».

---

## Det som kanskje betyr mest på sikt

Underveis er det bygget inn noe som ikke sto i bestillingen: **løsningen sier
nå fra når den tar feil.**

- Et **jobbpanel** i administrasjonen viser hver nattjobb: hva som utløser
  den i dette miljøet, når den kjører, når den sist kjørte, og om den
  faktisk er registrert. Et panel som påsto «dette kjører» uten å vite det,
  var det første vi rettet da vi tok det i bruk.
- **En jobb som ikke når fram, markerer ingenting som utført.** En purring
  som ikke ble sendt, blir forsøkt igjen — den blir ikke avkrysset i det
  stille.
- **Helsesjekken skiller mellom årsaker.** Samme symptom kan ha to helt
  ulike forklaringer i ulike miljøer, og rådet den gir er tilpasset miljøet
  den står i.

Løsningen har i dag **140 endepunkter**. Ingen av dem er åpne uten at det er
skrevet ned hvorfor, og et skript kontrollerer det ved hver endring.
**124 testfiler** kjøres før hver utrulling, og utrullingen stopper på rødt.

---

## Arbeidsmåten

To vaner har formet resultatet mer enn noe annet:

**Én regel, ett sted.** Den tilbakevendende feilen i et system som dette er
at samme regel finnes i to utgaver som svarer ulikt — og at forskjellen er
taus. Hver gang vi fant en slik, ble den slått sammen, og en test leser nå
begge sider og krever samme svar.

**Vi bryter koden med vilje for å se at testen fanger det.** En grønn test
beviser ingenting før man har sett den bli rød. I denne perioden avdekket
den vanen flere tester som var grønne av feil grunn — og én kontroll som
hadde sluttet å kontrollere noe som helst.

---

## Veien videre

Flyttingen er gjort og målt i utviklingsmiljøet. Produksjon står igjen, og
forslaget er å gjøre det **uten å rive i det som virker**:

1. **Sett opp en ny produksjonsversjon ved siden av dagens**, mot en tom
   lagringskonto. Den testes i fred mens dagens løsning går som før.
2. **Fyll den med et utvalg skjematyper** fra dagens produksjon. Verktøyet
   for det er bygget, og det advarer om avhengigheter som ikke følger med.
3. **Test ferdig.** Deretter kobles den nye versjonen til de ekte dataene,
   eller dataene flyttes over etter et kort kjørestopp.
4. **Veien tilbake er ett steg.** Går noe galt, peker vi tilbake til dagens
   versjon, som står urørt hele veien.

En egen kokebok (`KOKEBOK-PROD-V3.md`) beskriver oppsettet kommando for
kommando, slik at det kan gjøres i ett arbeidsmøte med driftsmiljøet i
stedet for å bestilles som enkeltoppdrag.

**Et eget domene** bør på plass før cutover. Da blir overgangen — og en
eventuell retur — en navneendring i stedet for en ny adresse alle må lære.

---

## Det vi ikke vet ennå

| Spørsmål | Status |
|---|---|
| Kostnaden ved å kjøre to versjoner parallelt | **Skal slås opp, ikke antas.** Volumet er lite, men prisen er ikke sjekket |
| Om maskinidentitet kan erstatte flytene helt | Utredet, ikke prøvd. Den veien krever rettigheter som må avklares med driftsmiljøet |
| Prod-tenantens egne rammer | Policyer, regioner og roller må bekreftes av driftsmiljøet før oppsettet kan kjøres |

Det er med vilje at denne lista finnes. Et sammendrag som bare inneholder det
som gikk bra, er ikke et sammendrag.
