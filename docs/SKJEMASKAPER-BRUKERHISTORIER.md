# Brukerhistorier for skjemaskapere

Ti historier som til sammen viser egenskapene i skjemaeditoren. Hver historie
er et realistisk skjema fra FHS, med oppsettet steg for steg og det som skal
skje når det brukes.

Innstillingene er beskrevet i `SKJEMASKAPER-INNSTILLINGER.md`. Historiene
viser til avsnittene der (§1–§9). Bakerst er en tabell over hvilken historie
som viser hvilken egenskap.

Hver historie har samme form:

- **Behovet** — hvem, hva og hvorfor
- **Oppsettet** — det skjemaskaperen gjør i editoren
- **Slik virker det** — det innsender og behandlere opplever
- **Sjekk at** — det som kan prøves etterpå. Kan også brukes som testtilfeller

Navn, roller og enheter er eksempler.

---

## 1. Påmelding til fagdag

**Behovet.** Som arrangør av en fagdag vil jeg at ansatte melder seg på med
ønskede sesjoner, slik at jeg vet hvor mange som kommer og kan fordele rom.

**Oppsettet**

1. *Grunnleggende* (§1): navn «Påmelding fagdag 2027», ikon, og en
   skjemaforklaring i Markdown med program og lenke til agendaen.
2. *Tilgjengelighet* (§2): én periode fra 1. til 20. januar.
3. *Tilgang* (§3): Publikum **Åpen for alle innloggede**. Eiere: deg selv og
   rollen `Arrangør(Fagdag)`.
4. *Seksjon 1 «Om deg»* (§6–7):
   - Informasjon: praktisk informasjon om sted og tid
   - Flervalg-dropdown «Avdeling», med alternativer skrevet inn for hånd,
     **Obligatorisk**, **Vis i registerlista**, **Filtrerbar**
5. *Seksjon 2 «Sesjoner»*:
   - Flervalg-knapper «Velg sesjoner», fire alternativer, **Maks antall
     valg** 2, Obligatorisk, Vis i registerlista
   - Tekst «Allergier og hensyn», **Flerlinje**
6. *Innsenderkvittering* (§1): på, med egen melding som gjentar tid og sted.
7. Fase **Produksjon**.

**Slik virker det.** Ansatte finner skjemaet i portalen i perioden, velger
opptil to sesjoner og sender inn. De får en kvittering på e-post. Arrangøren
ser påmeldingene i registeret med avdeling og sesjoner som kolonner, og kan
filtrere på avdeling. Etter 20. januar ser bare eierne skjemaet.

**Sjekk at**
- et tredje sesjonsvalg ikke lar seg krysse av
- skjemaet ikke vises for andre enn eierne etter at perioden er ute
- registeret har kolonnene Avdeling og Sesjoner, og filteret på avdeling virker

---

## 2. Valg av tillitsvalgt

**Behovet.** Som valgstyre vil jeg at hver ansatt kan avgi én stemme, uten at
noen kan se hvem som stemte hva, slik at valget blir hemmelig og gyldig.

**Oppsettet**

1. *Tilgjengelighet* (§2): periode for valguka. **Maks antall svar** 1.
2. *Grunnleggende* (§1): **Anonymiser innsender** på. **Krypteres**: `Svar`.
3. *Tilgang* (§3): Publikum er teamet med alle ansatte. Eiere er
   valgstyret, som rolle.
4. *Felt* (§7):
   - Flervalg-knapper «Kandidat», Maks antall valg 1, Obligatorisk, Vis i
     registerlista
   - Skala «Hvor fornøyd er du med valgordningen?» med nummer 1–5 og tekst
     på endepunktene («Lite», «Svært»)
5. Ingen behandlingssteg (§8). Skjemaet er ferdig i det det sendes inn.
6. Innsenderkvittering: på, med teksten «Stemmen din er registrert».

**Slik virker det.** Hver ansatt kan stemme én gang. Prøver noen å stemme på
nytt, avvises det. Når skjemaet avsluttes, byttes navn og e-post ut med et
pseudonym, og svarene krypteres. Valgstyret teller stemmene i registeret
eller datauttrekket.

**Sjekk at**
- en andre innsending fra samme person avvises, også fra en eier
- registeret ikke viser hvem som har stemt
- en mellomlagret, ikke innsendt stemme ikke teller som svar

---

## 3. Søknad om kurs med godkjenning i to ledd

**Behovet.** Som ansatt vil jeg søke om å ta et kurs. Lederen min skal
anbefale, og HR skal avgjøre. Jeg vil bare høre fra systemet når det er
avgjort.

**Oppsettet**

1. *Felt*:
   - Tekst «Kursnavn»
   - Valuta «Kostnad»
   - Dato «Startdato» og Dato «Sluttdato»
   - E-post «Nærmeste leder», Obligatorisk
2. *Steg 1 «Anbefaling»* (§8.1):
   - Behandlere: personen fra feltet, `{1-05}`, altså lederen innsenderen
     oppga (§8.2)
   - Beslutningsvalg: 1 «Anbefalt», 2 «Ikke anbefalt» (Handling
     **Avvisning**). **Varsle** av på begge (§8.3)
3. *Steg 2 «Vedtak»*:
   - Behandlere: rollen `HR-rådgiver(Kompetanse)`
   - **Avhengig av** steg 1
   - **Steget kjøres kun hvis** steg 1 = 1 (Anbefalt) (§9)
   - Beslutningsvalg: 1 «Innvilget», 2 «Avslått» (Avvisning), hver med egen
     **Melding til innsender**
4. *Ferdigvarsling* (§1): på, til `HR-arkiv` og lederen fra felt `{1-05}`.
5. *Validering* på Sluttdato (§7.1): **Gyldig hvis** Sluttdato `>=` Startdato,
   med meldingen «Sluttdato kan ikke være før startdato».

**Slik virker det.** Lederen får e-post når søknaden kommer, og anbefaler
eller ikke. Innsenderen hører ingenting om anbefalingen. Anbefales søknaden,
går den til HR. Blir den ikke anbefalt, hoppes steg 2 over, og saken
avsluttes. Innsenderen får HRs egen melding for vedtaket, og arkivet og
lederen får ferdigvarselet.

**Sjekk at**
- innsenderen ikke får e-post etter steg 1
- steg 2 hoppes over ved «Ikke anbefalt», og saken avsluttes
- sluttdato før startdato stopper innsendingen med meldingen

---

## 4. Søknad til egen klassesjef

**Behovet.** Som student vil jeg søke om fritak fra en aktivitet. Søknaden
skal til klassesjefen for **min** klasse, uten at skjemaet må lages én gang
per klasse.

**Oppsettet**

1. *Felt 1-01* Flervalg-dropdown «Klasse», med **datakilde** `Klasser` (§7.3),
   Obligatorisk.
2. *Felt 1-02* Flervalg-dropdown «Emne», med datakilde `Emner`, filter
   `Termin = 27V`.
3. *Steg 1*:
   - Behandlere: **rolle med omfang fra felt**, `Klassesjef({1-01})` (§8.2)
   - **Reserverolle**: `Studieleder` — brukes hvis klassen ikke har en
     registrert klassesjef
4. *Innsenderkvittering*: **Kopi til** `Kontaktlærer({1-01})`.

**Slik virker det.** Studenten velger klassen sin. Ved innsending slås
klassesjefen for akkurat den klassen opp, og søknaden går dit. Mangler
klassen klassesjef, går den til studieleder i stedet. Kvitteringen går til
studenten, med klassens kontaktlærer i kopi.

**Sjekk at**
- to studenter i ulike klasser havner hos hver sin klassesjef
- en klasse uten klassesjef havner hos studieleder
- «Sjekk oppsettet» varsler om roller uten medlemmer

---

## 5. Retting og klage

**Behovet.** Som saksbehandler vil jeg kunne sende en søknad tilbake for
retting, og diskutere den med søkeren. Får søkeren avslag, vil jeg at hen
kan si om hen vil klage, uten å fylle ut et nytt skjema.

**Oppsettet**

1. *Steg 1 «Behandling»*:
   - Beslutningsvalg: 1 «Innvilget», 2 «Avslått» (Avvisning), 3 «Mangler
     opplysninger» med Handling **Ompuss** (§8.3)
2. *Steg 2 «Klage?»*:
   - **Innsenderen som behandler** (§8.1)
   - **Avhengig av** steg 1, og kjøres kun hvis steg 1 = 2 (Avslått)
   - Beslutningsvalg: 1 «Jeg klager», 2 «Jeg klager ikke»
   - **Forventet behandlingstid** 21 dager. Ved utløp: **avgjøre** med valg 2
3. *Steg 3 «Klagebehandling»*:
   - Behandlere: rollen `Klagenemnd`
   - Avhengig av steg 2, og kjøres kun hvis steg 2 = 1
4. *Samtale* (§8.5): **Behandlere starter — innsender kan svare**.

**Slik virker det.** Ved «Mangler opplysninger» går søknaden tilbake til
søkeren med status «Til revidering», og hen får alltid beskjed. Hen retter
og sender inn på nytt. Behandleren kan starte en samtale for å spørre om
noe, og søkeren svarer i samme tråd. Ved avslag får søkeren selv en oppgave:
klage eller ikke. Svarer hen ikke innen 21 dager, avgjøres det som «klager
ikke».

> **Vilkår på et tidligere steg krever avhengighet.** Uten «Avhengig av»
> starter steget ved innsending, og vilkåret vurderes før det andre steget er
> avgjort. Da hoppes steget over.

**Sjekk at**
- varsel for ompuss ikke kan slås av
- innsenderen ser og kan avgjøre steg 2, men ikke steg 1
- steg 2 avgjøres automatisk etter fristen, og steg 3 hoppes da over

> Innsenderen som behandler gjelder bare innloggede innsendere.

---

## 6. Behandling som ikke må bli liggende

**Behovet.** Som leder for en støttefunksjon vil jeg at henvendelser blir
fulgt opp. Behandlerne skal minnes på saker som blir liggende, og oppgavene
skal ligge der teamet jobber.

**Oppsettet**

1. *Steg 1 «Behandling»*:
   - Behandlere: teamet `Støtte`. **Første behandler avgjør**
   - **Forventet behandlingstid** 5 dager. Ved utløp: **purre** (§8.1)
   - **Varsling** (§8.4): E-post, **Planner-oppgave** og **Teams-kanal**
   - Planner: Team:Plan `Støtte:Henvendelser`, bucket «Nye», frist
     `{idag+5}`, prioritet Viktig, sjekkliste med tre punkter
   - Teams-kanal: team `Støtte`, kanal «Henvendelser», tittel
     «Ny henvendelse: $skjemanavn»

**Slik virker det.** En ny henvendelse gir e-post til teamet, en
Planner-oppgave og et innlegg i kanalen. Den første som avgjør, avslutter
saken for alle. Er den ikke avgjort etter fem dager, får behandlerne en
påminnelse, og deretter én i uken til den er avgjort.

**Sjekk at**
- Planner-oppgaven har bucket, frist og sjekkliste
- påminnelsen kommer etter fem kalenderdager, og ikke igjen før det har gått
  en uke
- en sak som avgjøres, ikke blir purret

---

## 7. Skjema med betingede deler

**Behovet.** Som skjemaeier vil jeg at søkeren bare ser spørsmålene som
gjelder hen, og at det som er påkrevd, avhenger av svarene.

**Oppsettet** — «Søknad om tilrettelegging»:

1. *Felt 1-01* Flervalg-knapper «Gjelder søknaden», med valgene
   «Eksamen», «Undervisning», «Begge».
2. *Seksjon 2 «Eksamen»*: **Seksjon vises kun hvis** 1-01 = Eksamen ELLER
   1-01 = Begge (§6, §9).
   - Tall «Ekstra tid i minutter», Min 15, Maks 120
   - Opplasting «Dokumentasjon», bare PDF, maks 2 filer, **Obligatorisk hvis**
     Ekstra tid `>` 30
3. *Felt i seksjon 3* Tekst «Annet behov», og Informasjon med veiledning som
   bare **vises hvis** «Annet behov» er `ikke_tom`.
4. *Validering* på et felt (§7.1): regel med egen feilmelding.

**Slik virker det.** Seksjonen om eksamen vises bare når den er relevant, og
det som er skjult, sendes ikke inn. Dokumentasjon kreves bare ved mer enn 30
minutter ekstra tid. Veiledningen dukker opp når søkeren skriver noe i «Annet
behov».

**Sjekk at**
- seksjon 2 forsvinner og ikke kreves når «Undervisning» velges
- 45 minutter uten vedlegg stopper innsendingen, og 20 minutter gjør det ikke
- et tall utenfor 15–120 avvises

---

## 8. Skjema fra eksterne

**Behovet.** Som kursansvarlig vil jeg ha evaluering fra eksterne
foredragsholdere som ikke har bruker hos oss. De skal få en lenke, og bli
purret om de ikke svarer.

**Oppsettet**

1. *Tilgang* (§3): **Ekstern innsender** på. Editoren viser den eksterne
   lenken.
2. *Felt*: Skala, Tekst flerlinje og **Opplasting** «Presentasjon» (Office
   og PDF).
3. *Steg 1 «Gjennomgang»*: kursansvarlig. Beslutningsvalg med **Ompuss**
   «Trenger utfylling».
4. *Masseutsending* (Administrasjon → Utsendinger): mottakerlisten,
   avslutningsdato og purring.

**Slik virker det.** Hver foredragsholder får en personlig lenke på e-post,
som virker uten innlogging. De som ikke har svart, purres. Den åpne lenken
krever en engangskode på e-post. Kvitteringen, beslutningen og en eventuell
retting kommer med lenker som virker uten innlogging, også for vedleggene.

**Sjekk at**
- lenken fra utsendingen åpner skjemaet uten innlogging
- en ekstern som får skjemaet tilbake (ompuss), kan rette og sende inn igjen
  fra lenken i e-posten
- utsending avvises når Ekstern innsender er av

---

## 9. Skjema med personopplysninger

**Behovet.** Som økonomikonsulent vil jeg samle inn honorarinformasjon fra
sensorer, med fødselsnummer og kontonummer, og vite at opplysningene er
beskyttet når saken er ferdig.

**Oppsettet**

1. *Felt*: **Fodselsnummer**, **Kontonummer**, **Postnummer**, **Valuta**
   «Honorar», Dato «Sensurdato».
2. *Grunnleggende* (§1): **Krypteres** `Svar`. Nøkkel i Admin → Nøkler.
3. *Tilgang*: Eiere er bare rollen `Økonomi(Honorar)`.
4. Ingen av feltene **Filtrerbar** eller **Vis i registerlista**.
5. *Steg 1 «Utbetaling»*: rollen `Økonomi(Honorar)`.

**Slik virker det.** Feil i fødselsnummer eller kontonummer stoppes ved
utfylling. Postnummeret gir poststedet. Honoraret vises som kroner. Når saken
er avsluttet, krypteres svarene, mens metadata som dato og status kan leses
som før.

**Sjekk at**
- et fødselsnummer med feil kontrollsiffer avvises
- svarene ikke kan leses uten nøkkelen etter avslutning
- registerlista ikke viser fødselsnummer eller kontonummer

---

## 10. Integrasjon og oppfølging

**Behovet.** Som forvalter av et utstyrslager vil jeg at bestillinger havner
i en SharePoint-liste vi allerede bruker, med vedlegg.

**Oppsettet**

1. *SharePoint* (§4): listeadresse og listenavn. **SP-kolonne** på hvert felt
   som skal med. **Metadata**: `$skjema_id` → «Bestillingsnr»,
   `$tidspunkt_innsendt` → «Bestilt». **Legg ved opplastede filer**.
2. *Felt*: Flervalg-dropdown «Utstyr» med **datakilde** `Skjemasvar`, liste
   «Utstyrskatalog» (§7.3). Den er bygget av godkjente skjemaer fra et
   annet skjema, «Nytt utstyr».
3. *Steg 1 «Utlevering»*: Teams-melding til behandlerne (§8.4).
4. *Variant*: et steg med **Ekstern PA-flyt** (§8.1), der en flyt i stedet
   for en person avgjør, f.eks. ved oppslag i et annet system.

**Slik virker det.** Hver bestilling blir en rad i SharePoint-lista, med
nummer, tidspunkt, de valgte feltene og vedleggene. Nedtrekket «Utstyr»
fylles av det som er godkjent i «Nytt utstyr», og oppdateres én gang i
døgnet.

**Sjekk at**
- raden i SharePoint har metadataene og vedlegget
- «Sjekk oppsettet» melder fra om felt med SP-kolonne når lista ikke er satt
  opp

---

## Dekning

| Egenskap | Historie |
|---|---|
| Navn, fase, ikon, forklaring (Markdown) | 1 |
| Innsenderkvittering, egen melding | 1, 2 |
| Kopi på kvittering, med rolle fra felt | 4 |
| Ferdigvarsling, med mottaker fra felt | 3 |
| Kryptering | 2, 9 |
| Anonymisering | 2 |
| Perioder | 1, 2 |
| Maks antall svar | 2 |
| Publikum «alle innloggede» / team / rolle | 1 / 2 / 9 |
| Eiere | 1, 9 |
| Ekstern innsender og masseutsending | 8 |
| SharePoint (kolonner, metadata, vedlegg) | 10 |
| Seksjon vises hvis | 7 |
| Felt vises hvis, obligatorisk hvis | 7 |
| Validering mot annet felt | 3, 7 |
| Filtrerbar, vis i registerlista | 1, 9 |
| Felttypene Informasjon, Tekst (flerlinje), Flervalg | 1 |
| Skala | 2, 8 |
| Tall (min/maks), Opplasting (filtyper, antall) | 7, 8 |
| Valuta, Dato | 3, 9 |
| E-post (som mottaker) | 3 |
| Fodselsnummer, Kontonummer, Postnummer | 9 |
| Datakilder: Klasser, Emner med filter | 4 |
| Datakilde: Skjemasvar | 10 |
| Steg, avhengighet, vilkår på tidligere steg | 3, 5 |
| Rolle med omfang fra felt, reserverolle | 4 |
| Person fra felt som behandler | 3 |
| Første avgjør / team som behandler | 6 |
| Beslutningsvalg: avvisning, varsle av | 3 |
| Ompuss | 5, 8 |
| Innsenderen som behandler | 5 |
| Forventet behandlingstid: purre / avgjøre | 6 / 5 |
| Kanaler: Planner, Teams-kanal / Teams-melding | 6 / 10 |
| Melding per beslutningsvalg | 3 |
| Samtale | 5 |
| Ekstern PA-flyt | 10 |

**Ikke med i noen historie:** «Alle må avgjøre» på et steg, Merk alle i
flervalg, AI-import, kopiering av skjematype og datakildene Personer,
Studenter, Roller, Team, Kull og Studieprogrammer. De kan tas inn som
varianter, eller i en egen historie om behandling i panel («Alle må
avgjøre», f.eks. en opptakskomité).
