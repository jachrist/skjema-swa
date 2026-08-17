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
| `KL` | Klasse | klassekode | `KL\|Klasse 4` |
| `KU` | Kull | kullkode | `KU\|H26` |
| `SP` | Studieprogram | studieprogramkode | `SP\|MILM` |
| `ALLE` | Alle studenter | tom | `ALLE\|` |

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

## 6. Datakilder i FS — må verifiseres

Dagens spørring henter studenter via
`undervisningsenheter → studieretter → student → personProfil`
(`fs-client.js:131-141`). Kun `student` plukkes ut av studierett-noden.

I FS' datamodell er **studieretten** stedet der studieprogram, kull og klasse
henger. Feltnavnene er **ikke verifisert** — de må bekreftes mot skjemaet før
transformasjonen skrives. Introspeksjon:

```graphql
query { __type(name: "Studierett") { fields { name type { name kind ofType { name } } } } }
```

Kjøres mot `FS_API_URL` med samme Basic auth og `Feature-Flags: beta,experimental`
som `kallGraphQl` bruker. Hvis typenavnet ikke er `Studierett`, list opp typene
via `__schema { types { name } }` først.

Antatt utvidelse av spørringen, med forbehold om feltnavn:

```graphql
studieretter(first: 1000) {
    nodes {
        student { personProfil { navn { etternavn fornavn } institusjonsEpost } }
        studieprogram { kode navnAlleSprak { nb } }   # ← verifiser
        kull { kode }                                  # ← verifiser
        klasse { kode }                                # ← verifiser
    }
}
```

### Semantisk valg: studieprogram

`SK`/`SN` finnes allerede på `Emner`-radene, men det er **emnets**
studieprogramkobling (`fs-client.js:127-129`), ikke studentens. En student på et
emne kan tilhøre et annet program enn emnet er koblet til.

For filteret `Studenter{Studieprogram}` er det studentens eget program via
studieretten som er riktig. Dette bør bekreftes med kunden — det er en reell
forskjell, ikke en teknisk detalj.

## 7. Kodeendringer

| Fil | Endring |
|---|---|
| `api/src/lib/fs-client.js` | Utvid `studieretter`-seleksjonen med studieprogram/kull/klasse (etter introspeksjon) |
| `api/src/lib/refresh-fs.js` | `transformer()` produserer `filterRader` (EK/KL/KU/SP/ALLE) i stedet for `studentRader`; ny generasjonsbasert rydding |
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

1. **FS-feltnavn** for kull/klasse/studieprogram på studierett — må introspiseres.
2. **Studieprogram-semantikk** — studentens (studierett) eller emnets? Se §6.
3. **Klasse/kull per termin?** Hvis en student bytter klasse mellom terminer, må
   `FV` termin-prefikses som for emne (`KL|26H|Klasse 4`). Avklares mot FS-data.
4. **Studentvolum** — tallene i §4 er antakelser. Faktisk volum bør leses av
   `CacheMetadata` (`FS-Studenter.AntallRader`) før dimensjonering konkluderes.
5. **Caching** — `oppslag.js` har ingen caching i dag; hvert dropdown-treff går
   rett i storage. En TTL-cache i prosessen ville hjulpet uansett modell, men er
   uavhengig av denne endringen.
