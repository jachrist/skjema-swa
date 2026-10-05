/**
 * behandling.js — Logikk for aktive behandlingssteg.
 *
 * Et steg er "aktivt" hvis:
 *   - Beslutning = 0 (ikke behandlet ennå)
 *   - AvhengigAv-steget er behandlet (eller ingen avhengighet)
 *   - Vilkår er oppfylt (eller ingen vilkår)
 *
 * En bruker er "behandler" for et steg hvis:
 *   - UPN finnes i steg.Personer, ELLER
 *   - UPN er innehaver av en rolle i steg.Roller (via roller-storage)
 *   - Team-basert behandling kommer med Graph API (fase 8)
 */
const { evaluerVilkar } = require('./vilkar');
const { erRolleMedlem, erTeamMedlem } = require('./tilgang');

/**
 * Beslutningsvalget med dette nummeret på steget, eller null.
 */
function finnBeslutningsvalg(steg, beslutningNr) {
    return (steg?.Beslutningsvalg || [])
        .find(v => Number(v.Nummer) === Number(beslutningNr)) || null;
}

/**
 * Er dette valget en ompuss — «tilbake til innsender for retting»?
 *
 * Eksportert fordi to steder må stille samme spørsmål: lagringen, som
 * nullstiller steget og setter status 3, og varslingen, som må lenke
 * innsenderen til utfyllingssiden i stedet for visningssiden.
 *
 * Fram til 05.10.2026 fantes regelen bare i lagringen, og varslingen lenket
 * alltid til visning.html. Innsenderen fikk dermed «Fikses» med en lenke til
 * et skrivebeskyttet skjema — en blindvei.
 */
function erOmpussValg(valg) {
    return valg?.Handling === 'ompuss';
}

/**
 * Har noen faktisk behandlet et steg?
 *
 * «Under behandling» har ingen egen Skjema_status. Et skjema som er avgjort
 * på steg 1 og venter på steg 2 står fortsatt på 2, akkurat som et ingen har
 * rørt. Forskjellen må derfor utledes, og regelen er denne.
 *
 * `Beslutning = 5` er «hoppet over» — et steg som ikke skulle kjøre. Det er
 * ikke arbeid noen har gjort, og skal ikke få skjemaet til å se ut som om
 * behandlingen er i gang.
 *
 * Eksportert fordi registerlista er kompakt og ikke bærer `Behandling`.
 * Serveren regner ut svaret der og sender det som `UnderBehandling`.
 * `frontend/js/skjemastatus.js` har samme regel for de sidene som HAR hele
 * skjemaet, og en test krever at de to svarer likt.
 */
function noenStegErBehandlet(skjema) {
    return (skjema?.Behandling || []).some(s => {
        const b = Number(s?.Beslutning || 0);
        return b !== 0 && b !== 5;
    });
}

/**
 * Skal innsenderen varsles om denne beslutningen?
 *
 * Standard er ja. `VarsleInnsender: false` slår den av — brukerønske fra
 * skjemaer med flere steg, der innsenderen ikke skal høre fra oss ved hver
 * delbeslutning, bare ved den endelige. (`Ferdigvarsling` er den andre
 * halvdelen av det oppsettet.)
 *
 * **Ompuss varsler ALLTID.** Et skjema som sendes tilbake for retting uten at
 * noen får beskjed, blir liggende til evig tid: innsenderen vet ikke at
 * ballen er hos hen, og behandleren venter på et svar som aldri kommer.
 * Bryteren kan ikke slå av den meldingen, og editoren lar den ikke prøve.
 */
function skalVarsleInnsender(valg) {
    if (erOmpussValg(valg)) return true;
    return valg?.VarsleInnsender !== false;
}

function stegErFerdig(steg) {
    return Number(steg?.Beslutning || 0) !== 0;
}

/**
 * Har steget en avhengighet i det hele tatt?
 *
 * Alt falsy betyr «nei»: `undefined`, `null`, `''` og — ikke minst — `0`.
 * Steg nummereres fra 1, så 0 er «ingen», og eldre definisjoner har den
 * verdien liggende.
 *
 * Eksportert fordi diagnosen må stille NØYAKTIG samme spørsmål. Den fikk
 * først sin egen sjekk som bare så etter undefined/null/'', og meldte da
 * «venter på steg 0, som ikke finnes» på skjematyper som var helt i orden.
 * Regelen bor her, hos den som faktisk blokkerer steget.
 */
function harAvhengighet(steg) {
    return !!steg?.AvhengigAv;
}

function stegErBlokkertAvAvhengighet(steg, alleSteg) {
    if (!harAvhengighet(steg)) return false;
    const avh = alleSteg.find(s => Number(s.Steg) === Number(steg.AvhengigAv));
    if (!avh) return true; // referanse til ikke-eksisterende steg blokkerer
    return !stegErFerdig(avh);
}

function beregnAktiveSteg(skjema) {
    const behandling = skjema?.Behandling || [];
    const aktive = [];
    for (const steg of behandling) {
        if (stegErFerdig(steg)) continue;
        if (stegErBlokkertAvAvhengighet(steg, behandling)) continue;
        if (steg.Vilkår && !evaluerVilkar(steg.Vilkår, skjema.Seksjoner, behandling)) continue;
        aktive.push(steg);
    }
    return aktive;
}

function brukerErBehandler(steg, upn) {
    if (!upn) return false;
    const upnLower = String(upn).toLowerCase();
    return (steg?.Personer || []).map(p => String(p).toLowerCase()).includes(upnLower);
}

/**
 * Utvidet variant som også sjekker Roller. Krever async pga rolle-oppslag.
 * Bruk denne der behandler-sjekken skjer i request-håndtering.
 */
/**
 * @param {object} [cache] — valgfri memo fra tilgang.lagTilgangsCache(). Send
 *   inn når mange skjemaer sjekkes i samme forespørsel (f.eks. mine-behandlinger);
 *   da slås hver rolle opp én gang i stedet for én gang per skjema.
 */
async function brukerErBehandlerAsync(steg, upn, cache = null) {
    if (brukerErBehandler(steg, upn)) return true;
    const roller = steg?.Roller || [];
    for (const r of roller) {
        try {
            if (await erRolleMedlem(cache, r, upn)) return true;
        } catch (_) { /* prøv neste */ }
    }
    const team = steg?.Team || [];
    for (const t of team) {
        try {
            if (await erTeamMedlem(cache, t, upn)) return true;
        } catch (_) { /* prøv neste */ }
    }
    return false;
}

/**
 * Har denne brukeren noe med saken å gjøre som behandler — på ETHVERT steg?
 *
 * Skilt fra «kan handle nå», som er behandler på et AKTIVT steg. De to er
 * ulike spørsmål, og å blande dem har kostet oss tre ulike svar på det samme:
 *
 *   skjemaer.js GET  krevde aktivt steg
 *   pdf.js           aktivt steg ELLER BehandletAv
 *   dialog-tilgang   ethvert steg
 *
 * Følgen av den strengeste var at en behandler mistet saken i det den ble
 * ferdig: hen kunne verken se hva hen selv hadde bestemt, åpne lenka fra
 * e-posten eller hente PDF-en. Det gjaldt også mellom steg — er steg 2
 * blokkert av en avhengighet, sto behandleren uten innsyn i saken hen snart
 * skal avgjøre. (Meldt fra testing 05.10.2026.)
 *
 * Tre kilder, fordi lista kan ha endret seg siden beslutningen ble tatt:
 *
 *   `BehandletAv`          den som avgjorde steget
 *   `Beslutninger[].Aktor` deltakerne i «alle må avgjøre» — der er
 *                          BehandletAv markøren «alle-behandlere», ikke en
 *                          person
 *   `Personer/Roller/Team` de som er utpekt nå
 *
 * Dette gir LESETILGANG. Hva brukeren kan gjøre med saken avgjøres fortsatt
 * av de aktive stegene og av beslutningsendepunktet.
 */
/**
 * Verdier som står i `BehandletAv` uten å være personer.
 *
 * `alle-behandlere` markerer et steg avgjort av flere, `ekstern-flyt` en
 * beslutning fra en Power Automate-flyt, `system` et steg skip-logikken
 * hoppet over. Ingen av dem er en UPN, men de ville matchet som strenger —
 * og da ga de tilgang til den som klarte å logge inn med navnet.
 */
const IKKE_PERSONER = new Set(['alle-behandlere', 'ekstern-flyt', 'system']);

async function erBehandlerPaaNoeSteg(skjema, upn, cache = null) {
    if (!upn) return false;
    const upnLower = String(upn).toLowerCase();
    if (IKKE_PERSONER.has(upnLower)) return false;
    for (const s of (skjema?.Behandling || [])) {
        if (String(s.BehandletAv || '').toLowerCase() === upnLower) return true;
        if ((s.Beslutninger || []).some(b => String(b.Aktor || '').toLowerCase() === upnLower)) return true;
        if (await brukerErBehandlerAsync(s, upn, cache)) return true;
    }
    return false;
}

/**
 * Hvem som fortsatt må avgi beslutning på et «alle må avgjøre»-steg.
 *
 * Kravene er stegets konkrete Personer, hver rollestreng i Roller og hvert Team.
 * En rolle er dekket når én av innehaverne har levert — ett svar per rolle, ikke
 * per person. Det er granulariteten saken har: tre klassesjefer på tre klasser
 * gir tre vurderinger, og at én klasse har to registrerte sjefer betyr ikke at
 * begge må svare. Dekker samme person to roller, dekker det ene svaret begge.
 *
 * Fram til dette telte modusen bare Personer, så et steg med roller falt stille
 * tilbake til «første behandler avgjør».
 *
 * @param {object} steg
 * @param {object} [cache] — memo fra tilgang.lagTilgangsCache()
 * @returns {Promise<{krav: object[], gjenstar: string[], alleLevert: boolean}>}
 */
async function beregnAlleKrav(steg, cache = null) {
    const leverte = [...new Set(
        (steg?.Beslutninger || [])
            .map(b => String(b.Aktor || '').toLowerCase())
            .filter(Boolean)
    )];
    const levertSett = new Set(leverte);
    const krav = [];

    for (const p of (steg?.Personer || [])) {
        const navn = String(p || '').toLowerCase();
        if (!navn || krav.some(k => k.type === 'person' && k.navn === navn)) continue;
        krav.push({ type: 'person', navn, dekket: levertSett.has(navn) });
    }

    for (const [type, liste, erMedlem] of [
        ['rolle', steg?.Roller || [], erRolleMedlem],
        ['team', steg?.Team || [], erTeamMedlem]
    ]) {
        for (const oppforing of liste) {
            const navn = String(oppforing || '');
            if (!navn || krav.some(k => k.type === type && k.navn === navn)) continue;
            let dekket = false;
            for (const aktor of leverte) {
                try {
                    if (await erMedlem(cache, navn, aktor)) { dekket = true; break; }
                } catch (_) { /* oppslagsfeil skal ikke låse steget — prøv neste */ }
            }
            krav.push({ type, navn, dekket });
        }
    }

    return {
        krav,
        gjenstar: krav.filter(k => !k.dekket).map(k => k.navn),
        alleLevert: krav.length > 0 && krav.every(k => k.dekket)
    };
}

function alleStegFerdig(skjema) {
    const behandling = skjema?.Behandling || [];
    if (behandling.length === 0) return true;
    return behandling.every(stegErFerdig);
}

/**
 * Marker steg som "Hoppet over" (Beslutning=5) hvis:
 *   - Ikke behandlet ennå
 *   - Avhengighet er oppfylt (så vilkåret kan evalueres pålitelig)
 *   - Vilkår finnes og er ikke oppfylt
 *
 * Løper fixpunkt — noen skip kan trigge nye skip via Behandling-referanser.
 * Endrer skjemaet in-place. Returnerer antall steg som ble skippet.
 */
function skipStegSomIkkeSkalKjore(skjema) {
    if (!Array.isArray(skjema?.Behandling)) return 0;
    let totalSkippet = 0;
    let endret = true;
    while (endret) {
        endret = false;
        for (const s of skjema.Behandling) {
            if (Number(s.Beslutning || 0) !== 0) continue;
            if (stegErBlokkertAvAvhengighet(s, skjema.Behandling)) continue;
            if (s.Vilkår && !evaluerVilkar(s.Vilkår, skjema.Seksjoner, skjema.Behandling)) {
                s.Beslutning = 5;
                s.BehandletAv = 'system';
                s.BehandletDato = new Date().toISOString();
                totalSkippet++;
                endret = true;
            }
        }
    }
    return totalSkippet;
}

module.exports = {
    erBehandlerPaaNoeSteg,
    skalVarsleInnsender,
    noenStegErBehandlet,
    finnBeslutningsvalg,
    erOmpussValg,
    harAvhengighet,
    beregnAktiveSteg,
    brukerErBehandler,
    brukerErBehandlerAsync,
    beregnAlleKrav,
    alleStegFerdig,
    stegErFerdig,
    stegErBlokkertAvAvhengighet,
    skipStegSomIkkeSkalKjore
};
