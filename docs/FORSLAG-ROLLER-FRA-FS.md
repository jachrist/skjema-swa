# Forslag: hovedlærer fra FS som rolle

**Status: forslag.** Ingenting er besluttet, og ingen kode er endret.
Skrevet 28.10.2026. Venter på svar fra FS-ansvarlig om hvor pålitelig
rolleinformasjonen i FS er — se «Spørsmål før beslutning».

Notatet bygger på `VURDERING-ROLLER.md`, særlig skillet mellom masterdata og
manuelt vedlikeholdte roller. Les det først hvis klassifiseringen er ukjent.

---

## Dagens situasjon

**FS-jobben skriver ingen roller.** Den nattlige kjøringen (`lib/refresh-fs.js`)
henter undervisningsenhetene fra FS og lagrer lærerne på emneraden i
`Emner`-tabellen:

| Felt på emneraden | FS-rolle | Innhold |
|---|---|---|
| `Larere` | `LÆRER` | JSON med fornavn, etternavn og institusjons-e-post |
| `Hovedlarere` | `HOVEDLÆRER` | samme |

De brukes i dag **bare** som datakilde i nedtrekkslister (`EmneLarere` og
`EmneHovedlarere` i `lib/oppslag.js`). De gir ingen tilgang, og ingen blir
behandler av dem.

**Rollelista** (`Rollemedlemskap`) skrives bare av adminportalen
(`functions/roller.js`) og importen fra fil (`lib/rolle-import.js`).
`Emneansvarlig(CBU2501)` finnes altså bare fordi noen har lagt den inn.

`hentEmnerForUpn` i `lib/emner-storage.js` finner emnene en person er lærer
eller hovedlærer på, men kalles ikke fra noe sted. Den ser ut til å være
påbegynt for nettopp dette.

---

## Forslaget

FS-jobben skriver hovedlærerne som rollemedlemskap, i en **egen rolle**, med
`Kilde: 'fs'`:

```
Hovedlærer(ING2308)   →   per.hansen@…   Kilde: fs
```

### Egen rolle, ikke `Emneansvarlig`

Skriver FS rett inn i `Emneansvarlig`, får samme rolle både FS-rader og
manuelle rader. Det er tilstanden `VURDERING-ROLLER.md` advarer mot: ingen
kan se hvilke medlemmer som kommer fra hvor, og en manuell rettelse kan bli
stående mot FS eller bli overskrevet av den.

Med en egen rolle velger hver skjematype selv. Behandlerlista på et steg er
en ELLER-liste, så et steg kan ha begge:

```
Emneansvarlig({2-01}), Hovedlærer({2-01})
```

Da behandler den manuelt innlagte emneansvarlige hvis den finnes, og
hovedlæreren fra FS ellers. `Emneansvarlig` blir en overstyring, ikke en
konkurrent.

### Omfanget er emnekoden, ikke versjonen

`ING2308`, ikke `ING2308-1`. `lib/omfang.js` prøver allerede full nøkkel
først og emnekoden etterpå, nettopp så en rolle ikke slutter å gjelde når
emnet får ny versjon. Skrives omfanget med versjon, mister rollen treffet
ved hver versjonsendring.

### Synkroniseringsregelen

Samme regel som importen, og helst samme kode:

- Jobben eier bare rader med `Kilde: 'fs'`. Manuelle rader og importerte
  rader røres aldri, også når de gjelder samme person og omfang.
- Hver kjøring er fasiten for sine egne rader. En hovedlærer som ikke lenger
  står i FS, fjernes.
- **Sperre mot massefall.** Gir FS plutselig langt færre hovedlærere enn
  forrige kjøring, fjernes ingenting, og statusraden sier fra. Det er samme
  vern som team-synk har («stoppet»), og av samme grunn: en tom respons fra
  FS skal ikke tømme rollelista.

### Hvilke terminer

Jobben henter i dag de aktive terminene. Hovedlærerrollen bør være unionen
over dem, slik at en hovedlærer for høstens emne fortsatt gjelder mens
vårens er lagt inn.

---

## Spørsmål før beslutning

**1. Er institusjons-e-posten i FS den samme som innloggingsnavnet?**
Rollene slås opp på UPN — det `x-ms-client-principal` gir. FS lagrer
`institusjonsEpost`. Er de ulike for noen (f.eks. `e-`-prefiks i UPN, eller
fornavn.etternavn i FS), treffer rollen aldri, og ingenting sier fra. Dette
er det viktigste spørsmålet. Det kan prøves på et utvalg før noe bygges:
sammenlign `Hovedlarere` på noen emner mot UPN-ene til de samme personene.

**2. Hvor pålitelig er `HOVEDLÆRER` i FS?** Er den registrert for alle
emner, og oppdateres den når ansvaret skifter?

**3. Tilsvarer `HOVEDLÆRER` emneansvarlig?** Eller er det en annen funksjon,
slik at noen emner har én hovedlærer og en annen emneansvarlig?

**4. Skal `LÆRER` også bli en rolle?** Teknisk er det det samme, men det gir
mange flere medlemskap og et bredere publikum.

---

## Omfang ved ja

| Hva | Hvor |
|---|---|
| Samle hovedlærerne per emnekode over terminene | `lib/refresh-fs.js` — dataene er der allerede |
| Planlegg og skriv rollemedlemskap med `Kilde: 'fs'` | Ny `lib/fs-roller.js`, med planleggingsregelen fra `lib/rolle-import.js` gjenbrukt, ikke kopiert |
| Sperre mot massefall, og antall i statusraden | `lib/refresh-fs-jobb.js` |
| Vis kilden i rolleadmin | `frontend/admin.html` — `Kilde` vises allerede per gruppe |
| Fjern eller ta i bruk `hentEmnerForUpn` | `lib/emner-storage.js` |
| Tester: regelen om bare egne rader, sperren, emnekode som omfang | `api/test/` |

**Ikke med:** klassifisering av roller som masterdata eller global
(`VURDERING-ROLLER.md`, punkt 1). Forslaget her klarer seg med `Kilde` per
rad, fordi rollen er ny og bare har FS-rader. Kommer klassifiseringen
senere, er `Hovedlærer` den første rollen som er masterdata.
