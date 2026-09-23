# Power BI-kobling

Datauttrekk-siden kan lage en **Power BI Web-connector URL** for en skjematype:

```
https://<host>/api/power-bi?skjematype_id=<id>&guid=<token>&upn=<eier>
```

Den returnerer alle innsendte skjemaer for typen som en JSON-array, ett objekt
per skjema, med spørsmålstekst som kolonnenavn. Krypterte skjemaer dekrypteres
av endepunktet. Filtrene på Datauttrekk-siden påvirker **ikke** hva Power BI
får — alle innsendte skjemaer eksponeres.

Ruta er `anonymous` i `staticwebapp.config`, og tokenet i query-strengen er hele
autentiseringen. Det er et bevisst valg: Power BI Desktop skal kunne hente
dataene uten interaktiv innlogging.

> **URL-en er en hemmelighet.** Den som har den, har alle svarene på
> skjematypen — også personopplysninger i klartekst. Den skal ikke i e-post,
> ikke i et Teams-innlegg og ikke i en sak.

## Oppsett i Power BI

1. Datauttrekk → velg skjematype → **Lag eller forny Power BI-kobling**
2. Power BI Desktop → **Hent data → Web** → lim inn URL-en → **Anonym**
3. Publiser til tjenesten

Etter publisering må legitimasjonen settes **i tjenesten**. Desktop hadde den
lokalt; den følger ikke med .pbix-fila.

## Planlagt oppdatering

Tre feilmeldinger, tre ulike årsaker. De ser like ut i forbifarten, og bare den
første handler om M-koden:

| Feilmelding | Årsak | Rettelse |
|---|---|---|
| «datakildene støtter ikke oppdatering» — kilden er ikke listet | Dynamisk datakilde: URL-en settes sammen med `&` eller en parameter i Power Query | Skriv om til `Web.Contents(base, [RelativePath=…, Query=[…]])` |
| «minst én datakilde mangler innloggingsdata» | Legitimasjonen er aldri satt i tjenesten | Se under |
| Oppdateringen kjører, men feiler med 403 | Tokenet er utløpt, eller `upn` matcher ikke | Lag ny kobling, publiser .pbix på nytt |

**Sette legitimasjonen** (den nest vanligste, og den vi traff 22.09.2026):
semantisk modell → Innstillinger → **Legitimasjon for datakilde** → Rediger
legitimasjon → Godkjenningsmetode **Anonym**, personvernnivå **Offentlig** →
Logg på. Deretter må oppdateringsplanen slås **på igjen** — en feilet kjøring
deaktiverer den, og den slår seg ikke på av seg selv.

Anonym legitimasjon er altså godtatt for Web-kilder. Det var vår antakelse om
det motsatte som sendte oss på jakt etter Basic-auth og flyt; ingen av delene
trengtes.

## Hvor ofte

Power BI Pro: **8 oppdateringer per modell per døgn**. Premium/PPU: 48.
API-utløste oppdateringer teller med i den samme kvoten, også de som feiler.
Bare manuell «Oppdater nå» i grensesnittet er unntatt.

Det betyr at en Power Automate-flyt som oppdaterer ved hver innsending ikke er
farbar på Pro — kvoten ville vært brukt opp før lunsj på en travel dag. Legg i
stedet inn alle 8 tidspunktene i oppdateringsplanen, spredt over arbeidsdagen.
Det gir like mange oppdateringer som en flyt ville klart, uten flyten.

En flyt gir bare én ting planen ikke gir: at oppdateringen skjer rett etter en
innsending i stedet for på neste faste klokkeslett. Med 8 tidspunkter er den
gevinsten under to timer i verste fall.

## Tokenet varer i 365 dager

`pb-eier`-tokenet ligger i `Tilgangskontroll` med `ExpiresUTC`, og TTL-en settes
i `api/src/lib/pb-token-storage.js`. Når det går ut, begynner oppdateringen å
feile med 403, og Power BI deaktiverer planen.

**`sjekk-nokler`-jobben varsler om dette fra 23.09.2026.** Tokenene står ikke
som rader i `Nokkelkalender` — de opprettes av skjemaeiere når som helst, og en
manuelt vedlikeholdt rad ville manglet for nettopp de koblingene ingen husket.
I stedet formes de som kalenderrader ved varsling (`lib/pb-kalender.js`), slik
at **én** eskaleringsregel gjelder for begge slag og alt havner i samme e-post.
Utløpet leses fra `ExpiresUTC` hver gang og kan derfor aldri komme ut av takt.

Varselet går til **ADMIN_UPNS**, ikke til rapporteier. Rapportene forvaltes av
eierne av skjematypen, men eierskap flytter seg, og vi vet ikke hvem det er på
utløpstidspunktet. Admin videreformidler. Avklart med oppdragsgiver
23.09.2026.

Selve håndteringen gjøres av skjemaeier:

1. Datauttrekk → skjematypen → **Lag eller forny Power BI-kobling**
2. Bytt URL-en i Power BI Desktop
3. Publiser .pbix på nytt
4. Sett legitimasjonen i tjenesten igjen (Anonym), og slå oppdateringsplanen på

Eieren kan også melde inn via support uten å ha fått varselet — symptomet er at
rapporten har sluttet å oppdatere seg.
