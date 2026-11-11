/**
 * Forventet behandlingstid (`Frist` på et steg) — reglene, jobben og
 * systembeslutningen.
 *
 * Ønsket 11.11.2026. Besluttet: «avgjør» velger et beslutningsvalg (ikke lukk
 * saken), purring hver uke, kalenderdager. Testene passer på:
 *
 *   - at klokka starter når steget blir AKTIVT, ikke ved innsending, og
 *     starter på nytt etter ompuss
 *   - at purringen kommer ukentlig, ikke hver natt
 *   - at «avgjør» med et ugyldig eller ompuss-valg purrer i stedet
 *   - at jobben skriver SistPurret på en FERSK kopi, og ikke over en
 *     beslutning som kom mens varselet gikk
 *   - at systemet bare kan avgjøre med stegets eget fristvalg, også i
 *     alle-modus, og at merket ikke kan komme over HTTP
 *   - at purringen er e-post/Teams, ikke en ny Planner-oppgave
 *
 * Kjøres med:  node api/test/behandlingsfrist.test.js
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const behandling = require('../src/lib/behandling');
const { fristFor, stempleAktiveSteg, fristTiltak, PURRE_INTERVALL_DAGER, SYSTEMBESLUTNING } = behandling;

const DAG = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-11-01T08:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const VALG = [{ Nummer: 1, Tekst: 'Jeg klager' }, { Nummer: 2, Tekst: 'Jeg klager ikke' }, { Nummer: 3, Tekst: 'Fiks', Handling: 'ompuss' }];
const steg = (ekstra = {}) => ({ Steg: 2, Personer: ['kari@jccodevel.onmicrosoft.com'], Roller: [], Team: [], Beslutning: 0, Beslutningsvalg: VALG, ...ekstra });

(async () => {
    // ---------- 1. fristFor ----------
    sjekk('uten frist', fristFor(steg()), null);
    for (const d of [0, -1, 'x', 1.5, null]) sjekk(`Dager=${JSON.stringify(d)} er ingen frist`, fristFor(steg({ Frist: { Dager: d } })), null);
    sjekk('purre er standard', fristFor(steg({ Frist: { Dager: 21 } })), { dager: 21, vedUtlop: 'purre', valg: null });
    sjekk('avgjør med valg', fristFor(steg({ Frist: { Dager: 21, VedUtlop: 'avgjor', Valg: 2 } })), { dager: 21, vedUtlop: 'avgjor', valg: 2 });

    // ---------- 2. stempling ----------
    {
        const sak = { Skjema_status: 2, Behandling: [
            { Steg: 1, Beslutning: 0, Personer: ['a@b.no'] },
            { Steg: 2, Beslutning: 0, Personer: ['c@d.no'], AvhengigAv: 1 }] };
        sjekk('ett steg stemplet', stempleAktiveSteg(sak, iso(T0)), 1);
        sjekk('det aktive', sak.Behandling[0].AktivFra, iso(T0));
        sjekk('ikke det som venter', sak.Behandling[1].AktivFra, undefined);
        stempleAktiveSteg(sak, iso(T0 + DAG));
        sjekk('klokka starter én gang', sak.Behandling[0].AktivFra, iso(T0));
        sak.Behandling[0].Beslutning = 1;
        stempleAktiveSteg(sak, iso(T0 + 2 * DAG));
        sjekk('neste steg får sitt tidspunkt når det blir aktivt', sak.Behandling[1].AktivFra, iso(T0 + 2 * DAG));
        const tilbake = { Skjema_status: 3, Behandling: [{ Steg: 1, Beslutning: 0, Personer: ['a@b.no'] }] };
        sjekk('sendt tilbake: ingen stempling', stempleAktiveSteg(tilbake, iso(T0)), 0);
    }

    // ---------- 3. fristTiltak ----------
    {
        const s = (ekstra) => steg({ AktivFra: iso(T0), Frist: { Dager: 21 }, ...ekstra });
        sjekk('før fristen: ingenting', fristTiltak(s(), T0 + 20 * DAG), null);
        const ute = fristTiltak(s(), T0 + 21 * DAG);
        sjekk('ved fristen: purre', ute && [ute.tiltak, ute.dagerOver, ute.forfall], ['purre', 0, iso(T0 + 21 * DAG)]);
        sjekk('purret for 3 dager siden: ingenting', fristTiltak(s({ SistPurret: iso(T0 + 22 * DAG) }), T0 + 25 * DAG), null);
        sjekk(`purret for ${PURRE_INTERVALL_DAGER} dager siden: purre igjen`,
            fristTiltak(s({ SistPurret: iso(T0 + 22 * DAG) }), T0 + (22 + PURRE_INTERVALL_DAGER) * DAG)?.tiltak, 'purre');
        sjekk('avgjør med gyldig valg', fristTiltak(s({ Frist: { Dager: 21, VedUtlop: 'avgjor', Valg: 2 } }), T0 + 21 * DAG)?.tiltak, 'avgjor');
        sjekk('avgjør med ompuss-valg: purrer i stedet', fristTiltak(s({ Frist: { Dager: 21, VedUtlop: 'avgjor', Valg: 3 } }), T0 + 21 * DAG)?.tiltak, 'purre');
        sjekk('avgjør med ukjent valg: purrer i stedet', fristTiltak(s({ Frist: { Dager: 21, VedUtlop: 'avgjor', Valg: 9 } }), T0 + 21 * DAG)?.tiltak, 'purre');
        sjekk('avgjort steg: ingenting', fristTiltak(s({ Beslutning: 1 }), T0 + 30 * DAG), null);
        sjekk('uten AktivFra (eldre sak): ingenting', fristTiltak(steg({ Frist: { Dager: 1 } }), T0 + 30 * DAG), null);
    }

    // ---------- 4. jobben, med stubbet lagring ----------
    {
        const { gjennomgaa } = require('../src/lib/behandlingsfrist-jobb');
        const NAA = T0 + 30 * DAG;
        const sakMed = (id, ekstra, status = 2) => ({ Skjema_id: id, Skjematype_id: '70', Skjema_status: status,
            Behandling: [steg({ AktivFra: iso(T0), ...ekstra })] });
        const lager = {
            '70/1': sakMed('1', { Frist: { Dager: 21 } }),                                   // purres
            '70/2': sakMed('2', { Frist: { Dager: 21, VedUtlop: 'avgjor', Valg: 2 } }),      // avgjøres
            '70/3': sakMed('3', { Frist: { Dager: 21 } }, 3),                                // sendt tilbake
            '70/4': sakMed('4', { Frist: { Dager: 21 } })                                    // avgjøres mens varselet går
        };
        const lest = [], skrevet = [], varslet = [], avgjort = [];
        const deps = {
            skjematyper: { hentAlleSkjematyper: async () => [
                { id: '70', JSON: { Behandling: [{ Steg: 2, Frist: { Dager: 21 } }] } },
                { id: '71', JSON: { Behandling: [{ Steg: 1 }] } }] },
            saker: {
                hentAlleSkjemaerForType: async (id) => { lest.push(id); return Object.entries(lager).filter(([k]) => k.startsWith(id + '/')).map(([, v]) => JSON.parse(JSON.stringify(v))); },
                hentSkjema: async (sid, tid) => JSON.parse(JSON.stringify(lager[`${tid}/${sid}`])),
                hentLagretSkjema: async (sid, tid) => {
                    const kopi = JSON.parse(JSON.stringify(lager[`${tid}/${sid}`]));
                    if (sid === '4') kopi.Behandling[0].Beslutning = 1;   // en behandler rakk det
                    return kopi;
                },
                erstattJson: async (tid, sid, data) => skrevet.push([`${tid}/${sid}`, data.Behandling[0].SistPurret])
            },
            varsling: { sendBehandlerVarsling: async (sak, def, s, opts) => varslet.push([sak.Skjema_id, opts.purring]) },
            avgjor: async (a) => { avgjort.push(a); return { status: 200 }; }
        };
        const res = await gjennomgaa({ naa: NAA, deps });
        sjekk('typen uten frist leses ikke', lest.filter((v, i, a) => a.indexOf(v) === i), ['70']);
        sjekk('sendt tilbake hoppes over', res.sjekket, 3);
        sjekk('purret 1 og 4', varslet.map(v => v[0]).sort(), ['1', '4']);
        sjekk('purringen bærer fristen', varslet[0][1], { dager: 21, dagerOver: 9 });
        sjekk('SistPurret skrevet på 1', skrevet, [['70/1', iso(NAA)]]);
        sjekk('ikke over beslutningen på 4', skrevet.some(s => s[0] === '70/4'), false);
        sjekk('2 avgjort med fristvalget', avgjort.map(a => [a.skjemaId, a.steg, a.beslutning]), [['2', 2, 2]]);
        sjekk('med en kommentar som sier hvorfor', /forventet behandlingstid \(21 dager\)/.test(avgjort[0]?.kommentar), true);
        sjekk('ingen feil', res.feil, []);
    }

    // ---------- 5. systembeslutningen i den ekte beslutningsruten ----------
    {
        const ekteLoad = Module._load;
        Module._load = function (f, ...r) {
            if (f === '@azure/functions') return { app: { http() {}, timer() {} } };
            return ekteLoad.call(this, f, ...r);
        };
        let ruten;
        try { ({ lagreBeslutning: ruten } = require('../src/functions/skjemaer')); }
        finally { Module._load = ekteLoad; }

        const forekomst = require('../src/lib/skjema-forekomst-storage');
        const skjemaStorage = require('../src/lib/skjema-storage');
        const hendelser = require('../src/lib/hendelser-storage');
        const varsling = require('../src/lib/varsling');
        let lagret = null;
        const hendelseTyper = [];
        const lagSak = (alle = false) => ({
            Skjema_id: '9', Skjematype_id: '70', Skjema_status: 2, Innsender_Epost: 'kari@jccodevel.onmicrosoft.com',
            Behandling: [
                steg({ Steg: 1, AvhengigAv: undefined, AktivFra: iso(T0), Frist: { Dager: 21, VedUtlop: 'avgjor', Valg: 2 },
                    Beslutning_alle: alle, Personer: ['a@x.no', 'b@x.no'] }),
                steg({ Steg: 2, AvhengigAv: 1, Personer: ['c@x.no'] })
            ]
        });
        let sak = lagSak();
        forekomst.hentSkjema = async () => JSON.parse(JSON.stringify(sak));
        forekomst.lagreSkjema = async (s) => { lagret = s; };
        skjemaStorage.hentSkjematype = async () => ({ JSON: { Behandling: [] } });
        hendelser.logg = async (h) => { hendelseTyper.push(h.Type); };
        for (const f of ['sendBeslutningVarsling', 'sendVarslingAktiveSteg', 'sendFerdigVarsling']) varsling[f] = async () => ({ status: 'ok' });
        varsling.loggVarslingsutfall = async () => [];

        const kall = (body, system = true) => ruten({
            ...(system ? { [SYSTEMBESLUTNING]: true } : {}),
            params: { skjematypeId: '70', skjemaId: '9' },
            headers: { get: () => null },
            json: async () => body
        }, { log: () => {} });

        const svar = await kall({ steg: 1, beslutning: 2, kommentar: 'frist' });
        sjekk('systemet avgjør med fristvalget', svar.status ?? 200, 200);
        sjekk('beslutningen står', lagret?.Behandling[0].Beslutning, 2);
        sjekk('avgjort av «system»', lagret?.Behandling[0].BehandletAv, 'system');
        sjekk('neste steg fikk sitt tidspunkt', typeof lagret?.Behandling[1].AktivFra, 'string');
        sjekk('egen hendelsestype', hendelseTyper.includes('skjema.beslutning.frist'), true);

        lagret = null; sak = lagSak();
        sjekk('et annet valg avvises', (await kall({ steg: 1, beslutning: 1 })).status, 403);
        sjekk('og ingenting lagres', lagret, null);

        sak = lagSak(); sak.Behandling[0].Frist = { Dager: 21 };
        sjekk('steg uten avgjør-frist avvises', (await kall({ steg: 1, beslutning: 2 })).status, 403);

        lagret = null; sak = lagSak(true);
        await kall({ steg: 1, beslutning: 2 });
        sjekk('alle-modus: fristen avgjør steget', lagret?.Behandling[0].Beslutning, 2);

        sak = lagSak();
        sjekk('uten merket: ikke innlogget', (await kall({ steg: 1, beslutning: 2 }, false)).status, 401);
        sjekk('merket er et Symbol', typeof SYSTEMBESLUTNING, 'symbol');

        // Ompuss nullstiller klokka. Kalt av en innlogget behandler.
        sak = lagSak(); sak.Behandling[0].SistPurret = iso(T0 + 22 * DAG);
        const principal = Buffer.from(JSON.stringify({ userDetails: 'a@x.no', userRoles: ['authenticated'] })).toString('base64');
        await ruten({ params: { skjematypeId: '70', skjemaId: '9' },
            headers: { get: (n) => (n.toLowerCase() === 'x-ms-client-principal' ? principal : null) },
            json: async () => ({ steg: 1, beslutning: 3 }) }, { log: () => {} });
        sjekk('ompuss: saken er sendt tilbake', lagret?.Skjema_status, 3);
        sjekk('ompuss: klokka er nullstilt', [lagret?.Behandling[0].AktivFra, lagret?.Behandling[0].SistPurret], [undefined, undefined]);
    }

    // ---------- 6. purringen er e-post/Teams, ikke Planner ----------
    {
        const varsling = require('../src/lib/varsling');
        delete require.cache[require.resolve('../src/lib/varsling')];
        const ekte = require('../src/lib/varsling');
        const rollerStorage = require('../src/lib/roller-storage');
        rollerStorage.hentInnehavere = async () => [];
        const forrige = { fetch: global.fetch, url: process.env.VARSLING_FLOW_URL, swa: process.env.SWA_URL };
        process.env.VARSLING_FLOW_URL = 'https://eksempel.invalid/flyt';
        process.env.SWA_URL = 'https://www.fskjema.no';
        delete process.env.VARSLING_DEAKTIVERT;
        let payload = null;
        global.fetch = async (_u, o) => { payload = JSON.parse(o.body); return { ok: true, status: 200, json: async () => ({}), text: async () => '' }; };
        const s = steg({ Steg: 2, Stegnavn: 'Klage?', Varsling: ['epost', 'planner'], PlannerOppgave: { Tittel: 'X' } });
        await ekte.sendBehandlerVarsling({ Skjema_id: '1', Skjematype_id: '70', Seksjoner: [] }, { Skjema_navn: 'Søknad' }, s,
            { purring: { dager: 21, dagerOver: 2 } });
        global.fetch = forrige.fetch;
        sjekk('purringen gikk', !!payload, true);
        sjekk('bare e-post', payload?.varslinger, ['epost']);
        sjekk('ingen ny Planner-oppgave', payload?.planner, null);
        sjekk('emnet sier påminnelse', /^Påminnelse: /.test(payload?.epost_og_teams?.emne || ''), true);
        sjekk('teksten sier hvor lenge', /\(21 dager\) gikk ut for 2 dager siden/.test(payload?.epost_og_teams?.html || ''), true);
        void varsling;
    }

    // ---------- 7. editoren ----------
    {
        const ed = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'editor.html'), 'utf8');
        sjekk('feltene finnes', ['setStegFristDager', 'setStegFristVedUtlop', 'setStegFristValg'].every(f => ed.includes(`window.${f} =`)), true);
        sjekk('«avgjør» tilbyr ikke ompuss', /\.filter\(v => v\.Handling !== 'ompuss'\)/.test(ed), true);
        // fristHtml er godkjent som helhet i scripts/html-injeksjon.js, og
        // skanneren ser derfor ikke inn i den. Escapingen av valgteksten er
        // det godkjenningen hviler på — prøvd her, ellers prøves den ikke.
        const fristKilde = ed.slice(ed.indexOf('function fristHtml('), ed.indexOf('window.setStegFristDager'));
        sjekk('valgteksten escapes', /escapeHtml\(v\.Tekst/.test(fristKilde), true);
        sjekk('valgnummeret escapes', (fristKilde.match(/escapeHtml\(String\(v\.Nummer\)\)/g) || []).length, 2);
        sjekk('tomt antall dager fjerner fristen', /if \(!Number\.isInteger\(n\) \|\| n < 1\) delete steg\.Frist;/.test(ed), true);
    }

    // ---------- 8. innsendingen stempler — etter skip-logikken ----------
    //
    // lagreSkjema er for stor til å kjøres her; rekkefølgen leses av kilden.
    // Et steg som hoppes over skal ikke få en frist, og stemplingen må skje
    // FØR krypteringen ved status 5 — men en ferdig sak har uansett ingen
    // aktive steg.
    {
        const kilde = fs.readFileSync(path.join(__dirname, '..', 'src', 'functions', 'skjemaer.js'), 'utf8');
        const lagre = kilde.slice(kilde.indexOf("app.http('lagreSkjema'"));
        const iSkip = lagre.indexOf('skipStegSomIkkeSkalKjore(skjemaData)');
        const iStempel = lagre.indexOf('stempleAktiveSteg(skjemaData)');
        const iKrypter = lagre.indexOf('kryptering.krypterSkjema(skjemaData');
        sjekk('innsendingen stempler', iStempel > 0, true);
        sjekk('etter skip-logikken', iStempel > iSkip, true);
        sjekk('før krypteringen', iStempel < iKrypter, true);
    }

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
})().catch(e => { console.log('FEIL  testen kastet:', e.message, e.stack); process.exit(1); });
