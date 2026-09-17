/**
 * feltref-migrering.js — fest feltreferanser til feltets stabile Id.
 *
 * En feltreferanse i en melding kan skrives på to måter:
 *
 *   {1-02}                                    posisjon (seksjon-felt)
 *   {3f2504e0-4f89-11d3-9a0c-0305e82c3301}    feltets Id
 *
 * Posisjonen er ikke stabil. `renummererFelter` i editoren tildeler feltnumre
 * etter rekkefølge, så et felt som settes inn eller slettes lenger opp flytter
 * numrene under seg. Svarene tåler det — de kobles på Id (skjema-kompakt.js) og
 * flyttes med ved lagring (svar-reparasjon.js) — men referanseteksten i malene
 * er bare tekst, og ble aldri flyttet med. En `{1-02}` som pekte på «Reisemål»
 * peker etterpå på nabospørsmålet, eller på ingenting.
 *
 * Derfor migreres referansene ved INNLASTING i editoren, i samme steg som
 * feltene får Id. Det er det siste tidspunktet der numrene fortsatt er de
 * referansene ble skrevet mot; etter første omnummerering i økta er koblingen
 * borte for godt.
 *
 * Migreringen kan ikke redde en referanse som alt har mistet feltet sitt. Den
 * fester referansen til feltet den peker på NÅ — samme felt som ville blitt
 * brukt ved utsending i dag. Pekte den allerede feil, må den rettes for hånd;
 * `uloste` er til for å vise hvilke det gjelder.
 */

const POSISJONELL = /\{(\d+)-(\d+)\}/g;
const UUID = /\{([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}/gi;

/** Posisjonsnøkkel på samme form som resten av koden bruker: "1-02". */
function nokkel(sekNr, feltNr) {
    return `${sekNr}-${String(feltNr).padStart(2, '0')}`;
}

/**
 * Kart fra posisjon ("1-02") til feltets Id, og settet av gyldige Id-er.
 *
 * Informasjon-felter tas ikke med: de har ingen svar, og kan derfor ikke være
 * målet for en referanse. De teller likevel i nummereringen, så posisjonene
 * deres skal heller ikke kunne treffes.
 */
export function byggPosisjonskart(seksjoner) {
    const kart = new Map();
    const ider = new Set();
    for (const seksjon of (seksjoner || [])) {
        const sekNr = seksjon.Seksjon_nummer ?? seksjon.Nummer;
        for (const felt of (seksjon.Felter || [])) {
            if (felt.Type === 'Informasjon') continue;
            if (felt.Id) {
                ider.add(String(felt.Id));
                kart.set(nokkel(sekNr, felt.Nummer), String(felt.Id));
            }
        }
    }
    return { kart, ider };
}

/**
 * Bytt posisjonsreferanser i én streng med Id-referanser.
 * Returnerer { tekst, uloste } — uloste er referansene uten felt.
 */
export function migrerStreng(tekst, { kart, ider }) {
    const uloste = [];
    let ut = String(tekst).replace(POSISJONELL, (treff, sek, felt) => {
        const id = kart.get(nokkel(sek, felt));
        if (id) return `{${id}}`;
        uloste.push(treff);
        return treff;
    });
    // Id-referanser røres ikke, men en Id uten felt er like ødelagt som en
    // posisjon uten felt — feltet er slettet siden referansen ble satt inn.
    for (const [treff, id] of ut.matchAll(UUID)) {
        if (!ider.has(String(id).toLowerCase()) && !ider.has(String(id))) uloste.push(treff);
    }
    return { tekst: ut, uloste };
}

/**
 * Migrer alle feltreferanser i en skjematype. Endrer objektet in-place.
 * Returnerer { endret, uloste } — antall strenger som ble skrevet om, og en
 * liste med { sti, ref } for referansene som ikke peker på noe felt.
 *
 * Gjennomgangen er generisk og hopper bare over `Seksjoner`. Referanser kan
 * stå i e-postmaler, Planner- og Teams-oppsett, rollestrenger
 * («Klassesjef({2-01})») og SPMetadata — en fast liste over dem ville måtte
 * vedlikeholdes hver gang en ny kanal kommer til, og en glemt oppføring gir
 * nøyaktig den stille feilen dette skal fjerne. Inne i `Seksjoner` står
 * definisjonen av feltene selv, og der er `{1-02}` ikke en referanse.
 */
export function migrerFeltreferanser(data) {
    const oppslag = byggPosisjonskart(data?.Seksjoner);
    let endret = 0;
    const uloste = [];

    function gå(node, sti) {
        if (Array.isArray(node)) {
            node.forEach((v, i) => {
                if (typeof v === 'string') {
                    const r = migrerStreng(v, oppslag);
                    if (r.tekst !== v) { node[i] = r.tekst; endret++; }
                    for (const ref of r.uloste) uloste.push({ sti: `${sti}[${i}]`, ref });
                } else gå(v, `${sti}[${i}]`);
            });
            return;
        }
        if (!node || typeof node !== 'object') return;
        for (const [k, v] of Object.entries(node)) {
            if (typeof v === 'string') {
                const r = migrerStreng(v, oppslag);
                if (r.tekst !== v) { node[k] = r.tekst; endret++; }
                for (const ref of r.uloste) uloste.push({ sti: sti ? `${sti}.${k}` : k, ref });
            } else gå(v, sti ? `${sti}.${k}` : k);
        }
    }

    for (const [k, v] of Object.entries(data || {})) {
        if (k === 'Seksjoner') continue;
        if (typeof v === 'string') {
            const r = migrerStreng(v, oppslag);
            if (r.tekst !== v) { data[k] = r.tekst; endret++; }
            for (const ref of r.uloste) uloste.push({ sti: k, ref });
        } else gå(v, k);
    }

    return { endret, uloste };
}
