# FilterStudent — spesifikasjon

Status: **forslag, ikke implementert.** Skrevet 2026-08-17 etter behov for å filtrere
studenter på klasse/kull og studieprogram i tillegg til emne.

## 1. Problemet

`EmneStudenter` har i dag `PartitionKey = {Termin}|{EK}-{VK}`, `RowKey = epost`
(`refresh-fs.js:92-99`). Tabellen er avgrenset — refresh beholder kun forrige/
inneværende/neste termin og rydder resten (`refresh-fs.js:112-116`).

Men oppslaget fra skjemafeltene kaller `hentStudenterForEmne(emneId)` **uten**
termin (`oppslag.js:124`), og da faller partisjonsfilteret bort:

```js
const filter = termin ? odata`PartitionKey eq ${`${termin}|${emneId}`}` : undefined;
for await (const row of t.listEntities(opts)) {
    if (!termin && !String(row.partitionKey).endsWith(`|${emneId}`)) continue;
}
```
`emner-storage.js:169-173`

Resultat: **full tabellskann på hvert dropdown-oppslag.** `hentAlleStudenter()`
skanner alltid. Det samme gjelder `Personer.EmneStudenter`-filteret
(`oppslag.js:91`), som går inn i samme funksjon.

Årsaken er nøkkelrekkefølgen: termin står først, så emnekoden havner som
*suffiks*. Azure Table Storage kan gjøre prefiks-oppslag på nøkler via
`PK ge 'X' and PK lt 'X~'`, men aldri suffiks. Derfor klientside-matchingen.

Antall rader er altså ikke flaskehalsen i dag — manglende bruk av
partisjonsnøkkelen er det.

## 2. Hvorfor ikke ett JSON-felt per student

Vurdert alternativ: én rad per student med et JSON-array av
`[{"FN":"EK","FV":"MILM2301"},{"FN":"KL","FV":"Klasse 4"}]`.

Avgjørende begrensning: **Azure Table Storage kan ikke filtrere inne i et
strengfelt.** Table-API-et støtter kun sammenligningsoperatorer og and/or/not —
ingen `substringof`/`startswith` på vanlige properties. Hvert oppslag måtte
hentet alle studentrader, `JSON.parse`-et hver av dem og filtrert i Node.

Det ville vært raskere enn i dag (færre, fetere rader), men sementerer
skanningen: kostnaden blir alltid proporsjonal med studentmassen, aldri med
antall treff, og modellen kan ikke indekseres senere uten omskriving av
lagringsformatet.

Modellen er derimot riktig hvis behovet en dag blir *omvendt* oppslag —
«hvilke filtre gjelder for student X». Appens behov er forlengs.

## 3. Foreslått modell

Én tabell, `FilterStudent`, som generaliserer `EmneStudenter`:

```
PartitionKey = {FK}|{FV}          filterkategori | filterverdi
RowKey       = epost (lowercase)
Properties   = FN, EN, EP, Termin, G
```

| Property | Betydning |
|---|---|
| `FN` | Fornavn (uendret fra dagens rader) |
| `EN` | Etternavn |
| `EP` | Institusjonsepost |
| `Termin` | Kort-kode, f.eks. `26H` — for visning/etterfiltrering |
| `G` | Generasjon (refresh-kjøringens tidsstempel) — brukes til rydding, se §5 |

### Navnekollisjon — merk

Det opprinnelige forslaget brukte `FN` for *Filternavn*. `FN` er allerede
*Fornavn* på dagens rader (`refresh-fs.js:95`), og brukes som sådan i
`oppslag.js:95` og `oppslag.js:138`. Derfor **`FK`** (filterkategori) her.

`FK`/`FV` lagres ikke som egne properties — partisjonsnøkkelen bærer dem, og
duplisering ville bare kunne komme ut av synk. De utledes ved behov med
`pk.split('|')`.

### Filterkategorier

| `FK` | Betydning | `FV`-format | Eksempel-PK |
|---|---|---|---|
| `EK` | Emne | `{Termin}\|{EK}-{VK}` | `EK\|26H\|MILM2301-1` |
| `KL` | Klasse | `{SP}\|{årstall}-{betegnelse}\|{klassekode}` | `KL\|FHS-AS\|2023-HØST\|ÅRS SKSK` |
| `KU` | Kull | `{SP}\|{årstall}-{betegnelse}` | `KU\|FHS-AS\|2026-HØST` |
| `SP` | Studieprogram | studieprogramkode | `SP\|FHS-AS` |
| `ALLE` | Alle studenter | tom | `ALLE\|` |

Klasse- og kullnøklene er sammensatte fordi **klassekode ikke er unik** — se §6.
De følger FS' egen naturlige nøkkel. Den sammensatte verdien er stygg, men den
vises aldri for brukeren: `Tekst` i dropdownen blir klassenavnet
(«Årsenhet SKSK 2023»), `Verdi` blir nøkkelen. Det er samme Tekst/Verdi-skille
som resten av `oppslag.js` allerede bruker.

Termin ligger **inne i `FV`** for emne, ikke foran `FK`. Ellers gjenskapes
suffiks-problemet fra §1. Formatet `{Termin}|{EK}-{VK}` er allerede den
dokumenterte verdien i editoren (`editor.html:537`), så dette er ingen endring
for skjemabyggeren.

`ALLE`-partisjonen gjør at også det ufiltrerte oppslaget blir én
partisjonsspørring i stedet for en skann. Én rad per student (dedup på epost),
ikke én per innmelding.

### Oppslag

```js
async function hentStudenterForFilter(fk, fv) {
    const t = await tabell(TABELL_FILTERSTUDENT);
    const pk = `${fk}|${fv || ''}`;
    const result = [];
    for await (const row of t.listEntities({ queryOptions: { filter: odata`PartitionKey eq ${pk}` } })) {
        result.push({ EP: row.EP, FN: row.FN, EN: row.EN, Termin: row.Termin });
    }
    return result;
}
```

Kostnaden blir proporsjonal med svaret, ikke med tabellen — uavhengig av hvor
mange dimensjoner som legges til senere.

## 4. Radvolum

Emne-dimensjonen koster **nøyaktig det samme som i dag**: `EK`-radene er dagens
`EmneStudenter`-rader med et prefiks på partisjonsnøkkelen. Kun de nye
dimensjonene legger til rader, og de vokser additivt — ikke kombinatorisk:

```
rader ≈ (innmeldinger)                    ← som i dag, EK
      + (studenter × terminer × 3)        ← KL, KU, SP
      + (studenter)                       ← ALLE
```

Med 2 000 studenter, 6 emner per student og 3 terminer: ~36 000 EK-rader
(uendret) + ~18 000 nye + ~2 000 = ~56 000 rader mot dagens ~36 000.

Det er en større tabell enn JSON-alternativet ville gitt — men tabellstørrelse
slutter å bety noe når ingen spørring skanner. Et emne-oppslag leser ~30 rader
i stedet for 36 000.

## 5. Rydding ved refresh — viktig

Dagens rydding utnytter at termin står først i nøkkelen:
`pk.split('|')[0]` gir terminen, og hele partisjoner slettes per termin
(`refresh-fs.js:112-116`, `150-154`).

**Den muligheten forsvinner** med ny nøkkel: en partisjon som `KL|Klasse 4`
spenner over flere terminer. Uten en ny strategi vil studenter som er tatt ut av
FS ligge igjen for alltid.

Foreslått løsning — generasjonsmarkør:

1. Sett `G = <ISO-tidsstempel for kjøringen>` på alle rader som skrives.
2. Upsert alle nye rader **først** (ingen tom-vindu for brukerne).
3. Enumerer tabellen og slett rader der `G !== <denne kjøringen>`.

Steg 3 er en full enumerering, men den skjer kun i nattjobben — ikke i
brukerflyten. Det er heller ingen regresjon: `listPartisjoner()` gjør allerede
en full enumerering i dagens refresh (`refresh-fs.js:150`).

Alternativet er blå/grønn med to tabeller og en peker i `CacheMetadata`. Mer
robust, men mer maskineri enn dette trenger.

## 6. Datakilder i FS — funn fra `klasser`-spørringen

Klasse/kull/student hentes **ikke** via `undervisningsenheter`, men via en egen
rot-spørring `klasser(filter: {eierOrganisasjonskode, erAktiv})`. Verifisert mot
FS 2026-08-17. Stien til student er:

```
klasse → studenterIKlasse → programStudierett → student → personProfil
```

Dette blir altså en **andre FS-spørring** i refresh-jobben, uavhengig av dagens
`hentUndervisningsenheter`. Emne-dimensjonen (`EK`) bygges som før.

### Funn 1 — klassekode er ikke unik

I et uttrekk på 10 klasser forekom `kode: "A"` fem ganger (Kull 57/61/62/63 og
Årsenhet KS 2021) og `"ÅRS SKSK"` to ganger (2021 og 2023). Klassekode alene kan
ikke brukes som filterverdi.

`endCursor` fra samme spørring avslører FS' egen naturlige nøkkel — base64 av:

```json
[1627, "FHS-AS", "HØST", 2023, "ÅRS SKSK"]
```

altså `(eierorg, studieprogram, terminbetegnelse, årstall, klassekode)`. Det er
denne nøkkelen `KL`-partisjonen i §3 replikerer.

### Funn 2 — `erAktiv: true` er ikke et ferskhetsfilter

Uttrekket returnerte klasser med kull fra 2007, 2010, 2012, 2013 og 2021 — alle
med `erAktiv: true`, alle med `studenterIKlasse.nodes: []`. Kun klassen med kull
2026 hadde studenter.

Skal ikke dropdownen fylles med tjue år gamle klasser, må det filtreres. Det
riktige kriteriet er **at klassen har minst én student** — tomme klasser er
selvryddende, siden `studenterIKlasse` ser ut til å reflektere gjeldende
studieretter.

### Funn 3 — ikke filtrer klasser på aktiv termin

Fristende, men galt: `kull.terminV2` er kullets **start**-termin, ikke
inneværende. Klassen `EA 26` heter `EA 26-29` og løper altså over tre år. Et
kull startet i 2024 har aktive studenter i dag, men start-termin utenfor
vinduet forrige/inneværende/neste som `terminer.aktiveTerminer()` beregner.
Filtrering på aktiv termin ville stilltiende utelatt pågående klasser.

Bruk «har studenter» (funn 2) som kriterium i stedet.

### Funn 4 — feltdetaljer

- `betegnelse { id }` gir en ugjennomsiktig FS-id (`MTE3OjE2MjcsSMOYU1Q` =
  `117:1627,HØST`). Bruk `betegnelse { kode }`, slik `hentTerminer` allerede gjør
  (`fs-client.js:62`).
- Språknøklene er inkonsistente: klassenavn ligger under `navnAlleSprak.und`,
  kullnavn under `.no`, mens emner bruker `.nb` (`fs-client.js:125`). Transformen
  trenger en fallback-kjede `nb → no → und`.
- `klasser` paginerer (`hasNextPage: true` ved `first: 10`) — cursor-løkke som i
  `hentUndervisningsenheter` er nødvendig.

### Semantisk valg: studieprogram — nå løsbart

`SK`/`SN` på `Emner`-radene er **emnets** studieprogramkobling
(`fs-client.js:127-129`), ikke studentens. Med `programStudierett` i denne
spørringen kan studentens eget program leses direkte, som er det riktige for
filteret `Studenter{Studieprogram}`. Feltet må velges eksplisitt — se §6b.

## 6b. Gjenstående verifisering

Følgende felter er ikke bekreftet ennå. Spørring å kjøre:

```graphql
query KlasserVerifisering {
  klasser(filter: {eierOrganisasjonskode: "1627", erAktiv: true}, first: 5) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        kode
        navnAlleSprak { und nb no }
        studieprogram { kode navnAlleSprak { nb } }        # ← finnes feltet på klasse?
        kull {
          terminV2 { arstall betegnelse { kode } }          # kode, ikke id
          navnAlleSprak { no nb }
        }
        studenterIKlasse(first: 1000) {                     # ← støttes «first»?
          totalCount                                         # ← støttes «totalCount»?
          nodes {
            programStudierett {
              studieprogram { kode navnAlleSprak { nb } }   # ← studentens eget program
              student { personProfil { institusjonsEpost navn { fornavn etternavn } } }
            }
          }
        }
      }
    }
  }
}
```

Tre spørsmål den skal svare på:

1. **Ligger studieprogram på klassen, på `programStudierett`, eller begge?**
   Cursoren inneholder `"FHS-AS"`, så koblingen finnes — men ikke nødvendigvis
   som et selekterbart felt på klasse-noden. `KL`/`KU`-nøklene i §3 forutsetter
   at koden er tilgjengelig.
2. **Paginerer `studenterIKlasse`?** Uten `first` kan FS ha en implisitt grense.
   `studieretter` bruker `first: 1000` med `totalCount` (`fs-client.js:131-133`);
   samme mønster bør brukes her, og `totalCount` sammenlignes med `nodes.length`
   for å avdekke avkorting.
3. **Er tomme klasser virkelig utgåtte?** Bekreftes ved å finne en klasse med
   kull-termin 2024/2025 som fortsatt løper, og se at den har studenter. Det
   validerer kriteriet fra funn 2.

Filter-mulighetene på rot-spørringen bør også introspiseres, i tilfelle FS kan
gjøre avgrensningen serverside:

```graphql
query { __type(name: "QueryKlasserFilterInput") { inputFields { name type { name kind ofType { name } } } } }
```

## 7. Kodeendringer

| Fil | Endring |
|---|---|
| `api/src/lib/fs-client.js` | Ny `hentKlasser()` — egen rot-spørring med cursor-paginering (ikke en utvidelse av `hentUndervisningsenheter`) |
| `api/src/lib/refresh-fs.js` | Ny fase som henter klasser; `transformer()` produserer `filterRader` (EK/KL/KU/SP/ALLE) i stedet for `studentRader`; ny generasjonsbasert rydding |
| `api/src/lib/emner-storage.js` | `TABELL_FILTERSTUDENT`, ny `hentStudenterForFilter(fk, fv)`; behold gamle funksjoner til cutover er verifisert |
| `api/src/lib/oppslag.js` | `_hentStudenter` mapper filterbegrep → `(FK, FV)`; `Personer.EmneStudenter` (linje 89-97) legges om til samme funksjon |
| `frontend/editor.html` | Nye filtre under datakilden `Studenter` i `DATAKILDER` (linje 533-539): Klasse, Kull, Studieprogram |

Dedupliseringen i `_hentStudenter` (`oppslag.js:128-134`) kan fjernes for
filtrerte oppslag — `RowKey = epost` gjør partisjonen unik per student. Den må
beholdes hvis `ALLE`-partisjonen av en eller annen grunn ikke bygges dedupet.

## 8. Cutover

Det finnes **ingen migrering i vanlig forstand.** `EmneStudenter` er en ren
cache, 100 % utledet fra FS og bygget på nytt av cron-jobben — ingenting der er
kilde-til-sannhet. Derfor:

1. Bygg `FilterStudent` i tillegg til `EmneStudenter` i samme refresh-kjøring.
2. Verifiser radantall og stikkprøver mot dagens tabell.
3. Legg om `oppslag.js` til den nye tabellen.
4. Slipp de nye filtrene i editoren.
5. Fjern `EmneStudenter`-skriving og slett tabellen.

Steg 1-3 er reversible ved å peke `oppslag.js` tilbake. Ingen datatap-risiko i
noe steg.

## 9. Åpne spørsmål

1. ~~**FS-feltnavn** for kull/klasse~~ — løst 2026-08-17, se §6. Gjenstår: de tre
   punktene i §6b.
2. ~~**Studieprogram-semantikk**~~ — løsbart via `programStudierett`; velg
   studentens eget program. Bekreft feltet, se §6b.
3. **Klasse over flere terminer.** Klassen er ikke termin-avgrenset slik emnet
   er — `EA 26-29` løper over tre år (§6, funn 3). Nøkkelen i §3 bruker derfor
   kullets start-termin, ikke inneværende. Konsekvens: bytter en student klasse
   underveis, får hen ny `KL`-rad, og den gamle ryddes av
   generasjonsmekanismen i §5. Det er ønsket oppførsel, men bør bekreftes mot
   hvordan FS faktisk representerer klassebytte.
4. **Studentvolum** — tallene i §4 er antakelser. Faktisk volum bør leses av
   `CacheMetadata` (`FS-Studenter.AntallRader`) før dimensjonering konkluderes.
5. **Caching** — `oppslag.js` har ingen caching i dag; hvert dropdown-treff går
   rett i storage. En TTL-cache i prosessen ville hjulpet uansett modell, men er
   uavhengig av denne endringen.
6. **Skal tomme klasser med i `Klasser`-dropdownen?** Kriteriet i §6 funn 2
   fjerner dem. Hvis en klasse skal kunne velges *før* studenter er meldt inn,
   trengs et annet kriterium — men da må dropdownen bygges fra en egen
   klasse-tabell, ikke fra `FilterStudent`, som per definisjon kun har rader der
   det finnes studenter.
