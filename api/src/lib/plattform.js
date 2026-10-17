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
 * `production` er det GAMLE navnet på pilot — ikke et annet ord for prod.
 * `config/env.pilot.json` setter `MILJO=production` den dag i dag, og
 * `scripts/build-config.js` gjør den samme oversettelsen ved bygg
 * («alias production → pilot»). Prod setter `MILJO=prod`.
 *
 * Skillet er ikke kosmetisk. Leses `production` som prod, arver pilot prodens
 * unntak — og en manglende `AAD_CLIENT_SECRET`, som tar ned innloggingen helt,
 * meldes da som «forventet tom her» i det ene miljøet som faktisk trenger den.
 * Det er nøyaktig feilen KUN_I_MILJO er laget for å unngå, speilvendt.
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
 * `AAD_CLIENT_SECRET` — men det var også grunnen til at `production` arvet
 * prodens unntak, og det ville gjort det samme for et hvilket som helst nytt
 * miljønavn. En hemmelighet som mangler i et miljø vi ikke kjenner skal meldes,
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
 * Lista utvides i steg 6, sammen med LØSER_KEYVAULT_REFERANSER.
 */
const KJORER_TIMERE = new Set(['dev']);

/**
 * Gjelder en evne-liste for miljøet vi står i?
 *
 * Egen funksjon av én grunn: **aliaset må normaliseres FØR oppslaget.**
 * `MILJO=production` er pilot, og en liste som inneholder `'pilot'` må svare
 * ja på den. Gjør den ikke det, er feilen usynlig i dag — ingen av listene
 * inneholder et alias-mål ennå — og slår inn først den dagen pilot legges
 * inn i steg 6. Det er den verste typen tidsinnstilt feil: den plantes nå og
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
    LØSER_KEYVAULT_REFERANSER, KJORER_TIMERE, stotterTimere
};
