/**
 * Forventet behandlingstid — jobben som purrer eller avgjør.
 *
 * Ønsket 11.11.2026: et steg ingen avgjør, blir stående for alltid. Et steg
 * med `Frist` får nå én av to ting når fristen er ute:
 *
 *   purre   — behandlerne får en påminnelse på e-post/Teams, så én i uken
 *             til steget er avgjort
 *   avgjor  — steget avgjøres med valget skjemaskaperen pekte ut, gjennom den
 *             SAMME beslutningen som en behandler treffer
 *
 * Reglene (hva som er ute, når det purres igjen, hva som er et gyldig valg)
 * bor i lib/behandling.js — `fristTiltak`. Her er bare gjennomgangen og
 * bokføringen.
 *
 * ## Bare saker under behandling
 *
 * En sak i status 2. En sendt tilbake (3) ligger hos innsenderen; en ferdig
 * (5) har ingen aktive steg. Saker under behandling er aldri kryptert —
 * krypteringen skjer ved avslutning — så Behandling kan leses direkte.
 *
 * ## Skrivingen
 *
 * Purringen skriver bare `SistPurret` på steget. Saken leses PÅ NYTT rett før
 * skrivingen, og feltet settes på den ferske kopien: en behandler kan ha
 * avgjort steget mens varselet gikk, og en skriving fra den gamle kopien ville
 * da slettet beslutningen. Er steget avgjort i mellomtiden, skrives ingenting.
 * `erstattJson` brukes fordi den ikke flytter «sist endret» — en påminnelse er
 * ikke en endring i saken.
 *
 * Avgjøringen skriver ikke selv. Den går gjennom beslutningsruten, som leser
 * saken fersk og avviser et steg som alt er avgjort.
 */
const behandling = require('./behandling');

const PK = 'Meta';
const RK = 'Jobb-Behandlingsfrist';

function standardDeps() {
    return {
        skjematyper: require('./skjema-storage'),
        saker: require('./skjema-forekomst-storage'),
        varsling: require('./varsling'),
        // Settes av functions/behandlingsfrist.js — beslutningsruten bor i
        // functions/skjemaer.js, og en lib skal ikke laste en funksjonsfil.
        avgjor: null
    };
}

/**
 * Gå gjennom alle saker med frist. Kaster ikke — feil per sak samles.
 *
 * @returns {{ purret, avgjort, feil: {sak, steg, melding}[], sjekket }}
 */
async function gjennomgaa({ naa = Date.now(), deps, log = () => {} }) {
    const ut = { purret: [], avgjort: [], feil: [], sjekket: 0 };

    for (const st of await deps.skjematyper.hentAlleSkjematyper()) {
        const def = st?.JSON;
        // Fristen følger saken fra innsending, som resten av steget. Men en
        // skjematype uten frist på noe steg i dag har ingen saker å se på —
        // det sparer en gjennomgang av alle saker i alle typer hver natt.
        if (!(def?.Behandling || []).some(s => behandling.fristFor(s))) continue;

        for (const sak of await deps.saker.hentAlleSkjemaerForType(st.id, { fulltFormat: false })) {
            if (Number(sak?.Skjema_status) !== 2) continue;
            ut.sjekket++;
            for (const steg of behandling.beregnAktiveSteg(sak)) {
                const t = behandling.fristTiltak(steg, naa);
                if (!t) continue;
                const hvor = { sak: `${st.id}/${sak.Skjema_id}`, steg: steg.Steg };
                try {
                    if (t.tiltak === 'avgjor') {
                        const svar = await deps.avgjor({
                            skjematypeId: st.id, skjemaId: sak.Skjema_id, steg: steg.Steg,
                            beslutning: t.frist.valg,
                            kommentar: `Avgjort automatisk: forventet behandlingstid (${t.frist.dager} dager) gikk ut `
                                + `${t.forfall.slice(0, 10)}.`
                        });
                        if (svar?.status && svar.status !== 200) {
                            ut.feil.push({ ...hvor, melding: `beslutningen svarte ${svar.status}: ${svar.jsonBody?.melding || ''}` });
                        } else {
                            ut.avgjort.push(hvor);
                            log(`behandlingsfrist: avgjorde ${hvor.sak} steg ${hvor.steg} med valg ${t.frist.valg}`);
                        }
                        // Saken har endret seg; neste aktive steg vurderes neste natt.
                        break;
                    }

                    // Purring. Varselet trenger saken i fullt format (svarene
                    // brukes i plassholderne), lagret form er kompakt.
                    const full = await deps.saker.hentSkjema(sak.Skjema_id, st.id);
                    await deps.varsling.sendBehandlerVarsling(full || sak, def, steg, {
                        log, purring: { dager: t.frist.dager, dagerOver: t.dagerOver }
                    });
                    // Les fersk, skriv bare SistPurret — se toppen av fila.
                    const fersk = await deps.saker.hentLagretSkjema(sak.Skjema_id, st.id);
                    const ferskSteg = (fersk?.Behandling || []).find(s => Number(s.Steg) === Number(steg.Steg));
                    if (!ferskSteg || behandling.stegErFerdig(ferskSteg)) {
                        log(`behandlingsfrist: ${hvor.sak} steg ${hvor.steg} ble avgjort mens påminnelsen gikk — skriver ingenting`);
                    } else {
                        ferskSteg.SistPurret = new Date(naa).toISOString();
                        await deps.saker.erstattJson(st.id, sak.Skjema_id, fersk);
                    }
                    ut.purret.push(hvor);
                    log(`behandlingsfrist: purret ${hvor.sak} steg ${hvor.steg} (${t.dagerOver} dager over)`);
                } catch (e) {
                    ut.feil.push({ ...hvor, melding: String(e.message || e) });
                    log(`behandlingsfrist: ${hvor.sak} steg ${hvor.steg} feilet — ${e.message}`);
                }
            }
        }
    }
    return ut;
}

/**
 * Kjør gjennomgangen og bokfør utfallet. Kaster aldri.
 *
 * `utfall`: `ok` (alt gikk, også når ingenting var forfalt), `delvis` (noen
 * saker feilet), `feil` (gjennomgangen kom ikke i gang).
 */
async function kjorBehandlingsfrist({ kilde, log = () => {}, naa = Date.now(), deps = {} } = {}) {
    const { tabellKlient } = require('./storage');
    const hendelser = require('./hendelser-storage');
    const d = { ...standardDeps(), ...deps };

    const startTid = new Date().toISOString();
    const settStatus = async (felter) => {
        try {
            const t = tabellKlient('CacheMetadata');
            await t.upsertEntity({ partitionKey: PK, rowKey: RK, ...felter }, 'Merge');
        } catch (_) { /* statusraden er ikke kritisk */ }
    };

    await settStatus({ Status: 'kjører', Startet: startTid, Kilde: kilde, SistFeil: '' });
    log(`behandlingsfrist: trigget av ${kilde}`);

    let res;
    try {
        if (typeof d.avgjor !== 'function') throw new Error('Beslutningen er ikke koblet til jobben (deps.avgjor)');
        res = await gjennomgaa({ naa, deps: d, log });
    } catch (e) {
        const melding = String(e.message || e);
        log(`behandlingsfrist FEIL: ${melding}`);
        await settStatus({ Status: 'feil', Ferdig: new Date().toISOString(), SistFeil: melding.slice(0, 500) });
        hendelser.logg({
            Type: 'behandling.frist', Aktor: kilde, ObjektType: 'jobb', ObjektId: RK,
            Melding: `Fristjobben kom ikke i gang: ${melding}`.slice(0, 500)
        });
        return { utfall: 'feil', melding, resultat: null };
    }

    const utfall = res.feil.length === 0 ? 'ok' : 'delvis';
    await settStatus({
        Status: utfall,
        Ferdig: new Date().toISOString(),
        SistOppdatert: new Date().toISOString(),
        AntallSjekket: res.sjekket,
        AntallPurret: res.purret.length,
        AntallAvgjort: res.avgjort.length,
        AntallFeilet: res.feil.length,
        SistFeil: res.feil.map(f => `${f.sak} steg ${f.steg}: ${f.melding}`).join(' | ').slice(0, 500)
    });
    hendelser.logg({
        Type: 'behandling.frist', Aktor: kilde, ObjektType: 'jobb', ObjektId: RK,
        Melding: `Fristjobben: ${res.purret.length} purret, ${res.avgjort.length} avgjort`
            + (res.feil.length ? `, ${res.feil.length} feilet` : '') + ` (${res.sjekket} saker sjekket)`,
        Detaljer: { purret: res.purret, avgjort: res.avgjort, feil: res.feil }
    });
    return { utfall, melding: null, resultat: res };
}

module.exports = { kjorBehandlingsfrist, gjennomgaa, PK, RK };
