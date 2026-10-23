# Vurdering: utvidelse av rollebegrepet

**Status: diskusjon.** Ingenting er besluttet, og ingen kode er endret.
Notatet er skrevet 23.10.2026 etter et forslag fra oppdragsgiver, og
inneholder to ting: hva rollemodellen FAKTISK er i dag, lest ut av koden, og
en vurdering av hva forslaget koster.

Les «Dagens modell» først. To av de tre forslagene finnes delvis allerede,
men på et annet nivå enn forslaget forutsetter, og det avgjør kostnaden.

---

## Forslaget

Roller brukes i dag til seks ting: tilgang til skjematyper (publikum),
eierskap til skjematyper, behandlere, tilgangsstyring til rapporter,
filtrering i rapporter, og valg i nedtrekksmenyer.

En rolle består minst av rollenavn og identitet (UPN, og gjerne navn).
`Omfang` er frivillig og avgrenser rollen: `Emneansvarlig(CU1234)`,
`Klassesjef(KLASSE 1)`.

Roller vedlikeholdes på fire måter: import fra masterdata (i dag bare Felles
Studentsystem, snart kanskje SAP), manuelt i adminportalen, import fra
Excel/CSV, og automatisk oppdatering fra et Team.

Forslaget er tredelt:

1. **Klassifisering i tre klasser**, som et tilleggsfelt på rollen:
   - *Masterdata* — vedlikeholdes av planlagte kjøringer, kan ikke
     overstyres manuelt.
   - *Globale roller* — vedlikeholdes manuelt eller ved import, bare av
     admin, kan refereres fra alle skjematyper.
   - *Skjemaspesifikke roller* — kan bare brukes i definerte skjematyper, og
     oppdateres av eierne av disse.
2. **Et frivillig JSON-felt på rollen** med egne datafelt ved siden av
   omfanget. Alle felt kan refereres med punktnotasjon —
   `Klasseansvarlig.klassenavn`, `Emneansvarlig.emnenavn` — i filtre og i
   definisjonen av hva en nedtrekksmeny viser.
3. **Bare omfang skal kunne brukes** til å definere publikum, eierskap og
   behandlere.

---

## Dagens modell

Modellen har **tre nivåer, men bare to er materialisert**:

| Nivå | Finnes som | Bærer i dag |
|---|---|---|
| **Rolle** | ingenting — bare `PartitionKey` | — |
| **Rollegruppe** (Rolle, Omfang) | tabellen `Rollegruppe` | `Team`, `EierRolle`, `SisteAntall`, `SisteSynk`, `SisteStatus`, `SisteMelding` |
| **Medlem** (Rolle, Omfang, UPN) | tabellen `Rollemedlemskap` | `FN`, `EN`, `EP`, `Kilde`, `Rollebeskrivelse`, `SistOppdatert` |

`Rollemedlemskap` har `PartitionKey = Rolle` og `RowKey = "{Omfang}|{upn}"`.
En rolle finnes altså bare så lenge den har minst ett medlem — den har ingen
egen rad noe sted.

`Rollegruppe` ble laget fordi noe ikke kunne ligge på medlemsradene, og
begrunnelsen står i koden:

> Legges `Team` på hver medlemsrad — slik `Rollebeskrivelse` ligger i dag —
> forsvinner koblingen når siste medlem fjernes. Teamet blir da stående med
> gamle medlemmer for alltid, og ingenting i systemet husker at det skulle
> vedlikeholdes.

**Det argumentet gjelder klassifiseringen direkte.** En klasse lagret på
medlemsradene forsvinner når rollen tømmes, og kommer tilbake som noe annet
neste gang noen legger inn et medlem.

### To av forslagene finnes delvis allerede

**`Kilde` på medlemsraden** skiller mellom `import`, `manuell`, `workflow` og
`seed`. `rolle-import.js` verner allerede manuelle rader mot å bli overskrevet
av en import.

«Masterdata kan ikke overstyres manuelt» er altså halvveis implementert —
men som en egenskap ved RADEN, ikke ved rollen. Forskjellen er praktisk: i
dag kan samme rolle ha noen masterdata-rader og noen manuelle side om side,
uten at noe sier fra. Det er nettopp den tilstanden klassifiseringen skal
gjøre umulig.

**Teamkoblingen** ligger på gruppa, ikke på rollen. «Automatisk oppdatering
fra et Team» er derfor per (Rolle, Omfang) i dag, ikke per rolle.

### Hvor rollestrengen tolkes

Formen `Rolle(Omfang)` plukkes fra hverandre på **to** steder, med hver sin
regex, og de to er ikke like:

| Sted | Regex | Omfanget er |
|---|---|---|
| `lib/roller-storage.js` — `hentInnehavere` | `/^(.+?)(?:\((.+)\))?$/` | frivillig |
| `lib/oppslag.js` — `hentInnehavereForRolle` | `/^(.+?)\((.+)\)$/` | påkrevd |

De øvrige modulene BYGGER strengen uten å tolke den: `dynamisk-rolle.js`
bytter ut feltreferansen i malen (`Klassesjef({2-01})`) og sender resultatet
videre til `hentInnehavere`, og `skjematype-diagnose.js` går samme vei.
`feltperson.js` tolker feltreferanser, ikke roller.

Det er bedre enn det kunne vært, og det betyr at et navnerom treffer disse to
pluss hvert sted som SETTER SAMMEN en rollestreng — færre steder, men ikke
ett.

### Omfanget har aliashåndtering

`lib/omfang.js` oversetter mellom FS' naturlige nøkkel (`FHSBA|22H|A`) og
klassenavnet admin skrev i nedtrekket (`KS Kull Rønneberg 22-25`). Det er
ikke kosmetikk: klassekoden alene er ikke unik — i et uttrekk på ti klasser
gikk `A` igjen fem ganger.

Alt som skal kunne vise til omfang, må gjennom den oversettelsen, ellers
treffer det stille ikke.

---

## Vurdering

### 1. Klassifisering

**Lagringen er den enkle delen.** En `Rolle`-tabell etter samme mønster som
`Rollegruppe` gir klassen en plass som overlever at rollen tømmes, og et sted
for senere rolle-nivå-fakta (beskrivelse, eier, gyldighetsperiode).

Granulariteten må avklares først: klassen hører på **rollen**, ikke på
(Rolle, Omfang). Ellers kan `Emneansvarlig(CU1)` være masterdata mens
`Emneansvarlig(CU2)` er global, og det er ikke en tilstand noen har ment å
be om.

**Håndhevingen er den dyre delen.** «Kan ikke overstyres manuelt» og «kan
bare brukes i definerte skjematyper» er regler som må holde ved hver
skriving og hver lesing. Stedene:

| Skriver roller | Leser roller |
|---|---|
| adminportalen (`functions/roller.js`) | `lib/tilgang.js` |
| import (`lib/rolle-import.js`) | `lib/rapport-rollefilter.js` |
| team-synk (`lib/team-synk-jobb.js`) | `lib/dynamisk-rolle.js` |
| FS-oppdatering (`lib/refresh-fs-jobb.js`) | `lib/oppslag.js` |

Åtte steder som må svare likt. Etter husreglene i `CLAUDE.md` betyr det én
regel ett sted, og en test som leser alle brukerne av den.

### 2. Skjemaspesifikke roller — den som ikke kan estimeres ennå

Rollenavnet er `PartitionKey`, altså **globalt unikt**. Vil to skjematyper
hver ha en «Veileder», er det to muligheter:

| Valg | Konsekvens |
|---|---|
| Navnene forblir globalt unike | «Skjemaspesifikk» begrenser bare BRUKEN. Avgrenset endring — en liste over skjematyper på rollen, og en sjekk på de fire lesestedene |
| Navnerom per skjematype | Hvert sted som tolker `Rolle(Omfang)` må endres, og alle eksisterende skjematyper må migreres |

**Dette valget avgjør om forslaget er lite eller stort.** Det bør avklares
før noe anslag gis.

Tre spørsmål til som ikke er besvart i forslaget:

- Kan samme skjemaspesifikke rolle brukes av to skjematyper?
- Hva skjer med rollen når skjematypen slettes?
- Kan en skjemaspesifikk rolle brukes i en rapport som spenner over flere
  skjematyper?

### 3. JSON-tilleggsfelt og punktnotasjon

Lagringen er billig: en strengkolonne med JSON. Granulariteten er trolig
**per medlem eller per gruppe**, ikke per rolle — `Klasseansvarlig.klassenavn`
varierer per klasse, akkurat som omfanget gjør.

Punktnotasjonen er der innvendingen ligger. Løsningen har allerede **tre
uttrykksformer**:

| Form | Brukes til | Ser ut som |
|---|---|---|
| Rapportfiltre | filtrering i rapporter | `{ type, seksjon, felt, operator, verdi, verdi2, fraRolle }` |
| FasteData | nedtrekksmenyer fra datakilder | `{ EllerAv: [{ OgAv: [{ Kolonne, Operator, Verdi }] }] }` |
| DNF-vilkår | vises, obligatorisk, validering | `{ Felt, Operator, Verdi }`, med `@idag` |

En fjerde notasjon er den tilbakevendende feilklassen i dette repoet: samme
spørsmål besvart to steder, med to ulike svar. To veier videre:

- **Uttrykk rollereferanser i DNF-formen** som alt finnes. `Verdi` kan
  allerede peke på et felt; en rollereferanse er samme slags høyreside.
- **Eller én parser** for punktnotasjonen, brukt av alle tre konsumentene,
  med en test som kjører alle og krever samme svar.

Og fella: `Rolle.omfang` må gjennom aliasoppslaget i `lib/omfang.js`. Uten
det treffer et filter på klassenavn ikke rader lagret med FS-nøkkel, og
omvendt — uten feilmelding.

### 4. Bare omfang til publikum, eierskap og behandlere

**Den billigste og mest verdifulle av de tre.** Det er en begrensning, ikke
en utvidelse: den håndheves i editoren og valideres ved lagring, og den
stemmer med koden som finnes — `tilgang.js` og `dynamisk-rolle.js` kjenner
bare (Rolle, Omfang).

Den hindrer at tilgangsstyring blir avhengig av vilkårlig JSON, som er
retningen slike modeller pleier å gli i.

---

## Anbefalt rekkefølge

1. **Forslag 3.** Billig, og den krymper flaten de to andre må forholde seg
   til.
2. **Rolle-entitet med masterdata/global**, uten skjemaspesifikke roller.
   Det er å gjøre eksplisitt det som i dag er antatt gjennom `Kilde`.
3. **JSON-feltet lagret og synlig** i admin, før noe uttrykksspråk. Da ser
   man hvilke felt som faktisk brukes før notasjonen låses.
4. **Punktnotasjon til slutt**, etter at det er avgjort om den gjenbruker
   DNF-motoren.

**Skjemaspesifikke roller behandles som eget spørsmål.** Navnekollisjonen
avgjør omfanget, og den er ikke avklart.

---

## Hva som IKKE er vurdert her

- Migrering av eksisterende roller inn i en ny `Rolle`-tabell. Antallet
  roller i drift er ikke talt opp.
- Hva klassifiseringen betyr for `Rollegruppe.EierRolle`, som allerede er en
  form for tilgangsstyring på gruppenivå.
- Om SAP-integrasjonen stiller krav som FS ikke gjør. Den finnes ikke ennå,
  og et anslag på noe som ikke er spesifisert, er en gjetning.
