# Samtale mellom behandler og innsender

Forespørsel fra oppdragsgiver 16.09.2026: enkelte prosesser krever omfattende
kommunikasjon mellom behandler(e) og innsender. I dag gjøres den på e-post, som
gir lange trådstrenger og er tungvint å følge. Dagens `Dialog` var ment å dekke
det, men gjør det ikke.

Ønsket er en samtaleflate som ligner en chat, der hvert innlegg er en del av
behandlingen og arkiveres sammen med resten. Åpen så lenge behandlingen pågår.
Tilgjengelig for både interne og eksterne når skjematypen tillater det — altså
både ordinære lenker og OTP. I tillegg: behandler skal kunne gi en kommentar
når endelig beslutning fattes.

Vurderingen ble skrevet 16.09.2026. Beslutningene ble tatt 18.09 og står under
«Besluttet» — det er de som gjelder. Delene over dem er bakgrunnen som førte
dit, og er beholdt fordi begrunnelsene fortsatt er gyldige.

## Hva som allerede finnes

| Del | Hvor |
|---|---|
| Datamodell `Dialog[]` — `Type`, `Avsender`, `Tekst`, `Dato` | `api/src/functions/skjemaer.js`, `leggTilDialog` |
| Tilgangsregel: innsender kan ikke skrive interne innlegg | samme sted, via `tilgangsRolle()` |
| Arkivering i PDF, delt i ekstern og intern | `api/src/lib/pdf-generator.js:262` |
| Tre autentiseringsveier: utsendings-token, OTP-token, SWA-cookie | `velgAuthvei()` i `skjemaer.js` |
| Ekstern lesetilgang til eget skjema | `hentSkjema`, samme mønster |
| **Kommentar på beslutning — ferdig** | `skjemaer.js:270` lagrer, `evaluering.html` skriver og viser |

Det siste er verdt å merke seg: **halve forespørselen er levert.** API-et har
lagret `Kommentar` siden beslutnings-endepunktet ble skrevet; feltet i
grensesnittet kom 16.09.2026 og var i produksjon til opplæringen 18.09.

Da denne vurderingen først ble skrevet, sto det her at feltet manglet. Det var
sant den formiddagen og feil noen timer senere, og notatet ble ikke rettet.
Står det igjen noe her som ikke stemmer med koden, er koden fasiten.

## Hvorfor dette ikke kan bygges oppå dagens Dialog

Hele skjemaet lagres som **én JSON-streng i én Table Storage-rad**
(`skjema-forekomst-storage.js:94`). Table Storage har to harde tak:

- **32 000 tegn** per strengfelt
- **1 MB** per rad

`Dialog[]` deler altså et budsjett på ~32 000 tegn med skjemaets egne svar og
hele behandlingshistorikken. Hundre innlegg à 300 tegn sprenger det. For
«omfattende kommunikasjon» er det ikke en grense man nærmer seg — det er en man
treffer.

Og det finnes ingen håndtering av at taket nås. Skrivingen feiler, sannsynligvis
midt i en samtale, i en sak som pågår.

**Samtidighet er det andre problemet.** `lagreSkjema` leser hele skjemaet,
endrer det og skriver det tilbake uten etag-sjekk. To behandlere som skriver
samtidig er usannsynlig i dag; i en chat er det normalen — og da overskriver den
siste den første, uten at noen får vite det.

Begge problemene forsvinner med **én rad per innlegg i en egen tabell**, med
skjemaet som partisjonsnøkkel. Paginering følger med på kjøpet.

```
Tabell:  Samtale
PK:      {skjematypeId}:{skjemaId}
RK:      {ISO-tid}-{kort tilfeldig}   ← sortering og unikhet i samme nøkkel
Felter:  Type (intern|ekstern), Avsender, AvsenderNavn, Tekst, Dato, Kilde
```

`Kilde` skiller innlogget fra token-basert avsender. Uten den kan ikke
revisjonssporet svare på hvordan noen kom inn.

## Omfang

| Del | Vurdering |
|---|---|
| Kommentar ved endelig beslutning | **Ferdig** — levert 16.09.2026 |
| `Samtale`-tabell + les/skriv-endepunkter | **Moderat** — her ligger tyngden |
| Chat-grensesnitt | **Moderat** — se «Sanntid» under |
| Ekstern skrivetilgang | **Moderat** — mønsteret finnes, arbeidet er identitet |
| Varsling ved nytt innlegg | **Lite til moderat**, avhengig av per melding eller sammendrag |
| Åpen/lukket mot behandlingsstatus | **Lite** — `alleStegFerdig()` finnes |
| Migrere eksisterende `Dialog[]` | **Lite**, men må gjøres — ellers ligger historikken to steder |
| Demping per sak | **Lite** — egen tabell, én rad per bruker per sak |

Samlet: **en fase, ikke en ettermiddag.** Sammenlignbart med OTP-arbeidet.

## Besluttet 18.09.2026

Modellen er en **gruppechat**, slik folk kjenner den fra Teams og Slack.
Deltakerne er innsenderen og behandlerne. Den er aktiv så lenge skjemaet er
åpent, og følger saken som dokumentasjon når den lukkes.

| # | Spørsmål | Valgt |
|---|---|---|
| 1 | Trådmodell | Én tråd per skjema |
| 2 | Sanntid | Polling, 10–15 s |
| 3 | Kryptering | **Ingen.** Informasjonstekst ved oppstart av samtalen |
| 4 | Synlighet | **Alt synlig for alle deltakere.** Ingen interne innlegg |
| 5 | Redigering | Nei — en retting er et nytt innlegg |
| 6 | Vedlegg | Ikke i første versjon |
| 7 | Varsling | Per innlegg. Behandlere kan dempe **per sak** |
| 8 | Ved lukking | Lenken deaktiveres. Samtalen følger saken i PDF-en |
| 9 | Datauttrekk | Bare antall innlegg og dato for siste |

### Hvorfor punkt 3 og 4 henger sammen

De ble avgjort hver for seg og endte likevel i samme svar, fordi de er det
samme spørsmålet sett fra to sider.

En kanal der innsenderen er til stede og ser alt, er noe folk allerede vet
hvordan de skal oppføre seg i. «Ikke skriv noe sensitivt i en chat» er en
innarbeidet norm, og den holder når alle i rommet er synlige. Den holder
dårligere for en intern kanal om noen — der er hele poenget å drøfte personen
saken gjelder.

Derfor: **ingen interne innlegg i samtalen.** Intern drøfting blir værende i
dagens `Dialog` og i kommentaren ved beslutning, som er bygget for nettopp
det, og som er dekket av skjematypens kryptering.

Uten interne innlegg er den farligste feilmodusen borte helt — den der noen
skriver i den tro at motparten ikke leser. Det er ikke en teoretisk risiko:
akkurat den lekkasjen lå i PDF-en til 18.09.2026, og ble funnet mens denne
modellen ble tegnet.

### Det dette koster

En ukryptert `Samtale`-tabell er en **svekkelse for skjematyper med omfang
`Alt`**, der dagens `Dialog` krypteres sammen med resten av skjemaet.

Det er akseptabelt fordi samtalen er en delt kanal med innsenderen til stede,
og fordi brukeren blir fortalt det ved oppstart. Men det er et bevisst valg,
ikke en nøytral forenkling, og det bør stå her.

### Deltakere

Samtalen bruker **samme tilgangsregel som saken selv** — `tilgangsRolle` i
`lib/dialog-tilgang.js`. Har du tilgang til skjemaet, er du deltaker.

Det inkluderer behandlere fra tidligere steg. En tråd per skjema betyr at noen
som avgjorde steg 1 fortsatt kan lese og skrive på steg 3. Alternativet — å
kaste folk ut av en samtale de har deltatt i — er verre, og PDF-tilgangen
fungerer allerede slik.

### Datamodell

```
Tabell:  Samtale
PK:      {skjematypeId}:{skjemaId}
RK:      {ISO-tid}-{kort tilfeldig}   ← sortering og unikhet i samme nøkkel
Felter:  Avsender, AvsenderNavn, Tekst, Dato, Kilde

Tabell:  SamtaleDemping
PK:      {skjematypeId}:{skjemaId}
RK:      {upn}
Felter:  Dempet, SistEndret
```

`Kilde` skiller innlogget fra token-basert avsender. Uten den kan ikke
revisjonssporet svare på hvordan noen kom inn.

`Type`-feltet fra det opprinnelige utkastet er borte. Det var intern/ekstern,
og etter punkt 4 finnes ikke det skillet. Et felt som bare kan ha én verdi er
en invitasjon til å gi det to igjen senere.

## Forhold som fortsatt gjelder

### Sanntid finnes ikke

SWA Managed Functions har hverken WebSockets eller SignalR. En «chat» blir
polling — realistisk hvert 10.–15. sekund mens siden er åpen.

Det oppleves som en chat, men er det ikke. Oppdragsgiver bør vite det før de
ser en demo, ikke etter.

### Lenken dør, PDF-en blir igjen

Deaktiveres lenken ved lukking, er PDF-en innsenderens eneste kopi av
samtalen. To ting følger av det:

- Samtalen **må** inn i PDF-en, i seksjonen innsender får se.
- Kvitteringen må sendes **før** lenken deaktiveres. Ellers mister innsenderen
  en samtale om sin egen sak uten å ha fått sjansen til å ta vare på den.

### Migrere eksisterende `Dialog[]`

Dagens eksterne innlegg hører hjemme i samtalen; de interne blir værende i
`Dialog`. Gjøres ikke dette, ligger historikken to steder, og det er ikke
åpenbart for noen hvilken av dem som er den fullstendige.

## Hvem kan starte (besluttet 18.09.2026)

Bryteren ligger på skjematypen som `Skjematype.Samtale`:

| Verdi | Betyr |
|---|---|
| `Av` | ingen samtale. **Standard.** |
| `Behandlere` | bare behandlere kan skrive det første innlegget; innsender kan svare |
| `Alle` | innsender kan starte selv, via kvitteringen |

`Av` er standard fordi skjematypene som allerede ligger i produksjon ikke skal
få en samtaleflate fordi funksjonen ble rullet ut. Eieren slår den på.

Uten behandlingssteg er svaret `Av` uansett hva som står lagret, og valget er
låst i editoren. En samtale mellom innsender og behandlere krever at det finnes
en behandler.

I en gruppechat finnes det ikke noe eget startpunkt — det første innlegget ER
starten. Regelen er derfor ikke «hvem kan opprette en tråd», men «hvem kan
skrive når tråden er tom» (`kanSkrive` i `lib/samtale-tilgang.js`), og den
håndheves på serveren. Et skjult skrivefelt er ingen tilgangskontroll.

En innsender som verken kan skrive eller har noe å lese, ser ingen samtale i
det hele tatt. En låst boks hen lurer på hva er, er verre enn ingen boks.

## Kjent begrensning: eksterne mister tilgangen ved navigasjon

OTP-tokenet ligger i minnet på siden (`api.settHeader`), ikke i
`sessionStorage`. Det overlever derfor ikke en navigasjon.

Følgen er at en ekstern innsender ikke kan åpne `visning.html` eller bruke
samtalen etter at kvitteringen er vist — kallet svarer 401. **Dette gjelder
allerede i dag**, uavhengig av samtalen: «Se skjemaet»-lenken på kvitteringen
har samme problem.

Samtalen er derfor i praksis bare tilgjengelig for innloggede innsendere
inntil dette er løst. Det krever en beslutning som ikke er tatt: å legge
tokenet i `sessionStorage` er den nærliggende løsningen, men det er et
bærer-token, og hvor det lagres er et sikkerhetsvalg.

## Åpne punkter

- Hvor skal OTP-tokenet lagres, slik at eksterne beholder tilgangen gjennom en
  navigasjon? Se «Kjent begrensning» over.
- Informasjonsteksten ved oppstart: utkast i `docs/SAMTALE-INFOTEKST.md`, til
  godkjenning hos oppdragsgiver. Den bærer hele begrunnelsen for punkt 3.
