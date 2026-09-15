# Deploy av Power Automate-flyter til prod

Hvordan de seks sentrale flytene kommer fra dev-tenanten til prod-miljøet.

Skrevet 15.09.2026, etter at ruta ble funnet den harde veien. Selve mønsteret
er standard ALM — det som tok tid var å oppdage at kryss-tenant-hoppet må skje
**før** managed-eksporten, ikke etter.

## Hvorfor fire steg og ikke to

Power Platform-pipelines virker bare innenfor **én** tenant. Utviklingen skjer
i dev-tenanten, produksjonen ligger i prod-tenanten, og det finnes ingen
innebygd vei mellom dem.

Løsningen er et **mellommiljø på prod-tenanten**: et utviklingsmiljø som tar
imot unmanaged fra dev-tenanten, og som managed-eksporten lages fra. Prod ser
da bare en ferdig managed løsning fra et miljø i sin egen tenant, slik ALM
forutsetter.

```
dev-tenant                    prod-tenant
┌──────────────┐             ┌──────────────┐     ┌──────────────┐
│ utvikling    │  unmanaged  │ mellommiljø  │     │ produksjon   │
│ (bygges her) │ ──────────► │ (mottak)     │ ──► │              │
└──────────────┘   .zip via  └──────────────┘     └──────────────┘
                   nedlasting               managed
```

## Stegene

1. **Øk versjonsnummeret** på løsningen i dev-tenanten. Importen kjenner igjen
   en oppgradering på dette, og filnavnet blir
   `LoesningsNavn_1_0_2_managed.zip` — da vet du hva som ligger hvor uten å
   åpne noe.

2. **Eksporter unmanaged** fra dev-tenanten. Fila lastes ned til PC-en din.

3. **Importer unmanaged** i mellommiljøet på prod-tenanten. To nettleser-
   profiler, eller ett InPrivate-vindu, gjør at du slipper å logge ut og inn.

4. **Eksporter managed** fra mellommiljøet, og **importer** i prod-miljøet.
   Velg **Oppgrader**, ikke Oppdater.

## Tre regler som holder det rent

**Aldri unmanaged i prod.** Det er denne som koster mest når den brytes: en
unmanaged komponent kan ikke fjernes rent igjen, og en «slettet» flyt kan bli
liggende i en upublisert tilstand som blokkerer neste import. Mellommiljøet er
stedet for unmanaged; prod ser bare managed.

**Oppgrader, ikke oppdater.** Oppgradering fjerner komponenter som er tatt ut
av løsningen. Oppdatering lar dem bli liggende — og det er nettopp slike
rester som gir konflikt neste gang.

**Øk versjonsnummeret hver gang.** Uten det vet verken importen eller du hva
som faktisk ligger ute.

## Miljøvariabler og tilkoblinger

Fjern **Current Value** fra miljøvariablene før eksport: åpne variabelen i
løsningen → `...` → **Remove from this solution**. Verdien blir stående i
utviklingsmiljøet, men følger ikke med — og da spør importen om verdien i
målmiljøet.

Blir verdien liggende, får prod dev-adressen. Det oppdages først når noe
kaller feil miljø.

Variablene er beskrevet i `docs/FLYTER.md`: `SwaBaseUrl` og `SkjemaMiljo`.

**Tilkoblingsreferanser** kobles ved **første** import i et miljø, og arves av
senere importer. Connectorene mot Office 365, Graph, OneDrive og Planner finnes
ikke i en ny tenant før noen autentiserer dem der. Dette er den delen som ikke
lar seg skripte bort — men den gjentar seg bare når en ny connector kommer til.

**Koble alle tilkoblingsreferansene før du aktiverer flytene.** Aktivering
validerer tilkoblingene, og feiler den, kommer feilen ut som `Unauthorized`
uten å si hvilken tilkobling som manglet.

### Tilkoblingen bestemmer tenanten, ikke miljøet

En connector-handling slår opp der **kontoen tilkoblingen er autentisert som**
hører hjemme. Hvilket miljø eller hvilken tenant løsningen ligger i, har
ingenting med saken å gjøre.

Det er derfor en flyt i en løsning på én tenant leser team fra en helt annen:
tilkoblingen er en `jccodevel`-konto, og da er det `jccodevel` sin Graph som
svarer. Det er ikke en feil, og det er måten dev-oppslag mot
utviklingstenanten skal virke på.

To ting følger av det:

- Et kryss-tenant-oppslag hviler på at connector-appen har samtykke i den
  *andre* tenanten, og på at kontoen der fortsatt virker. Ryker samtykket
  eller kontoen, feiler flyten — og utslaget hos oss er en HTTP-feil fra
  flyten, ikke en tydelig melding om tilkoblingen. `api/src/functions/team.js`
  logger vertsnavnet på flyten nettopp for å skille de tilfellene.
- Skillet dev/prod hører derfor hjemme i tilkoblingsreferansen, ikke i en
  gren inne i flyten. En gren krever at *begge* tilkoblingene finnes i
  miljøet flyten kjører i — også den grenen som aldri brukes, siden
  aktivering validerer alle handlinger. Da ligger utviklingstenantens
  legitimasjon i prod uten å ha noe der å gjøre.

### Hvordan tilkoblingsreferansene oppstår

**Lages eller redigeres flyten inne i en løsning**, opprettes referansen
automatisk per tilkobling og legges inn som komponent.

**Er flyten laget utenfor en løsning og siden lagt inn**, bærer den fortsatt
direkte tilkoblinger. De konverteres først når du åpner flyten i løsningen,
velger tilkoblingen på nytt på hver handling, og lagrer. Uten det ser flyten
riktig ut i designeren, men eksporten tar ikke med bindingen — og importen i
målmiljøet spør ikke om noe. Feilen kommer først ved aktivering.

Sjekken: åpne løsningen og se etter komponenter av typen
**Tilkoblingsreferanse**. Seks flyter mot Graph og null referanser betyr at
ingen er konvertert.

**Én referanse per tilkobling, ikke per flyt.** Referanser deles mellom flyter
i samme løsning. Bruker alle seks flytene samme Graph-tilkobling, holder det
med én — da binder du én gang per miljø i stedet for seks, og seks bindinger
er seks sjanser til å velge feil konto.

**Gi dem lesbare navn.** De autogenererte heter `shared_microsoftgraph_a1b2c`.
Det navnet er nøyaktig det du får presentert i bindingsdialogen ved import i
prod, der du skal velge riktig konto. Samme tanke som navnekonvensjonen på
flytene: `Graph – teamoppslag` sier hva den er.

## Feil som er lette å gå på

| Feilmelding | Hva den betyr |
|---|---|
| `FlowNotOriginalAuthor` | forfatteren er en identitet fra kildetenanten, som ikke finnes i målet. Koble tilkoblingsreferansene først; hjelper ikke det, sett eier via admin-senteret → Miljøer → Ressurser → Power Automate-flyter |
| `...published update ... when there exists an unpublished active row` | en tidligere versjon ligger igjen upublisert. Kjør **Publiser alle tilpassinger**. Hjelper ikke det, er miljøet forurenset av en blandet managed/unmanaged-import |
| `Provision kan ikke utføres ... CDS-forekomst` | miljøet mangler Dataverse. Opprett miljøet fra admin-senteret med «Legg til en Dataverse-datalager» — der er feilmeldinga presis, og du ser kapasiteten samtidig |

Gikk noe galt i et miljø som ikke er prod, er et **nytt, tomt miljø** ofte
raskere enn å rydde. Det var det som til slutt løste den første deployen.

## Hva som gjentar seg, og hva som ikke gjør det

Engangsarbeid: opprette miljøene, koble tilkoblingsreferanser, sette
miljøvariabler første gang.

Hver oppdatering: versjonsnummer, fire eksport/import-steg, filvalg. Noen
minutter.

Derfor er manuell deploy riktig nivå her. Automatisering med
`pac solution export` / `import` og en auth-profil per tenant er mulig, men
lønner seg først når dette gjøres ofte — og førstegangsjobben i et nytt miljø
må uansett gjøres for hånd.
