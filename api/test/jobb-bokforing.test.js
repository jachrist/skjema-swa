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

(async () => {
    await postnumreSjekk();
    await fsSjekk();
    await oppslagSjekk();
    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
})().catch((e) => { console.log('TESTEN KRASJET:', e.stack); process.exit(1); });
