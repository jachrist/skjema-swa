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

Dette dokumentet er vurderingen, ikke en ferdig spesifikasjon.

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
| Ekstern skrivetilgang | **Moderat** — mønsteret finnes, arbeidet er identitet og avgrensning |
| Varsling ved nytt innlegg | **Lite til moderat**, avhengig av per melding eller sammendrag |
| Åpen/lukket mot behandlingsstatus | **Lite** — `alleStegFerdig()` finnes |
| Migrere eksisterende `Dialog[]` | **Lite**, men må gjøres — ellers ligger historikken to steder |

Samlet: **en fase, ikke en ettermiddag.** Sammenlignbart med OTP-arbeidet.

## Tre forhold som må avklares før koding

### Sanntid finnes ikke

SWA Managed Functions har hverken WebSockets eller SignalR. En «chat» blir
polling — realistisk hvert 10.–15. sekund mens siden er åpen.

Det oppleves som en chat, men er det ikke. Oppdragsgiver bør vite det før de ser
en demo, ikke etter.

### Kryptering arves ikke lenger

Er skjematypen satt til omfang `Alt`, krypteres hele JSON-en, og dagens
`Dialog[]` er dekket automatisk (`kryptering.js:129`). Med andre omfang ligger
den i klartekst allerede i dag.

Flyttes meldingene til egen tabell, må dette avgjøres eksplisitt. Samtalen
inneholder etter all sannsynlighet mer personopplysninger enn skjemaet selv.

### Hva en ekstern skal se

I dag er `intern` sperret for innsender ved **skriving**. I en samtaletråd må
det også være sperret ved **lesing**, og det må være synlig for behandleren
hvilke innlegg motparten kan se.

Uten det skriver noen noe internt i den tro at det er skjult. Det er den
feilen som koster mest her, og den eneste som ikke kan rettes i ettertid.

## Anbefaling

**Kommentaren ved beslutning er tatt** (16.09.2026). Den dekket halve
forespørselen og er prøvd i opplæring.

**Samtalen bør gjøres som egen fase med egen tabell fra dag én.** Å bygge den
oppå dagens `Dialog[]` vil virke i test og feile i produksjon — på den måten som
er vanskeligst å rydde opp i: midt i en pågående sak, når noen nettopp har
skrevet noe viktig.

## Åpne punkter

- Skal et innlegg kunne redigeres eller slettes? Arkivering taler for nei, og
  for at en retting er et nytt innlegg.
- Vedlegg i samtalen? Blob-mønsteret finnes fra før (`vedlegg`-containeren),
  men det utvider både tilgangskontroll og arkivering.
- Varslingsfrekvens. Ett varsel per innlegg blir støy i en aktiv samtale.
- Hva skjer med samtalen når behandlingen lukkes — lesbar for begge parter,
  eller bare i arkivet?
- `Dialog` i datauttrekk og rapporter: den er **ikke** med i dag. Skal samtalen
  være det?
