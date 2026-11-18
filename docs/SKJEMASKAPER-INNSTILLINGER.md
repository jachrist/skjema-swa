# Innstillinger i skjemaeditoren

Oversikt over alt en skjemaskaper kan velge og sette i editoren
(`frontend/editor.html`), og hva hvert valg gjør. Skrevet 18.11.2026 som
grunnlag for brukerdokumentasjonen og brukerhistoriene.

Rekkefølgen følger editoren, panel for panel. Feltnavnet i skjemadefinisjonen
står i `kode` der det hjelper å finne igjen regelen; brukerdokumentasjonen
trenger dem ikke.

> **Dette er en kartlegging, ikke brukerdokumentasjon.** Den er lest ut av
> koden og sier hva som finnes. Brukerhistoriene skal si hvorfor noen vil
> bruke det.

---

## 0. Knapperaden øverst

| Knapp | Gjør |
|---|---|
| 💾 Lagre | Lagrer skjematypen. Ulagrede endringer holdes som utkast i nettleseren, og tilbys gjenopprettet neste gang editoren åpnes |
| 👁 Vis skjema | Åpner skjemaet i ny fane med endringene som ikke er lagret ennå |
| 🧪 Test utfylling | Åpner den **lagrede** versjonen for utfylling |
| 🩺 Sjekk oppsettet | Diagnose: roller uten medlemmer, oppsett som ikke brukes, referanser til felt som ikke finnes, frister uten gyldig valg osv. Tre grader: feil, advarsel, info |
| 📋 Kopier | Ny skjematype med samme innhold, i fase Utvikling, med «(kopi)» bak navnet |
| 🤖 Importer med AI | (Bare admin) Last opp bilde eller PDF av et papirskjema, og få en definisjon foreslått |
| 🗑 Slett | Sletter skjematypen |

Editoren advarer når en endring flytter feltnumre på en skjematype som alt har
innsendte skjemaer, og viser et banner når en feltreferanse i en melding peker
på et felt som ikke finnes lenger.

---

## 1. Grunnleggende

| Innstilling | Verdier | Virkning |
|---|---|---|
| **Skjemanavn** (`Skjema_navn`) | Fritekst | Navnet i portalen, i e-poster (`$skjemanavn`) og i registeret |
| **Fase** (`Fase`) | `Utvikling` · `Produksjon` | Utvikling: bare admin og eiere ser skjemaet. Produksjon: synlig for publikum |
| **Ikon** (`Logo_url`) | Velg fra logoene admin har lastet opp | Vises til venstre for tittelen på utfyllingssiden |
| **Skjemaforklaring** (`Skjemaforklaring`) | Tekst, format `Ren tekst` eller `Markdown` | Informasjon øverst på utfyllingssiden |
| **Innsenderkvittering** (`Innsenderkvittering`) | Av/på (standard på) · egen melding (emne og tekst) · **Kopi til**: personer og roller | E-post til innsender ved innsending. Kopimottakerne står i kopi-feltet, så det sendes én e-post. Rolleomfang kan hentes fra et felt, og et flervalgsfelt gir én rolle per valg. Har skjemaet ingen innsenderadresse, går kvitteringen til den første i kopilista |
| **Ferdigvarsling** (`Ferdigvarsling`) | Av/på (standard av) · egen melding · mottakere: personer og roller | E-post når siste behandlingssteg er avgjort. Feltreferanser i mottakerne slås opp mot svarene slik de står ved ferdigstillelse |
| **Kryptering** (`Krypteres`) | `Nei` · `Svar` (svarene, metadata i klartekst) · `Alt` (hele skjemaet) | Gjøres ved avslutning. Krever en nøkkel (Admin → Nøkler) |
| **Anonymiser innsender** (`Anonymiseres`) | Av/på | Innsenderens navn og e-post byttes med et pseudonym ved avslutning. Pseudonymet er det samme for samme person, så antall svar per person telles fortsatt riktig |

---

## 2. Tilgjengelighet

| Innstilling | Verdier | Virkning |
|---|---|---|
| **Perioder** (`Tilgjengelighetsperioder`) | Én eller flere `Fra`–`Til`-datoer | Utenfor periodene kan bare eiere se skjemaet. Ingen perioder = alltid tilgjengelig |
| **Maks antall svar per person** (`MaksSvarPerBruker`) | Heltall, `0` = ubegrenset | For avstemninger og valg: `1` gir én stemme per person. Gjelder alle, også eiere og admin. Mellomlagrede utkast teller ikke |

---

## 3. Tilgang

Personer, roller og team velges med samme verktøy overalt:

| Del | Hva | Merknad |
|---|---|---|
| Personer | E-postadresser | Fritekst |
| Roller | `Rolle` eller `Rolle(Omfang)` | Fra rollelista. Uten omfang: alle innehavere av rollen uansett omfang |
| Team | Teamnavn | Fra Teams-cachen |

| Innstilling | Verdier | Virkning |
|---|---|---|
| **Publikum** (`Publikum`) | Personer, roller, team · **Åpen for alle innloggede** | Hvem som kan fylle ut. «Åpen for alle» overstyrer resten |
| **Eiere** (`Eiere`) | Personer, roller, team | Kan redigere skjematypen og se alle innsendte skjemaer i registeret |
| **Ekstern innsender** (`EksternTilgang`) | Av/på | Lar folk uten innlogging sende inn, via engangskode på e-post eller en tilsendt lenke. Gir en ekstern lenke som kan kopieres og deles. Kreves for masseutsending |

---

## 4. SharePoint-integrasjon

| Innstilling | Verdier | Virkning |
|---|---|---|
| **Listeadresse** (`SPListeadresse`) | Site-URL | Tom = av |
| **Listenavn** (`SPListenavn`) | Fritekst | Begge må være satt |
| **SP-kolonne per felt** (`SPListefelt`) | Kolonnenavn | Vises under hvert felt når lista er satt opp. Tom = feltet sendes ikke |
| **Metadata-kolonner** (`SPMetadata`) | Plassholder → kolonne: `$skjema_id`, `$skjemanavn`, `$innsender`, `$innsender_navn`, `$tidspunkt_innsendt` | Én verdi per rad ved innsending |
| **Legg ved opplastede filer** (`SPLagreVedlegg`) | Av/på | Vedleggene festes til SP-raden |

Innsenderens navn og e-post skrives alltid til `Innsender_Navn` og
`Innsender_Epost`.

---

## 5. Gevinstoppfølging

Bare visning for skjemaskaperen. Estimat og rapportering settes av admin
(Admin → Gevinstoppfølging).

---

## 6. Seksjoner

| Innstilling | Verdier | Virkning |
|---|---|---|
| **Overskrift** (`Seksjon_overskrift`) | Fritekst | Overskriften på utfyllingssiden |
| **Seksjon vises kun hvis** (`Vises`) | Vilkår (se 9) mot felt i **tidligere** seksjoner | Skjult seksjon tas ikke med ved innsending |
| Rekkefølge | Dra, piler, sett inn før/etter | Feltnumrene følger posisjonen |

---

## 7. Felt

### 7.1 Felles for alle felttyper

| Innstilling | Verdier | Virkning |
|---|---|---|
| **Spørsmål** (`Tekst`) | Tekst, format `Ren tekst` eller `Markdown` | Etiketten. Markdown gir en større editor |
| **Undertittel** (`Undertittel`) | Tekst, `Ren tekst` eller `Markdown` | Hjelpetekst under spørsmålet |
| **Obligatorisk** (`Obligatorisk`) | Av/på | Må fylles ut før innsending |
| **Obligatorisk hvis** (`ObligatoriskHvis`) | Vilkår mot felt **før** dette | Påkrevd bare når vilkåret holder |
| **Vises kun hvis** (`Vises`) | Vilkår mot felt **før** dette | Gjelder alle typer, også informasjonsfelt |
| **Validering** (`Validering`) | Én eller flere regler: «Gyldig hvis» + melding | Sjekkes ved innsending. Kan sammenligne med **alle** felt, også senere (f.eks. sluttdato etter startdato). Ikke på Informasjon og Opplasting |
| **Filtrerbar i register/datauttrekk** (`Filtrerbar`) | Av/på | Feltet kan brukes som filter |
| **Vis i registerlista** (`Listekolonne`) | Av/på | Feltet blir egen kolonne. Uten noen: «#123 — innsender» |
| **SP-kolonne** (`SPListefelt`) | Se 4 | |
| Kopier, flytt, slett, sett inn | | Dra-og-slipp også mellom seksjoner |

### 7.2 Felttypene

| Type | Egne innstillinger | Hva utfylleren møter |
|---|---|---|
| **Informasjon** | Tekst, `Ren tekst` eller `Markdown` | Bare tekst, ingen inntasting |
| **Tekst** | **Flerlinje** av/på | Én linje eller tekstområde |
| **Tall** | **Min-verdi**, **Maks-verdi** | Tallfelt med grenser |
| **Valuta** | — | Beløp, formatert som kroner |
| **E-post** | — | Syntakssjekk. Eneste type som kan brukes som mottaker (se 8.2) |
| **Fodselsnummer** | — | Kontrollsiffer sjekkes |
| **Kontonummer** | — | Kontrollsiffer sjekkes |
| **Postnummer** | — | Søk i postnummerregisteret, poststed fylles ut |
| **Dato** | — | Datovelger |
| **Tidspunkt** | — | Klokkeslett |
| **Skala** | Alternativer med **nummer** og tekst | Rad med tall. Tekst vises der den er satt, typisk på endepunktene |
| **Flervalg-knapper** | Alternativer · **Maks antall valg** (1 = enkeltvalg) · **Merk alle / Fjern alle** · **datakilde** (se 7.3) | Knapper eller avkrysning |
| **Flervalg-dropdown** | Som over | Nedtrekk med søk |
| **Opplasting** | **Maks antall filer** · **Tillatte filtyper**: Office, PDF, Bilder (standard alle tre) | Filopplasting, maks 4 MB per fil |

«Merk alle» opphever maksgrensen.

### 7.3 Hent alternativer fra en datakilde (`FasteData`)

For Skala, Flervalg-knapper og Flervalg-dropdown. En datakilde med filtre i
OG/ELLER-grupper. Filterverdien kan være fast, eller en feltreferanse.

| Datakilde | Gir | Filtre |
|---|---|---|
| Skjematyper | Skjematypene | Fase |
| Roller | Rolle–omfang-par (velge en rolle, ikke en person) | Rolle, Omfang |
| Team | Teamnavn | — |
| Personer | Personer (navn for dem med rolle, ellers e-post) | Team, Rolle, EmneLarere, EmneHovedlarere, EmneStudenter |
| Emner | Emner fra FS | Termin, Campus |
| Studenter | Studenter fra FS | Emne, Klasse, Kull, Studieprogram |
| Klasser | Aktive klasser fra FS | — |
| Kull | Aktive kull fra FS | — |
| Studieprogrammer | Studieprogrammer | — |
| Skjemasvar | Verdier fra avsluttede og godkjente skjemaer, i oppslagslister admin har satt opp | Liste (påkrevd) |

Verdien som lagres er nøkkelen (UPN, FS-nøkkel, rollestreng). Teksten som sto
i nedtrekket lagres ved siden av, så arkivet viser det innsenderen valgte selv
om kilden endres.

---

## 8. Behandlingssteg

Ingen steg = skjemaet avsluttes ved innsending.

### 8.1 Steget

| Innstilling | Verdier | Virkning |
|---|---|---|
| **Stegnavn** (`Stegnavn`) | Fritekst | `$stegnavn` i meldinger |
| **Behandlere** (`Personer`, `Roller`, `Team`) | Personer, roller, team (se 8.2) | Hvem som kan avgjøre steget |
| **Innsenderen som behandler** (`InnsenderBehandler`) | Av/på | Innsenderen blir behandler på steget, f.eks. for å svare på om hen vil klage. Bare innloggede innsendere |
| **Reserverolle** (`Reserverolle`) | En rolle | Bare når en behandlerrolle har omfang fra et felt. Brukes hvis rollen ikke har innehavere for det svaret |
| **Krav ved flere behandlere** (`Beslutning_alle`) | `Første behandler avgjør` · `Alle må avgjøre` | Alle: ett svar per person, per rolle og per team, og én innehaver dekker en rolle. Steget er godkjent når alle har svart positivt. **Et avslag avgjør steget med en gang.** Ompuss sender tilbake med en gang, og etter retting må **alle** svare på nytt |
| **Beslutningsvalg** (`Beslutningsvalg`) | Nummer, tekst, handling, varsle (se 8.3) | Det behandleren kan velge. Standard: Godkjent, Avslått |
| **Forventet behandlingstid** (`Frist`) | Antall kalenderdager fra steget blir aktivt · ved utløp: **purre ukentlig** eller **avgjøre med et valg** | Tomt = ingen frist. Ompussvalg kan ikke velges for automatisk avgjørelse |
| **Varsling** (`Varsling`) | E-post · Teams-melding · Planner-oppgave · Teams-kanal (se 8.4) | Kanaler når steget blir aktivt. Standard: e-post |
| **Avhengig av** (`AvhengigAv`) | Et steg med lavere nummer | Steget starter først når det andre er ferdig. Uten: parallelt |
| **Steget kjøres kun hvis** (`Vilkår`) | Vilkår mot svar og tidligere stegs beslutninger | Ellers hoppes steget over. Et vilkår på et annet stegs beslutning krever **Avhengig av** det steget — ellers vurderes det ved innsending, før beslutningen finnes. «Sjekk oppsettet» varsler om det |
| **Ekstern PA-flyt** (`Flyt_url`, `Flyt_parametere`) | URL · notat | Satt: flyten kalles og avgjør steget i stedet for en behandler. Det vanlige oppsettet dempes |
| Rekkefølge | Piler, slett | |

### 8.2 Behandlere og mottakere hentet fra svaret

| Form | Eksempel | Virkning |
|---|---|---|
| Fast person | `ola@fhs.no` | |
| Fast rolle | `Klassesjef(EA 26)` | Alle innehavere |
| **Rolle med omfang fra et felt** | `Klassesjef({2-01})` | Omfanget er svaret i felt 2-01, f.eks. klassen innsenderen valgte |
| **Person fra et felt** | `{2-01}` | Adressen i et **E-post**-felt, eller valget i et nedtrekk med Personer eller Studenter |
| Team | Teamnavn | Bare for behandlere, ikke for e-postmottakere |

Gjelder også kopi på kvitteringen og mottakere av ferdigvarsling.

### 8.3 Beslutningsvalg

| Innstilling | Verdier | Virkning |
|---|---|---|
| **Nummer** | Heltall | Det vilkår og frist peker på |
| **Tekst** | Fritekst | `$beslutning` i meldingen |
| **Handling** (`Handling`) | `Vanlig` · `Ompuss (retur)` · `Avvisning (negativ)` | Ompuss sender skjemaet tilbake til innsender for retting. Avvisning merker valget som et avslag: rødt utfall, og i «Alle må avgjøre» avgjør det steget med en gang. Valg som heter «Avslått», «Avvist», «Ikke anbefalt» o.l. regnes som avslag også uten merkingen |
| **Varsle** (`VarsleInnsender`) | Av/på (standard på) | Av: innsender får ingen melding om dette valget. Ompuss varsler alltid |
| **Melding til innsender** (`FraBehandler`) | Egen emne og tekst per valg | Standardmelding hvis ikke satt |

### 8.4 Meldinger og kanaler

| Melding | Når | Innstillinger |
|---|---|---|
| **Til behandler** (`TilBehandler`) | Steget blir aktivt | Emne, tekst |
| **Teams-melding** (`TeamsMelding`) | Samme | Tittel, innhold (HTML). Tom = meldingen til behandler |
| **Planner-oppgave** (`PlannerOppgave`) | Samme | Tittel · Team:Plan · Bucket · Ansvarlig (rolle, tom = behandlerne) · Frist (`{idag+7}` eller dato) · Prioritet (Lav, Medium, Viktig, Haster) · Startstatus (Ikke startet, Pågår, Ferdig) · Sjekkliste (maks 20 punkter) · Notat (lenker og avsnitt) |
| **Teams-kanal** (`TeamsKanalInnlegg`) | Samme | Team · Kanal · Tittel · Innhold (HTML) |
| **Fra behandler** | Et valg tas | Se 8.3 |
| **Kvittering** og **ferdigvarsling** | Se 1 | |

**Plassholdere i meldingene:**

| Plassholder | Verdi |
|---|---|
| `$skjemanavn`, `$skjema_id` | Skjematypens navn, skjemaets nummer |
| `$innsender`, `$innsender_navn` | Innsenderens e-post og navn |
| `$lenke` | Lenke til skjemaet. Eksterne får en lenke som virker uten innlogging |
| `$stegnavn`, `$rolle` | Steget og rollen behandleren har |
| `$beslutning`, `$kommentar` | Valget og behandlerens kommentar (meldinger til innsender) |
| `$tidspunkt` | Nå |
| `$frist`, `$dagerTilFrist` | **Tilbys, men blir i dag alltid tomme** — ingen kode setter verdiene (funnet 18.11.2026). Bør ikke brukes før det er rettet |
| `{2-01}` | Svaret i et felt. Settes inn fra lista i editoren |

### 8.5 Samtale

| Innstilling | Verdier | Virkning |
|---|---|---|
| **Samtale** (`Samtale`) | `Av` · `Behandlere starter — innsender kan svare` · `Alle deltakere kan starte` | En felles tråd mellom innsender og behandlere. Alle ser alt. Krever minst ett steg |

---

## 9. Vilkår

Brukes av «Seksjon vises», «Felt vises», «Obligatorisk hvis», «Gyldig hvis»
og «Steget kjøres kun hvis».

- **Form:** én eller flere grupper. Innenfor en gruppe må **alle** betingelser
  holde (OG). Holder **én** gruppe, holder vilkåret (ELLER).
- **Betingelse:** felt · operator · verdi.
- **Operatorer:** `=`, `!=`, `<`, `<=`, `>`, `>=`, `tom`, `ikke_tom`, `inneholder`.
- **Høyresiden** kan være en fast verdi eller et annet felt (sluttdato `>=`
  startdato).
- **I steg** kan venstresiden også være et tidligere stegs beslutning.

Datakildefiltre (7.3) bruker de samme gruppene, men bare `=`, `!=` og
`inneholder`.

---

## Utenfor editoren, men del av skjemaskaperens hverdag

Ikke kartlagt i detalj her. Tas i egne brukerhistorier:

- **Registeret** — innsendte skjemaer, filtre, kolonner, PDF
- **Behandlingssiden** — beslutning, kommentar, samtale, vedlegg
- **Masseutsending** (Administrasjon → Utsendinger) — sende skjemaet til en liste
  mottakere, med purring
- **Rapporter og datauttrekk**
- **Roller og oppslagslister** (Admin) — det datakildene og rollene i
  editoren henter fra
- **Logoer og nøkler** (Admin) — ikon og kryptering

---

## Forslag til brukerhistorier, gruppert

Ett forslag til hvordan egenskapene over kan dekkes av et lite sett historier,
der hver historie viser flere egenskaper i bruk:

| Historie | Viser |
|---|---|
| Et enkelt påmeldingsskjema | Grunnleggende, publikum «alle», perioder, kvittering, felttyper, obligatorisk, registerkolonner |
| Én stemme per person | Maks antall svar, anonymisering, Skala, Flervalg |
| Søknad med godkjenning i to ledd | Steg, avhengighet, roller, beslutningsvalg, melding per valg, ferdigvarsling |
| Søknad til egen klassesjef | Datakilde Klasser, rolle med omfang fra felt, reserverolle |
| Retting og klage | Ompuss, samtale, innsenderen som behandler |
| Behandling som ikke må bli liggende | Forventet behandlingstid, purring, automatisk avgjørelse |
| Skjema med betingede deler | Seksjon og felt vises hvis, obligatorisk hvis, validering mot annet felt |
| Skjema fra eksterne | Ekstern innsender, lenke, masseutsending, vedlegg |
| Skjema med personopplysninger | Kryptering, anonymisering, fødselsnummer, kontonummer |
| Integrasjon og oppfølging | SharePoint-liste, Teams, Planner, Teams-kanal, ekstern flyt |
