# Oppslagslister — svar fra innsendte skjemaer som nedtrekksverdier

Et skjema skal kunne velge blant data som allerede ligger i systemet. Det
konkrete ønsket: FHS har verdivurdert informasjonstyper i én skjematype (ett
skjema per datapunkt), og andre skjemaer skal kunne peke på de ferdige
vurderingene i stedet for at hver skjemaskaper vedlikeholder sin egen kopi av
lista.

## Formen

En liste er én rad per kvalifiserende forekomst, og raden er **én streng**
satt sammen av svarene fra noen av feltene:

```
epost_privat - Personopplysning: Ja - Særlig kategori personopplysninger: Nei - Datapunkt: KAN OFFENTLIGGJØRES/TJENSTLIG - Datapunkt liste: TJENSTLIG
```

Delene skilles med ` - `. Flere valg i samme felt skilles med `/` — samme form
importskriptet leser, så en verdi ser lik ut uansett hvilken vei den kom inn.

Teksten er også **verdien** som lagres i mottakerskjemaet. Det gjør rapporter,
PDF og arkiv lesbare uten et oppslag tilbake til kilden. Prisen er at en
endring i kildeskjemaet ikke følger med: feltreferanser fryses ved innsending,
så et lagret svar blir stående som det var. Det er med vilje — et vedtatt
datapunkt skal ikke endre seg i ettertid i skjemaer som alt har valgt det.

## Utvalget: BÅDE avsluttet OG godkjent

En forekomst kommer med bare hvis **begge** er oppfylt:

* `Skjema_status = 5` (Avsluttet), og
* behandlingsresultatet er `Godkjent`

Det er to ulike akser. Avsluttet er en status; Godkjent er et
behandlingsresultat utledet av `sisteBeslutning` og har ingen statuskode. En
forekomst som er godkjent men ikke avsluttet, eller avsluttet uten å være
godkjent, er ikke et vedtatt datapunkt.

Kravet er strengt med vilje. Lista er kilden andre skjemaer velger fra, og et
feilaktig valg sprer seg til hvert skjema som har valgt det — og blir stående,
siden feltreferanser fryses.

Regelen ligger i `kvalifiserer()` i `api/src/lib/oppslagsliste.js`, alene og
med egen test. Utledningen av resultatet er `sisteBeslutning` fra
`datauttrekk.js` — samme funksjon som registeret, rapportene og PDF-en bruker.

## Felt oppgis med MERKELAPP, ikke feltnummer

Oppsettet navngir feltene slik de står i skjemaet («Datapunkt (navn)»), ikke
som `1-03`. To grunner:

* Oppsettet skal kunne skrives av en som ser skjemaet.
* Kildeskjematypen defineres i prod, der feltnumrene ikke er kjent når
  oppsettet lages.

Merkelapp → feltnummer slås opp mot den **levende** definisjonen ved hver
kjøring, og oppslaget går gjennom alle seksjoner — feltene i skjematype 59
ligger i to. En merkelapp uten treff **stopper** jobben, med de tilgjengelige
merkelappene i feilmeldingen. En merkelapp som treffer to felter stopper også,
og foreslår feltnummeret. Begge alternativene — hoppe over feltet, eller velge
det første — ville gitt en liste som ser riktig ut og er gal.

Et feltnummer (`2-01`) godtas også, for den som vil være presis.

## Hvorfor en egen tabell, og ikke et direkte oppslag

Lista bygges av en døgnjobb og legges i tabellen `Oppslagsliste`. Nedtrekket
leser derfra, aldri fra skjemaforekomstene. To grunner, begge i
`faste-data.js`:

**Ytelse.** FasteData løses opp ved hver `GET /api/skjematyper/{id}` — altså
hver gang noen åpner skjemaet. En direkte kilde ville skannet og dekryptert
alle forekomstene av kildeskjematypen på den kritiske veien inn i et skjema.

**En felle i filtermekanismen.** `hentForOgGruppe` (`faste-data.js:195`) kaller
oppslaget **én gang per betingelse** i en OG-gruppe og snitter resultatene på
`Verdi`. En kilde som trenger to parametre samtidig — hvilken skjematype OG
hvilket felt — ville fått dem i to kall, hvert uten den andre, og snittet
ville gitt en tom liste **uten en feilmelding**. En ferdigbygget liste trenger
bare ett filter (`Liste=<navn>`), så den formen kan ikke oppstå.

## Oppsett

**Administrasjon → 🗂 Oppslagslister.** Hver liste har navn, skjematype-ID og
feltene i rekkefølge, med teksten som skal stå foran hver verdi
(`Personopplysning: ` — med kolon og mellomrom; prefikset bærer sitt eget
skilletegn, så et navnefelt kan stå uten).

**Forhåndsvis** bygger uten å skrive og viser de første ti radene. Bruk den:
en kildeskjematype defineres i prod, og formatet må kunne sjekkes mot ekte
data før noe lagres. Oppsettet må være lagret først — jobben leser det fra
tabellen, ikke fra skjermen.

Oppsettet ligger i `SystemInnstillinger` under nøkkelen `Oppslagslister`, ikke
i `Oppslagsliste`-tabellen. Holdes de samme sted, kan en full erstatning av en
liste ta oppsettet med seg.

## I skjemaeditoren

Datakilde `Skjemasvar`, filter `Liste=<navn>`. Filteret er **påkrevd** — uten
det vet oppslaget ikke hvilken liste det er.

Nedtrekket har søk fra før: widgeten i `felt-render.js` er en kombiboks der
søkefeltet *er* kontrollen, og skriving filtrerer på delstreng i hele teksten.
«epost», «SÆRLIG» og «TJENSTLIG» treffer alle i eksempelet over.

## Oppdatering

`.github/workflows/refresh-oppslagsliste.yml`, 05:00 UTC daglig — etter
FS-refreshen (04:00). Timer-triggere støttes ikke i SWA Managed Functions, så
jobben kalles over HTTP, samme mønster og samme hemmeligheter som
`refresh-fs.yml`.

Manuelt: **Oppdater** (én liste) eller **Oppdater alle nå** i admin-panelet.

| Endepunkt | Hvem |
|---|---|
| `GET /api/oppslaglister` | admin |
| `PUT /api/oppslaglister` | admin |
| `POST /api/oppslaglister/oppdater` | admin **eller** `x-scheduler-key` |

`?liste=<navn>` kjører én liste, `?tort=1` forhåndsviser uten å skrive.

Feiler én liste, stopper ikke de andre — ett oppsett med en skrivefeil skal
ikke ta hele døgnjobben med seg. Svaret blir **207**, feilen havner i `feil[]`
og i statusraden som admin-panelet viser, og cron-jobben blir gul, ikke grønn:
en død liste gir et tomt nedtrekk, og det er ikke «ok».

## Det en tom liste kan bety

Tre ulike ting, og de skal kunne skilles. Loggen sier hvilken:

* **Lista finnes ikke** — navnet i filteret stemmer ikke med noe oppsett.
  Loggen lister de definerte navnene.
* **Lista er definert, men tom** — jobben har ikke kjørt, eller ingen
  forekomst er både avsluttet og godkjent.
* **Filteret mangler** — `Skjemasvar` uten `Liste=`.

Uten det skillet er «ingen vurderinger er godkjent ennå» umulig å skille fra
«koden er ikke deployet», og det er den forvekslingen som koster tid.

## Rader som forsvinner

`erstattListe` sletter rader som ikke er i det nye settet. En vurdering som er
trukket tilbake — avsluttet, men ikke lenger godkjent — forsvinner derfor fra
nedtrekket ved neste kjøring. Skjemaer som alt har valgt den, beholder sitt
lagrede svar.

Radnøkkelen er kildens `Skjema_id`, så samme forekomst treffer samme rad hver
gang: en endret vurdering erstatter seg selv i stedet for å legge seg ved
siden av.
