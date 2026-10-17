/**
 * Bokføringen i bakgrunnsjobbene — statusraden, hendelsen og «kaster aldri».
 *
 * Hver jobb har to inngangsporter: HTTP (GitHub Actions-cron i pilot og prod,
 * admin-knappen overalt) og en timer i dev. Bokføringen bor i jobbmodulen
 * nettopp for at de to skal gi admin-panelet SAMME bilde av samme kjøring.
 * Her prøves den modulen direkte, med stubbet lagring.
 *
 * Fire ting holdes fast for hver jobb, og alle fire er lært:
 *
 *   **Jobben kaster aldri.** Timeren VENTER på den. Kaster den, blir det en
 *   uhåndtert feil i hosten i stedet for en statusrad som sier hva som gikk
 *   galt — og «det gikk galt» blir umulig å skille fra «koden er ikke
 *   deployet».
 *
 *   **Statusraden går fra «kjører» til et endelig svar.** Mangler det siste
 *   skrivet, står raden på «kjører» for alltid, og panelet viser en jobb som
 *   later til å henge.
 *
 *   **Årsaken står i raden, ikke bare i returverdien.** Det er raden
 *   admin-panelet leser.
 *
 *   **`Kilde` følger med.** Den er det ENESTE som skiller en timer-kjøring
 *   fra et knappetrykk, og den er beviset på at timeren faktisk kjørte.
 *
 * Lå til 17.10.2026 som seksjon 5 i `timer-trigger.test.js`. Flyttet hit da
 * jobb nummer to og tre kom: den fila handler om REGISTRERINGEN, denne om
 * bokføringen.
 *
 * Kjøres med:  node api/test/jobb-bokforing.test.js
 */
const Module = require('module');
const { utenKommentarer } = require('../../scripts/test-kilde.js');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

/**
 * Last en jobbmodul med stubber, og hold dem installert mens jobben kjører.
 *
 * Lagringen lastes LAT inne i jobbene. Rives stubben etter `require`, treffer
 * kjøringen den ekte storage.js — og alt blir «ikke-kritisk» svelget, slik at
 * testen måler ingenting.
 */
async function medStubber(modulSti, stubber, bruk) {
    const sti = require.resolve(modulSti);
    const ekte = Module._load;
    Module._load = function (forespurt, ...r) {
        if (Object.prototype.hasOwnProperty.call(stubber, forespurt)) return stubber[forespurt];
        return ekte.call(this, forespurt, ...r);
    };
    delete require.cache[sti];
    try {
        return await bruk(require(sti));
    } finally {
        Module._load = ekte;
        delete require.cache[sti];
    }
}

/** Fanger det som skrives til CacheMetadata og til hendelsesloggen. */
function fangst() {
    const skrevet = [];
    const hendelser = [];
    return {
        skrevet,
        hendelser,
        stubber: {
            './storage': { tabellKlient: () => ({
                createTable: async () => {},
                upsertEntity: async (e) => { skrevet.push(e); }
            }) },
            './hendelser-storage': { logg: (h) => { hendelser.push(h); return Promise.resolve(); } }
        }
    };
}

// ==================== postnumre ====================
async function postnumreSjekk() {
    const kjor = async (bringSvar) => {
        const f = fangst();
        const res = await medStubber('../src/lib/postnummer-jobb.js',
            { ...f.stubber, './bring-postnummer': { oppdaterFraBring: bringSvar } },
            (m) => m.kjorBringOppdatering({ kilde: 'timer' }));
        return { res, ...f };
    };

    const godt = await kjor(async () => ({ antallSkrevet: 5, antallSlettet: 0, varighetSekunder: 1 }));
    sjekk('postnumre: vellykket kjøring gir ok', godt.res.status, 'ok');
    sjekk('postnumre: og tallene følger med', godt.res.antallSkrevet, 5);
    sjekk('postnumre: statusraden går fra kjører til ok',
        godt.skrevet.map(e => e.Status), ['kjører', 'ok']);
    sjekk('postnumre: kilden bokføres', godt.skrevet[0]?.Kilde, 'timer');
    sjekk('postnumre: hendelsen bærer kilden', godt.hendelser[0]?.Aktor, 'timer');

    let kastet = null, vondt = null;
    try {
        vondt = await kjor(async () => { throw new Error('Bring svarte ikke'); });
    } catch (e) { kastet = e.message; }
    sjekk('postnumre: en feilet kjøring kaster ikke', kastet, null);
    sjekk('postnumre: den returnerer status feil', vondt?.res?.status, 'feil');
    sjekk('postnumre: med årsaken i seg', /Bring svarte ikke/.test(vondt?.res?.melding || ''), true);
    sjekk('postnumre: statusraden ender på feil', vondt?.skrevet.map(e => e.Status), ['kjører', 'feil']);
    sjekk('postnumre: og bærer feilteksten',
        /Bring svarte ikke/.test(vondt?.skrevet.at(-1)?.SistFeil || ''), true);
}

// ==================== refresh-fs ====================
async function fsSjekk() {
    const kjor = async (fsSvar) => {
        const f = fangst();
        const res = await medStubber('../src/lib/refresh-fs-jobb.js',
            { ...f.stubber, './refresh-fs': { refreshFS: fsSvar } },
            (m) => m.kjorRefreshFs({ kilde: 'timer' }));
        return { res, ...f };
    };

    const godt = await kjor(async () => ({ varighetSekunder: 127, terminer: ['2026-HØST'] }));
    sjekk('fs: vellykket kjøring gir ok', godt.res.status, 'ok');
    sjekk('fs: statusraden går fra kjører til ok',
        godt.skrevet.map(e => e.Status), ['kjører', 'ok']);
    sjekk('fs: kilden bokføres', godt.skrevet[0]?.Kilde, 'timer');
    // Varigheten er det som avgjør om jobben nærmer seg funksjonsgrensen.
    // Forsvinner den fra raden, forsvinner også varselet.
    sjekk('fs: varigheten havner i raden', godt.skrevet.at(-1)?.VarighetSekunder, 127);
    sjekk('fs: terminene også', godt.skrevet.at(-1)?.Terminer, '2026-HØST');
    sjekk('fs: hendelsen bærer kilden', godt.hendelser[0]?.Aktor, 'timer');
    sjekk('fs: og er en oppdatert-hendelse', godt.hendelser[0]?.Type, 'refresh-fs.oppdatert');

    let kastet = null, vondt = null;
    try {
        vondt = await kjor(async () => { throw new Error('FS svarte 500'); });
    } catch (e) { kastet = e.message; }
    sjekk('fs: en feilet kjøring kaster ikke', kastet, null);
    sjekk('fs: den returnerer status feil', vondt?.res?.status, 'feil');
    sjekk('fs: statusraden ender på feil', vondt?.skrevet.map(e => e.Status), ['kjører', 'feil']);
    sjekk('fs: og bærer feilteksten', /FS svarte 500/.test(vondt?.skrevet.at(-1)?.SistFeil || ''), true);
    sjekk('fs: feilhendelsen logges', vondt?.hendelser[0]?.Type, 'refresh-fs.feil');
}

// ==================== oppslagslister ====================
//
// Her kjøres byggAlle for ekte — den ligger i SAMME modul som bokføringen og
// kan ikke stubbes bort. Lagene under den er stubbet i stedet, slik at
// utfallene «ok», «delvis», «feil» og «kastet» kan fremkalles hver for seg.
// Det er de fire tilstandene som skiller en grønn jobb fra en som ga et tomt
// nedtrekk, og de skal ikke se like ut i panelet.
async function oppslagSjekk() {
    const byggbar = (navn) => ({ Navn: navn, Skjematype_id: 'st-1' });
    const ubyggbar = (navn) => ({ Navn: navn });   // mangler skjematype → byggEn kaster

    const kjor = async (oppsett, { hentKaster = false } = {}) => {
        const f = fangst();
        const perListe = [];
        const stubber = {
            ...f.stubber,
            './oppslagsliste-storage': {
                hentOppsett: async () => {
                    if (hentKaster) throw new Error('Oppsettet kunne ikke leses');
                    return oppsett;
                },
                erstattListe: async () => ({ antallSkrevet: 1, antallSlettet: 0 }),
                settStatus: async (navn, felter) => { perListe.push({ navn, ...felter }); }
            },
            './skjema-storage': { hentSkjematype: async () => ({ JSON: {}, navn: 'Kilde' }) },
            './skjema-forekomst-storage': { hentAlleSkjemaerForType: async () => [] },
            './kryptering': { dekrypterAlle: async () => [] },
            './nokkel-storage': {},
            './oppslagsliste': { byggListe: () => ({ rader: [{ Tekst: 'a' }], hoppet: [], felter: [] }) }
        };
        const res = await medStubber('../src/lib/oppslagsliste-jobb.js', stubber,
            (m) => m.kjorOppslagslister({ kilde: 'timer' }));
        return { res, perListe, ...f };
    };

    const alt = await kjor([byggbar('A'), byggbar('B')]);
    sjekk('oppslag: alt gikk gir ok', alt.res.utfall, 'ok');
    sjekk('oppslag: statusraden går fra kjører til ok',
        alt.skrevet.map(e => e.Status), ['kjører', 'ok']);
    sjekk('oppslag: kilden bokføres', alt.skrevet[0]?.Kilde, 'timer');
    sjekk('oppslag: antallet lister står i raden', alt.skrevet.at(-1)?.AntallLister, 2);
    sjekk('oppslag: og ingen feilet', alt.skrevet.at(-1)?.AntallFeilet, 0);
    sjekk('oppslag: hendelsen bærer kilden', alt.hendelser[0]?.Aktor, 'timer');
    // Jobbraden må IKKE havne blant de per-liste radene: de leses på prefiks,
    // og en jobbrad der ville dukket opp som en liste ingen har definert.
    sjekk('oppslag: jobbraden er ikke en liste-rad',
        alt.skrevet.every(e => !String(e.rowKey).startsWith('Oppslagsliste-')), true);
    sjekk('oppslag: og per-liste radene skrives fortsatt',
        alt.perListe.map(p => p.navn), ['A', 'B']);

    const delvis = await kjor([byggbar('A'), ubyggbar('B')]);
    sjekk('oppslag: én av to feilet gir delvis', delvis.res.utfall, 'delvis');
    sjekk('oppslag: statusraden sier delvis', delvis.skrevet.at(-1)?.Status, 'delvis');
    sjekk('oppslag: og teller den som feilet', delvis.skrevet.at(-1)?.AntallFeilet, 1);
    sjekk('oppslag: feilteksten navngir lista',
        /B:/.test(delvis.skrevet.at(-1)?.SistFeil || ''), true);

    const ingen = await kjor([ubyggbar('A')]);
    sjekk('oppslag: ingen bygget gir feil', ingen.res.utfall, 'feil');
    sjekk('oppslag: og det står i raden', ingen.skrevet.at(-1)?.Status, 'feil');

    let kastet = null, aldri = null;
    try { aldri = await kjor([], { hentKaster: true }); } catch (e) { kastet = e.message; }
    sjekk('oppslag: en jobb som ikke kom i gang kaster ikke', kastet, null);
    sjekk('oppslag: den melder kastet', aldri?.res?.kastet, true);
    sjekk('oppslag: med årsaken', /kunne ikke leses/.test(aldri?.res?.melding || ''), true);
    sjekk('oppslag: statusraden ender likevel på feil',
        aldri?.skrevet.map(e => e.Status), ['kjører', 'feil']);
    sjekk('oppslag: og en feilhendelse logges', aldri?.hendelser[0]?.Type, 'oppslagsliste.feil');

    // Tørrkjøring skal ALDRI komme hit: forhåndsvisningen går rett på
    // byggAlle. Går den gjennom bokføringen, påstår statusraden at data ble
    // skrevet av en kjøring som ikke skrev noe.
    const fnKilde = require('fs').readFileSync(
        require('path').join(__dirname, '..', 'src', 'functions', 'oppslagsliste.js'), 'utf8');
    sjekk('oppslag: tørrkjøringen går utenom bokføringen',
        /if \(tørr\) \{[\s\S]*?byggAlle\(/.test(fnKilde), true);
}

// ==================== nøkkelkalender (SENDER E-POST) ====================
//
// Den viktigste regelen her er NEGATIV: ingenting merkes av som varslet når
// varselet ikke gikk ut. Merkes de likevel, er hemmeligheten varslet i
// bokføringen og taus i virkeligheten — og neste kjøring prøver ikke igjen.
async function nokkelSjekk() {
    const kjor = async ({ rader = [], epostSvar = { status: 'ok' }, admins = 'a@b.no', torrkjor = false } = {}) => {
        const f = fangst();
        const varslet = [];
        const foer = process.env.ADMIN_UPNS;
        if (admins === null) delete process.env.ADMIN_UPNS; else process.env.ADMIN_UPNS = admins;
        const sendt = [];
        const stubber = {
            ...f.stubber,
            './nokkelkalender-storage': {
                miljo: () => 'dev',
                listAlle: async () => rader.map(r => ({ ...r })),
                // Varsles alt som har et trinn satt i prøvedataene.
                skalVarsles: (rad) => (rad.Trinn === undefined ? null : rad.Trinn),
                markerVarslet: async (id, trinn) => { varslet.push([id, trinn]); }
            },
            './flyt-kaller': { sendEpostViaFlyt: async (args) => { sendt.push(args); return epostSvar; } },
            './pb-token-storage': { listPbEierTokens: async () => [], markerVarslet: async () => {} },
            './pb-kalender': { erPbRad: () => false, somKalenderRader: () => [] },
            './skjema-storage': { hentSkjematype: async () => null }
        };
        try {
            const res = await medStubber('../src/lib/nokkelkalender-jobb.js', stubber,
                (m) => m.kjorNokkelsjekk({ kilde: 'timer', torrkjor }));
            return { res, varslet, sendt, ...f };
        } finally {
            if (foer === undefined) delete process.env.ADMIN_UPNS; else process.env.ADMIN_UPNS = foer;
        }
    };

    const forfalt = [{ Id: 'kv-1', Navn: 'Sertifikat', Trinn: 7, DagerIgjen: 7 }];

    const tomt = await kjor({ rader: [{ Id: 'kv-1', Navn: 'Sertifikat' }] });
    sjekk('nøkler: ingenting å varsle gir eget utfall', tomt.res.utfall, 'ingenting');
    sjekk('nøkler: og ingen e-post', tomt.sendt.length, 0);
    sjekk('nøkler: statusraden går fra kjører til ok', tomt.skrevet.map(e => e.Status), ['kjører', 'ok']);
    sjekk('nøkler: og utfallet står i raden', tomt.skrevet.at(-1)?.Utfall, 'ingenting');

    const godt = await kjor({ rader: forfalt });
    sjekk('nøkler: varsel sendt gir ok', godt.res.utfall, 'ok');
    sjekk('nøkler: én e-post', godt.sendt.length, 1);
    sjekk('nøkler: og raden er merket av', godt.varslet, [['kv-1', 7]]);
    sjekk('nøkler: kilden bokføres', godt.skrevet[0]?.Kilde, 'timer');
    sjekk('nøkler: hendelsen bærer kilden', godt.hendelser[0]?.Aktor, 'timer');

    // DEN NEGATIVE REGELEN.
    const dottFlyt = await kjor({ rader: forfalt, epostSvar: { status: 'feil', melding: 'flyt nede' } });
    sjekk('nøkler: flyten feilet gir eget utfall', dottFlyt.res.utfall, 'varsling-feilet');
    sjekk('nøkler: INGENTING merkes av da', dottFlyt.varslet, []);
    sjekk('nøkler: statusraden ender på feil', dottFlyt.skrevet.at(-1)?.Status, 'feil');
    sjekk('nøkler: og bærer årsaken', /flyt nede/.test(dottFlyt.skrevet.at(-1)?.SistFeil || ''), true);

    const ingenAdmin = await kjor({ rader: forfalt, admins: null });
    sjekk('nøkler: uten mottakere er det en konfigurasjonsfeil', ingenAdmin.res.utfall, 'mangler-mottakere');
    sjekk('nøkler: og ingenting merkes av', ingenAdmin.varslet, []);
    sjekk('nøkler: og ingen e-post ble forsøkt', ingenAdmin.sendt.length, 0);

    // Tørrkjøring skal ikke etterlate seg et eneste spor i statusraden.
    const torr = await kjor({ rader: forfalt, torrkjor: true });
    sjekk('nøkler: tørrkjøring gir eget utfall', torr.res.utfall, 'tørrkjørt');
    sjekk('nøkler: og skriver INGEN statusrad', torr.skrevet.length, 0);
    sjekk('nøkler: og sender ingenting', torr.sendt.length, 0);
    sjekk('nøkler: men viser hva som ville blitt sendt', torr.res.villeVarslet?.length, 1);

    let kastet = null, vondt = null;
    try {
        vondt = await kjor({ rader: null });   // listAlle kaster på null.map
    } catch (e) { kastet = e.message; }
    sjekk('nøkler: en kjøring som kaster, kaster ikke videre', kastet, null);
    sjekk('nøkler: den melder feil', vondt?.res?.utfall, 'feil');
}

// ==================== team-synk (DESTRUKTIV FLYT) ====================
async function teamSjekk() {
    const kjor = async ({ grupper = [], flytSvar = async () => ({ status: 'ok' }), hentKaster = false } = {}) => {
        const f = fangst();
        const resultater = [];
        const stubber = {
            ...f.stubber,
            './rollegruppe-storage': {
                hentAlle: async () => {
                    if (hentKaster) throw new Error('Tabellen svarte ikke');
                    return grupper;
                },
                settResultat: async (rolle, omfang, felter) => { resultater.push({ rolle, ...felter }); }
            },
            './roller-storage': { hentInnehavere: async () => [{ Upn: 'a@b.no' }] },
            './team-synk': {
                harTeam: (g) => !!g.Team,
                upnListe: (rader) => rader.map(r => r.Upn),
                vurderSynk: ({ antallNaa }) => (antallNaa > 0
                    ? { ok: true, grunn: '' }
                    : { ok: false, grunn: 'tom-liste', melding: 'Ingen medlemmer' }),
                byggPayload: ({ upner }) => ({ Antall: upner.length, Medlemmer: upner }),
                eierRolleFor: () => null
            },
            './flyt-kaller': { kallTeamSynkFlyt: flytSvar, miljo: () => 'dev' }
        };
        const res = await medStubber('../src/lib/team-synk-jobb.js', stubber,
            (m) => m.kjorTeamSynk({ kilde: 'timer' }));
        return { res, resultater, ...f };
    };

    const g = (rolle, team = 'Team A') => ({ Rolle: rolle, Omfang: '', Team: team, SisteAntall: 1 });

    const alt = await kjor({ grupper: [g('Behandler'), g('Leser')] });
    sjekk('team: alle gikk gir ok', alt.res.utfall, 'ok');
    sjekk('team: begge kjørte', alt.res.kjort, 2);
    sjekk('team: statusraden går fra kjører til ok', alt.skrevet.map(e => e.Status), ['kjører', 'ok']);
    sjekk('team: kilden bokføres', alt.skrevet[0]?.Kilde, 'timer');
    sjekk('team: antallet grupper står i raden', alt.skrevet.at(-1)?.AntallGrupper, 2);
    sjekk('team: og hendelsen bærer kilden', alt.hendelser[0]?.Aktor, 'timer');

    // Én gruppe som kaster skal ikke ta de andre med seg.
    const delvis = await kjor({
        grupper: [g('Behandler'), g('Leser')],
        flytSvar: async (payload) => {
            if (payload.Medlemmer.length && resultatTeller++ === 1) throw new Error('flyten svarte ikke');
            return { status: 'ok' };
        }
    });
    sjekk('team: én som kaster gir delvis', delvis.res.utfall, 'delvis');
    sjekk('team: men begge er forsøkt', delvis.res.kjort, 2);
    sjekk('team: og feilen står i raden', delvis.skrevet.at(-1)?.AntallFeilet, 1);

    // En STOPPET gruppe er ikke en feil i koden — teamet står urørt fordi
    // sperren sa nei. Den telles for seg, og gjør ikke jobben rød.
    const stoppet = await kjor({ grupper: [{ ...g('Behandler'), tom: true }] });
    sjekk('team: stoppet gruppe teller for seg', typeof stoppet.skrevet.at(-1)?.AntallStoppet, 'number');

    let kastet = null, aldri = null;
    try { aldri = await kjor({ hentKaster: true }); } catch (e) { kastet = e.message; }
    sjekk('team: en jobb som ikke kom i gang kaster ikke', kastet, null);
    sjekk('team: den melder kastet', aldri?.res?.kastet, true);
    sjekk('team: statusraden ender på feil', aldri?.skrevet.map(e => e.Status), ['kjører', 'feil']);

    // tillatFall skal ALDRI sendes fra jobben. Sperren mot store fall er det
    // eneste som står mellom en feilet rolleimport og et tømt team.
    // Kommentarene MÅ bort: ordet står i forklaringen av hvorfor det ikke
    // sendes, og en sjekk på at noe IKKE finnes blir ellers rød av sin egen
    // begrunnelse. Det skjedde da denne sjekken ble skrevet.
    const kilde = utenKommentarer(require('fs').readFileSync(
        require('path').join(__dirname, '..', 'src', 'lib', 'team-synk-jobb.js'), 'utf8'));
    const jobbDel = kilde.slice(kilde.indexOf('async function kjorTeamSynk'));
    sjekk('team: jobben sender ikke tillatFall', /tillatFall/.test(jobbDel), false);
}
let resultatTeller = 0;

// ==================== utsendingene (SENDER TIL EKSTERNE) ====================
//
// Den viktigste sjekken her er at ingenting sendes når adressen mangler.
// Timeren har ingen request, og uten SWA_URL fantes det før ingenting å
// utlede verten fra — e-posten ville båret «https://» med tom vert, til ekte
// mottakere, og lenka ville vært brukt opp.
async function utsendingSjekk() {
    const kjor = async (hvilken, { kandidater = [], flytSvar = { ok: true }, swaUrl = 'https://skjema.example.no', request = null, komFram = true } = {}) => {
        const f = fangst();
        const markert = [];
        const kalt = [];
        const foer = process.env.SWA_URL;
        if (swaUrl === null) delete process.env.SWA_URL; else process.env.SWA_URL = swaUrl;
        const stubber = {
            ...f.stubber,
            './utsending-storage': {
                listForfalteUtsendinger: async () => kandidater,
                listUbesvarte: async () => kandidater,
                markerSendt: async (b, m) => { markert.push(['sendt', b, m]); },
                markerPurret: async (b, m) => { markert.push(['purret', b, m]); }
            },
            './utsending-token': { utsted: () => 'token-123' },
            './flyt-utfall': { svarKomFram: () => komFram },
            './flyt-kaller': { miljo: () => 'dev', flytHeadere: async () => ({}) },
            './skjema-storage': { hentSkjematype: async () => ({ navn: 'Skjema', JSON: {} }) }
        };
        try {
            const res = await medStubber('../src/lib/utsending-jobb.js', stubber, async (m) => {
                // `fetch` stubbes, ikke `kallUtsendingsflyt`. Jobbene kaller
                // den funksjonen direkte inne i modulen, så en erstatning på
                // eksportobjektet ville ikke virket — og testen ville sett ut
                // til å måle at ingenting ble sendt, uansett hva koden gjorde.
                // Dette er det ekte kallet, og `kalt` er derfor et ekte svar
                // på «gikk det noe ut?».
                const ekteFetch = global.fetch;
                global.fetch = async (url, opts) => {
                    kalt.push(JSON.parse(opts.body).handling);
                    if (flytSvar.ok) return { ok: true, status: 200, text: async () => '' };
                    return { ok: false, status: flytSvar.status || 500, text: async () => 'nei' };
                };
                const foerFlyt = process.env.VARSLING_FLOW_URL;
                process.env.VARSLING_FLOW_URL = flytSvar.mangler ? '' : 'https://flyt.example.no/x';
                try {
                    return hvilken === 'send'
                        ? await m.kjorSendForfalte({ kilde: 'timer', request })
                        : await m.kjorPurring({ kilde: 'timer', request });
                } finally {
                    global.fetch = ekteFetch;
                    if (foerFlyt === undefined) delete process.env.VARSLING_FLOW_URL;
                    else process.env.VARSLING_FLOW_URL = foerFlyt;
                }
            });
            return { res, markert, kalt, ...f };
        } finally {
            if (foer === undefined) delete process.env.SWA_URL; else process.env.SWA_URL = foer;
        }
    };

    const kandidat = [{ BatchId: 'b1', Mottaker: 'a@b.no', SkjematypeId: 'st-1' }];

    // ---- den harde sperren ----
    const utenUrl = await kjor('send', { kandidater: kandidat, swaUrl: null, request: null });
    sjekk('utsending: uten SWA_URL og uten request feiler jobben', utenUrl.res.utfall, 'feil');
    sjekk('utsending: INGENTING ble sendt', utenUrl.kalt, []);
    sjekk('utsending: og ingenting markert', utenUrl.markert, []);
    sjekk('utsending: årsaken navngir SWA_URL',
        /SWA_URL/.test(utenUrl.res.melding || ''), true);
    sjekk('utsending: og står i statusraden',
        /SWA_URL/.test(utenUrl.skrevet.at(-1)?.SistFeil || ''), true);
    sjekk('utsending: statusraden ender på feil',
        utenUrl.skrevet.map(e => e.Status), ['kjører', 'feil']);

    // Samme sperre for purringen.
    const purreUtenUrl = await kjor('purre', { kandidater: kandidat, swaUrl: null, request: null });
    sjekk('purring: uten SWA_URL feiler jobben', purreUtenUrl.res.utfall, 'feil');
    sjekk('purring: INGENTING ble sendt', purreUtenUrl.kalt, []);
    sjekk('purring: og ingenting markert', purreUtenUrl.markert, []);

    // ---- normalveien ----
    const sendt = await kjor('send', { kandidater: kandidat });
    sjekk('utsending: vellykket kjøring gir ok', sendt.res.utfall, 'ok');
    sjekk('utsending: flyten ble kalt med riktig handling', sendt.kalt, ['sendUtsendinger']);
    sjekk('utsending: og mottakeren ble markert', sendt.markert, [['sendt', 'b1', 'a@b.no']]);
    sjekk('utsending: kilden bokføres', sendt.skrevet[0]?.Kilde, 'timer');

    const purret = await kjor('purre', { kandidater: kandidat });
    sjekk('purring: vellykket kjøring gir ok', purret.res.utfall, 'ok');
    sjekk('purring: riktig handling', purret.kalt, ['purreUtsendinger']);
    sjekk('purring: og mottakeren ble markert', purret.markert, [['purret', 'b1', 'a@b.no']]);

    // ---- ingenting å gjøre ----
    const tomt = await kjor('send', { kandidater: [] });
    sjekk('utsending: ingen kandidater gir eget utfall', tomt.res.utfall, 'ingenting');
    sjekk('utsending: og ingen flyt ble kalt', tomt.kalt, []);

    // ---- flyten feiler ----
    //
    // DEN AVGJØRENDE FORSKJELLEN MELLOM DE TO: utsendingen markerer ingenting
    // når flyten feiler (mottakeren fikk aldri lenka), mens purringen
    // markerer når kallet KOM FRAM (flyten kan ha rukket å sende til noen).
    const sendFeil = await kjor('send', { kandidater: kandidat, flytSvar: { ok: false, status: 500 } });
    sjekk('utsending: feilet flyt gir eget utfall', sendFeil.res.utfall, 'flyt-feilet');
    sjekk('utsending: og INGENTING markeres som sendt', sendFeil.markert, []);

    const purreFeil = await kjor('purre', { kandidater: kandidat, flytSvar: { ok: false, status: 500 } });
    sjekk('purring: kallet kom fram, så den markeres likevel',
        purreFeil.markert, [['purret', 'b1', 'a@b.no']]);
    sjekk('purring: men utfallet er delvis, ikke ok', purreFeil.res.utfall, 'delvis');

    // ---- og når kallet ALDRI kom fram ----
    //
    // DENNE SAKEN MANGLET I FØRSTE UTGAVE AV TESTEN, og hullet var usynlig:
    // stubben svarte at kallet kom fram uansett, så grenen under var
    // uprøvbar. En mutasjon som markerte purring selv når kallet aldri gikk
    // ut var GRØNN. Det er nøyaktig den feilen anti-spam-hensynet hviler på
    // å unngå — en purring brukt opp i stillhet, uten at noen fikk e-post.
    const kom_ikke = await kjor('purre', {
        kandidater: kandidat, flytSvar: { ok: false, status: 500 }, komFram: false
    });
    sjekk('purring: kallet kom aldri fram gir eget utfall', kom_ikke.res.utfall, 'kom-ikke-fram');
    sjekk('purring: og INGENTING markeres da', kom_ikke.markert, []);
    sjekk('purring: statusraden ender på feil',
        kom_ikke.skrevet.map(e => e.Status), ['kjører', 'feil']);
}


// ==================== backup (TO KADENSER) ====================
//
// Backup er den eneste jobben med to kadenser, og den eneste der modusen som
// BLE KJØRT kan være en annen enn den som ble bedt om: et delta uten en full
// å bygge på kjøres som full. Jobbraden må vise det som faktisk skjedde —
// «når gikk siste FULLE backup» er spørsmålet som avgjør om en
// gjenoppretting er mulig.
async function backupSjekk() {
    const sti = require.resolve('../src/functions/backup.js');
    const kjor = async (modus, utfall) => {
        const skrevet = [];
        const ekte = Module._load;
        Module._load = function (forespurt, ...r) {
            if (forespurt === '@azure/functions') return { app: { http() {}, timer() {} } };
            if (forespurt === '../lib/storage') {
                return {
                    tabellKlient: () => ({ upsertEntity: async (e) => { skrevet.push(e); } }),
                    sikreTabell: async () => ({ upsertEntity: async (e) => { skrevet.push(e); } }),
                    odata: () => ''
                };
            }
            return ekte.call(this, forespurt, ...r);
        };
        delete require.cache[sti];
        try {
            const m = require(sti);
            const res = await m._kjorBackupMedBokforing('timer', () => {}, modus,
                async () => {
                    if (typeof utfall === 'function') return utfall();
                    return utfall;
                });
            return { res, skrevet };
        } finally {
            Module._load = ekte;
            delete require.cache[sti];
        }
    };

    const full = await kjor('full', { status: 'ok', modus: 'full', filnavn: 'b-full.enc', varighetSekunder: 42 });
    sjekk('backup: full skriver sin egen jobbrad',
        full.skrevet.map(e => e.rowKey), ['Jobb-Backup-Full', 'Jobb-Backup-Full']);
    sjekk('backup: statusraden går fra kjører til ok',
        full.skrevet.map(e => e.Status), ['kjører', 'ok']);
    sjekk('backup: kilden bokføres', full.skrevet[0]?.Kilde, 'timer');
    sjekk('backup: filnavnet følger med', full.skrevet.at(-1)?.Filnavn, 'b-full.enc');

    const delta = await kjor('delta', { status: 'ok', modus: 'delta', filnavn: 'b-delta.enc' });
    sjekk('backup: delta skriver SIN rad, ikke fullens',
        delta.skrevet.map(e => e.rowKey), ['Jobb-Backup-Delta', 'Jobb-Backup-Delta']);

    // DEN VIKTIGE: bedt om delta, kjørt som full.
    const oppgradert = await kjor('delta', { status: 'ok', modus: 'full', filnavn: 'b-full.enc' });
    sjekk('backup: raden viser modusen som FAKTISK ble kjørt',
        oppgradert.skrevet.at(-1)?.Modus, 'full');
    sjekk('backup: og hva som ble bedt om', oppgradert.skrevet[0]?.BedtOmModus, 'delta');
    sjekk('backup: men raden er fortsatt deltaets',
        oppgradert.skrevet.at(-1)?.rowKey, 'Jobb-Backup-Delta');

    const feilet = await kjor('full', { status: 'feil', modus: 'full', melding: 'blob-lageret svarte ikke' });
    sjekk('backup: en feilet kjøring ender på feil', feilet.skrevet.at(-1)?.Status, 'feil');
    sjekk('backup: og bærer årsaken',
        /blob-lageret/.test(feilet.skrevet.at(-1)?.SistFeil || ''), true);

    // Timeren VENTER på denne. Slipper noe gjennom, skal det bli en rad og
    // ikke en uhåndtert feil i hosten.
    let kastet = null, vondt = null;
    try {
        vondt = await kjor('full', () => { throw new Error('noe uventet'); });
    } catch (e) { kastet = e.message; }
    sjekk('backup: en jobb som kaster, kaster ikke videre', kastet, null);
    sjekk('backup: den ender på feil', vondt?.skrevet.at(-1)?.Status, 'feil');
    sjekk('backup: med årsaken i raden',
        /noe uventet/.test(vondt?.skrevet.at(-1)?.SistFeil || ''), true);
}

(async () => {
    await postnumreSjekk();
    await fsSjekk();
    await oppslagSjekk();
    await nokkelSjekk();
    await teamSjekk();
    await utsendingSjekk();
    await backupSjekk();
    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
})().catch((e) => { console.log('TESTEN KRASJET:', e.stack); process.exit(1); });
