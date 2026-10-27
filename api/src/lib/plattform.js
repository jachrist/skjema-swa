/**
 * Hvilket miljø vi står i, og hva PLATTFORMEN der kan.
 *
 * To spørsmål som hører sammen, og som lå spredt til 17.10.2026:
 * miljønavnet ble normalisert i `functions/system.js`, og evnene — foreløpig
 * Key Vault-referanser og timer-triggere — ville ellers fått hver sin liste i
 * hver sin fil.
 *
 * Det er den samme typen liste, den endres på de samme dagene (steg 5b og 6),
 * og to kopier som svarer ulikt om hvilket miljø som kan hva, er nøyaktig
 * feilklassen dette repoet lager flest av.
 *
 * Lista over miljønavn leses også av `scripts/build-config.js`, og
 * `api/test/system-miljo.test.js` krever at de to svarer likt.
 */

/**
 * Normaliser MILJO til ett navn per miljø.
 *
 * **`production` er v2-PROD, og det leses som pilot med vilje.** Pinget
 * 27.10.2026 — de fire vertene svarer:
 *
 *   | Navn    | Vert                   | MILJO        | miljonavn() |
 *   |---------|------------------------|--------------|-------------|
 *   | v2-dev  | SWA Managed Functions  | `pilot`      | pilot       |
 *   | v3-dev  | lenket Function App    | `dev`        | dev         |
 *   | v2-prod | SWA Managed Functions  | `Production` | pilot       |
 *   | v3-prod | lenket Function App    | `prod`       | prod        |
 *
 * Repoet trodde til samme dag at det var PILOT som satte `production`. Det
 * var feil, men aliaset er riktig likevel: `miljonavn()` svarer på «hvilke
 * regler gjelder for denne verten», og v2-prod er en SWA Managed
 * Functions-vert, som pilot. Leses `production` som prod, får v2-prod timere
 * og vente-på-bakgrunnsarbeid den ikke tåler — se KJORER_TIMERE.
 *
 * Det motsatte spørsmålet — «hvem er det som skriver» — skal IKKE gå
 * gjennom denne funksjonen. Backupfilnavn, nøkkelkalenderens partisjon og
 * `miljø` i flytkallene leser `MILJO` rått, fordi de må skille v2-prod fra
 * v2-dev. Gikk de via aliaset, ville prod skrevet i pilots rader.
 *
 * Et ukjent navn sendes uendret videre, og medForventning() behandler det som
 * «vet ikke» — se KJENTE_MILJOER der.
 */
const MILJO_ALIAS = { production: 'pilot' };

// `development` sto her til 15.10.2026, som alias for pilot. Da `dev` ble et
// ekte miljø, ville det navnet pekt på feil sted — og det er den samme fellen
// aliaset selv ble laget for å unngå, speilvendt. Det er fjernet også i
// scripts/build-config.js; et alias som bare finnes ett av stedene, er verre
// enn ingen.

/**
 * Miljøene vi kjenner. Et navn utenfor denne mengden er «vet ikke», ikke
 * «gjelder ikke».
 *
 * `KUN_I_MILJO.miljoer` er en positivliste: står miljøet ikke der, blir en tom
 * verdi friskmeldt. Det er riktig for prod, som vi vet ikke trenger
 * `AAD_CLIENT_SECRET` — men det ville også gitt et hvilket som helst nytt
 * miljønavn prodens unntak. En hemmelighet som mangler i et miljø vi ikke kjenner skal meldes,
 * ikke ties i hjel.
 */
const KJENTE_MILJOER = new Set(['dev', 'pilot', 'prod', 'lokal']);

/**
 * Miljøer der PLATTFORMEN løser `@Microsoft.KeyVault(...)`-referanser.
 *
 * SWA Managed Functions gjør det ikke — prøvd i pilot 12.10.2026, appen fikk
 * referansestrengen på 109 tegn. En frittstående Function App gjør det —
 * prøvd 14.10.2026, se 8d i `docs/BESLUTNING-EGEN-FUNCTION-APP.md`.
 *
 * Forskjellen gjør at SAMME symptom har to ulike årsaker, og dermed to ulike
 * råd. Uten dette skillet ga helsesjekken i dev 16.10.2026 et råd som var
 * aktivt feil — «lim inn verdien som klartekst» — mens referansene der
 * faktisk virket og det som manglet var én secret i vaulten. Et råd som
 * sender feilsøkingen i gal retning er verre enn ingen melding.
 *
 * Lista utvides i steg 6, når pilot og prod også kjører på Function Apps.
 */
const LØSER_KEYVAULT_REFERANSER = new Set(['dev']);

function miljonavn() {
    const raatt = String(process.env.MILJO || '').trim().toLowerCase();
    return MILJO_ALIAS[raatt] || raatt;
}

/**
 * Miljøer der PLATTFORMEN kjører timer-triggere.
 *
 * SWA Managed Functions gjør det ikke — det er hele grunnen til at de åtte
 * cron-jobbene ligger i GitHub Actions og kaller HTTP-endepunkter. En
 * frittstående Function App gjør det.
 *
 * **Vakten må stå rundt selve `app.timer(...)`-kallet, ved modullast.** En
 * timer som registreres på en vert som ikke støtter dem er ikke en stille
 * no-op — den kan velte oppstarten for HELE appen, og da er alle
 * HTTP-rutene borte også. Registreringen er altså ikke noe som skal
 * forsøkes og feile pent.
 *
 * **Prod kom til 27.10.2026**, da prod v3 ble en frittstående Function App.
 * Det var ikke en opprydding — det var nødvendig: HTTP-veien de åtte
 * cron-jobbene bruker er FIRE-AND-FORGET, og den virket bare fordi SWA
 * Managed Functions holder en langlivet vert. På en Function App fullfører
 * verten invokasjonen når handleren returnerer, og Microsoft er eksplisitt:
 * «the Functions runtime does not track threads or tasks your code starts …
 * they must complete before your function code returns».
 *
 * Utslaget i prod v3: alle ni jobbene sto på «aldri kjørt». Ruta svarte 202
 * «startet», og jobben rakk ikke engang sin første statusskriving — den som
 * står FØR alt arbeid, nettopp for at «startet, men feilet» skal kunne
 * skilles fra «startet aldri».
 *
 * En timer-invokasjon venter verten derimot på. Det er hele grunnen til at
 * timerne finnes.
 *
 * PILOT STÅR IGJEN, og skal det: den kjører fortsatt på SWA Managed
 * Functions, der en timer-registrering kan velte oppstarten. Lista tømmes
 * for miljøer først når alle kjører på Function Apps.
 *
 * **«prod» HER BETYR v3-PROD, OG DET ER ALIASET SOM HOLDER DE TO FRA
 * HVERANDRE.** Det finnes to prod-SWA-er. v3-prod er Function App-en; v2-prod
 * er den som er i drift, og den kjører på SWA Managed Functions. `MILJO` er det
 * eneste signalet koden har, og det skiller dem IKKE av seg selv — begge er
 * «prod» for et menneske, og `config/env.prod.json` sier `MILJO=prod`.
 *
 * Det som faktisk skiller dem er at app-settingen på v2-prod står til
 * `Production`. Den normaliseres til `pilot` (se MILJO_ALIAS), så v2-prod
 * leser som pilot og får ingen timere. Det er riktig — v2-prod ER en SWA
 * Managed Functions-vert — og det er to grep fra å bli galt:
 *
 *   - Settes v2 til `MILJO=prod` — f.eks. for å gjøre System-siden ærlig om
 *     hvilket miljø det er — registreres åtte timere på en vert som ikke
 *     støtter dem, i produksjon.
 *   - Ryddes aliaset bort, gjelder det samme.
 *
 * Så lenge begge prod-SWA-ene finnes, er `Production` på v2 en VAKT, ikke en
 * levning. Den kan ryddes først når v2 er revet (kapittel 10 og 11 i
 * `docs/KOKEBOK-PROD-V3.md`). `api/test/bakgrunnsjobb.test.js` leser den
 * påstanden.
 */
const KJORER_TIMERE = new Set(['dev', 'prod']);

/**
 * Miljøer der verten FULLFØRER INVOKASJONEN når handleren returnerer.
 *
 * Altså: der «start jobben, svar 202, la den gå» ikke er en vei. Microsoft
 * sier det rett ut om Functions: «the Functions runtime does not track
 * threads or tasks your code starts … they must complete before your
 * function code returns», og en tidlig retur bokføres som vellykket uansett
 * hva som skjedde etterpå.
 *
 * SWA Managed Functions holder en langlivet vert, og der HAR fire-and-forget
 * virket. Det er grunnen til at mønsteret ble skrevet i det hele tatt — og
 * grunnen til at det så ut til å virke helt til v3.
 *
 * Utslaget i prod v3 27.10.2026: fire av ni jobber svarte 202 «startet» og
 * gjorde ingenting. De fem som allerede `await`-et, virket.
 *
 * SAMME INNHOLD SOM `KJORER_TIMERE` I DAG, og likevel en egen liste: de
 * svarer på to ulike spørsmål. «Kan jeg registrere en timer her» og «dør
 * bakgrunnsarbeid her» er ikke samme spørsmål, og den dagen de skiller lag
 * skal ikke den ene ha dratt den andre med seg.
 */
const FULLFOERER_VED_RETUR = new Set(['dev', 'prod']);

/** Må vi vente på jobben, eller kan den gå i bakgrunnen? */
function maaVentePaaBakgrunnsarbeid() {
    return gjelderHer(FULLFOERER_VED_RETUR);
}

/**
 * Gjelder en evne-liste for miljøet vi står i?
 *
 * Egen funksjon av én grunn: **aliaset må normaliseres FØR oppslaget.**
 * `MILJO=production` (v2-prod) leses som pilot, og en liste som inneholder
 * `'pilot'` må svare ja på den. Gjør den ikke det, er feilen usynlig i dag —
 * ingen av listene inneholder et alias-mål ennå — og slår inn først den dagen
 * pilot legges inn i steg 6. Det er den verste typen tidsinnstilt feil: den plantes nå og
 * oppdages av noen andre.
 *
 * At den tar settet som argument er nettopp det som gjør den prøvbar i dag:
 * testen kan sende inn `new Set(['pilot'])` og kreve at `production` svarer
 * ja, uten å endre de ekte listene.
 */
function gjelderHer(sett) {
    return sett.has(miljonavn());
}

/** Kan vi registrere en timer-trigger her? */
function stotterTimere() {
    return gjelderHer(KJORER_TIMERE);
}

module.exports = {
    MILJO_ALIAS, KJENTE_MILJOER, miljonavn, gjelderHer,
    LØSER_KEYVAULT_REFERANSER, KJORER_TIMERE, stotterTimere,
    FULLFOERER_VED_RETUR, maaVentePaaBakgrunnsarbeid
};
