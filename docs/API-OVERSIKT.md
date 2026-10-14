<!-- GENERERT av scripts/api-oversikt.js — ikke rediger for hånd. -->
<!-- Oppdater med: node scripts/api-oversikt.js --skriv -->

# API-oversikt

Alle HTTP-endepunkter i løsningen, med hvem som slipper inn.

Tilgangen avgjøres i to lag, og tabellene under viser begge:

* **SWA-gatewayen** (`staticwebapp.config.<miljø>.json`) avgjør hvem som
  kommer fram til funksjonen. `anonymous` betyr hvem som helst.
* **Handleren** avgjør resten. Hvert endepunkt har minst én vakt her; se
  `docs/SIKKERHET-OG-ARKITEKTUR.md` for hva hver vakt innebærer.

136 endepunkter, hvorav 39 er anonyme i gatewayen.

## Anonyme i gatewayen

SWA slipper hvem som helst fram til handleren. Vakten der er eneste sperre.

| Rute | Metoder | Vakt i handleren |
|---|---|---|
| `/api/backup/kjor` | POST | scheduler |
| `/api/backup/kvittering` | POST | flytnøkkel |
| `/api/backup/verifiser-lagret` | POST | scheduler |
| `/api/cache/teammedlemskap` | POST | admin, innlogget, flytnøkkel |
| `/api/cache/teammedlemskap/team-navn` | GET | innlogget, flytnøkkel |
| `/api/hendelser/logg` | POST | admin, innlogget, flytnøkkel |
| `/api/logo/{filnavn}` | GET | _åpent med vilje:_ Serverer bilde-bytes. Vises i skjema-headere, også for eksterne innsendere som ikke er pålogget. |
| `/api/nokkelkalender/sjekk` | POST | admin, innlogget, scheduler |
| `/api/ny-skjema-id/{skjematypeId}` | GET | admin, innlogget, otp, utsendingstoken |
| `/api/oppslag` | POST | innlogget, utsendingstoken |
| `/api/otp/be-om-kode` | POST | ratelimit — Må være anonymt — det er her en ekstern ber om tilgang. Koden sendes bare til adressen som oppgis, og kallet er rate-limitet. |
| `/api/otp/verifiser-kode` | POST | _åpent med vilje:_ Må være anonymt av samme grunn. Feil kode gir ingen opplysning om adressen finnes. |
| `/api/ping` | GET | _åpent med vilje:_ Helsesjekk. Svarer med commit-SHA, miljø, og om innloggingen nådde fram til funksjonen — ikke hvem som er innlogget: hverken UPN eller rollenavn er med. SHA-en er nødvendig for å kunne avgjøre om en rettelse er deployet. |
| `/api/postnumre/refresh-bring` | POST | admin, innlogget, scheduler |
| `/api/power-bi` | GET | pb-token |
| `/api/publikum-skjematype/{id}` | GET | _åpent med vilje:_ Returnerer BARE skjematyper med EksternTilgang=true, og bare definisjonen — ingen svar. Er grunnlaget for at en ekstern kan åpne et skjema i det hele tatt. |
| `/api/refresh-fs` | POST | admin, innlogget, scheduler |
| `/api/roller-swa` | POST | admin |
| `/api/skjemaer` | POST | admin, innlogget, otp, utsendingstoken |
| `/api/skjemaer/{skjematypeId}/{skjemaId}` | DELETE | admin, innlogget, eier |
| `/api/skjemaer/{skjematypeId}/{skjemaId}` | GET | admin, innlogget, eier, otp |
| `/api/skjemaer/{skjematypeId}/{skjemaId}/beslutning` | POST | innlogget, flytnøkkel |
| `/api/skjemaer/{skjematypeId}/{skjemaId}/dialog` | POST | innlogget |
| `/api/skjemaer/{skjematypeId}/{skjemaId}/komprimer` | POST | admin, innlogget, eier |
| `/api/skjemaer/{skjematypeId}/{skjemaId}/pdf` | POST, GET | admin, innlogget |
| `/api/skjemaer/{skjematypeId}/{skjemaId}/samtale` | GET | innlogget, otp, utsendingstoken |
| `/api/skjemaer/{skjematypeId}/{skjemaId}/samtale` | POST | innlogget, otp, utsendingstoken |
| `/api/skjemaer/{skjematypeId}/{skjemaId}/samtale/demping` | POST | innlogget, otp, utsendingstoken |
| `/api/skjemaer/{skjematypeId}/{skjemaId}/videresend` | POST | innlogget |
| `/api/skjemaer/{skjematypeId}/import` | POST | admin, innlogget, eier |
| `/api/systemlogo` | GET | _åpent med vilje:_ Systemets logo og tittel. Vises før innlogging. |
| `/api/team-synk` | GET | admin, innlogget |
| `/api/team-synk` | POST | scheduler |
| `/api/utsending` | POST | admin, innlogget, flytnøkkel, utsendingstoken |
| `/api/utsending/purre` | POST | admin, innlogget, scheduler |
| `/api/utsending/send-forfalte` | POST | admin, innlogget, scheduler |
| `/api/utsending/valider` | GET | utsendingstoken |
| `/api/vedlegg/{skjematypeId}/{skjemaId}` | POST | admin, innlogget, utsendingstoken |
| `/api/vedlegg/{skjematypeId}/{skjemaId}` | GET | admin, innlogget |

## Krever innlogging

| Rute | Metoder | SWA | Vakt i handleren |
|---|---|---|---|
| `/api/ai/analyser-skjema` | POST | authenticated | admin, innlogget |
| `/api/ai/diag` | POST, GET | authenticated | admin, innlogget |
| `/api/arkiv` | GET | authenticated | admin, innlogget |
| `/api/arkiv/{skjematypeId}` | POST | authenticated | admin, innlogget |
| `/api/arkiv/{skjematypeId}/forhandsvis` | POST | authenticated | admin, innlogget |
| `/api/arkiv/{skjematypeId}/slett` | POST | authenticated | admin, innlogget |
| `/api/backup/eksternt-status` | GET | authenticated | admin, innlogget |
| `/api/backup/kjor-eksternt` | POST | authenticated | admin, innlogget |
| `/api/backup/last-ned` | POST | authenticated | admin, innlogget |
| `/api/backup/liste` | GET | authenticated | admin, innlogget |
| `/api/backup/restore` | POST | authenticated | admin, innlogget |
| `/api/backup/status` | GET | authenticated | admin, innlogget |
| `/api/backup/verifiser` | POST | authenticated | admin, innlogget |
| `/api/backup/verifiser-status` | GET | authenticated | admin, innlogget |
| `/api/cache/teammedlemskap/{team}` | DELETE | authenticated | admin, innlogget |
| `/api/datauttrekk` | POST | authenticated | admin, innlogget, eier |
| `/api/datauttrekk/filtre` | GET | authenticated | admin, innlogget, eier |
| `/api/diagnose/mi-flyt` | GET | authenticated | admin, innlogget |
| `/api/diagnose/mi-tabell` | GET | authenticated | admin, innlogget |
| `/api/diagnose/mi-token` | GET | authenticated | admin, innlogget |
| `/api/emner/{termin}/{emneId}/beskrivelse` | GET | authenticated | innlogget |
| `/api/gevinst/nullpunkt-status` | GET | authenticated | innlogget |
| `/api/hello-storage` | GET | authenticated | innlogget |
| `/api/hendelser` | GET | authenticated | admin, innlogget |
| `/api/innstillinger` | GET | authenticated | admin, innlogget |
| `/api/innstillinger` | POST | authenticated | admin, innlogget |
| `/api/innstillinger/{nokkel}` | GET | authenticated | admin, innlogget |
| `/api/innstillinger/{nokkel}` | DELETE | authenticated | admin, innlogget |
| `/api/logoer` | GET | authenticated | innlogget |
| `/api/logoer` | POST | authenticated | admin, innlogget |
| `/api/logoer/{filnavn}` | DELETE | authenticated | admin, innlogget |
| `/api/mine-behandlinger` | GET | authenticated | innlogget |
| `/api/mine-mellomlagrede` | GET | authenticated | innlogget |
| `/api/nokkel/{skjematypeId}` | GET | authenticated | admin, innlogget, eier |
| `/api/nokkel/{skjematypeId}/generer` | POST | authenticated | admin, innlogget, eier |
| `/api/nokkel/{skjematypeId}/rekrypter` | POST | authenticated | admin, innlogget, eier |
| `/api/nokkelkalender` | GET | authenticated | admin, innlogget |
| `/api/nokkelkalender` | POST | authenticated | admin, innlogget |
| `/api/nokkelkalender/{id}` | PUT | authenticated | admin, innlogget |
| `/api/nokkelkalender/{id}` | DELETE | authenticated | admin, innlogget |
| `/api/nokkelkalender/seed` | POST | authenticated | admin, innlogget |
| `/api/oppslaglister` | GET | authenticated | admin, innlogget |
| `/api/oppslaglister` | PUT | authenticated | admin, innlogget |
| `/api/oppslaglister/oppdater` | POST | authenticated | admin, innlogget, scheduler |
| `/api/pb-token` | POST | authenticated | admin, innlogget, eier |
| `/api/postnumre/seed` | POST | authenticated | admin, innlogget |
| `/api/postnumre/sok` | GET | authenticated | innlogget |
| `/api/postnumre/status` | GET | authenticated | admin, innlogget |
| `/api/rapport/kjor` | POST | authenticated | admin, innlogget |
| `/api/rapporttyper` | GET | authenticated | admin, innlogget |
| `/api/rapporttyper` | POST | authenticated | innlogget, skjemaskaper |
| `/api/rapporttyper/{id}` | GET | authenticated | admin, innlogget |
| `/api/rapporttyper/{id}` | DELETE | authenticated | innlogget |
| `/api/refresh-fs/diag` | POST | authenticated | admin, innlogget, scheduler |
| `/api/refresh-fs/diag-lu` | POST | authenticated | admin, innlogget, scheduler |
| `/api/refresh-fs/status` | GET | authenticated | innlogget |
| `/api/roller/fjern` | POST | authenticated | admin, innlogget |
| `/api/roller/grupper` | GET | authenticated | innlogget |
| `/api/roller/import` | POST | authenticated | admin, innlogget |
| `/api/roller/innehavere` | GET | authenticated | innlogget |
| `/api/roller/leggtil` | POST | authenticated | admin, innlogget |
| `/api/roller/seed` | POST | authenticated | admin, innlogget |
| `/api/roller/slett` | POST | authenticated | admin, innlogget |
| `/api/seed-eksempel` | POST | authenticated | admin, innlogget |
| `/api/skjema-liste/{skjematypeId}` | GET | authenticated | admin, innlogget, eier |
| `/api/skjematype-oversikt` | GET | authenticated | admin, innlogget |
| `/api/skjematyper` | GET | authenticated | admin, innlogget |
| `/api/skjematyper` | POST | authenticated | admin, innlogget |
| `/api/skjematyper/{id}` | GET | authenticated | admin, innlogget |
| `/api/skjematyper/{id}` | DELETE | authenticated | innlogget |
| `/api/skjematyper/{id}/analyser-flytting` | POST | authenticated | innlogget |
| `/api/skjematyper/{id}/antall-skjemaer` | GET | authenticated | innlogget |
| `/api/skjematyper/{id}/diagnose` | GET | authenticated | innlogget |
| `/api/skjematyper/{id}/kan-svare` | GET | authenticated | innlogget, otp |
| `/api/system/info` | GET | authenticated | admin, innlogget |
| `/api/team-synk/{rolle}` | PUT | authenticated | admin, innlogget |
| `/api/team-synk/{rolle}` | POST | authenticated | scheduler |
| `/api/team/last-medlemmer` | POST | authenticated | innlogget |
| `/api/team/sok-eksternt` | POST | authenticated | innlogget |
| `/api/tilgang-avvist` | POST | authenticated | innlogget |
| `/api/todo` | GET | authenticated | admin, innlogget |
| `/api/todo` | POST | authenticated | admin, innlogget |
| `/api/todo/{nummer}` | PUT | authenticated | admin, innlogget |
| `/api/todo/{nummer}` | DELETE | authenticated | admin, innlogget |
| `/api/todo/{nummer}/vedlegg` | GET | authenticated | admin, innlogget |
| `/api/todo/{nummer}/vedlegg` | POST | authenticated | admin, innlogget |
| `/api/todo/{nummer}/vedlegg/{filnavn}` | GET | authenticated | admin, innlogget |
| `/api/todo/{nummer}/vedlegg/{filnavn}` | DELETE | authenticated | admin, innlogget |
| `/api/todo/importer` | POST | authenticated | admin, innlogget |
| `/api/todo/markdown` | GET | authenticated | admin, innlogget |
| `/api/utsending/batch/{batchId}` | GET | authenticated | admin, innlogget |
| `/api/utsending/for-meg` | POST | authenticated | innlogget, utsendingstoken |
| `/api/varsling/diag` | GET | authenticated | admin, innlogget |
| `/api/varsling/diag/{skjematypeId}/{skjemaId}` | GET | authenticated | admin, innlogget |
| `/api/vedlegg-fil/{skjematypeId}/{skjemaId}/{filnavn}` | GET | authenticated | admin, innlogget |
| `/api/vedlegg-fil/{skjematypeId}/{skjemaId}/{filnavn}` | DELETE | authenticated | admin, innlogget |
| `/api/whoami` | GET | authenticated | admin, innlogget |

